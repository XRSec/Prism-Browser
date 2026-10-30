import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AutomationStartResult, AutomationStatus, BrowserProfile, McpConnection, McpStatus } from '../shared/types'
import type { Logger } from './app-logger'
import type { AutomationAuditLog } from './automation-audit'
import type { BrowserLauncher } from './browser-launcher'
import type { ProAgentChallenge, ProAgentHandshake } from './license-manager'
import type { ProfileCreationService } from './profile-creation-service'
import type { ProfileStore } from './profile-store'
import { verifyProAgentBundle, type OsSignatureVerifier } from './pro-agent-integrity'

interface ProAgentLicenseAuthority {
  has(entitlement: 'automation-api' | 'mcp'): boolean
  proAgentReleasePublicKey(): Promise<string>
  createProAgentHandshake(challenge: ProAgentChallenge): Promise<ProAgentHandshake>
}

interface AgentMessage {
  type?: string
  id?: string
  method?: string
  params?: Record<string, unknown>
  challenge?: ProAgentChallenge
  endpoint?: string
  accessToken?: string
  mcpAccessToken?: string
  agentVersion?: string
}

type BundleVerifier = typeof verifyProAgentBundle
type SpawnAgent = typeof spawn

interface McpRequestBroker {
  handleAgentRequest(method: string, params: Record<string, unknown> | undefined, requestId: string): Promise<unknown>
  status(agentRunning?: boolean): McpStatus
  resetSessions(): void
  canStart?(): boolean
}

function protocolError(error: unknown) {
  const candidate = error as {
    code?: unknown
    retryable?: unknown
    suggestedTool?: unknown
    details?: Array<{ path?: unknown; message?: unknown }>
  }
  const details = Array.isArray(candidate?.details)
    ? candidate.details
        .filter((item): item is { path: string; message: string } => typeof item?.path === 'string' && typeof item?.message === 'string')
        .slice(0, 20)
        .map((item) => ({ path: item.path.slice(0, 200), message: item.message.slice(0, 300) }))
    : []
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'MCP_REQUEST_FAILED',
    message: error instanceof Error ? error.message : 'mcp_request_failed',
    retryable: candidate?.retryable === true,
    ...(typeof candidate?.suggestedTool === 'string' ? { suggestedTool: candidate.suggestedTool } : {}),
    ...(details.length ? { details } : {})
  }
}

function publicAutomationProfile(profile: BrowserProfile) {
  return {
    id: profile.id,
    serialNumber: profile.serialNumber,
    name: profile.name,
    group: profile.group,
    tags: [...profile.tags],
    status: profile.status,
    lastOpenedAt: profile.lastOpenedAt
  }
}

function validProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value)
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Prism Pro Agent 返回的 API 地址无效')
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('Prism Pro Agent 必须只监听 127.0.0.1')
  return url.toString().replace(/\/$/, '')
}

function agentEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows',
      WINDIR: process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? ''
    }
  }
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8'
  }
}

export class ProAgentManager {
  private current: AutomationStatus = { state: 'stopped', message: '本地自动化 API 未启动', controlledProfileIds: [] }
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<AutomationStartResult> | null = null
  private controlled = new Set<string>()
  private expectedStop = false
  private mcpBroker?: McpRequestBroker
  private profileCreator?: ProfileCreationService
  private mcpAccessToken = ''
  private agentExecutable = ''
  private readonly instanceId = randomUUID()
  private recoveryTimer?: NodeJS.Timeout
  private recoveryAttempts = 0
  private readonly runtimeDirectory: string

