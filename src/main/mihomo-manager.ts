import { ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { MihomoConfigSummary, MihomoStartOptions, MihomoStatus } from '../shared/types'

export function expandHome(filepath: string): string {
  if (!filepath) return ''
  const trimmed = filepath.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(homedir(), trimmed.slice(2))
  }
  return resolve(trimmed)
}

export async function findDefaultMihomoBinary(): Promise<string> {
  const isWin = platform() === 'win32'
  const candidates: string[] = isWin
    ? [
        join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'mihomo.exe'),
        join(process.env['ProgramFiles'] || 'C:\\Program Files', 'mihomo', 'mihomo.exe'),
        join(homedir(), 'scoop', 'shims', 'mihomo.exe'),
        'mihomo.exe'
      ]
    : [
        '/opt/homebrew/bin/mihomo',
        '/usr/local/bin/mihomo',
        join(homedir(), '.local', 'bin', 'mihomo'),
        '/usr/bin/mihomo',
        'mihomo'
      ]

  for (const candidate of candidates) {
    if (!candidate.includes('/') && !candidate.includes('\\')) continue
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // not available at candidate path
    }
  }

  return isWin ? 'mihomo.exe' : '/opt/homebrew/bin/mihomo'
}

export function parseMihomoConfigContent(content: string): MihomoConfigSummary {
  const mixedPortMatch = content.match(/^mixed-port:\s*(\d+)/m)
  const portMatch = content.match(/^port:\s*(\d+)/m)
  const controllerMatch = content.match(/^external-controller:\s*["']?([^"'\r\n]+)["']?/m)
  const secretMatch = content.match(/^secret:\s*["']?([^"'\r\n]*)["']?/m)

  const userMatches = [...content.matchAll(/^\s*-\s*["']?([a-zA-Z0-9_\-]+:[^"'\r\n]+)["']?/gm)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('MATCH') && !u.startsWith('IN-USER'))

  let prefix = 'node-'
  let password = 'prism'
  if (userMatches.length > 0) {
    const first = userMatches[0]
    const idx = first.indexOf(':')
    if (idx !== -1) {
      const u = first.slice(0, idx)
      const p = first.slice(idx + 1)
      if (p) password = p
      const prefixMatch = u.match(/^([a-zA-Z_-]+)/)
      if (prefixMatch) prefix = prefixMatch[1]
    }
  }

  return {
    content,
    port: mixedPortMatch ? Number(mixedPortMatch[1]) : portMatch ? Number(portMatch[1]) : 17890,
    externalController: controllerMatch ? controllerMatch[1].trim() : '127.0.0.1:9090',
    secret: secretMatch ? secretMatch[1].trim() : '',
    userCount: userMatches.length > 0 ? userMatches.length : 10,
    prefix,
    password
  }
}

export class MihomoManager {
  private child: ChildProcess | null = null
  private readonly workDir: string
  private readonly serviceConfigPath: string
  private binaryPath: string = ''
  private configPath: string = ''
  private autoStart: boolean = false
  private startedAt?: string
  private lastError?: string
  private logs: string[] = []
  private statusNotifyTimer: NodeJS.Timeout | null = null
  private readonly onStatusChange?: (status: MihomoStatus) => void

  constructor(vaultPath: string, onStatusChange?: (status: MihomoStatus) => void) {
    this.workDir = join(vaultPath, 'mihomo')
    this.serviceConfigPath = join(this.workDir, 'service.json')
    this.onStatusChange = onStatusChange
  }

  async initialize(): Promise<void> {
    await mkdir(this.workDir, { recursive: true })
    try {
      const raw = await readFile(this.serviceConfigPath, 'utf8')
      const parsed = JSON.parse(raw) as { binaryPath?: string; configPath?: string; autoStart?: boolean }
      if (typeof parsed.binaryPath === 'string' && parsed.binaryPath.trim()) {
        this.binaryPath = parsed.binaryPath.trim()
      }
      if (typeof parsed.configPath === 'string' && parsed.configPath.trim()) {
        this.configPath = parsed.configPath.trim()
      }
      if (typeof parsed.autoStart === 'boolean') {
        this.autoStart = parsed.autoStart
      }
    } catch {
      // no existing service config
    }

    if (!this.binaryPath) {
      this.binaryPath = await findDefaultMihomoBinary()
    }
    if (!this.configPath) {
      this.configPath = join(this.workDir, 'config.yaml')
    }

    const defaultConfigFile = join(this.workDir, 'config.yaml')
    try {
      await stat(defaultConfigFile)
    } catch {
      // 预先自动创建初始默认配置，杜绝首次启动报错“文件不存在”
      await writeFile(defaultConfigFile, this.generateDefaultConfig(), 'utf8')
    }
  }

