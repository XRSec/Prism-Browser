import { access, constants } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { screen } from 'electron'
import type { Logger } from './app-logger'

export interface WindowSyncSettings {
  syncClicks: boolean
  syncTyping: boolean
  syncKeys: boolean
  syncScroll: boolean
  delayMinMs: number
  delayMaxMs: number
}

export interface WindowSyncStatus {
  state: 'stopped' | 'starting' | 'running' | 'error'
  message: string
  mainProfileId?: string
  followerProfileIds: string[]
  settings: WindowSyncSettings
  actionCount: number
  errorCount: number
  lastActionAt?: string
  startedAt?: string
  addressBarSync?: string
}

export interface WindowSyncStartOptions {
  mainProfileId?: string
  followerProfileIds?: string[]
  settings?: Partial<WindowSyncSettings>
}

export interface WindowArea {
  x: number
  y: number
  width: number
  height: number
}

export type WindowTileLayout = 'grid' | 'overlap'
export type CloseTabsMode = 'current' | 'others' | 'blank'
export type AddressBarSyncState = 'unavailable' | 'starting' | 'running' | 'error' | 'permission-required'

export interface WindowSyncAction {
  kind: 'click' | 'scroll' | 'key' | 'navigate' | 'openTab' | 'activateTab' | 'closeTab' | 'input'
  tabIndex?: number
  tabUrl?: string
  xRatio?: number
  yRatio?: number
  selector?: string
  button?: 'left' | 'middle' | 'right'
  clickCount?: number
  key?: string
  code?: string
  modifiers?: number
  url?: string
  value?: string
}

export interface AddressBarBridge {
  start(mainPID: number, followerPIDs: number[], onState: (state: AddressBarSyncState) => void): Promise<AddressBarSyncState>
  stop(): Promise<void>
}

interface Launcher {
  runningProfileIds(): string[]
  startWindowSyncCapture(profileId: string, onAction: (action: WindowSyncAction) => void): Promise<() => void>
  applyWindowSyncAction(profileId: string, action: WindowSyncAction): Promise<void>
  browserProcessId(profileId: string): number
  setBrowserWindowBounds(profileId: string, bounds: { left: number; top: number; width: number; height: number }): Promise<void>
  browserWindowBounds(profileId: string): Promise<{ left: number; top: number; width: number; height: number }>
  bringBrowserToFront(profileId: string): Promise<void>
  browserPageUrls(profileId: string): Promise<string[]>
  replaceBrowserTabs(profileId: string, urls: string[]): Promise<void>
  closeBrowserTabs(profileId: string, mode: CloseTabsMode): Promise<void>
  visitBrowser(profileId: string, url: string, newTab: boolean): Promise<void>
}

interface LicensingLike {
  status(): { plan: string }
}

const WINDOW_SYNC_BINDING = '__prismWindowSyncEvent'
const WINDOW_SYNC_WORLD = '__prismWindowSyncWorldV1'

export { WINDOW_SYNC_BINDING, WINDOW_SYNC_WORLD }

const DEFAULT_SETTINGS: WindowSyncSettings = {
  syncClicks: true,
  syncTyping: true,
  syncKeys: true,
  syncScroll: true,
  delayMinMs: 0,
  delayMaxMs: 120,
}

function delay(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizedSettings(value: Partial<WindowSyncSettings> | undefined): WindowSyncSettings {
  const min = Number(value?.delayMinMs)
  const max = Number(value?.delayMaxMs)
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || max > 5000) {
    throw new Error('同步延迟必须为 0 到 5000 毫秒，且最大值不能小于最小值')
  }
  return {
    syncClicks: value?.syncClicks !== false,
    syncTyping: value?.syncTyping !== false,
    syncKeys: value?.syncKeys !== false,
    syncScroll: value?.syncScroll !== false,
    delayMinMs: min,
    delayMaxMs: max,
  }
}