  constructor(
    private readonly profiles: ProfileStore,
    private readonly launcher: BrowserLauncher,
    private readonly licensing: ProAgentLicenseAuthority,
    private readonly audit: AutomationAuditLog,
    private readonly resourcesPath: string,
    private readonly onChanged: (status: AutomationStatus) => void,
    private readonly logger?: Logger,
    private readonly manifestPathOverride?: string,
    private readonly verifyBundle: BundleVerifier = verifyProAgentBundle,
    private readonly spawnAgent: SpawnAgent = spawn,
    private readonly verifyOsSignature?: OsSignatureVerifier,
    runtimeDirectory?: string
  ) {
    this.runtimeDirectory = runtimeDirectory ?? join(resourcesPath, 'runtime')
  }

  setProfileCreator(creator: ProfileCreationService): void {
    this.profileCreator = creator
  }

  status(): AutomationStatus {
    return { ...this.current, controlledProfileIds: [...this.controlled] }
  }

  attachMcpBroker(broker: McpRequestBroker): void {
    this.mcpBroker = broker
  }

  async mcpConnection(): Promise<McpConnection> {
    if (!this.mcpBroker) throw new Error('MCP 控制器尚未就绪')
    if (this.mcpBroker.status().policy?.enabled === false) throw new Error('MCP 全局开关已关闭')
    await this.ensureStarted()
    if (!this.mcpAccessToken || !this.agentExecutable) throw new Error('Prism Pro Agent 未返回 MCP 会话凭据')
    return {
      ...this.mcpBroker.status(true),
      command: this.agentExecutable,
      args: ['--mcp'],
      env: {}
    }
  }

  async ensureStarted(): Promise<AutomationStartResult> {
    if (this.current.state === 'running') return { ...this.status(), accessToken: '' }
    if (this.starting) return this.starting
    return this.start()
  }

  async start(): Promise<AutomationStartResult> {
    if (this.current.state === 'running') throw new Error('本地自动化 API 已经在运行；如需新令牌，请先停止后重新启动')
    if (this.starting) return this.starting
    this.starting = this.startInternal()
    try { return await this.starting } finally { this.starting = null }
  }

