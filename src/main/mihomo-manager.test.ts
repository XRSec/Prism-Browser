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

  it('refuses to start when binary or config does not exist', async () => {
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
