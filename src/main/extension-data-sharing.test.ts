import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserExtension } from '../shared/types'
import {
  isProfileEnrolledInDataSharing,
  syncExtensionDataOnClose,
  syncExtensionDataOnLaunch
} from './extension-data-sharing'

describe('extension-data-sharing', () => {
  let tempVault: string

  beforeEach(async () => {
    tempVault = await mkdtemp(join(tmpdir(), 'prism-ext-data-test-'))
  })

  afterEach(async () => {
    await rm(tempVault, { recursive: true, force: true })
  })

  it('isProfileEnrolledInDataSharing 正确判断环境是否接入共享', () => {
    expect(isProfileEnrolledInDataSharing('p1', undefined)).toBe(false)
    expect(isProfileEnrolledInDataSharing('p1', { enabled: false })).toBe(false)
    expect(isProfileEnrolledInDataSharing('p1', { enabled: true })).toBe(true)
    expect(isProfileEnrolledInDataSharing('p1', { enabled: true, targetProfileIds: [] })).toBe(true)
    expect(isProfileEnrolledInDataSharing('p1', { enabled: true, targetProfileIds: ['p1', 'p2'] })).toBe(true)
    expect(isProfileEnrolledInDataSharing('p3', { enabled: true, targetProfileIds: ['p1', 'p2'] })).toBe(false)
  })

  it('启动时若主卷未初始化，则从 sourceProfileId 初始化主卷并拉取到目标环境', async () => {
    const ext: BrowserExtension = {
      id: 'ext-uuid-1',
      storeId: 'nngceckbapebfimnlniiiahkandclblb',
      name: 'Bitwarden',
      version: '1.0.0',
      description: '',
      manifestVersion: 3,
      installedAt: new Date().toISOString(),
      path: '/dummy',
      globalEnabled: true,
      dataSharing: {
        enabled: true,
        sourceProfileId: 'source-p',
        targetProfileIds: ['target-p']
      }
    }

    // 准备 source-p 的数据
    const sourceStorage = join(
      tempVault,
      'profiles',
      'source-p',
      'user-data',
      'Default',
      'Local Extension Settings',
      ext.storeId!
    )
    await mkdir(sourceStorage, { recursive: true })
    await writeFile(join(sourceStorage, 'vault.json'), '{"vault":"secret"}')
    await writeFile(join(sourceStorage, 'LOCK'), '')

    // target-p 启动同步
    await syncExtensionDataOnLaunch(tempVault, 'target-p', [ext])

    // 检查 target-p 已同步且 LOCK 被排除
    const targetStorage = join(
      tempVault,
      'profiles',
      'target-p',
      'user-data',
      'Default',
      'Local Extension Settings',
      ext.storeId!
    )
    expect(await readFile(join(targetStorage, 'vault.json'), 'utf8')).toBe('{"vault":"secret"}')
    await expect(access(join(targetStorage, 'LOCK'))).rejects.toThrow()
  })

  it('环境关闭时将数据回写到共享主卷', async () => {
    const ext: BrowserExtension = {
      id: 'ext-uuid-1',
      storeId: 'nngceckbapebfimnlniiiahkandclblb',
      name: 'Bitwarden',
      version: '1.0.0',
      description: '',
      manifestVersion: 3,
      installedAt: new Date().toISOString(),
      path: '/dummy',
      globalEnabled: true,
      dataSharing: {
        enabled: true,
        targetProfileIds: ['target-p']
      }
    }

    const targetStorage = join(
      tempVault,
      'profiles',
      'target-p',
      'user-data',
      'Default',
      'Local Extension Settings',
      ext.storeId!
    )
    await mkdir(targetStorage, { recursive: true })
    await writeFile(join(targetStorage, 'updated.json'), '{"new_entry":123}')
    await writeFile(join(targetStorage, 'LOCK'), '')

    // 关闭同步
    await syncExtensionDataOnClose(tempVault, 'target-p', [ext])

    // 检查主卷被更新
    const masterVolume = join(tempVault, 'shared-extension-data', ext.storeId!)
    expect(await readFile(join(masterVolume, 'updated.json'), 'utf8')).toBe('{"new_entry":123}')
    await expect(access(join(masterVolume, 'LOCK'))).rejects.toThrow()
  })
})