  generateDefaultConfig(): string {
    return `# === Prism Browser Mihomo 本地多环境分流配置 ===
mixed-port: 17890
allow-lan: false
bind-address: 127.0.0.1
external-controller: 127.0.0.1:9090
external-ui: ui
external-ui-url: "https://github.com/Zephyruso/zashboard/releases/latest/download/dist-cdn-fonts.zip"

# 1. 本地入站凭据池 (环境分流标签)
users:
  - "node-0001:prism"
  - "node-0002:prism"
  - "node-0003:prism"

# 2. 定向分流规则 (IN-USER 规则)
rules:
  # 示例: - IN-USER,node-0001,指定节点名称
  - MATCH,DIRECT
`
  }

  private async saveServiceConfig(): Promise<void> {
    try {
      await mkdir(this.workDir, { recursive: true })
      await writeFile(
        this.serviceConfigPath,
        JSON.stringify({ binaryPath: this.binaryPath, configPath: this.configPath, autoStart: this.autoStart }, null, 2),
        'utf8'
      )
    } catch {
      // ignore write error
    }
  }

  async setAutoStart(autoStart: boolean): Promise<MihomoStatus> {
    this.autoStart = autoStart
    await this.saveServiceConfig()
    this.notifyStatusImmediate()
    return this.getStatus()
  }

