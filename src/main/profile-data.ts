import { lstat, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClearProfileDataOptions, ProfileStorageInfo, StorageOverview } from '../shared/types'

const CACHE_PATHS = [
  ['Default', 'Cache'],
  ['Default', 'Code Cache'],
  ['Default', 'GPUCache'],
  ['Default', 'Service Worker', 'CacheStorage'],
  ['ShaderCache'],
  ['GrShaderCache'],
  ['GraphiteDawnCache'],
  ['component_crx_cache'],
  ['Crashpad']
] as const

const HISTORY_PATHS = [
  ['Default', 'History'],
  ['Default', 'History-journal'],
  ['Default', 'History-wal'],
  ['Default', 'History-shm'],
  ['Default', 'History Provider Cache'],
  ['Default', 'Visited Links'],
  ['Default', 'Top Sites'],
  ['Default', 'Top Sites-journal'],
  ['Default', 'Favicons'],
  ['Default', 'Favicons-journal'],
  ['Default', 'Shortcuts'],
  ['Default', 'Shortcuts-journal']
] as const

const DOWNLOADS_PATHS = [
  ['Default', 'Download Service']
] as const

const COOKIES_PATHS = [
  ['Default', 'Cookies'],
  ['Default', 'Cookies-journal'],
  ['Default', 'Network', 'Cookies'],
  ['Default', 'Network', 'Cookies-journal'],
  ['Default', 'Local Storage'],
  ['Default', 'IndexedDB'],
  ['Default', 'Session Storage'],
  ['Default', 'SharedStorage'],
  ['Default', 'SharedStorage-wal'],
  ['Default', 'Shared Dictionary'],
  ['Default', 'TransportSecurity'],
  ['Default', 'Trust Tokens'],
  ['Default', 'Trust Tokens-journal'],
  ['Default', 'WebStorage'],
  ['Default', 'DIPS']
] as const

const AUTOFILL_PATHS = [
  ['Default', 'Web Data'],
  ['Default', 'Web Data-journal'],
  ['Default', 'Account Web Data'],
  ['Default', 'Account Web Data-journal'],
  ['Default', 'AutofillStates'],
  ['Default', 'AutofillAiModelCache'],
  ['Default', 'AutofillStrikeDatabase']
] as const

const HOSTED_APP_PATHS = [
  ['Default', 'Local Extension Settings'],
  ['Default', 'Sync Extension Settings'],
  ['Default', 'Managed Extension Settings'],
  ['Default', 'Extension State']
] as const

const SITE_SETTINGS_PATHS = [
  ['Default', 'Platform Notifications'],
  ['Default', 'Site Characteristics Database'],
  ['Default', 'Network Action Predictor'],
  ['Default', 'Network Action Predictor-journal']
] as const

export async function safePathSize(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (info.isSymbolicLink()) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path)) total += await safePathSize(join(path, entry))
  return total
}

export async function profileStorageInfo(userDataPath: string): Promise<ProfileStorageInfo> {
  const cachePaths = CACHE_PATHS.map((segments) => join(userDataPath, ...segments))
  const [totalBytes, cacheParts] = await Promise.all([
    safePathSize(userDataPath),
    Promise.all(cachePaths.map(safePathSize))
  ])
  return {
    path: userDataPath,
    totalBytes,
    cacheBytes: cacheParts.reduce((total, size) => total + size, 0)
  }
}

export async function clearProfileCache(userDataPath: string): Promise<ProfileStorageInfo> {
  for (const segments of CACHE_PATHS) {
    await rm(join(userDataPath, ...segments), { recursive: true, force: true })
  }
  return profileStorageInfo(userDataPath)
}

export async function clearProfileData(userDataPath: string, options: ClearProfileDataOptions): Promise<ProfileStorageInfo> {
  const tasks: Promise<void>[] = []

  const removePaths = (pathList: readonly (readonly string[])[]) => {
    for (const segments of pathList) {
      tasks.push(rm(join(userDataPath, ...segments), { recursive: true, force: true }).catch(() => undefined))
    }
  }

  if (options.cache) removePaths(CACHE_PATHS)
  if (options.history) removePaths(HISTORY_PATHS)
  if (options.downloads) removePaths(DOWNLOADS_PATHS)
  if (options.cookies) removePaths(COOKIES_PATHS)
  if (options.autofill) removePaths(AUTOFILL_PATHS)
  if (options.hostedAppData) removePaths(HOSTED_APP_PATHS)
  if (options.siteSettings) {
    removePaths(SITE_SETTINGS_PATHS)
    tasks.push((async () => {
      try {
        const prefPath = join(userDataPath, 'Default', 'Preferences')
        const raw = await readFile(prefPath, 'utf8')
        const data = JSON.parse(raw)
        if (data.profile?.content_settings) {
          delete data.profile.content_settings
          await writeFile(prefPath, JSON.stringify(data, null, 2), 'utf8')
        }
      } catch {}
    })())
  }

  await Promise.all(tasks)
  return profileStorageInfo(userDataPath)
}

export async function storageOverview(vaultPath: string): Promise<StorageOverview> {
  const profilesRoot = join(vaultPath, 'profiles')
  let profileEntries: string[] = []
  try {
    profileEntries = (await readdir(profilesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const [profilesBytes, recycleBytes, kernelsBytes, downloadsBytes, extensionsBytes, cacheParts] = await Promise.all([
    safePathSize(profilesRoot),
    safePathSize(join(vaultPath, 'recycle-bin')),
    safePathSize(join(vaultPath, 'kernels')),
    safePathSize(join(vaultPath, 'downloads')),
    safePathSize(join(vaultPath, 'extensions')),
    Promise.all(profileEntries.flatMap((id) => CACHE_PATHS.map((segments) => safePathSize(join(profilesRoot, id, 'user-data', ...segments)))))
  ])
  return {
    profilesBytes,
    cacheBytes: cacheParts.reduce((sum, size) => sum + size, 0),
    recycleBytes,
    kernelsBytes,
    downloadsBytes,
    extensionsBytes,
    totalBytes: profilesBytes + recycleBytes + kernelsBytes + downloadsBytes + extensionsBytes
  }
}
