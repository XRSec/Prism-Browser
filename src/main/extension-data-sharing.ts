import { access, cp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserExtension, ExtensionDataSharingConfig } from '../shared/types'
import type { Logger } from './app-logger'

export function extensionStorageKey(extension: BrowserExtension): string {
  return extension.storeId || extension.id
}

export function isProfileEnrolledInDataSharing(profileId: string, config?: ExtensionDataSharingConfig): boolean {
  if (!config?.enabled) return false
  if (!Array.isArray(config.targetProfileIds) || config.targetProfileIds.length === 0) {
    return true // 未指定具体环境时对所有环境生效
  }
  return config.targetProfileIds.includes(profileId)
}

/**
 * 环境启动时拉取共享数据
 */
export async function syncExtensionDataOnLaunch(
  vaultPath: string,
  profileId: string,
  extensions: BrowserExtension[],
  logger?: Logger
): Promise<void> {
  const profileUserData = join(vaultPath, 'profiles', profileId, 'user-data')
  const localSettingsParent = join(profileUserData, 'Default', 'Local Extension Settings')

  for (const ext of extensions) {
    if (!ext.dataSharing?.enabled) continue
    if (!isProfileEnrolledInDataSharing(profileId, ext.dataSharing)) continue

    const storageKey = extensionStorageKey(ext)
    const masterVolume = join(vaultPath, 'shared-extension-data', storageKey)
    const targetDir = join(localSettingsParent, storageKey)

    try {
      let hasMaster = false
      try {
        await access(masterVolume)
        hasMaster = true
      } catch {
        // 主卷不存在时，若配置了 sourceProfileId，则从源环境初始化主卷
        if (ext.dataSharing.sourceProfileId) {
          const sourceDir = join(
            vaultPath,
            'profiles',
            ext.dataSharing.sourceProfileId,
            'user-data',
            'Default',
            'Local Extension Settings',
            storageKey
          )
          try {
            await access(sourceDir)
            await mkdir(join(vaultPath, 'shared-extension-data'), { recursive: true })
            await cp(sourceDir, masterVolume, {
              recursive: true,
              filter: (src) => !src.endsWith('LOCK')
            })
            hasMaster = true
            logger?.info('已从源环境初始化扩展共享数据主卷', {
              extensionId: ext.id,
              sourceProfileId: ext.dataSharing.sourceProfileId
            })
          } catch {
            // 源环境数据不存在则跳过
          }
        }
      }

      if (hasMaster) {
        await mkdir(localSettingsParent, { recursive: true })
        try {
          await rm(targetDir, { recursive: true, force: true })
        } catch {
          // ignore
        }
        await cp(masterVolume, targetDir, {
          recursive: true,
          filter: (src) => !src.endsWith('LOCK')
        })
        logger?.info('已同步共享扩展数据到启动环境', { profileId, extensionId: ext.id })
      }
    } catch (error) {
      logger?.error('启动时同步共享扩展数据失败', {
        profileId,
        extensionId: ext.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

/**
 * 环境关闭时将修改回写到共享主卷
 */
export async function syncExtensionDataOnClose(
  vaultPath: string,
  profileId: string,
  extensions: BrowserExtension[],
  logger?: Logger
): Promise<void> {
  const profileUserData = join(vaultPath, 'profiles', profileId, 'user-data')
  const localSettingsParent = join(profileUserData, 'Default', 'Local Extension Settings')

  for (const ext of extensions) {
    if (!ext.dataSharing?.enabled) continue
    if (!isProfileEnrolledInDataSharing(profileId, ext.dataSharing)) continue

    const storageKey = extensionStorageKey(ext)
    const sourceDir = join(localSettingsParent, storageKey)
    const masterVolume = join(vaultPath, 'shared-extension-data', storageKey)

    try {
      await access(sourceDir)
      await mkdir(join(vaultPath, 'shared-extension-data'), { recursive: true })
      try {
        await rm(masterVolume, { recursive: true, force: true })
      } catch {
        // ignore
      }
      await cp(sourceDir, masterVolume, {
        recursive: true,
        filter: (src) => !src.endsWith('LOCK')
      })
      logger?.info('窗口关闭，已将修改回写到扩展共享主卷', { profileId, extensionId: ext.id })
    } catch {
      // 容错处理：源目录不存在或复制失败不影响关闭
    }
  }
}
