import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/client'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  launchPrismApplication,
  runPrismMcpRuntime
} from './server'

const TEST_TOKEN = 'a'.repeat(48)
const TEST_INSTANCE_ID = '11111111-1111-4111-8111-111111111111'
const TEST_PROFILE_ID = '22222222-2222-4222-8222-222222222222'
const TEST_TASK_ID = '33333333-3333-4333-8333-333333333333'

const cleanupTasks: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanupTasks.length) {
    const task = cleanupTasks.pop()
    if (task) await task().catch(() => undefined)
  }
})

/** Minimal client-side Transport wired directly to the server's PassThrough stdin/stdout streams. */
class StreamPairClientTransport implements Transport {
  private readonly buffer = new ReadBuffer()
  private closed = false
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  constructor(
    private readonly serverInput: PassThrough,
    private readonly serverOutput: PassThrough
  ) {}

  async start(): Promise<void> {
    this.serverOutput.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk)
      for (;;) {
        const message = this.buffer.readMessage()
        if (message === null) break
        this.onmessage?.(message)
      }
    })
    this.serverOutput.on('end', () => {
      void this.close()
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('Client transport closed')
    this.serverInput.write(serializeMessage(message))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.serverInput.end()
    this.buffer.clear()
    this.onclose?.()
  }
}

async function createTempRuntimeDir(): Promise<{
  dir: string
  statePath: string
  suppressionPath: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-mcp-test-'))
  await chmod(dir, 0o700)
  cleanupTasks.push(() => rm(dir, { recursive: true, force: true }))
  return {
    dir,
    statePath: join(dir, 'mcp-connection.json'),
    suppressionPath: join(dir, 'mcp-user-quit.json')
  }
}

async function writeConnectionState(statePath: string, endpoint: string, token = TEST_TOKEN): Promise<void> {
  await writeFile(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      instanceId: TEST_INSTANCE_ID,
      pid: process.pid,
      endpoint,
      token,
      updatedAt: new Date().toISOString()
    }),
    { encoding: 'utf8', mode: 0o600 }
  )
  await chmod(statePath, 0o600)
}

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

async function startMockPrismBridge(
  handler: (req: RecordedRequest) => { status?: number; body: unknown }
): Promise<{ endpoint: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsedBody: unknown
      if (raw) {
        try {
          parsedBody = JSON.parse(raw)
        } catch {
          parsedBody = raw
        }
      }
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: parsedBody
      }
      requests.push(recorded)
      const reply = handler(recorded)
      const json = JSON.stringify(reply.body)
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(json)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanupTasks.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unexpected mock server address')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests
  }
}

async function connectTestRuntime(options: {
  statePath: string
  suppressionPath?: string
  launchImpl?: () => Promise<void>
  implicitLaunchGraceMs?: number
}) {
  const serverInput = new PassThrough()
  const serverOutput = new PassThrough()
  const runtime = await runPrismMcpRuntime({
    statePath: options.statePath,
    suppressionPath: options.suppressionPath,
    input: serverInput,
    output: serverOutput,
    launchImpl: options.launchImpl,
    implicitLaunchGraceMs: options.implicitLaunchGraceMs ?? 0
  })
  const clientTransport = new StreamPairClientTransport(serverInput, serverOutput)
  const client = new Client({ name: 'vitest-client', version: '1.0.0' })
  await client.connect(clientTransport)
  cleanupTasks.push(async () => {
    await client.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
  })
  return { client, runtime }
}