export function validWindowSyncAction(value: unknown): value is WindowSyncAction {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (v['tabIndex'] !== undefined && (!Number.isInteger(v['tabIndex']) || (v['tabIndex'] as number) < 0 || (v['tabIndex'] as number) > 1000)) return false
  if (v['tabUrl'] !== undefined && (typeof v['tabUrl'] !== 'string' || (v['tabUrl'] as string).length > 2048)) return false
  if (v['kind'] === 'click') return Number.isFinite(v['xRatio']) && (v['xRatio'] as number) >= 0 && (v['xRatio'] as number) <= 1 && Number.isFinite(v['yRatio']) && (v['yRatio'] as number) >= 0 && (v['yRatio'] as number) <= 1 && (v['selector'] === undefined || typeof v['selector'] === 'string' && (v['selector'] as string).length <= 2000) && ['left', 'middle', 'right'].includes(v['button'] as string) && Number.isInteger(v['clickCount'])
  if (v['kind'] === 'scroll') return Number.isFinite(v['xRatio']) && (v['xRatio'] as number) >= 0 && (v['xRatio'] as number) <= 1 && Number.isFinite(v['yRatio']) && (v['yRatio'] as number) >= 0 && (v['yRatio'] as number) <= 1 && (v['selector'] === undefined || typeof v['selector'] === 'string' && (v['selector'] as string).length <= 2000)
  if (v['kind'] === 'key') return typeof v['key'] === 'string' && (v['key'] as string).length <= 40 && typeof v['code'] === 'string' && (v['code'] as string).length <= 40 && Number.isInteger(v['modifiers'])
  if (v['kind'] === 'navigate' || v['kind'] === 'openTab') {
    if (v['url'] === 'about:blank') return true
    try { return typeof v['url'] === 'string' && new URL(v['url'] as string).protocol.startsWith('http') } catch { return false }
  }
  if (v['kind'] === 'activateTab') return true
  if (v['kind'] === 'closeTab') return true
  return v['kind'] === 'input' && typeof v['selector'] === 'string' && (v['selector'] as string).length <= 2000 && typeof v['value'] === 'string' && (v['value'] as string).length <= 16000
}

export class WindowSyncManager {
  private launcher: Launcher
  private licensing: LicensingLike
  private onChanged: (status: WindowSyncStatus) => void
  private logger?: Logger
  private platform: string
  private random: () => number
  private addressBarBridge?: AddressBarBridge

  private current: WindowSyncStatus = {
    state: 'stopped',
    message: '窗口同步尚未启动',
    followerProfileIds: [],
    settings: { ...DEFAULT_SETTINGS },
    actionCount: 0,
    errorCount: 0,
  }
  private disposeCapture?: () => void
  private generation = 0
  private queues = new Map<string, Promise<void>>()

  constructor(
    launcher: Launcher,
    licensing: LicensingLike,
    onChanged: (status: WindowSyncStatus) => void,
    logger?: Logger,
    platform = process.platform,
    random = Math.random,
    addressBarBridge?: AddressBarBridge,
  ) {
    this.launcher = launcher
    this.licensing = licensing
    this.onChanged = onChanged
    this.logger = logger
    this.platform = platform
    this.random = random
    this.addressBarBridge = addressBarBridge
  }

  status(): WindowSyncStatus {
    return { ...this.current, followerProfileIds: [...this.current.followerProfileIds], settings: { ...this.current.settings } }
  }

