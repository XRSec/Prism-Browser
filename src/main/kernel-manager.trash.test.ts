import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KernelManager } from './kernel-manager'
import { SettingsStore } from './settings-store'

const temporaryPaths: string[] = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function setup(): Promise<{ manager: KernelManager; vaultPath: string }> {
  const vaultPath = await mkdtemp(join(tmpdir(), 'prism-kernel-trash-'))
  temporaryPaths.push(vaultPath)
  const settings = new SettingsStore(vaultPath)
  const manager = new KernelManager(vaultPath, settings, () => {})
  return { manager, vaultPath }
}

describe('KernelManager Trash', () => {
  it('lists trashed kernels sorted by deletedAt descending', async () => {
    const { manager, vaultPath } = await setup()
    const recycleRoot = join(vaultPath, 'recycle-bin', 'kernels')

    const olderTime = Date.now() - 100_000
    const newerTime = Date.now() - 10_000

    const olderTrash = join(recycleRoot, `150.0.7871.46-${olderTime}`)
    const newerTrash = join(recycleRoot, `153.0.8010.53-${newerTime}`)

    await mkdir(olderTrash, { recursive: true })
    await writeFile(join(olderTrash, 'binary.bin'), Buffer.alloc(1024))

    await mkdir(newerTrash, { recursive: true })
    await writeFile(join(newerTrash, 'binary.bin'), Buffer.alloc(2048))

    const list = await manager.listTrash()
    expect(list).toHaveLength(2)
    expect(list[0].version).toBe('153.0.8010.53')
    expect(list[0].trashId).toBe(`153.0.8010.53-${newerTime}`)
    expect(list[0].sizeBytes).toBeGreaterThanOrEqual(2048)

    expect(list[1].version).toBe('150.0.7871.46')
    expect(list[1].trashId).toBe(`150.0.7871.46-${olderTime}`)
    expect(list[1].sizeBytes).toBeGreaterThanOrEqual(1024)
  })

  it('restores trashed kernel back to kernels directory', async () => {
    const { manager, vaultPath } = await setup()
    const recycleRoot = join(vaultPath, 'recycle-bin', 'kernels')
    const trashId = `150.0.7871.46-${Date.now()}`
    const trashPath = join(recycleRoot, trashId)

    await mkdir(trashPath, { recursive: true })
    await writeFile(join(trashPath, 'manifest.json'), JSON.stringify({ version: '150.0.7871.46' }))

    await manager.restoreTrash(trashId)

    const list = await manager.listTrash()
    expect(list).toHaveLength(0)

    const restoredPath = join(vaultPath, 'kernels', '150.0.7871.46')
    const manifest = await rm(restoredPath, { recursive: true, force: true }).then(() => true).catch(() => false)
    expect(manifest).toBe(true)
  })

  it('refuses to restore when target kernel already exists', async () => {
    const { manager, vaultPath } = await setup()
    const recycleRoot = join(vaultPath, 'recycle-bin', 'kernels')
    const trashId = `150.0.7871.46-${Date.now()}`
    const trashPath = join(recycleRoot, trashId)
    await mkdir(trashPath, { recursive: true })

    const existingPath = join(vaultPath, 'kernels', '150.0.7871.46')
    await mkdir(existingPath, { recursive: true })

    await expect(manager.restoreTrash(trashId)).rejects.toThrow('已存在，无法恢复')
  })

  it('purges specific trash item and empties trash', async () => {
    const { manager, vaultPath } = await setup()
    const recycleRoot = join(vaultPath, 'recycle-bin', 'kernels')
    const trashId1 = `150.0.7871.46-${Date.now()}`
    const trashId2 = `153.0.8010.53-${Date.now()}`

    await mkdir(join(recycleRoot, trashId1), { recursive: true })
    await mkdir(join(recycleRoot, trashId2), { recursive: true })

    await manager.purgeTrash(trashId1)
    let list = await manager.listTrash()
    expect(list).toHaveLength(1)
    expect(list[0].trashId).toBe(trashId2)

    const purgedCount = await manager.emptyTrash()
    expect(purgedCount).toBe(1)
    list = await manager.listTrash()
    expect(list).toHaveLength(0)
  })

  it('purges expired trash older than specified days', async () => {
    const { manager, vaultPath } = await setup()
    const recycleRoot = join(vaultPath, 'recycle-bin', 'kernels')

    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000

    await mkdir(join(recycleRoot, `150.0.7871.46-${tenDaysAgo}`), { recursive: true })
    await mkdir(join(recycleRoot, `153.0.8010.53-${twoDaysAgo}`), { recursive: true })

    const count = await manager.purgeTrashOlderThan(7)
    expect(count).toBe(1)

    const list = await manager.listTrash()
    expect(list).toHaveLength(1)
    expect(list[0].version).toBe('153.0.8010.53')
  })
})
