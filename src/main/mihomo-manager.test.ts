import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expandHome, findDefaultMihomoBinary, MihomoManager } from './mihomo-manager'

describe('MihomoManager', () => {
  let tempVault: string

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'prism-mihomo-test-'))
  })

  afterEach(async () => {
    await rm(tempVault, { recursive: true, force: true }).catch(() => undefined)
  })

  it('correctly expands home paths', () => {
    expect(expandHome('')).toBe('')
    expect(expandHome('~/config.yaml')).not.toContain('~')
    expect(expandHome('/opt/bin/mihomo')).toBe('/opt/bin/mihomo')
  })

  it('detects default binary path', async () => {
    const binary = await findDefaultMihomoBinary()
    expect(typeof binary).toBe('string')
    expect(binary.length).toBeGreaterThan(0)
  })

  it('initializes and saves service config and config files', async () => {
    const manager = new MihomoManager(tempVault)
    await manager.initialize()

    const status = manager.getStatus()
    expect(status.running).toBe(false)
    expect(status.binaryPath).toBeTruthy()
    expect(status.configPath).toContain('config.yaml')

    const testYaml = 'mixed-port: 17890\nusers:\n  - "node-0001:prism"'
    const savedPath = await manager.saveConfigFile(testYaml)
    expect(savedPath).toContain('config.yaml')

    const fileContent = await readFile(savedPath, 'utf8')
    expect(fileContent).toBe(testYaml)

    const reloaded = new MihomoManager(tempVault)
    await reloaded.initialize()
    expect(reloaded.getStatus().configPath).toBe(savedPath)
  })

  it('reads and parses existing config file correctly', async () => {
    const manager = new MihomoManager(tempVault)
    await manager.initialize()

    const sample = `mixed-port: 17895
external-controller: 127.0.0.1:9095
secret: "my-secret-123"
users:
  - "custom-0001:my-pass"
  - "custom-0002:my-pass"
`
    await manager.saveConfigFile(sample)

    const parsed = await manager.readConfig()
    expect(parsed.port).toBe(17895)
    expect(parsed.externalController).toBe('127.0.0.1:9095')
    expect(parsed.secret).toBe('my-secret-123')
    expect(parsed.prefix).toBe('custom-')
    expect(parsed.password).toBe('my-pass')
    expect(parsed.userCount).toBe(2)
  })

  it('refuses to start when binary does not exist', async () => {
    const manager = new MihomoManager(tempVault)
    await manager.initialize()

    await expect(
      manager.start({
        binaryPath: '/non/existent/path/to/mihomo',
        configPath: '/non/existent/config.yaml'
      })
    ).rejects.toThrow('二进制文件不存在')
  })
})
