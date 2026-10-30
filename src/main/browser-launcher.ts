// @ts-nocheck
import { spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { BrowserCrashRecord, BrowserProfile, LaunchDiagnosticCheck, LaunchDiagnosticReport, ProfileLaunchOptions, ProxyConfig, ProxyTestResult } from '../shared/types'
import { locateBrowserForProfile } from './browser-locator'
import { buildLaunchArgs } from './launch-args'
import type { ProfileStore } from './profile-store'
import type { SettingsStore } from './settings-store'
import { closeProxyBridge, openProxyBridge } from './proxy-bridge'
import type { Logger } from './app-logger'
import type { ExtensionStore } from './extension-store'
import { findManagedProcess, SystemProcessInspector, type ProcessInspector } from './process-inspector'
import { assertFingerprintKernelCompatibility } from '../shared/fingerprint-consistency'
import { safeErrorText } from './redaction'
import { hardwareProfile, hardwareProfileSummary } from '../shared/hardware-profiles'
import { hostHardwareSnapshot } from './host-hardware'
import { classifyProxyFailure, testProxy } from './proxy-tester'
import { GEOIP_CONFLICT_CONFIRMATION_PREFIX, hasCompleteProxyIdentity, proxyLaunchError } from '../shared/network-identity'
import { sameProxyIdentity } from './profile-secrets'
import { BrowserControlError, BrowserControlSession, PipeCdpTransport, WebSocketCdpTransport, validWindowSyncAction } from './browser-control-session'
import { kernelRequiresPro } from '../shared/kernel-policy'

export { BrowserControlError, BrowserControlSession, PipeCdpTransport, WebSocketCdpTransport }

export interface LauncherRuntimeSnapshot {
  managedProcesses: number
  orphanProcesses: number
  launchOperations: number
  closeOperations: number
  activeLaunches: number
  queuedLaunches: number
  closingAll: boolean
}

export type { BrowserCrashRecord } from '../shared/types'

const MAX_CLOSE_ALL_ROUNDS = 4;
const MAX_STAGNANT_CLOSE_ALL_ROUNDS = 2;
async function removeStaleDevToolsActivePort(userDataDir) {
  const path = join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      const code = error.code;
      if (!["EBUSY", "EPERM", "EACCES"].includes(code ?? "") || attempt === 7) throw error;
      await new Promise((resolve2) => setTimeout(resolve2, 80 * (attempt + 1)));
    }
  }
}
async function waitForWebSocketEndpoint(userDataDir, child) {
  const path = join(userDataDir, "DevToolsActivePort");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("浏览器在控制通道就绪前退出");
    try {
      const [port, browserPath] = (await readFile(path, "utf8")).trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && browserPath?.startsWith("/")) return `ws://127.0.0.1:${port}${browserPath}`;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve2) => setTimeout(resolve2, 100));
  }
  throw new Error("等待浏览器控制通道超时");
}
function validCrashHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((record) => Boolean(
    record && typeof record === "object" && typeof record.occurredAt === "string" && (record.code === null || typeof record.code === "number") && (record.signal === null || typeof record.signal === "string") && ["starting", "running"].includes(record.phase)
  )).slice(-20);
}
export class BrowserLauncher {
  constructor(
    profiles: ProfileStore,
    settings: SettingsStore,
    onChanged: (profile: BrowserProfile) => void,
    extensions: ExtensionStore,
    logger2?: Logger,
    processInspector: ProcessInspector = new SystemProcessInspector(),
    proxyTester: (config: ProxyConfig) => Promise<ProxyTestResult> = testProxy,
    maxConcurrentLaunches = 3,
    browserSpawner: typeof spawn = spawn,
    proxyMonitorIntervalMs = 5 * 6e4,
    controlTransport: 'pipe' | 'websocket' = process.platform === "win32" ? "websocket" : "pipe"
  ) {
    this.profiles = profiles;
    this.settings = settings;
    this.onChanged = onChanged;
    this.extensions = extensions;
    this.logger = logger2;
    this.processInspector = processInspector;
    this.proxyTester = proxyTester;
    this.maxConcurrentLaunches = maxConcurrentLaunches;
    this.browserSpawner = browserSpawner;
    this.proxyMonitorIntervalMs = proxyMonitorIntervalMs;
    this.controlTransport = controlTransport;
    if (!Number.isInteger(maxConcurrentLaunches) || maxConcurrentLaunches < 1 || maxConcurrentLaunches > 20) {
      throw new Error("浏览器并发启动数必须在 1 到 20 之间");
    }
    if (!Number.isInteger(proxyMonitorIntervalMs) || proxyMonitorIntervalMs < 10) {
      throw new Error("代理出口复检间隔不能小于 10 毫秒");
    }
  }
  profiles;
  settings;
  onChanged;
  extensions;
  logger;
  processInspector;
  proxyTester;
  maxConcurrentLaunches;
  browserSpawner;
  proxyMonitorIntervalMs;
  controlTransport;
  processes = /* @__PURE__ */ new Map();
  orphanProcesses = /* @__PURE__ */ new Map();
  launchOperations = /* @__PURE__ */ new Map();
  closeOperations = /* @__PURE__ */ new Map();
  activeLaunches = 0;
  launchWaiters = [];
  closeAllOperation;
  canUseProKernel = () => true;
  setProKernelAccessCheck(_check?: () => boolean): void {
    this.canUseProKernel = () => true;
  }
  async initialize() {
    if (this.profiles.list().length === 0) return;
    let systemProcesses;
    try {
      systemProcesses = await this.processInspector.list();
    } catch (error) {
      this.logger?.error("启动时无法扫描 Chromium 遗留进程", error);
      await Promise.allSettled(this.profiles.list().map(async (profile) => {
        const processMarker = join(this.profiles.profileRuntimePath(profile.id), "process.json");
        const hadProcessMarker = await access(processMarker).then(() => true).catch(() => false);
        if (!hadProcessMarker && (profile.status === "closed" || profile.status === "error")) return;
        const next = await this.profiles.setRuntime(profile.id, {
          status: "error",
          lastError: "应用重启后无法扫描系统进程，请先执行启动诊断再重新打开环境"
        });
        this.onChanged(next);
      }));
      return;
    }
    for (const profile of this.profiles.list()) {
      const process2 = findManagedProcess(systemProcesses, this.profiles.profileDataPath(profile.id));
      if (process2) {
        this.orphanProcesses.set(profile.id, process2.pid);
        await this.profiles.setRuntime(profile.id, {
          status: "orphaned",
          lastError: `检测到上次异常退出遗留的浏览器进程（PID ${process2.pid}）`
        });
        this.logger?.error("检测到遗留浏览器进程", { profileId: profile.id, pid: process2.pid });
      } else {
        const processMarker = join(this.profiles.profileRuntimePath(profile.id), "process.json");
        const hadProcessMarker = await access(processMarker).then(() => true).catch(() => false);
        await rm(processMarker, { force: true });
        if (hadProcessMarker || profile.status !== "closed" && profile.status !== "error") {
          const next = await this.profiles.setRuntime(profile.id, {
            status: "error",
            lastError: "上次运行未正常结束，但当前未发现占用数据目录的浏览器进程"
          });
          this.onChanged(next);
          this.logger?.error("浏览器环境状态已从异常中断中恢复", { profileId: profile.id });
        }
      }
    }
  }
  async launch(id, options = {}) {
    if (this.closeAllOperation) throw new Error("正在关闭全部浏览器环境，请等待操作完成后再启动");
    const existing = this.launchOperations.get(id);
    if (existing) return existing;
    const operation = (async () => {
      const closing = this.closeOperations.get(id);
      if (closing) await closing.catch(() => void 0);
      return this.profiles.withProfileDataOperation(id, () => this.withLaunchSlot(() => this.launchProfile(id, options)));
    })();
    this.launchOperations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.launchOperations.get(id) === operation) this.launchOperations.delete(id);
    }
  }
  async launchProfile(id, options) {
    if (this.processes.has(id)) return this.profiles.get(id);
    if (this.orphanProcesses.has(id)) throw new Error("该环境仍有异常遗留进程，请先点击“结束遗留”");
    let profile = this.profiles.get(id);
    let localProxyUrl;
    try {
      await this.guardProfileAvailable(id);
      const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion);
      if (!engine.executable) {
        throw new Error(profile.kernelVersion ? `环境绑定的内核 ${profile.kernelVersion} 不可用，请先安装该版本或修改环境配置` : "没有找到浏览器内核，请先选择 Fingerprint Chromium 可执行文件");
      }
      // Pro kernel check unlocked for Community Edition
      if (profile.proxy.protocol !== "direct") profile = await this.refreshProxyForLaunch(profile, options.allowGeoConflict === true);
      const hostHardware = hostHardwareSnapshot();
      const selectedHardware = hardwareProfile(profile.fingerprint.hardwareProfileId);
      if (selectedHardware?.hostMatched && selectedHardware.platform !== hostHardware.platform) {
        throw new Error(`${selectedHardware.label} 只能在对应系统上使用；请改用本机模板或成套模拟模板`);
      }
      assertFingerprintKernelCompatibility(profile, engine);
      this.logger?.info("准备启动浏览器环境", { profileId: id, engine: engine.label });
      this.onChanged(await this.profiles.setRuntime(id, { status: "starting", lastError: void 0 }));
      localProxyUrl = await openProxyBridge(profile.proxy, {
        onFailure: (error) => {
          void this.noteProxyBridgeFailure(id, error).catch((callbackError) => {
            this.logger?.error("记录代理桥失败状态时出错", {
              profileId: id,
              error: callbackError instanceof Error ? callbackError.message : String(callbackError)
            });
          });
        },
        onTraffic: () => {
          void this.noteProxyBridgeTraffic(id).catch((error) => {
            this.logger?.error("记录代理桥恢复状态时出错", {
              profileId: id,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        }
      });
      const runtimePath = this.profiles.profileRuntimePath(id);
      await mkdir(runtimePath, { recursive: true });
      const args = buildLaunchArgs(profile, {
        userDataDir: this.profiles.profileDataPath(id),
        proxyUrl: localProxyUrl,
        extensionPaths: this.extensions.paths(profile.extensionIds),
        engineVersion: engine.version,
        fingerprintKernel: engine.fingerprintKernel,
        hostHardwareConcurrency: hostHardware.hardwareConcurrency,
        hostPlatformVersion: hostHardware.platformVersion,
        proxyIdentity: profile.proxyCheck,
        allowGeoConflict: options.allowGeoConflict === true
      });
      if (process.env.PRISM_E2E === "1" && process.env.PRISM_E2E_BROWSER_HEADLESS === "1") {
        args.push("--headless=new");
        if (process.platform === "darwin") args.push("--use-mock-keychain");
      }
      const pipeControlEnabled = this.controlTransport === "pipe";
      if (pipeControlEnabled) args.push("--remote-debugging-pipe");
      else {
        await removeStaleDevToolsActivePort(this.profiles.profileDataPath(id));
        args.push("--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--remote-allow-origins=*");
      }
      await writeFile(
        join(runtimePath, "last-launch.json"),
        JSON.stringify({ executable: engine.executable, args, launchedAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2),
        { encoding: "utf8", mode: 384 }
      );
      const child = this.browserSpawner(engine.executable, args, {
        stdio: pipeControlEnabled ? ["ignore", "ignore", "ignore", "pipe", "pipe"] : "ignore",
        windowsHide: false,
        env: { ...process.env }
      });
      let automation2;
      if (pipeControlEnabled && Array.isArray(child.stdio)) {
        const writable = child.stdio[3];
        const readable = child.stdio[4];
        if (readable && writable) automation2 = new BrowserControlSession(new PipeCdpTransport(readable, writable));
      }
      let resolveExited;
      const exited = new Promise((resolve2) => {
        resolveExited = resolve2;
      });
      let resolveStarted;
      let rejectStarted;
      const started = new Promise((resolve2, reject) => {
        resolveStarted = resolve2;
        rejectStarted = reject;
      });
      let startSettled = false;
      const markStarted = () => {
        if (startSettled) return;
        startSettled = true;
        resolveStarted();
      };
      const markStartFailed = (error) => {
        if (startSettled) return;
        startSettled = true;
        rejectStarted(error instanceof Error ? error : new Error(String(error)));
      };
      let finalized = false;
      const finalize = async (status, lastError) => {
        if (finalized) return;
        finalized = true;
        automation2?.close();
        if (running?.proxyMonitor) clearInterval(running.proxyMonitor);
        this.processes.delete(id);
        this.orphanProcesses.delete(id);
        try {
          const cleanup = await Promise.allSettled([
            closeProxyBridge(localProxyUrl),
            rm(join(runtimePath, "process.json"), { force: true })
          ]);
          for (const result of cleanup) {
            if (result.status === "rejected") {
              this.logger?.error("浏览器退出资源清理失败", {
                profileId: id,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason)
              });
            }
          }
          const next = await this.profiles.setRuntime(id, { status, lastError });
          this.onChanged(next);
        } catch (error) {
          this.logger?.error("浏览器退出状态持久化失败", {
            profileId: id,
            error: error instanceof Error ? error.message : String(error)
          });
        } finally {
          resolveExited();
        }
      };
      const running = {
        process: child,
        automation: automation2,
        proxyUrl: localProxyUrl,
        proxyIdentityIp: profile.proxyCheck?.ip,
        proxyMonitorRunning: false,
        proxyQuarantined: false,
        proxyIdentityMismatch: false,
        expectedExit: false,
        exited,
        proxyFailureTimes: [],
        proxyWarningIssued: false,
        finalize
      };
      this.processes.set(id, running);
      let spawnWork;
      const isCurrent = () => !finalized && this.processes.get(id) === running && child.exitCode === null && child.signalCode === null;
      child.once("spawn", () => {
        spawnWork = (async () => {
          try {
            if (!isCurrent()) return;
            this.logger?.info("浏览器环境已启动", { profileId: id, pid: child.pid });
            if (!pipeControlEnabled) {
              const endpoint = await waitForWebSocketEndpoint(this.profiles.profileDataPath(id), child);
              if (!isCurrent()) return;
              automation2 = new BrowserControlSession(await WebSocketCdpTransport.connect(endpoint));
              if (!isCurrent()) {
                automation2.close();
                return;
              }
              running.automation = automation2;
            }
            await writeFile(join(runtimePath, "process.json"), JSON.stringify({
              pid: child.pid,
              executable: engine.executable,
              userDataDir: this.profiles.profileDataPath(id),
              startedAt: (/* @__PURE__ */ new Date()).toISOString()
            }, null, 2), { mode: 384 });
            if (!isCurrent()) {
              await rm(join(runtimePath, "process.json"), { force: true });
              return;
            }
            const next = await this.profiles.setRuntime(id, {
              status: "running",
              lastOpenedAt: (/* @__PURE__ */ new Date()).toISOString(),
              lastError: void 0
            });
            if (!isCurrent()) return;
            this.onChanged(next);
            if (localProxyUrl) this.startProxyMonitor(id, profile.proxy);
            markStarted();
          } catch (error) {
            if (finalized) return;
            markStartFailed(error);
            running.expectedExit = true;
            child.kill("SIGTERM");
            await finalize("error", safeErrorText(error));
          }
        })();
      });
      child.once("error", (error) => {
        this.logger?.error("浏览器进程启动失败", { profileId: id, error: error.message });
        markStartFailed(error);
        void finalize("error", error.message);
      });
      child.once("exit", (code, signal) => {
        const unexpected = !running.expectedExit && code !== 0;
        const phase = startSettled ? "running" : "starting";
        if (!startSettled) {
          this.logger?.error("浏览器在启动完成前退出", { profileId: profile.id, code, signal });
          markStartFailed(new Error("浏览器在启动完成前退出，请重试或运行启动诊断"));
        }
        this.logger?.info("浏览器环境已退出", { profileId: id, code, signal, expected: !unexpected });
        void (async () => {
          if (unexpected) {
            await this.recordCrash(id, {
              occurredAt: (/* @__PURE__ */ new Date()).toISOString(),
              pid: child.pid,
              code,
              signal,
              phase
            }).catch((error) => {
              this.logger?.error("浏览器崩溃历史写入失败", {
                profileId: id,
                error: error instanceof Error ? error.message : String(error)
              });
            });
          }
          await finalize(
            unexpected ? "error" : "closed",
            unexpected ? `浏览器异常退出（code=${code ?? "-"}, signal=${signal ?? "-"}）` : void 0
          );
        })();
      });
      try {
        await started;
      } finally {
        await spawnWork;
      }
      return this.profiles.get(id);
    } catch (error) {
      this.logger?.error("浏览器环境启动流程失败", { profileId: id, error: error instanceof Error ? error.message : String(error) });
      await closeProxyBridge(localProxyUrl);
      const safeError = safeErrorText(error);
      if (this.profiles.get(id).status === "starting") {
        const next = await this.profiles.setRuntime(id, {
          status: "error",
          lastError: safeError
        });
        this.onChanged(next);
      }
      throw new Error(safeError);
    }
  }
  async close(id) {
    const existing = this.closeOperations.get(id);
    if (existing) return existing;
    const operation = (async () => {
      const launching = this.launchOperations.get(id);
      if (launching) await launching.catch(() => void 0);
      return this.closeProfile(id);
    })();
    this.closeOperations.set(id, operation);
    try {
      return await operation;
    } finally {
      if (this.closeOperations.get(id) === operation) this.closeOperations.delete(id);
    }
  }
  async closeProfile(id) {
    const orphanPid = this.orphanProcesses.get(id);
    if (orphanPid) return this.closeOrphan(id, orphanPid);
    const running = this.processes.get(id);
    if (!running) {
      const profile = await this.profiles.setRuntime(id, { status: "closed", lastError: void 0 });
      this.onChanged(profile);
      return profile;
    }
    running.expectedExit = true;
    this.logger?.info("正在关闭浏览器环境", { profileId: id, pid: running.process.pid });
    this.onChanged(await this.profiles.setRuntime(id, { status: "stopping", lastError: void 0 }));
    running.process.kill("SIGTERM");
    const exited = await new Promise((resolve2) => {
      const forceTimer = setTimeout(() => {
        running.process.kill("SIGKILL");
      }, 5e3);
      const giveUpTimer = setTimeout(() => {
        clearTimeout(forceTimer);
        resolve2(false);
      }, 8e3);
      void running.exited.then(() => {
        clearTimeout(forceTimer);
        clearTimeout(giveUpTimer);
        resolve2(true);
      });
    });
    if (!exited && this.processes.get(id) === running) {
      let managedProcess;
      try {
        managedProcess = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id));
      } catch (error) {
        const message = "浏览器关闭超时，且无法重新扫描进程；请稍后重试或执行启动诊断";
        this.onChanged(await this.profiles.setRuntime(id, { status: "error", lastError: message }));
        this.logger?.error("浏览器关闭超时且进程扫描失败", {
          profileId: id,
          error: error instanceof Error ? error.message : String(error)
        });
        throw new Error(message);
      }
      if (managedProcess) {
        this.processes.delete(id);
        this.orphanProcesses.set(id, managedProcess.pid);
        const message = `浏览器关闭超时，仍检测到占用数据目录的进程（PID ${managedProcess.pid}）`;
        const profile = await this.profiles.setRuntime(id, { status: "orphaned", lastError: message });
        this.onChanged(profile);
        this.logger?.error("浏览器关闭后转为遗留进程", { profileId: id, pid: managedProcess.pid });
        return profile;
      }
      await running.finalize("closed");
    }
    return this.profiles.get(id);
  }
  closeAll() {
    if (this.closeAllOperation) return this.closeAllOperation;
    const operation = (async () => {
      const failures = /* @__PURE__ */ new Map();
      let stagnantRounds = 0;
      for (let round = 0; round < MAX_CLOSE_ALL_ROUNDS; round += 1) {
        const ids = /* @__PURE__ */ new Set([
          ...this.processes.keys(),
          ...this.orphanProcesses.keys(),
          ...this.launchOperations.keys(),
          ...this.closeOperations.keys()
        ]);
        if (!ids.size) return;
        const before = this.closeAllState();
        const orderedIds = [...ids].sort();
        const results = await Promise.allSettled(orderedIds.map((id) => this.close(id)));
        results.forEach((result, index) => {
          if (result.status === "rejected") failures.set(orderedIds[index], result.reason);
          else failures.delete(orderedIds[index]);
        });
        const after = this.closeAllState();
        if (!after.length) return;
        if (after.join("\n") === before.join("\n")) stagnantRounds += 1;
        else stagnantRounds = 0;
        if (stagnantRounds >= MAX_STAGNANT_CLOSE_ALL_ROUNDS) break;
      }
      const remaining = [.../* @__PURE__ */ new Set([
        ...this.processes.keys(),
        ...this.orphanProcesses.keys(),
        ...this.launchOperations.keys(),
        ...this.closeOperations.keys()
      ])].sort();
      const causes = remaining.map((id) => failures.get(id) ?? new Error(`环境 ${id} 仍有未结束的浏览器进程`));
      throw new AggregateError(causes, `仍有 ${remaining.length} 个浏览器环境无法关闭，请查看启动诊断或手动结束遗留进程`);
    })();
    this.closeAllOperation = operation;
    const clearOperation = () => {
      if (this.closeAllOperation === operation) this.closeAllOperation = void 0;
    };
    void operation.then(clearOperation, clearOperation);
    return operation;
  }
  closeAllState() {
    return [
      ...[...this.processes.keys()].map((id) => `managed:${id}`),
      ...[...this.orphanProcesses.keys()].map((id) => `orphan:${id}`),
      ...[...this.launchOperations.keys()].map((id) => `launch:${id}`),
      ...[...this.closeOperations.keys()].map((id) => `close:${id}`)
    ].sort();
  }
  isRunning(id) {
    return this.processes.has(id) || this.orphanProcesses.has(id) || this.launchOperations.has(id) || this.closeOperations.has(id);
  }
  hasRunning() {
    return this.processes.size > 0 || this.orphanProcesses.size > 0 || this.launchOperations.size > 0 || this.closeOperations.size > 0;
  }
  runningProfileIds() {
    return [...this.processes.keys()];
  }
  browserProcessId(id) {
    const pid = this.processes.get(id)?.process.pid;
    if (!pid) throw new Error("浏览器环境尚未启动");
    return pid;
  }
  startWindowSyncCapture(id, onAction) {
    return this.controlSession(id).startWindowSyncCapture(onAction);
  }
  applyWindowSyncAction(id, action) {
    return this.controlSession(id).applyWindowSyncAction(action);
  }
  browserWindowBounds(id) {
    return this.controlSession(id).windowBounds();
  }
  setBrowserWindowBounds(id, bounds) {
    return this.controlSession(id).setWindowBounds(bounds);
  }
  bringBrowserToFront(id) {
    return this.controlSession(id).bringToFront();
  }
  browserPageUrls(id) {
    return this.controlSession(id).pageUrls();
  }
  replaceBrowserTabs(id, urls) {
    return this.controlSession(id).replaceTabs(urls);
  }
  closeBrowserTabs(id, mode) {
    return this.controlSession(id).closeTabs(mode);
  }
  visitBrowser(id, url, newTab) {
    return this.controlSession(id).visit(url, newTab);
  }
  async openPage(id, url) {
    await this.launch(id);
    return this.controlSession(id).open(url);
  }
  async createPageControlSession(id) {
    await this.launch(id);
    return this.controlSession(id).fork();
  }
  pageSnapshot(id) {
    return this.controlSession(id).snapshot();
  }
  clickPageElement(id, ref) {
    return this.controlSession(id).click(ref);
  }
  clickPageElementAndWait(id, ref, filter) {
    return this.controlSession(id).clickAndWaitForTarget(ref, filter);
  }
  setPageElementChecked(id, ref, checked) {
    return this.controlSession(id).setChecked(ref, checked);
  }
  setPageInputFiles(id, ref, paths) {
    return this.controlSession(id).setInputFiles(ref, paths);
  }
  typePageElement(id, ref, text2, clear = true) {
    return this.controlSession(id).type(ref, text2, clear);
  }
  listPageTargets(id) {
    return this.controlSession(id).listTargets();
  }
  selectPageTarget(id, targetId) {
    return this.controlSession(id).selectTarget(targetId);
  }
  waitForPageTarget(id, filter) {
    return this.controlSession(id).waitForTarget(filter);
  }
  capturePageScreenshot(id) {
    return this.controlSession(id).screenshot();
  }
  clickPagePoint(id, x, y) {
    return this.controlSession(id).clickPoint(x, y);
  }
  scrollPage(id, deltaX, deltaY) {
    return this.controlSession(id).scroll(deltaX, deltaY);
  }
  pressPageKey(id, key) {
    return this.controlSession(id).pressKey(key);
  }
  runtimeSnapshot() {
    return {
      managedProcesses: this.processes.size,
      orphanProcesses: this.orphanProcesses.size,
      launchOperations: this.launchOperations.size,
      closeOperations: this.closeOperations.size,
      activeLaunches: this.activeLaunches,
      queuedLaunches: this.launchWaiters.length,
      closingAll: Boolean(this.closeAllOperation)
    };
  }
  controlSession(id) {
    const running = this.processes.get(id);
    if (!running) throw new Error("浏览器环境尚未启动");
    if (!running.automation) {
      throw new Error("当前浏览器内核没有建立页面控制通道，请关闭环境后重新启动");
    }
    return running.automation;
  }
  async crashHistory(id) {
    this.profiles.get(id);
    try {
      return validCrashHistory(JSON.parse(await readFile(
        join(this.profiles.profileRuntimePath(id), "crash-history.json"),
        "utf8"
      )));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }
  async crashHistorySnapshot() {
    return Object.fromEntries(await Promise.all(this.profiles.list().map(async (profile) => [
      profile.id,
      await this.crashHistory(profile.id)
    ])));
  }
  async diagnose(id) {
    const profile = this.profiles.get(id);
    const checks = [];
    const add = (key, label, status, message) => {
      checks.push({ key, label, status, message });
    };
    if (this.isRunning(id) || !["closed", "error"].includes(profile.status)) {
      add("process", "进程状态", "error", profile.status === "orphaned" ? "存在异常遗留进程，需先结束遗留" : "环境当前正在运行或切换状态");
    } else {
      try {
        const process2 = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id));
        add("process", "进程状态", process2 ? "error" : "pass", process2 ? `数据目录被 PID ${process2.pid} 占用` : "未发现数据目录占用");
      } catch {
        add("process", "进程状态", "error", "无法扫描系统进程，为保护数据不建议启动");
      }
    }
    try {
      await this.profiles.assertProfileDataIdentity(id);
      add("data-identity", "数据目录身份", "pass", "环境 ID、用户数据目录与运行目录对应一致");
    } catch (error) {
      add("data-identity", "数据目录身份", "error", error instanceof Error ? error.message : String(error));
    }
    const engine = await locateBrowserForProfile(this.settings, this.profiles.vaultPath, profile.kernelVersion);
    if (!engine.executable) {
      add("engine", "浏览器内核", "error", engine.label);
    } else {
      try {
        await access(engine.executable, constants.X_OK);
        add("engine", "浏览器内核", engine.fingerprintKernel ? "pass" : "warning", !engine.fingerprintKernel ? `${engine.label} 可执行，但不会应用指纹参数` : engine.version ? `${engine.label} 可执行（版本 ${engine.version}）` : `${engine.label} 可执行`);
      } catch {
        add("engine", "浏览器内核", "error", "内核文件不存在、不可执行或权限不足");
      }
      try {
        assertFingerprintKernelCompatibility(profile, engine);
        add("version", "版本一致性", "pass", engine.fingerprintKernel && engine.version ? `UA、UA-CH 与请求头版本将统一使用实际内核 ${engine.version}` : "兼容模式使用浏览器自身版本");
      } catch (error) {
        add("version", "版本一致性", "error", error instanceof Error ? error.message : String(error));
      }
    }
    try {
      const paths = this.extensions.paths(profile.extensionIds);
      await Promise.all(paths.map((path) => access(path)));
      add("extensions", "浏览器扩展", "pass", paths.length ? `${paths.length} 个扩展配置完整` : "未加载额外扩展");
    } catch (error) {
      add("extensions", "浏览器扩展", "error", error instanceof Error ? error.message : String(error));
    }
    try {
      const fileSystem = await statfs(this.profiles.profileDataPath(id));
      const availableBytes = fileSystem.bavail * fileSystem.bsize;
      const availableMb = Math.floor(availableBytes / 1024 / 1024);
      const status = availableBytes < 200 * 1024 * 1024 ? "error" : availableBytes < 1024 * 1024 * 1024 ? "warning" : "pass";
      add("disk", "数据磁盘", status, `数据目录所在磁盘可用 ${availableMb.toLocaleString()} MB`);
    } catch {
      add("disk", "数据磁盘", "error", "无法读取数据目录磁盘空间");
    }
    if (profile.proxy.protocol === "direct") {
      add("proxy", "代理网络", "warning", "当前使用本地直连网络，多个环境可能共享同一出口 IP");
    } else if (!profile.proxyCheck) {
      add("proxy", "代理网络", "warning", "代理尚未检测，建议先确认出口 IP 和地区");
    } else if (!profile.proxyCheck.ok) {
      add("proxy", "代理网络", "error", `最近一次代理检测失败：${safeErrorText(profile.proxyCheck.error ?? "连接失败")}`);
    } else {
      const stale = Date.now() - Date.parse(profile.proxyCheck.checkedAt) > 24 * 60 * 60 * 1e3;
      const geoConflict = profile.proxyCheck.geoConfidence === "conflict";
      add("proxy", "代理网络", stale || profile.proxyCheck.degraded ? "warning" : "pass", [
        profile.proxyCheck.ip ?? "代理可用",
        `${profile.proxyCheck.latencyMs} ms`,
        ...stale ? ["结果已超过 24 小时"] : [],
        ...profile.proxyCheck.geoConfidence === "consensus" ? ["GeoIP 双源一致"] : []
      ].join(" · "));
      if (profile.proxyCheck.exitChanged) {
        add(
          "proxy-exit",
          "出口稳定性",
          profile.fingerprint.proxyExitPolicy === "block" ? "error" : "warning",
          `代理出口已从 ${profile.proxyCheck.previousIp ?? "原地址"} 变为 ${profile.proxyCheck.ip ?? "新地址"}`
        );
      } else {
        add("proxy-exit", "出口稳定性", "pass", "最近两次检测未发现出口 IP 变化");
      }
      if (geoConflict) {
        add("timezone", "时区一致性", "warning", `${profile.proxyCheck.geoConflict ?? "GeoIP 数据源对代理地区或时区判断不一致"}；启动时将要求用户确认风险`);
      } else if (profile.proxyCheck.timezone && profile.proxyCheck.timezone !== profile.fingerprint.timezone) {
        add(
          "timezone",
          "时区一致性",
          profile.fingerprint.networkIdentityMode === "proxy" ? "pass" : "warning",
          profile.fingerprint.networkIdentityMode === "proxy" ? `启动时自动使用代理时区 ${profile.proxyCheck.timezone}` : `代理为 ${profile.proxyCheck.timezone}，指纹为 ${profile.fingerprint.timezone}`
        );
      } else {
        add("timezone", "时区一致性", "pass", "代理地区与指纹时区未发现冲突");
      }
      if (profile.fingerprint.networkIdentityMode === "proxy") {
        const geoReady = Boolean(profile.proxyCheck.countryCode && profile.proxyCheck.timezone && profile.proxyCheck.latitude !== void 0 && profile.proxyCheck.longitude !== void 0);
        add("geolocation", "地理身份", geoReady ? geoConflict ? "warning" : "pass" : "error", geoReady ? `${profile.proxyCheck.countryCode} · ${profile.proxyCheck.timezone} · 浏览器位置使用代理城市级坐标` : profile.proxyCheck.geoConflict ?? "自动网络身份缺少国家、时区或坐标，请重新检测代理");
      }
    }
    if (profile.proxy.protocol !== "direct" && profile.fingerprint.webrtcPolicy !== "proxy_only") {
      add("webrtc", "WebRTC", "warning", "当前兼容策略可能暴露代理之外的公网或本地地址");
    } else {
      add("webrtc", "WebRTC", "pass", "已启用非代理 UDP 防泄漏策略");
    }
    if (profile.proxy.protocol !== "direct") {
      add("dns", "DNS 路由", "pass", "域名解析、预取与 QUIC 均限制在代理路径，回环地址除外");
      add("ipv6", "IPv6 路由", "pass", profile.proxyCheck?.ipVersion === 6 ? "代理出口已检测为 IPv6，WebRTC 不允许绕过代理" : "当前出口为 IPv4，宿主 IPv6 不允许通过 WebRTC 或直连 DNS 旁路");
    }
    const hardware = hardwareProfile(profile.fingerprint.hardwareProfileId);
    if (!hardware) {
      add("hardware", "硬件一致性", "warning", "旧版自定义组合保持不变；新账号建议改用成套硬件模板");
    } else if (hardware.hostMatched && hardware.platform !== hostHardwareSnapshot().platform) {
      add("hardware", "硬件一致性", "error", `${hardware.label} 不能在当前系统上使用`);
    } else {
      add("hardware", "硬件一致性", "pass", `${hardware.label} · ${hardwareProfileSummary(hardware.id)}`);
      add("rendering", "渲染策略", "pass", hardware.hostMatched ? "GPU、字体、Canvas、Audio、ClientRects 使用本机原生结果" : `GPU 固定为 ${hardware.gpuModel}；Canvas、Audio、ClientRects 使用稳定原生结果`);
    }
    return {
      profileId: id,
      checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
      ready: !checks.some((check) => check.status === "error"),
      checks
    };
  }
  async withLaunchSlot(operation) {
    if (this.activeLaunches >= this.maxConcurrentLaunches) {
      await new Promise((resolve2) => this.launchWaiters.push(resolve2));
    }
    this.activeLaunches += 1;
    try {
      return await operation();
    } finally {
      this.activeLaunches -= 1;
      this.launchWaiters.shift()?.();
    }
  }
  async recordCrash(id, record) {
    const path = join(this.profiles.profileRuntimePath(id), "crash-history.json");
    const temporary = `${path}.tmp`;
    const history = [...await this.crashHistory(id), record].slice(-20);
    await writeFile(temporary, JSON.stringify(history, null, 2), { encoding: "utf8", mode: 384 });
    await rm(path, { force: true });
    await rename(temporary, path);
  }
  async guardProfileAvailable(id) {
    await this.profiles.assertProfileDataIdentity(id);
    let process2;
    try {
      process2 = findManagedProcess(await this.processInspector.list(), this.profiles.profileDataPath(id));
    } catch (error) {
      this.logger?.error("无法确认环境数据目录是否被占用", { profileId: id, error: error instanceof Error ? error.message : String(error) });
      throw new Error("无法检查浏览器进程占用状态，为保护环境数据已取消启动");
    }
    if (!process2) return;
    this.orphanProcesses.set(id, process2.pid);
    const profile = await this.profiles.setRuntime(id, {
      status: "orphaned",
      lastError: `环境数据目录正被遗留浏览器进程占用（PID ${process2.pid}）`
    });
    this.onChanged(profile);
    throw new Error("环境数据目录正被其他浏览器进程占用，请先结束遗留进程");
  }
  async refreshProxyForLaunch(profile, allowGeoConflict) {
    const result = await this.proxyTester(profile.proxy);
    const current = this.profiles.get(profile.id);
    if (!sameProxyIdentity(profile.proxy, current.proxy) || profile.proxy.password !== current.proxy.password) {
      throw new Error("启动检测期间代理配置已变更，请重新启动环境");
    }
    const updated = await this.profiles.setProxyCheck(profile.id, { ...result, checkedAt: (/* @__PURE__ */ new Date()).toISOString() });
    this.onChanged(updated);
    const error = proxyLaunchError(updated.proxyCheck, updated.fingerprint.proxyExitPolicy);
    if (error) throw new Error(error);
    if (updated.fingerprint.networkIdentityMode === "proxy" && updated.proxyCheck?.geoConfidence === "conflict" && !allowGeoConflict) {
      throw new Error(`${GEOIP_CONFLICT_CONFIRMATION_PREFIX} ${geoConflictLaunchQuestion(updated.proxyCheck.geoConflict ?? "GeoIP 数据源对代理地区判断不一致")}`);
    }
    if (updated.fingerprint.networkIdentityMode === "proxy" && !hasCompleteProxyIdentity(updated.proxyCheck, { allowGeoConflict })) {
      throw new Error("代理地理信息不完整，无法生成一致的时区、语言和地理位置；请重新检测或改用手动网络身份");
    }
    if (updated.proxyCheck?.geoConfidence === "conflict" && allowGeoConflict) {
      this.logger?.error("用户已确认在 GeoIP 数据源冲突下继续启动", {
        profileId: profile.id,
        geoConflict: updated.proxyCheck.geoConflict
      });
    }
    if (updated.proxyCheck?.exitChanged) {
      this.logger?.error("代理出口 IP 已变化但策略允许继续", { profileId: profile.id });
    }
    return updated;
  }
  async noteProxyBridgeFailure(id, error) {
    const running = this.processes.get(id);
    if (!running || running.expectedExit || running.proxyWarningIssued) return;
    const failureKind = classifyProxyFailure(error);
    if (failureKind === "unknown") return;
    const now = Date.now();
    running.proxyFailureTimes = running.proxyFailureTimes.filter((time) => now - time <= 6e4);
    running.proxyFailureTimes.push(now);
    if (failureKind !== "authentication" && running.proxyFailureTimes.length < 3) return;
    running.proxyWarningIssued = true;
    const message = failureKind === "authentication" ? "代理认证在运行期间失败，请检查账号或代理授权；浏览器会继续尝试重连" : "代理连接在 60 秒内连续失败，出口网络可能已断开；浏览器会继续尝试重连";
    this.logger?.error("浏览器代理桥运行异常", {
      profileId: id,
      failureKind,
      error: safeErrorText(error)
    });
    if (this.profiles.get(id).fingerprint.proxyExitPolicy === "block") {
      await this.quarantineProxyNetwork(id, message);
      return;
    }
    this.onChanged(await this.profiles.setRuntime(id, { status: "running", lastError: message }));
  }
  async noteProxyBridgeTraffic(id) {
    const running = this.processes.get(id);
    if (!running || running.proxyQuarantined || running.proxyIdentityMismatch) return;
    running.proxyFailureTimes = [];
    if (!running.proxyWarningIssued) return;
    running.proxyWarningIssued = false;
    this.logger?.info("浏览器代理桥已恢复传输", { profileId: id });
    this.onChanged(await this.profiles.setRuntime(id, { status: "running", lastError: void 0 }));
  }
  startProxyMonitor(id, proxy) {
    const running = this.processes.get(id);
    if (!running || running.proxyMonitor) return;
    running.proxyMonitor = setInterval(() => {
      void this.monitorProxyIdentity(id, proxy).catch((error) => {
        this.logger?.error("运行中代理出口复检失败", {
          profileId: id,
          error: safeErrorText(error)
        });
      });
    }, this.proxyMonitorIntervalMs);
    running.proxyMonitor.unref();
  }
  async monitorProxyIdentity(id, proxy) {
    const running = this.processes.get(id);
    if (!running || running.expectedExit || running.proxyMonitorRunning || running.proxyQuarantined) return;
    running.proxyMonitorRunning = true;
    try {
      const current = this.profiles.get(id);
      if (!sameProxyIdentity(proxy, current.proxy) || proxy.password !== current.proxy.password) return;
      const result = await this.proxyTester(proxy);
      const latest = this.profiles.get(id);
      if (!sameProxyIdentity(proxy, latest.proxy) || proxy.password !== latest.proxy.password) return;
      const updated = await this.profiles.setProxyCheck(
        id,
        { ...result, checkedAt: (/* @__PURE__ */ new Date()).toISOString() },
        running.proxyIdentityIp
      );
      this.onChanged(updated);
      if (!result.ok) {
        const message2 = `运行期间代理出口复检失败：${result.error ?? "无法连接代理"}`;
        if (updated.fingerprint.proxyExitPolicy === "block") {
          await this.quarantineProxyNetwork(id, message2);
          return;
        }
        await this.noteProxyBridgeFailure(id, new Error(result.error ?? result.failureKind ?? "代理出口复检失败"));
        return;
      }
      if (!updated.proxyCheck?.exitChanged) {
        if (running.proxyIdentityMismatch && result.ip === running.proxyIdentityIp) {
          running.proxyIdentityMismatch = false;
          running.proxyWarningIssued = false;
          this.onChanged(await this.profiles.setRuntime(id, { status: "running", lastError: void 0 }));
        }
        return;
      }
      running.proxyIdentityMismatch = true;
      const message = `运行期间代理出口已从 ${updated.proxyCheck.previousIp ?? "启动地址"} 变为 ${updated.proxyCheck.ip ?? "新地址"}，当前浏览器网络身份已不一致`;
      this.logger?.error("运行期间代理出口发生变化", { profileId: id });
      if (updated.fingerprint.proxyExitPolicy === "block") {
        await this.quarantineProxyNetwork(id, message);
      } else {
        running.proxyWarningIssued = true;
        this.onChanged(await this.profiles.setRuntime(id, { status: "running", lastError: message }));
      }
    } finally {
      running.proxyMonitorRunning = false;
    }
  }
  async quarantineProxyNetwork(id, reason) {
    const running = this.processes.get(id);
    if (!running || running.proxyQuarantined) return;
    running.proxyQuarantined = true;
    running.proxyWarningIssued = true;
    if (running.proxyMonitor) {
      clearInterval(running.proxyMonitor);
      running.proxyMonitor = void 0;
    }
    await closeProxyBridge(running.proxyUrl);
    const message = `${reason}；已停止该环境的代理网络以防止身份泄漏，请关闭并重新启动环境`;
    this.logger?.error("浏览器代理网络已隔离", { profileId: id, reason });
    this.onChanged(await this.profiles.setRuntime(id, { status: "running", lastError: message }));
  }
  async closeOrphan(id, pid) {
    this.onChanged(await this.profiles.setRuntime(id, { status: "stopping", lastError: void 0 }));
    try {
      await this.processInspector.terminate(pid, this.profiles.profileDataPath(id));
      this.orphanProcesses.delete(id);
      await rm(join(this.profiles.profileRuntimePath(id), "process.json"), { force: true });
      const profile = await this.profiles.setRuntime(id, { status: "closed", lastError: void 0 });
      this.onChanged(profile);
      this.logger?.info("遗留浏览器进程已结束", { profileId: id, pid });
      return profile;
    } catch (error) {
      const profile = await this.profiles.setRuntime(id, {
        status: "orphaned",
        lastError: error instanceof Error ? error.message : String(error)
      });
      this.onChanged(profile);
      throw error;
    }
  }
}
