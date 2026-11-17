import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationAuditLog } from './automation-audit'
import { ProAgentManager } from './pro-agent-manager'

const TEST_TOKEN = 'b'.repeat(48)
const TEST_ACCESS_TOKEN = 'c'.repeat(48)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ProAgentManager.mcpConnection', () => {
  it('returns ELECTRON_RUN_AS_NODE launcher config pointing to resources/mcp/prism-mcp.mjs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-pro-agent-test-'))
    roots.push(root)
    const audit = new AutomationAuditLog(root)
    await audit.initialize()

    const fakeSpawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
        kill: () => boolean
      }
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.killed = false
      child.kill = () => {
        child.killed = true
        queueMicrotask(() => child.emit('exit', 0, null))
        return true
      }
      child.stdin.on('data', (chunk: Buffer) => {
        const msg = JSON.parse(chunk.toString('utf8').trim()) as { type?: string }
        if (msg.type === 'handshake') {
          child.stdout.write(
            `${JSON.stringify({
              type: 'ready',
              agentVersion: '1.0.0',
              endpoint: 'http://127.0.0.1:41234',
              accessToken: TEST_ACCESS_TOKEN,
              mcpAccessToken: TEST_TOKEN
            })}\n`
          )
        } else if (msg.type === 'stop') {
          queueMicrotask(() => child.emit('exit', 0, null))
        }
      })
      queueMicrotask(() => {
        child.stdout.write(`${JSON.stringify({ type: 'challenge', challenge: { agentVersion: '1.0.0' } })}\n`)
      })
      return child
    })

    const resourcesPath = join(root, 'Resources')
    const fakeExec = join(resourcesPath, 'pro-agent', 'prism-pro-agent')
    const manager = new ProAgentManager(
      { list: () => [], get: () => { throw new Error('missing') } } as never,
      { launch: vi.fn(), close: vi.fn() } as never,
      {
        has: () => true,
        proAgentReleasePublicKey: async () => 'pub',
        createProAgentHandshake: async () => ({} as never)
      },
      audit,
      resourcesPath,
      vi.fn(),
      undefined,
      undefined,
      async () => ({
        manifest: {
          payload: {
            schemaVersion: 1,
            product: 'prism-pro-agent',
            version: '1.0.0',
            target: 'darwin-arm64',
            executableFile: 'prism-pro-agent',
            executableSize: 1,
            executableSha256: '0'.repeat(64),
            issuedAt: new Date().toISOString()
          },
          signature: ''
        },
        executablePath: fakeExec
      }),
      fakeSpawn as never,
      undefined,
      join(root, 'runtime')
    )

    manager.attachMcpBroker({
      handleAgentRequest: vi.fn(async () => undefined),
      status: (running = false) => ({
        state: running ? 'ready' : 'stopped',
        message: 'ok',
        policy: { enabled: true, defaultAccess: 'deny', allowProfileCreation: false },
        enabledProfileIds: [],
        controlledProfileIds: []
      }),
      resetSessions: vi.fn()
    })

    const connection = await manager.mcpConnection()
    expect(connection.command).toBe(process.execPath)
    expect(connection.args).toEqual([join(resourcesPath, 'mcp', 'prism-mcp.mjs')])
    expect(connection.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(fakeSpawn).toHaveBeenCalledWith(fakeExec, ['--stdio'], expect.any(Object))

    await manager.stop(false)
  })
})
