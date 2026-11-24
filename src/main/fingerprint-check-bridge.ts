import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { FingerprintCheckReport } from '../shared/fingerprint-check'
import type { Logger } from './app-logger'

export interface FingerprintCheckBridgeDependencies {
  runtimeDirectory: string
  isMcpEnabled: () => boolean
  isProfileAllowed: (profileId: string) => boolean
  hasProfile: (profileId: string) => boolean
  checkFingerprint: (profileId: string) => Promise<FingerprintCheckReport>
  logger?: Logger
}

const PROFILE_CHECK_ROUTE_RE = /^\/v1\/mcp\/profiles\/([A-Za-z0-9-]{1,100})\/check-fingerprint$/

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(payload))
}

function constantTimeTokenMatch(header: string | undefined, expectedToken: string): boolean {
  if (!header || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7).trim(), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export class FingerprintCheckBridge {
  private server: Server | null = null
  private token = ''
  private endpoint = ''
  private readonly descriptorPath: string

  constructor(private readonly deps: FingerprintCheckBridgeDependencies) {
    this.descriptorPath = join(deps.runtimeDirectory, 'fingerprint-check-bridge.json')
  }

  async start(): Promise<void> {
    if (this.server) return
    this.token = randomBytes(32).toString('base64url')
    const server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo | null
    if (!address || typeof address.port !== 'number') {
      server.close()
      throw new Error('Failed to bind fingerprint check bridge')
    }
    this.server = server
    this.endpoint = `http://127.0.0.1:${address.port}`
    await mkdir(this.deps.runtimeDirectory, { recursive: true })
    await writeFile(
      this.descriptorPath,
      JSON.stringify({ endpoint: this.endpoint, token: this.token, updatedAt: new Date().toISOString() }, null, 2),
      { encoding: 'utf8', mode: 0o600 }
    )
    await chmod(this.descriptorPath, 0o600).catch(() => undefined)
  }

  async stop(): Promise<void> {
    const active = this.server
    this.server = null
    this.endpoint = ''
    this.token = ''
    await rm(this.descriptorPath, { force: true }).catch(() => undefined)
    if (!active) return
    await new Promise<void>((resolve) => active.close(() => resolve()))
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!constantTimeTokenMatch(req.headers.authorization, this.token)) {
      sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid bridge token', retryable: false } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = url.pathname.match(PROFILE_CHECK_ROUTE_RE)
    if (req.method !== 'POST' || !match) {
      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Unsupported fingerprint bridge route', retryable: false } })
      return
    }
    const profileId = match[1]
    if (!this.deps.isMcpEnabled()) {
      sendJson(res, 403, { error: { code: 'MCP_GLOBAL_DISABLED', message: 'MCP is disabled by the user; enable it in Prism settings', retryable: false } })
      return
    }
    if (!this.deps.hasProfile(profileId)) {
      sendJson(res, 404, { error: { code: 'PROFILE_NOT_FOUND', message: '未找到指定环境', retryable: false } })
      return
    }
    if (!this.deps.isProfileAllowed(profileId)) {
      sendJson(res, 403, { error: { code: 'PROFILE_NOT_ALLOWED', message: '该环境尚未允许本地 AI 控制', retryable: false } })
      return
    }
    try {
      const report = await this.deps.checkFingerprint(profileId)
      sendJson(res, 200, { result: report })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const notRunning = message.includes('尚未启动')
      this.deps.logger?.error('指纹一致性自检失败', { profileId, error: message })
      sendJson(res, notRunning ? 409 : 500, {
        error: {
          code: notRunning ? 'PROFILE_NOT_RUNNING' : 'FINGERPRINT_CHECK_FAILED',
          message,
          retryable: false,
          ...(notRunning ? { suggestedTool: 'prism_start_profile' } : {})
        }
      })
    }
  }
}