  async saveConfigFile(content: string, customPath?: string): Promise<string> {
    await mkdir(this.workDir, { recursive: true })
    const targetPath = customPath ? expandHome(customPath) : join(this.workDir, 'config.yaml')
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content, 'utf8')
    this.configPath = targetPath
    await this.saveServiceConfig()
    this.appendLog(`[Prism] 已保存配置文件至: ${targetPath}`)
    this.notifyStatusImmediate()
    return targetPath
  }

  async readConfig(customPath?: string): Promise<MihomoConfigSummary> {
    const targetPath = customPath ? expandHome(customPath) : expandHome(this.configPath)
    try {
      const content = await readFile(targetPath, 'utf8')
      return parseMihomoConfigContent(content)
    } catch {
      const defaultContent = this.generateDefaultConfig()
      return parseMihomoConfigContent(defaultContent)
    }
  }

  getStatus(): MihomoStatus {
    const isRunning = Boolean(this.child && !this.child.killed && this.child.pid)
    return {
      running: isRunning,
      pid: isRunning ? this.child?.pid : undefined,
      startedAt: this.startedAt,
      binaryPath: this.binaryPath,
      configPath: this.configPath,
      autoStart: this.autoStart,
      error: this.lastError,
      recentLogs: [...this.logs]
    }
  }

  getLogs(): string[] {
    return [...this.logs]
  }

  private appendLog(line: string): void {
    const timestamp = new Date().toLocaleTimeString()
    const formatted = `[${timestamp}] ${line}`
    this.logs.push(formatted)
    if (this.logs.length > 250) {
      this.logs.shift()
    }
  }

  private notifyStatus(): void {
    if (!this.onStatusChange) return
    if (this.statusNotifyTimer) return
    this.statusNotifyTimer = setTimeout(() => {
      this.statusNotifyTimer = null
      this.onStatusChange?.(this.getStatus())
    }, 100)
  }

  private notifyStatusImmediate(): void {
    if (this.statusNotifyTimer) {
      clearTimeout(this.statusNotifyTimer)
      this.statusNotifyTimer = null
    }
    this.onStatusChange?.(this.getStatus())
  }

  async start(options?: MihomoStartOptions): Promise<MihomoStatus> {
    if (this.child && !this.child.killed) {
      await this.stop()
    }

    if (options?.binaryPath?.trim()) {
      this.binaryPath = options.binaryPath.trim()
    }
    if (options?.configPath?.trim()) {
      this.configPath = options.configPath.trim()
    }

    await this.saveServiceConfig()

    const resolvedBinary = expandHome(this.binaryPath)
    const resolvedConfig = expandHome(this.configPath)

    try {
      await access(resolvedBinary, constants.X_OK)
    } catch {
      const err = `Mihomo 二进制文件不存在或无执行权限: ${resolvedBinary}。请检查路径或安装 mihomo。`
      this.lastError = err
      this.appendLog(`[Prism 错误] ${err}`)
      this.notifyStatusImmediate()
      throw new Error(err)
    }

    try {
      await stat(resolvedConfig)
    } catch {
      // 若配置文件不存在，自动为其创建初始配置模版，避免启动中断
      await mkdir(dirname(resolvedConfig), { recursive: true })
      await writeFile(resolvedConfig, this.generateDefaultConfig(), 'utf8')
      this.appendLog(`[Prism] 配置文件不存在，已自动创建初始模版: ${resolvedConfig}`)
    }

    await mkdir(this.workDir, { recursive: true })
    this.lastError = undefined
    this.appendLog(`[Prism] 正在启动 Mihomo: ${resolvedBinary} -d "${this.workDir}" -f "${resolvedConfig}"`)

    try {
      const child = spawn(resolvedBinary, ['-d', this.workDir, '-f', resolvedConfig], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      })

      this.child = child
      this.startedAt = new Date().toISOString()

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        const lines = text.split(/\r?\n/).filter(Boolean)
        for (const line of lines) {
          this.appendLog(line)
          if (line.includes('level=fatal') || line.includes('level=error') || line.includes('Parse config error')) {
            const match = line.match(/msg="([^"]+)"/)
            this.lastError = match ? match[1] : line
          }
        }
        this.notifyStatus()
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        const lines = text.split(/\r?\n/).filter(Boolean)
        for (const line of lines) {
          this.appendLog(`[STDERR] ${line}`)
          if (line.includes('level=fatal') || line.includes('level=error') || line.includes('Parse config error')) {
            const match = line.match(/msg="([^"]+)"/)
            this.lastError = match ? match[1] : line
          }
        }
        this.notifyStatus()
      })

      child.on('error', (err) => {
        this.lastError = `启动失败: ${err.message}`
        this.appendLog(`[Prism 错误] ${this.lastError}`)
        this.child = null
        this.startedAt = undefined
        this.notifyStatusImmediate()
      })

      child.on('exit', (code, signal) => {
        this.appendLog(`[Prism] Mihomo 进程退出 (code: ${code}, signal: ${signal})`)
        if (code !== 0 && code !== null) {
          if (!this.lastError) {
            this.lastError = `Mihomo 异常退出 (退出码: ${code})`
          }
        }
        this.child = null
        this.startedAt = undefined
        this.notifyStatusImmediate()
      })

      this.notifyStatusImmediate()
      return this.getStatus()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.lastError = msg
      this.appendLog(`[Prism 异常] 无法启动进程: ${msg}`)
      this.notifyStatusImmediate()
      throw error
    }
  }

  async stop(): Promise<MihomoStatus> {
    if (!this.child) {
      return this.getStatus()
    }

    const proc = this.child
    this.appendLog(`[Prism] 正在停止 Mihomo (PID: ${proc.pid})...`)

    return new Promise((resolve) => {
      let finished = false
      const done = (): void => {
        if (finished) return
        finished = true
        this.child = null
        this.startedAt = undefined
        this.notifyStatusImmediate()
        resolve(this.getStatus())
      }

      const timer = setTimeout(() => {
        try {
          if (!proc.killed) {
            proc.kill('SIGKILL')
            this.appendLog('[Prism] 强制结束 Mihomo 进程 (SIGKILL)')
          }
        } catch {
          // ignore
        }
        done()
      }, 2000)

      proc.once('exit', () => {
        clearTimeout(timer)
        done()
      })

      try {
        proc.kill('SIGTERM')
      } catch {
        proc.kill()
      }
    })
  }

  async selectFile(type: 'binary' | 'config', win?: BrowserWindow): Promise<string | null> {
    const isWin = platform() === 'win32'
    if (type === 'binary') {
      const res = await dialog.showOpenDialog(win ?? (null as any), {
        title: '选择 Mihomo 可执行文件',
        properties: ['openFile'],
        filters: isWin ? [{ name: '可执行文件', extensions: ['exe'] }] : undefined
      })
      if (!res.canceled && res.filePaths.length > 0) {
        return res.filePaths[0]
      }
    } else {
      const res = await dialog.showOpenDialog(win ?? (null as any), {
        title: '选择 Mihomo / Clash 配置文件',
        properties: ['openFile'],
        filters: [
          { name: 'YAML 配置文件', extensions: ['yaml', 'yml', 'txt'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (!res.canceled && res.filePaths.length > 0) {
        return res.filePaths[0]
      }
    }
    return null
  }

  async cleanup(): Promise<void> {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGKILL')
      } catch {
        // ignore
      }
      this.child = null
    }
  }
}
