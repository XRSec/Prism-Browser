import { createPublicKey, verify } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EngineStatus, KernelRelease } from '../shared/types'
import { activationUrl, validateConfig } from './license-manager'
import { canonicalJson } from './license-crypto'

const LIMIT = 256 * 1024

interface SignedCatalog {
  payload: {
    schemaVersion: number
    product: string
    publishedAt: string
    artifacts: Array<{
      version: string
      target: string
      assetName: string
      size: number
      sha256: string
      urls: string[]
    }>
  }
  signature: string
}

export function validateKernelCatalog(value: unknown, publicKey: string, target = `${process.platform}-${process.arch}`): KernelRelease[] {
  const signed = value as SignedCatalog
  const payload = signed?.payload
  if (!payload || payload.schemaVersion !== 1 || payload.product !== 'prism-kernel-catalog'
    || !Number.isFinite(Date.parse(payload.publishedAt)) || !Array.isArray(payload.artifacts)
    || payload.artifacts.length > 100 || typeof signed.signature !== 'string'
    || Buffer.from(signed.signature, 'base64').length !== 64
    || !verify(null, Buffer.from(canonicalJson(payload)), createPublicKey(publicKey), Buffer.from(signed.signature, 'base64'))) {
    throw new Error('内核版本目录签名无效')
  }
  const identities = new Set<string>()
  for (const item of payload.artifacts) {
    if (!item || !/^\d+(?:\.\d+){3}$/.test(item.version)
      || !['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'].includes(item.target)
      || !/^Prism-Kernel-[A-Za-z0-9._-]+\.(dmg|zip)$/.test(item.assetName)
      || (item.target.startsWith('darwin') ? !item.assetName.endsWith('.dmg') : !item.assetName.endsWith('.zip'))
      || !Number.isSafeInteger(item.size) || item.size < 1e7 || item.size > 2e9
      || !/^[a-f\d]{64}$/.test(item.sha256) || !Array.isArray(item.urls) || item.urls.length < 1
      || item.urls.length > 4 || item.urls.some((raw) => {
        try {
          const u = new URL(raw)
          return typeof raw !== 'string' || raw.length > 2048 || u.protocol !== 'https:' || Boolean(u.username || u.password || u.hash)
        } catch {
          return true
        }
      })) {
      throw new Error('内核版本目录字段无效')
    }
    const id = `${item.version}/${item.target}`
    if (identities.has(id)) throw new Error('内核版本目录重复')
    identities.add(id)
  }
  return payload.artifacts.filter((item) => item.target === target).map((item) => ({
    version: item.version,
    publishedAt: payload.publishedAt,
    assetName: item.assetName,
    size: item.size,
    sha256: item.sha256,
    downloadUrl: item.urls[0],
    mirrorUrls: item.urls.slice(1),
    installed: false,
    remoteAvailable: true,
    origin: 'release' as const
  }))
}

export class KernelReleaseCatalog {
  constructor(
    private readonly vaultPath: string,
    private readonly resourcesPath: string,
    private readonly options: { configPath?: string; now?: () => number; fetch?: typeof fetch } = {}
  ) {}

  async releases(): Promise<KernelRelease[]> {
    const configPath = this.options.configPath ?? join(this.resourcesPath, 'license-config.json')
    const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')))
    const cachePath = join(this.vaultPath, 'kernel-catalog-cache.json')
    const now = (this.options.now ?? Date.now)()
    try {
      const fetcher = this.options.fetch ?? fetch
      const response = await fetcher(activationUrl(config.activationBaseUrl, '/v1/kernels/current'), {
        redirect: 'error',
        signal: AbortSignal.timeout(12_000)
      })
      if (!response.ok || !response.body) throw new Error(`版本目录 HTTP ${response.status}`)
      const text = await response.text()
      if (Buffer.byteLength(text) > LIMIT) throw new Error('版本目录过大')
      const signed = JSON.parse(text)
      const releases = validateKernelCatalog(signed, config.licensePublicKey)
      try {
        await mkdir(this.vaultPath, { recursive: true })
        await writeFile(`${cachePath}.tmp`, JSON.stringify({ fetchedAt: now, signed }), { mode: 0o600 })
        await rename(`${cachePath}.tmp`, cachePath)
      } catch {}
      return releases
    } catch (error) {
      try {
        const text = await readFile(cachePath, 'utf8')
        if (Buffer.byteLength(text) > LIMIT + 256) throw new Error('缓存过大')
        const cache = JSON.parse(text)
        if (!Number.isFinite(cache.fetchedAt) || cache.fetchedAt > now || now - cache.fetchedAt > 30 * 864e5) {
          throw new Error('缓存过期')
        }
        return validateKernelCatalog(cache.signed, config.licensePublicKey)
      } catch {
        throw new Error(`无法获取可下载内核，本地版本仍可使用：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

/**
 * The copy shipped with Prism is authoritative for a bundled version. A stale
 * user-imported copy with the same version must not hide it in the UI.
 */
export function mergeKernelCatalog(managed: KernelRelease[], bundled: EngineStatus[]): KernelRelease[] {
  const byVersion = new Map(managed.map((kernel) => [kernel.version, kernel]))
  for (const engine of bundled) {
    if (!engine.version || !engine.executable) continue
    byVersion.set(engine.version, {
      version: engine.version,
      publishedAt: '',
      assetName: 'bundled-with-prism',
      downloadUrl: '',
      size: 0,
      sha256: '',
      installed: true,
      remoteAvailable: false,
      origin: 'bundled',
      executable: engine.executable
    })
  }
  return [...byVersion.values()]
    .sort((first, second) => second.version.localeCompare(first.version, undefined, { numeric: true }))
}