  async start(options: WindowSyncStartOptions): Promise<WindowSyncStatus> {
    this.requirePro()
    if (!['darwin', 'win32'].includes(this.platform)) throw new Error('当前系统暂不支持多窗口同步')
    const mainProfileId = String(options?.mainProfileId ?? '')
    const followerProfileIds = [...new Set((options?.followerProfileIds ?? []).map(String))].filter((id) => id && id !== mainProfileId)
    if (!mainProfileId || followerProfileIds.length < 1) throw new Error('请选择 1 个主控环境和至少 1 个受控环境')
    const running = new Set(this.launcher.runningProfileIds())
    const unavailable = [mainProfileId, ...followerProfileIds].filter((id) => !running.has(id))
    if (unavailable.length) throw new Error(`有 ${unavailable.length} 个环境尚未运行，请先打开后再开始同步`)
    const settings = normalizedSettings(options.settings)
    await this.stop()
    const generation = ++this.generation
    this.setStatus({
      state: 'starting',
      message: '正在连接主控窗口…',
      mainProfileId,
      followerProfileIds,
      settings,
      actionCount: 0,
      errorCount: 0,
    })
    try {
      this.disposeCapture = await this.launcher.startWindowSyncCapture(mainProfileId, (action) => {
        if (generation !== this.generation || !this.actionEnabled(action, settings)) return
        this.current.actionCount += 1
        this.current.lastActionAt = new Date().toISOString()
        for (const followerId of followerProfileIds) this.enqueue(followerId, action, settings, generation)
        this.changed()
      })
      if (this.addressBarBridge) {
        const bridgeState = await this.addressBarBridge.start(
          this.launcher.browserProcessId(mainProfileId),
          followerProfileIds.map((id) => this.launcher.browserProcessId(id)),
          (state) => this.updateBridgeState(state),
        )
        this.current.addressBarSync = bridgeState
      }
      this.setStatus({ ...this.current, state: 'running', message: `正在同步到 ${followerProfileIds.length} 个受控窗口`, startedAt: new Date().toISOString() })
      this.logger?.info('多窗口同步已启动', { mainProfileId, followerCount: followerProfileIds.length })
      return this.status()
    } catch (error) {
      this.disposeCapture?.()
      this.disposeCapture = undefined
      await this.addressBarBridge?.stop()
      this.setStatus({ ...this.current, state: 'error', message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async stop(): Promise<WindowSyncStatus> {
    this.generation += 1
    this.disposeCapture?.()
    this.disposeCapture = undefined
    await this.addressBarBridge?.stop()
    this.queues.clear()
    if (this.current.state !== 'stopped') this.logger?.info('多窗口同步已停止', { actionCount: this.current.actionCount, errorCount: this.current.errorCount })
    this.setStatus({
      state: 'stopped',
      message: '窗口同步已停止',
      followerProfileIds: [],
      settings: { ...this.current.settings },
      actionCount: this.current.actionCount,
      errorCount: this.current.errorCount,
      lastActionAt: this.current.lastActionAt,
    })
    return this.status()
  }

  async refreshEntitlement(): Promise<void> {
    if (this.licensing.status().plan !== 'pro' && this.current.state !== 'stopped') await this.stop()
  }

  async reconcileRunningProfiles(): Promise<void> {
    if (!['starting', 'running'].includes(this.current.state) || !this.current.mainProfileId) return
    const running = new Set(this.launcher.runningProfileIds())
    if (!running.has(this.current.mainProfileId)) {
      await this.stop()
      this.setStatus({ ...this.current, message: '主控窗口已关闭，同步已自动停止' })
      return
    }
    const followers = this.current.followerProfileIds.filter((id) => running.has(id))
    if (!followers.length) {
      await this.stop()
      this.setStatus({ ...this.current, message: '受控窗口均已关闭，同步已自动停止' })
      return
    }
    if (followers.length !== this.current.followerProfileIds.length) {
      this.setStatus({ ...this.current, followerProfileIds: followers, message: `已移除关闭的窗口，继续同步到 ${followers.length} 个受控窗口` })
      if (this.addressBarBridge) {
        const bridgeState = await this.addressBarBridge.start(
          this.launcher.browserProcessId(this.current.mainProfileId),
          followers.map((id) => this.launcher.browserProcessId(id)),
          (state) => this.updateBridgeState(state),
        )
        this.current.addressBarSync = bridgeState
        this.changed()
      }
    }
  }

  private async resolveWorkArea(ids: string[], area?: WindowArea): Promise<WindowArea> {
    if (area && area.width > 320 && area.height > 240) {
      return area
    }
    try {
      if (ids.length > 0) {
        const bounds = await this.launcher.browserWindowBounds(ids[0])
        if (bounds && bounds.width > 0 && bounds.height > 0) {
          const display = screen.getDisplayMatching({
            x: bounds.left ?? 0,
            y: bounds.top ?? 0,
            width: bounds.width,
            height: bounds.height
          })
          if (display?.workArea && display.workArea.width > 0 && display.workArea.height > 0) {
            return {
              x: display.workArea.x,
              y: display.workArea.y,
              width: display.workArea.width,
              height: display.workArea.height
            }
          }
        }
      }
    } catch {
      // ignore
    }
    try {
      const primary = screen.getPrimaryDisplay()
      if (primary?.workArea && primary.workArea.width > 0 && primary.workArea.height > 0) {
        return {
          x: primary.workArea.x,
          y: primary.workArea.y,
          width: primary.workArea.width,
          height: primary.workArea.height
        }
      }
    } catch {
      // ignore
    }
    return { x: 0, y: 0, width: 1440, height: 900 }
  }

  async tile(profileIds: string[], layout: WindowTileLayout, area: WindowArea, keepCurrentSize = false): Promise<void> {
    this.requirePro()
    const ids = this.runningIds(profileIds)
    if (ids.length < 2) throw new Error('至少选择 2 个正在运行的环境')
    const resolvedArea = await this.resolveWorkArea(ids, area)
    const gap = this.platform === 'win32' ? 0 : 10

    if (layout === 'overlap') {
      const width = Math.max(520, Math.floor(resolvedArea.width * 0.76))
      const height = Math.max(420, Math.floor(resolvedArea.height * 0.78))
      await Promise.all(ids.map((id, index) => this.launcher.setBrowserWindowBounds(id, {
        left: resolvedArea.x + gap + index * 28,
        top: resolvedArea.y + gap + index * 28,
        width,
        height,
      })))
      return
    }

    if (keepCurrentSize) {
      let targetWidth = 600
      let targetHeight = 450
      try {
        const mainBounds = await this.launcher.browserWindowBounds(ids[0])
        if (mainBounds && mainBounds.width > 0 && mainBounds.height > 0) {
          targetWidth = Math.max(320, mainBounds.width)
          targetHeight = Math.max(240, mainBounds.height)
        }
      } catch {
        // fallback
      }
      const maxColumns = Math.max(1, Math.floor((resolvedArea.width - gap) / (targetWidth + gap)))
      const columns = Math.min(ids.length, maxColumns)

      await Promise.all(ids.map((id, index) => {
        const col = index % columns
        const row = Math.floor(index / columns)
        return this.launcher.setBrowserWindowBounds(id, {
          left: resolvedArea.x + gap + col * (targetWidth + gap),
          top: resolvedArea.y + gap + row * (targetHeight + gap),
          width: targetWidth,
          height: targetHeight,
        })
      }))
      return
    }

    const columns = Math.ceil(Math.sqrt(ids.length))
    const rows = Math.ceil(ids.length / columns)
    const width = Math.max(320, Math.floor((resolvedArea.width - gap * (columns + 1)) / columns))
    const height = Math.max(240, Math.floor((resolvedArea.height - gap * (rows + 1)) / rows))
    await Promise.all(ids.map((id, index) => this.launcher.setBrowserWindowBounds(id, {
      left: resolvedArea.x + gap + index % columns * (width + gap),
      top: resolvedArea.y + gap + Math.floor(index / columns) * (height + gap),
      width,
      height,
    })))
  }

  async uniformSize(mainProfileId: string, followerProfileIds: string[]): Promise<void> {
    this.requirePro()
    const ids = this.runningIds([mainProfileId, ...followerProfileIds])
    if (!ids.includes(mainProfileId) || ids.length < 2) throw new Error('主控和受控环境必须处于运行状态')
    const main = await this.launcher.browserWindowBounds(mainProfileId)
    await Promise.all(ids.filter((id) => id !== mainProfileId).map(async (id) => {
      const current = await this.launcher.browserWindowBounds(id)
      await this.launcher.setBrowserWindowBounds(id, { ...current, width: main.width, height: main.height })
    }))
  }

  async bringToFront(profileIds: string[]): Promise<void> {
    this.requirePro()
    const ids = this.runningIds(profileIds)
    for (const id of [...ids].reverse()) await this.launcher.bringBrowserToFront(id)
  }

  async sameTabs(mainProfileId: string, followerProfileIds: string[]): Promise<void> {
    this.requirePro()
    const ids = this.runningIds([mainProfileId, ...followerProfileIds])
    if (!ids.includes(mainProfileId) || ids.length < 2) throw new Error('主控和受控环境必须处于运行状态')
    const urls = await this.launcher.browserPageUrls(mainProfileId)
    await Promise.all(ids.filter((id) => id !== mainProfileId).map((id) => this.launcher.replaceBrowserTabs(id, urls)))
  }

  async closeTabs(profileIds: string[], mode: CloseTabsMode): Promise<void> {
    this.requirePro()
    if (!['current', 'others', 'blank'].includes(mode)) throw new Error('标签页操作无效')
    const ids = this.runningIds(profileIds)
    if (!ids.length) throw new Error('请选择正在运行的环境')
    await Promise.all(ids.map((id) => this.launcher.closeBrowserTabs(id, mode)))
  }

  async visit(profileIds: string[], url: string, newTab: boolean): Promise<void> {
    this.requirePro()
    const ids = this.runningIds(profileIds)
    if (!ids.length) throw new Error('请选择正在运行的环境')
    await Promise.all(ids.map((id) => this.launcher.visitBrowser(id, url, newTab)))
  }

  private enqueue(profileId: string, action: WindowSyncAction, settings: WindowSyncSettings, generation: number): void {
    const previous = this.queues.get(profileId) ?? Promise.resolve()
    const actionDelay = action.kind === 'scroll' ? 0 : settings.delayMinMs + Math.floor(this.random() * (settings.delayMaxMs - settings.delayMinMs + 1))
    const dueAt = Date.now() + actionDelay
    const operation = previous.catch(() => undefined).then(async () => {
      await delay(Math.max(0, dueAt - Date.now()))
      if (generation !== this.generation) return
      await this.launcher.applyWindowSyncAction(profileId, action)
    }).catch((error) => {
      if (generation !== this.generation) return
      this.current.errorCount += 1
      this.current.message = `同步到部分窗口失败，已继续运行（累计 ${this.current.errorCount} 次）`
      this.logger?.error('受控窗口同步操作失败', { profileId, action: action.kind, error: error instanceof Error ? error.message : String(error) })
      this.changed()
    })
    this.queues.set(profileId, operation as Promise<void>)
    void operation.finally(() => {
      if (this.queues.get(profileId) === operation) this.queues.delete(profileId)
    })
  }

  private actionEnabled(action: WindowSyncAction, settings: WindowSyncSettings): boolean {
    if (action.kind === 'click') return settings.syncClicks
    if (action.kind === 'input') return settings.syncTyping
    if (action.kind === 'key') return settings.syncKeys
    if (action.kind === 'scroll') return settings.syncScroll
    return true
  }

  private runningIds(profileIds: string[]): string[] {
    const running = new Set(this.launcher.runningProfileIds())
    return [...new Set(profileIds.map(String))].filter((id) => running.has(id))
  }

  private requirePro(): void {
    if (this.licensing.status().plan !== 'pro') throw new Error('多窗口同步需要 Prism Pro 授权')
  }

  private setStatus(status: WindowSyncStatus): void {
    this.current = status
    this.changed()
  }

  private changed(): void {
    this.onChanged(this.status())
  }

  private updateBridgeState(state: string): void {
    if (!['starting', 'running'].includes(this.current.state)) return
    this.current.addressBarSync = state
    this.changed()
  }
}

export class MacWindowSyncBridge implements AddressBarBridge {
  private resourcesPath: string
  private logger?: Logger
  private helperPathOverride?: string
  private child?: ChildProcess
  private generation = 0

  constructor(resourcesPath: string, logger?: Logger, helperPathOverride?: string) {
    this.resourcesPath = resourcesPath
    this.logger = logger
    this.helperPathOverride = helperPathOverride
  }

  async start(mainPID: number, followerPIDs: number[], onState: (state: AddressBarSyncState) => void): Promise<AddressBarSyncState> {
    await this.stop()
    if (process.platform !== 'darwin') return 'unavailable'
    const followers = [...new Set(followerPIDs)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== mainPID)
    if (!Number.isInteger(mainPID) || mainPID <= 0 || !followers.length) return 'unavailable'
    const helper = this.helperPathOverride ?? join(this.resourcesPath, 'window-sync', 'prism-window-sync-helper')
    try {
      await new Promise<void>((resolve, reject) => access(helper, constants.X_OK, (err) => err ? reject(err) : resolve()))
    } catch {
      this.logger?.error('macOS 地址栏同步组件不可用', { helper })
      onState('unavailable')
      return 'unavailable'
    }
    onState('starting')
    const generation = ++this.generation
    const child = spawn(helper, ['--main-pid', String(mainPID), '--followers', followers.join(',')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: process.env['LANG'] ?? 'en_US.UTF-8' },
    })
    this.child = child
    let buffer = ''
    let state: AddressBarSyncState = 'starting'
    child.stdout!.on('data', (chunk: Buffer) => {
      if (generation !== this.generation || this.child !== child) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 64 * 1024) { child.kill('SIGKILL'); return }
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: { type: string }
        try { message = JSON.parse(line) } catch { continue }
        if (message.type === 'ready') { state = 'running'; onState(state) }
        else if (message.type === 'permission-required') { state = 'permission-required'; onState(state) }
        else if (message.type === 'error') { state = 'error'; onState(state) }
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => this.logger?.error('macOS 地址栏同步组件输出错误', { bytes: chunk.length }))
    child.once('error', (error) => {
      this.logger?.error('macOS 地址栏同步组件启动失败', error)
      if (generation === this.generation && this.child === child) onState('error')
    })
    child.once('exit', (code) => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (code !== 0 && state !== 'permission-required') onState('error')
    })
    await new Promise((resolve) => setTimeout(resolve, 120))
    return state
  }

  async stop(): Promise<void> {
    this.generation += 1
    const child = this.child
    if (!child) return
    this.child = undefined
    child.kill('SIGTERM')
  }
}

export class WindowsWindowSyncBridge implements AddressBarBridge {
  private resourcesPath: string
  private logger?: Logger
  private helperPathOverride?: string
  private child?: ChildProcess
  private generation = 0

  constructor(resourcesPath: string, logger?: Logger, helperPathOverride?: string) {
    this.resourcesPath = resourcesPath
    this.logger = logger
    this.helperPathOverride = helperPathOverride
  }

  async start(mainPID: number, followerPIDs: number[], onState: (state: AddressBarSyncState) => void): Promise<AddressBarSyncState> {
    await this.stop()
    if (process.platform !== 'win32' && !this.helperPathOverride) return 'unavailable'
    const followers = [...new Set(followerPIDs)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== mainPID)
    if (!Number.isInteger(mainPID) || mainPID <= 0 || !followers.length) return 'unavailable'
    const helper = this.helperPathOverride ?? join(this.resourcesPath, 'window-sync', 'prism-window-sync-helper.exe')
    try {
      await new Promise<void>((resolve, reject) => access(helper, constants.F_OK, (err) => err ? reject(err) : resolve()))
    } catch {
      this.logger?.error('Windows 地址栏同步组件不可用', { helper })
      onState('unavailable')
      return 'unavailable'
    }
    onState('starting')
    const generation = ++this.generation
    const child = spawn(helper, ['--main-pid', String(mainPID), '--followers', followers.join(',')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    let buffer = ''
    let state: AddressBarSyncState = 'starting'
    child.stdout!.on('data', (chunk: Buffer) => {
      if (generation !== this.generation || this.child !== child) return
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > 64 * 1024) { child.kill(); return }
      for (;;) {
        const end = buffer.indexOf('\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: { type: string }
        try { message = JSON.parse(line) } catch { continue }
        if (message.type === 'ready') { state = 'running'; onState(state) }
        else if (message.type === 'error') { state = 'error'; onState(state) }
      }
    })
    child.stderr!.on('data', (chunk: Buffer) => this.logger?.error('Windows 地址栏同步组件输出错误', { bytes: chunk.length }))
    child.once('error', (error) => {
      this.logger?.error('Windows 地址栏同步组件启动失败', error)
      if (generation === this.generation && this.child === child) onState('error')
    })
    child.once('exit', (code) => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (code !== 0) onState('error')
    })
    await new Promise((resolve) => setTimeout(resolve, 180))
    return state
  }

  async stop(): Promise<void> {
    this.generation += 1
    const child = this.child
    if (!child) return
    this.child = undefined
    child.kill()
  }
}
