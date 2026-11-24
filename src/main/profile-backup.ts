import { suffixedProfileName } from '../shared/profile-name'
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { BrowserExtension, BrowserProfile, ProfileBackupResult, ProfileDraft } from '../shared/types'
import { validateProfileDraft } from '../shared/validation'
import type { Logger } from './app-logger'
import type { ExtensionStore } from './extension-store'
import type { ProfileStore } from './profile-store'

export type ProfileBackupMode = 'full' | 'portable-session'

export interface ExtensionReference {
  id: string
  name: string
  storeId?: string
  version?: string
}

interface ProfileBackupManifest {
  schemaVersion: 1
  packageKind?: ProfileBackupMode
  exportedAt: string
  sourcePlatform: NodeJS.Platform
  sourceAppVersion: string
  totalBytes: number
  fileCount: number
  contentSha256?: string
  extensionReferences?: ExtensionReference[]
  profile: ProfileDraft
}

const VOLATILE_CACHE_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
  'BrowserMetrics',
  'CacheStorage'
])

interface CopyStats {
  bytes: number
  files: number
  hash: Hash
}

const MAX_BACKUP_FILES = 1_000_000
const MAX_BACKUP_BYTES = 500 * 1024 * 1024 * 1024

function safeDirectoryName(name: string): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 50)
  return safe || '环境'
}