  private async startInternal(): Promise<AutomationStartResult> {
    this.setStatus({ state: 'starting', message: '正在启动本地自动化 API', controlledProfileIds: [] })
    try {
      const manifestPath = this.manifestPathOverride ?? join(this.resourcesPath, 'pro-agent', 'manifest.json')
      const releasePublicKey = await this.licensing.proAgentReleasePublicKey()
      const bundle = await this.verifyBundle({ manifestPath, releasePublicKey, verifyOsSignature: this.verifyOsSignature })
      const child = this.spawnAgent(bundle.executablePath, ['--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: agentEnvironment()
      }) as ChildProcessWithoutNullStreams
      this.child = child
      this.expectedStop = false
      child.stdin.on('error', (error) => {
        if (this.child !== child) return
        this.logger?.error('Prism Pro Agent 通信管道已断开', error)
        this.mcpBroker?.resetSessions()
        this.mcpAccessToken = ''
        void this.removeConnectionState()
        if (!this.expectedStop) {
          this.setStatus({
            state: 'error',
            message: '本地自动化通信中断，请重新启动 MCP 会话',
            controlledProfileIds: [...this.controlled]
          })
        }
        if (!child.killed) child.kill('SIGKILL')
      })
      let buffer = ''
      let handshakeSent = false
      const result = await new Promise<AutomationStartResult>((resolvePromise, reject) => {
        let settled = false
        let messageQueue = Promise.resolve()
        const timer = setTimeout(() => fail(new Error('Prism Pro Agent 启动超时')), 15_000)
        const fail = (error: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(error)
        }
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          if (Buffer.byteLength(buffer) > 256 * 1024) {
            fail(new Error('Prism Pro Agent 输出超出安全限制'))
            return
          }
          for (;;) {
            const lineEnd = buffer.indexOf('\n')
            if (lineEnd < 0) break
            const line = buffer.slice(0, lineEnd)
            buffer = buffer.slice(lineEnd + 1)
            if (!line.trim()) continue
            let message: AgentMessage
            try { message = JSON.parse(line) as AgentMessage } catch { fail(new Error('Prism Pro Agent 协议消息无效')); return }
            messageQueue = messageQueue.then(async () => {
              const handled = await this.handleMessage(message, bundle.manifest.payload.version, handshakeSent)
              if (handled.handshake) handshakeSent = true
              if (!handled.ready || settled) return
              settled = true
              clearTimeout(timer)
              const startedAt = new Date().toISOString()
              this.setStatus({
                state: 'running',
                message: '本地自动化 API 仅监听当前设备',
                endpoint: handled.ready.endpoint,
                agentVersion: bundle.manifest.payload.version,
                startedAt,
                controlledProfileIds: []
              })
              this.mcpAccessToken = handled.ready.mcpAccessToken
              this.agentExecutable = bundle.executablePath
              await this.writeConnectionState(handled.ready.endpoint, handled.ready.mcpAccessToken)
              this.recoveryAttempts = 0
              this.audit.record({ action: 'agent-start', outcome: 'success' })
              resolvePromise({ ...this.status(), accessToken: handled.ready.accessToken })
            }).catch(fail)
          }
        })
        child.stderr.on('data', (chunk: Buffer) => {
          this.logger?.error('Prism Pro Agent 写入了 stderr', {
            bytes: chunk.length,
            output: chunk.subarray(0, 4096).toString('utf8').trim()
          })
        })
        child.once('error', (error) => fail(error))
        child.once('exit', (code, signal) => {
          this.child = null
          if (!settled) fail(new Error(`Prism Pro Agent 在就绪前退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`))
          this.mcpBroker?.resetSessions()
          this.mcpAccessToken = ''
          void this.removeConnectionState()
          if (this.expectedStop) {
            this.setStatus({ state: 'stopped', message: '本地自动化 API 已停止', controlledProfileIds: [] })
          } else {
            this.setStatus({ state: 'error', message: '本地自动化 API 意外停止，正在自动恢复', controlledProfileIds: [...this.controlled] })
            this.scheduleRecovery()
          }
        })
      })
      return result
    } catch (error) {
      this.child?.kill('SIGKILL')
      this.child = null
      this.audit.record({ action: 'agent-start', outcome: 'failure', detail: error instanceof Error ? error.message : String(error) })
      this.setStatus({ state: 'error', message: '本地自动化 API 启动失败，请重试', controlledProfileIds: [] })
      throw error
    }
  }

  private async handleMessage(message: AgentMessage, expectedVersion: string, handshakeSent: boolean): Promise<{
    handshake?: true
    ready?: { endpoint: string; accessToken: string; mcpAccessToken: string }
  }> {
    if (message.type === 'challenge') {
      if (handshakeSent || !message.challenge || message.challenge.agentVersion !== expectedVersion) throw new Error('Prism Pro Agent 握手挑战无效')
      this.write({ type: 'handshake', handshake: await this.licensing.createProAgentHandshake(message.challenge) })
      return { handshake: true }
    }
    if (message.type === 'ready') {
      if (!handshakeSent || message.agentVersion !== expectedVersion || typeof message.accessToken !== 'string'
        || !/^[A-Za-z0-9_-]{43,128}$/.test(message.accessToken) || typeof message.mcpAccessToken !== 'string'
        || !/^[A-Za-z0-9_-]{43,128}$/.test(message.mcpAccessToken)
        || message.mcpAccessToken === message.accessToken) throw new Error('Prism Pro Agent 就绪消息无效')
      return { ready: { endpoint: validateEndpoint(message.endpoint), accessToken: message.accessToken, mcpAccessToken: message.mcpAccessToken } }
    }
    if (message.type === 'request') {
      if (!handshakeSent) throw new Error('Prism Pro Agent 尚未完成授权握手')
      await this.handleRequest(message)
      return {}
    }
    throw new Error('Prism Pro Agent 发送了未知协议消息')
  }

  private async handleRequest(message: AgentMessage): Promise<void> {
    const id = typeof message.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(message.id) ? message.id : randomUUID()
    const method = message.method
    const profileId = message.params?.profileId
    if (method === 'agent.restart') {
      if (this.mcpBroker?.status().policy?.enabled === false) {
        this.write({ type: 'response', id, error: { code: 'MCP_GLOBAL_DISABLED', message: 'MCP is disabled by the user', retryable: false } })
        return
      }
      this.write({ type: 'response', id, result: { accepted: true, state: 'restarting' } })
      setTimeout(() => void this.restartService().catch((error) => this.logger?.error('自动重启本地 AI 服务失败', error)), 100)
      return
    }
    if (method?.startsWith('mcp.')) {
      if (!this.mcpBroker) {
        this.write({ type: 'response', id, error: 'mcp_not_available' })
        return
      }
      try {
        const result = await this.mcpBroker.handleAgentRequest(method, message.params, id)
        this.write({ type: 'response', id, result })
      } catch (error) {
        this.write({ type: 'response', id, error: protocolError(error) })
      }
      return
    }
    const action = method === 'profiles.create' ? 'profile-create'
      : method === 'profiles.createBatch' ? 'profiles-create-batch'
        : method === 'profiles.list' ? 'profiles-list'
          : method === 'profiles.status' ? 'profile-status'
            : method === 'profiles.launch' ? 'profile-launch'
              : method === 'profiles.close' ? 'profile-close' : null
    if (!action) {
      this.write({ type: 'response', id, error: 'method_not_allowed' })
      return
    }
    try {
      this.audit.record({ action, outcome: 'allowed', requestId: id, profileId: validProfileId(profileId) ? profileId : undefined })
      let result: unknown
      let createdIds: string[] | undefined
      if (method === 'profiles.create' || method === 'profiles.createBatch') {
        if (!this.profileCreator) throw new Error('Profile creation is unavailable')
        const created = await this.profileCreator.create(
          message.params?.input,
          method.endsWith('createBatch'),
          'api',
          () => undefined
        )
        createdIds = created.map((profile) => profile.id)
        const items = created.map(publicAutomationProfile)
        result = method.endsWith('createBatch') ? { profiles: items, count: items.length } : items[0]
      } else if (method === 'profiles.list') {
        result = this.profiles.list().map(publicAutomationProfile)
      } else {
        if (!validProfileId(profileId)) throw new Error('环境 ID 无效')
        if (method === 'profiles.status') result = publicAutomationProfile(this.profiles.get(profileId))
        else if (method === 'profiles.launch') {
          result = publicAutomationProfile(await this.launcher.launch(profileId))
          this.controlled.add(profileId)
          this.notifyCurrent()
        } else {
          result = publicAutomationProfile(await this.launcher.close(profileId))
          this.controlled.delete(profileId)
          this.notifyCurrent()
        }
      }
      this.audit.record({
        action,
        outcome: 'success',
        requestId: id,
        profileId: validProfileId(profileId) ? profileId : undefined,
        profileIds: createdIds
      })
      this.write({ type: 'response', id, result })
    } catch (error) {
      this.audit.record({
        action,
        outcome: 'failure',
        requestId: id,
        profileId: validProfileId(profileId) ? profileId : undefined,
        detail: error instanceof Error ? error.message : String(error)
      })
      this.write({ type: 'response', id, error: protocolError(error) })
    }
  }

  async stop(emergency = false): Promise<AutomationStatus> {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    this.recoveryAttempts = 0
    const child = this.child
    this.expectedStop = true
    if (child) {
      let stopSent = false
      try {
        this.write({ type: 'stop', emergency })
        stopSent = true
      } catch (error) {
        this.logger?.error('停止 Prism Pro Agent 时通信通道已不可用', error)
      }
      if (stopSent) {
        const exited = await new Promise<boolean>((resolvePromise) => {
          const timer = setTimeout(() => resolvePromise(false), 2_000)
          child.once('exit', () => { clearTimeout(timer); resolvePromise(true) })
        })
        if (!exited) child.kill('SIGKILL')
      } else if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
    if (emergency) {
      await Promise.allSettled([...this.controlled].map((id) => this.launcher.close(id)))
      this.audit.record({ action: 'emergency-stop', outcome: 'success' })
    } else this.audit.record({ action: 'agent-stop', outcome: 'success' })
    this.controlled.clear()
    this.mcpAccessToken = ''
    this.agentExecutable = ''
    await this.removeConnectionState()
    this.mcpBroker?.resetSessions()
    this.child = null
    this.setStatus({ state: 'stopped', message: emergency ? '自动化已紧急停止，相关浏览器已关闭' : '本地自动化 API 已停止', controlledProfileIds: [] })
    return this.status()
  }

  async restartService(): Promise<AutomationStartResult> {
    await this.stop(false)
    return this.ensureStarted()
  }

  connectionStatePath(): string {
    return join(this.runtimeDirectory, 'mcp-connection.json')
  }

  autoStartSuppressionPath(): string {
    return join(this.runtimeDirectory, 'mcp-user-quit.json')
  }

  async clearAutoStartSuppression(): Promise<void> {
    await rm(this.autoStartSuppressionPath(), { force: true }).catch(() => undefined)
  }

  suppressAutoStartSync(): void {
    mkdirSync(this.runtimeDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(this.runtimeDirectory, 0o700)
    const path = this.autoStartSuppressionPath()
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify({
        schemaVersion: 1,
        reason: 'user-quit',
        appPid: process.pid,
        createdAt: new Date().toISOString()
      }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      if (process.platform !== 'win32') chmodSync(temporary, 0o600)
      renameSync(temporary, path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    }
  }

  async suppressAutoStart(): Promise<void> {
    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.runtimeDirectory, 0o700)
    const path = this.autoStartSuppressionPath()
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({
      schemaVersion: 1,
      reason: 'user-quit',
      appPid: process.pid,
      createdAt: new Date().toISOString()
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, path)
  }

  private async writeConnectionState(endpoint: string, token: string): Promise<void> {
    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') await chmod(this.runtimeDirectory, 0o700)
    const path = this.connectionStatePath()
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    const payload = JSON.stringify({
      schemaVersion: 1,
      instanceId: this.instanceId,
      pid: process.pid,
      endpoint,
      token,
      updatedAt: new Date().toISOString()
    })
    await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, path)
  }

  private async removeConnectionState(): Promise<void> {
    const path = this.connectionStatePath()
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as { instanceId?: string }
      if (current.instanceId !== this.instanceId) return
    } catch {
      return
    }
    await rm(path, { force: true }).catch(() => undefined)
  }

  private scheduleRecovery(): void {
    if (this.expectedStop || this.recoveryTimer || this.recoveryAttempts >= 4) return
    if (this.mcpBroker?.canStart && !this.mcpBroker.canStart()) return
    const delays = [300, 1000, 3000, 7000]
    const delay = delays[this.recoveryAttempts++] ?? 7000
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      void this.ensureStarted().catch((error) => {
        this.logger?.error('本地 AI 服务自动恢复失败', error)
        this.scheduleRecovery()
      })
    }, delay)
  }

  private write(value: unknown): void {
    const child = this.child
    if (!child?.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error('Prism Pro Agent 通道不可用')
    }
    try {
      child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error && this.child === child) this.logger?.error('Prism Pro Agent 消息发送失败', error)
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
        this.logger?.error('Prism Pro Agent 消息发送失败', error)
        return
      }
      throw error
    }
  }

  private notifyCurrent(): void { this.onChanged(this.status()) }
  private setStatus(status: AutomationStatus): void { this.current = status; this.notifyCurrent() }
}