describe('Prism first-party MCP STDIO server', () => {
  it('starts over STDIO, completes initialize and tools/list without triggering launchImpl', async () => {
    const { statePath, suppressionPath } = await createTempRuntimeDir()
    const launchImpl = vi.fn(async () => undefined)
    const { client } = await connectTestRuntime({ statePath, suppressionPath, launchImpl })

    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    expect(names).toHaveLength(59)
    expect(names).toContain('prism_health')
    expect(names).toContain('prism_list_profiles')
    expect(names).toContain('prism_inspect_pages')
    expect(client.getInstructions()).toContain('prism_open_page auto-starts closed profiles')
    expect(client.getInstructions()).toContain('ref_*')
    expect(launchImpl).not.toHaveBeenCalled()
  })

  it('does not trigger launchImpl when calling prism_health or prism_get_connection_status while stopped', async () => {
    const { statePath, suppressionPath } = await createTempRuntimeDir()
    const launchImpl = vi.fn(async () => undefined)
    const { client } = await connectTestRuntime({ statePath, suppressionPath, launchImpl })

    const healthResult = await client.callTool({ name: 'prism_health', arguments: {} })
    const healthJson = JSON.parse((healthResult.content[0] as { text: string }).text)
    expect(healthJson).toMatchObject({
      ok: false,
      state: 'stopped',
      transport: 'stdio',
      error: { code: 'SERVICE_NOT_RUNNING' }
    })

    const statusResult = await client.callTool({ name: 'prism_get_connection_status', arguments: {} })
    const statusJson = JSON.parse((statusResult.content[0] as { text: string }).text)
    expect(statusJson).toMatchObject({ ok: false, state: 'stopped' })
    expect(launchImpl).not.toHaveBeenCalled()
  })

  it('launches Prism lazily when a browser tool runs while stopped, unless mcp-user-quit.json exists', async () => {
    const { statePath, suppressionPath } = await createTempRuntimeDir()
    const mockBridge = await startMockPrismBridge((req) => {
      if (req.url === '/v1/mcp/service/status') return { body: { result: { ok: true } } }
      if (req.url.endsWith('/start')) return { body: { result: { state: 'running' } } }
      if (req.url === '/v1/mcp/profiles') {
        return {
          body: {
            result: [{ id: TEST_PROFILE_ID, serialNumber: 1, name: 'Test Profile', status: 'closed' }]
          }
        }
      }
      return { status: 404, body: { error: 'not_found' } }
    })

    // 1. Respect mcp-user-quit.json suppression for implicit browser tools
    await writeFile(suppressionPath, JSON.stringify({ schemaVersion: 1, reason: 'user-quit' }), 'utf8')
    const suppressedLaunch = vi.fn(async () => {
      await writeConnectionState(statePath, mockBridge.endpoint)
    })
    const { client: suppressedClient } = await connectTestRuntime({
      statePath,
      suppressionPath,
      launchImpl: suppressedLaunch
    })
    const suppressedCall = await suppressedClient.callTool({ name: 'prism_list_profiles', arguments: {} })
    expect(suppressedCall.isError).toBe(true)
    const suppressedError = JSON.parse((suppressedCall.content[0] as { text: string }).text)
    expect(suppressedError.error.code).toBe('APP_EXITED_BY_USER')
    expect(suppressedLaunch).not.toHaveBeenCalled()

    // Explicit prism_start_service overrides suppression
    const explicitStart = await suppressedClient.callTool({ name: 'prism_start_service', arguments: {} })
    expect(explicitStart.isError).toBeFalsy()
    expect(suppressedLaunch).toHaveBeenCalledTimes(1)

    // 2. Without suppression file, stopped service triggers lazy launch on first browser tool
    const dir2 = await createTempRuntimeDir()
    const lazyLaunch = vi.fn(async () => {
      await writeConnectionState(dir2.statePath, mockBridge.endpoint)
    })
    const { client: lazyClient } = await connectTestRuntime({
      statePath: dir2.statePath,
      suppressionPath: dir2.suppressionPath,
      launchImpl: lazyLaunch
    })
    const profilesResult = await lazyClient.callTool({ name: 'prism_list_profiles', arguments: {} })
    expect(profilesResult.isError).toBeFalsy()
    expect(lazyLaunch).toHaveBeenCalledTimes(1)
    const profiles = JSON.parse((profilesResult.content[0] as { text: string }).text)
    expect(profiles).toEqual([{ id: TEST_PROFILE_ID, serialNumber: 1, name: 'Test Profile', status: 'closed' }])
  })

  it('executes prism_inspect_pages end-to-end against mock HTTP bridge and closes task + profile', async () => {
    const { statePath, suppressionPath } = await createTempRuntimeDir()
    const mockBridge = await startMockPrismBridge((req) => {
      if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
        return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'bad token' } } }
      }
      if (req.url === '/v1/mcp/service/status') return { body: { result: { ok: true } } }
      if (req.url.startsWith('/v1/mcp/sessions/') && req.url.endsWith('/start')) {
        return { body: { result: { state: 'running' } } }
      }
      if (req.url === '/v1/mcp/tasks' && req.method === 'POST') {
        return { body: { result: { taskSessionId: TEST_TASK_ID, profileId: TEST_PROFILE_ID, state: 'active' } } }
      }
      if (req.url === `/v1/mcp/profiles/${TEST_PROFILE_ID}/open`) {
        const body = req.body as { url: string }
        return { body: { result: { url: body.url, title: 'First Page', readyState: 'complete' } } }
      }
      if (req.url === `/v1/mcp/profiles/${TEST_PROFILE_ID}/navigate`) {
        const body = req.body as { url: string }
        return {
          body: {
            result: { performed: true, pageChanged: true, urlChanged: true, url: body.url, title: 'Second Page', readyState: 'complete' }
          }
        }
      }
      if (req.url === `/v1/mcp/profiles/${TEST_PROFILE_ID}/wait-stable`) {
        const calls = mockBridge.requests.filter((r) => r.url.endsWith('/wait-stable')).length
        if (calls === 2) {
          return { status: 408, body: { error: { code: 'PAGE_NOT_STABLE', message: 'timed out', retryable: true } } }
        }
        return { body: { result: { stable: true, url: 'https://a.example/', title: 'First Page', readyState: 'complete' } } }
      }
      if (req.url === `/v1/mcp/profiles/${TEST_PROFILE_ID}/markdown`) {
        const calls = mockBridge.requests.filter((r) => r.url.endsWith('/markdown')).length
        return {
          body: {
            result: {
              markdown: calls === 1 ? '# Alpha' : '# Beta',
              length: 7,
              truncated: false
            }
          }
        }
      }
      if (req.url === `/v1/mcp/tasks/${TEST_TASK_ID}/close`) {
        return { body: { result: { taskSessionId: TEST_TASK_ID, state: 'closed' } } }
      }
      if (req.url === `/v1/mcp/profiles/${TEST_PROFILE_ID}/close`) {
        return { body: { result: { id: TEST_PROFILE_ID, status: 'closed' } } }
      }
      return { status: 404, body: { error: `Unhandled ${req.method} ${req.url}` } }
    })

    await writeConnectionState(statePath, mockBridge.endpoint)
    const launchImpl = vi.fn(async () => undefined)
    const { client, runtime } = await connectTestRuntime({ statePath, suppressionPath, launchImpl })

    const result = await client.callTool({
      name: 'prism_inspect_pages',
      arguments: {
        profileId: TEST_PROFILE_ID,
        urls: ['https://a.example/', 'https://b.example/'],
        waitStableMs: 2500,
        maxCharsPerPage: 8000,
        closeProfileAfter: true
      }
    })

    expect(launchImpl).not.toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    const payload = JSON.parse((result.content[0] as { text: string }).text)
    expect(payload).toMatchObject({
      profileId: TEST_PROFILE_ID,
      taskSessionId: TEST_TASK_ID,
      taskClosed: true,
      profileClosed: true,
      count: 2,
      pages: [
        {
          requestedUrl: 'https://a.example/',
          ok: true,
          url: 'https://a.example/',
          title: 'First Page',
          stable: true,
          markdown: '# Alpha'
        },
        {
          requestedUrl: 'https://b.example/',
          ok: true,
          url: 'https://b.example/',
          title: 'Second Page',
          stable: false,
          markdown: '# Beta'
        }
      ]
    })

    const urlsCalled = mockBridge.requests.map((r) => r.url)
    expect(urlsCalled).toEqual([
      `/v1/mcp/sessions/${runtime.sessionId}/start`,
      '/v1/mcp/tasks',
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/open`,
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/wait-stable`,
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/markdown`,
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/navigate`,
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/wait-stable`,
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/markdown`,
      `/v1/mcp/tasks/${TEST_TASK_ID}/close`,
      `/v1/mcp/profiles/${TEST_PROFILE_ID}/close`
    ])

    const openCall = mockBridge.requests.find((r) => r.url.endsWith('/open'))
    expect(openCall?.headers['x-prism-mcp-session']).toBe(runtime.sessionId)
    expect(openCall?.headers['x-prism-task-session']).toBe(TEST_TASK_ID)
    const mdCall = mockBridge.requests.find((r) => r.url.endsWith('/markdown'))
    expect(mdCall?.body).toEqual({ maxChars: 8000 })
  })

  it('derives macOS .app path from scriptPath fallback and strips ELECTRON_RUN_AS_NODE when spawning', async () => {
    const spawned: Array<{ command: string; args: string[]; opts: Record<string, unknown> }> = []
    const fakeSpawn = ((command: string, args: string[], opts: Record<string, unknown>) => {
      spawned.push({ command, args, opts })
      const emitter = new EventEmitter() as EventEmitter & { unref?: () => void }
      emitter.unref = vi.fn()
      queueMicrotask(() => emitter.emit('spawn'))
      return emitter
    }) as unknown as typeof import('node:child_process').spawn

    await launchPrismApplication({
      platform: 'darwin',
      environment: { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
      executablePath: '/opt/homebrew/bin/node',
      scriptPath: '/Applications/Prism Browser.app/Contents/Resources/mcp/prism-mcp.mjs',
      spawnImpl: fakeSpawn
    })

    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe('/usr/bin/open')
    expect(spawned[0].args).toEqual(['-g', '/Applications/Prism Browser.app'])
    expect((spawned[0].opts.env as Record<string, string>).ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