function ensureOutside(source: string, target: string): void {
  const normalizedSource = resolve(source)
  const normalizedTarget = resolve(target)
  if (normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}${sep}`)) {
    throw new Error('备份目录不能位于当前环境数据目录内部')
  }
}

async function copySafeTree(
  source: string,
  target: string,
  stats: CopyStats,
  relativePath = '',
  skipVolatileCaches = false
): Promise<void> {
  const info = await lstat(source)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true })
    for (const entry of (await readdir(source)).sort()) {
      if (skipVolatileCaches && VOLATILE_CACHE_DIRS.has(entry)) continue
      await copySafeTree(join(source, entry), join(target, entry), stats, join(relativePath, entry), skipVolatileCaches)
    }
    return
  }
  if (!info.isFile()) return
  stats.files += 1
  stats.bytes += info.size
  if (stats.files > MAX_BACKUP_FILES) throw new Error('环境数据文件数量超过 100 万，已停止备份')
  if (stats.bytes > MAX_BACKUP_BYTES) throw new Error('环境数据超过 500 GB，已停止备份')
  await copyFile(source, target)
  stats.hash.update(relativePath.replaceAll(sep, '/'))
  stats.hash.update('\0')
  stats.hash.update(String(info.size))
  stats.hash.update('\0')
  for await (const chunk of createReadStream(target)) stats.hash.update(chunk as Buffer)
}

function portableDraft(profile: BrowserProfile): ProfileDraft {
  return {
    name: profile.name,
    note: profile.note,
    group: profile.group,
    tags: [...profile.tags],
    extensionIds: [],
    color: profile.color,
    startUrls: [...profile.startUrls],
    kernelVersion: profile.kernelVersion,
    window: { ...profile.window },
    proxy: { ...profile.proxy, password: '', passwordStored: false },
    fingerprint: { ...profile.fingerprint, disabledSpoofing: [...profile.fingerprint.disabledSpoofing] }
  }
}

function remapExtensions(
  references: ExtensionReference[] | undefined,
  installed: BrowserExtension[]
): string[] {
  if (!references?.length || !installed.length) return []
  const matched = new Set<string>()
  for (const ref of references) {
    const byStore = ref.storeId ? installed.find((ext) => ext.storeId && ext.storeId === ref.storeId) : undefined
    const byName = byStore ?? installed.find((ext) => ext.name === ref.name)
    if (byName) matched.add(byName.id)
  }
  return [...matched]
}

async function repairImportedExtensionPaths(userDataDir: string, installed: BrowserExtension[]): Promise<void> {
  const prefsPath = join(userDataDir, 'Default', 'Preferences')
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(await readFile(prefsPath, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }
  const extensionsSection = parsed.extensions as Record<string, unknown> | undefined
  const settings = extensionsSection?.settings as Record<string, Record<string, unknown>> | undefined
  if (!settings || typeof settings !== 'object') return

  let changed = false
  for (const [extKey, entry] of Object.entries(settings)) {
    if (!entry || typeof entry !== 'object') continue
    const rawPath = entry.path
    if (typeof rawPath !== 'string' || !rawPath) continue
    const byStore = installed.find((ext) => ext.storeId === extKey)
    const manifestName = (entry.manifest as Record<string, unknown> | undefined)?.name
    const byName = typeof manifestName === 'string' ? installed.find((ext) => ext.name === manifestName) : undefined
    const target = byStore ?? byName
    if (target) {
      if (rawPath !== target.path) {
        entry.path = target.path
        changed = true
      }
    } else {
      try {
        await stat(rawPath)
      } catch {
        delete entry.path
        changed = true
      }
    }
  }
  if (changed) {
    await writeFile(prefsPath, JSON.stringify(parsed), 'utf8')
  }
}

export class ProfileBackupManager {
  constructor(
    private readonly profiles: ProfileStore,
    private readonly appVersion: string,
    private readonly logger?: Logger,
    private readonly extensions?: ExtensionStore
  ) {}

  async exportPortableSession(profileId: string, destinationParent: string): Promise<ProfileBackupResult> {
    return this.export(profileId, destinationParent, { mode: 'portable-session' })
  }

  async export(
    profileId: string,
    destinationParent: string,
    options: { mode?: ProfileBackupMode } = {}
  ): Promise<ProfileBackupResult> {
    const mode: ProfileBackupMode = options.mode ?? 'full'
    const profile = this.profiles.get(profileId)
    if (profile.status !== 'closed' && profile.status !== 'error') throw new Error('请先关闭浏览器环境再备份完整数据')
    await this.profiles.assertProfileDataIdentity(profileId)
    const source = this.profiles.profileDataPath(profileId)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const prefix = mode === 'portable-session' ? 'Prism Session' : 'Prism Backup'
    const target = join(resolve(destinationParent), `${prefix} - ${safeDirectoryName(profile.name)} - ${stamp}`)
    const staging = `${target}.partial`
    ensureOutside(source, target)
    try {
      await stat(target)
      throw new Error('目标备份目录已经存在')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(staging, { recursive: false })
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    try {
      await copySafeTree(source, join(staging, 'user-data'), stats, '', mode === 'portable-session')
      const contentSha256 = stats.hash.digest('hex')
      const installedExtensions = this.extensions?.list() ?? []
      const extensionReferences: ExtensionReference[] = profile.extensionIds
        .map((extId) => installedExtensions.find((ext) => ext.id === extId))
        .filter((ext): ext is BrowserExtension => Boolean(ext))
        .map((ext) => ({
          id: ext.id,
          name: ext.name,
          ...(ext.storeId ? { storeId: ext.storeId } : {}),
          ...(ext.version ? { version: ext.version } : {})
        }))
      const manifest: ProfileBackupManifest = {
        schemaVersion: 1,
        ...(mode === 'portable-session' ? { packageKind: 'portable-session' } : {}),
        exportedAt: new Date().toISOString(),
        sourcePlatform: process.platform,
        sourceAppVersion: this.appVersion,
        totalBytes: stats.bytes,
        fileCount: stats.files,
        contentSha256,
        ...(extensionReferences.length ? { extensionReferences } : {}),
        profile: portableDraft(profile)
      }
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, target)
      this.logger?.info(mode === 'portable-session' ? '便携式会话包已导出' : '环境完整数据备份已导出', {
        profileId,
        mode,
        bytes: stats.bytes,
        files: stats.files
      })
      return { path: target, totalBytes: stats.bytes, fileCount: stats.files }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async import(sourceInput: string): Promise<{ profile: BrowserProfile; result: ProfileBackupResult }> {
    const source = resolve(sourceInput)
    const manifestPath = join(source, 'manifest.json')
    if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('备份清单不能超过 1 MB')
    let manifest: ProfileBackupManifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProfileBackupManifest
    } catch {
      throw new Error('备份清单不是有效 JSON')
    }
    if (manifest.schemaVersion !== 1 || !manifest.profile || typeof manifest.totalBytes !== 'number' || typeof manifest.fileCount !== 'number') {
      throw new Error('不支持或不完整的 Prism 环境数据备份')
    }
    if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 0 || manifest.totalBytes > MAX_BACKUP_BYTES
      || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0 || manifest.fileCount > MAX_BACKUP_FILES) {
      throw new Error('备份清单中的数据大小或文件数量超出安全范围')
    }
    if (manifest.contentSha256 !== undefined && !/^[a-f\d]{64}$/i.test(manifest.contentSha256)) throw new Error('备份内容摘要无效')
    if (typeof manifest.profile.name !== 'string') throw new Error('备份中的环境名称无效')
    const userDataSource = join(source, 'user-data')
    const sourceInfo = await lstat(userDataSource)
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new Error('备份中的 user-data 目录无效')
    const installedExtensions = this.extensions?.list() ?? []
    const remappedExtensionIds = remapExtensions(manifest.extensionReferences, installedExtensions)
    const draft = validateProfileDraft({
      ...manifest.profile,
      kernelVersion: typeof manifest.profile.kernelVersion === 'string' ? manifest.profile.kernelVersion : '',
      name: suffixedProfileName('{0}（迁移）', manifest.profile.name),
      extensionIds: remappedExtensionIds,
      proxy: { ...manifest.profile.proxy, password: '', passwordStored: false }
    })
    const stagingRoot = await mkdtemp(join(this.profiles.vaultPath, '.profile-backup-import-'))
    const staging = join(stagingRoot, 'user-data')
    const stats: CopyStats = { bytes: 0, files: 0, hash: createHash('sha256') }
    let profile: BrowserProfile | undefined
    try {
      ensureOutside(userDataSource, staging)
      await copySafeTree(userDataSource, staging, stats)
      if (stats.bytes !== manifest.totalBytes || stats.files !== manifest.fileCount) {
        throw new Error('备份数据数量与清单不一致，文件可能不完整')
      }
      const contentSha256 = stats.hash.digest('hex')
      if (manifest.contentSha256 && contentSha256 !== manifest.contentSha256) {
        throw new Error('备份内容 SHA-256 校验失败，文件可能已损坏或被修改')
      }
      profile = await this.profiles.create(draft)
      const target = this.profiles.profileDataPath(profile.id)
      const empty = `${target}.empty-${randomUUID()}`
      await rename(target, empty)
      try {
        await rename(staging, target)
        await rm(empty, { recursive: true, force: true })
      } catch (error) {
        await rename(empty, target).catch(() => undefined)
        throw error
      }
      await repairImportedExtensionPaths(target, installedExtensions)
      await this.profiles.assertProfileDataIdentity(profile.id)
      this.logger?.info('环境完整数据备份已导入', { profileId: profile.id, bytes: stats.bytes, files: stats.files })
      return { profile: this.profiles.get(profile.id), result: { path: source, totalBytes: stats.bytes, fileCount: stats.files } }
    } catch (error) {
      if (profile) {
        await this.profiles.remove(profile.id).catch(() => undefined)
        const item = (await this.profiles.listTrash().catch(() => [])).find((candidate) => candidate.profileId === profile!.id)
        if (item) await this.profiles.purgeTrash(item.trashId).catch(() => undefined)
      }
      throw error
    } finally { await rm(stagingRoot, { recursive: true, force: true }) }
  }
}
