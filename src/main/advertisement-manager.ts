import { createPublicKey, verify } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isUiLocale } from '../shared/i18n'
import { activationUrl, validateConfig } from './license-manager'
import { canonicalJson } from './license-crypto'

export interface AdvertisementItem {
  id: string
  title: string
  body: string
  label: string
  url: string
  enabled: boolean
  order: number
  durationSeconds: number
  tone: 'sage' | 'sand' | 'slate'
  platform: 'all' | 'darwin' | 'win32'
  startsAt?: string
  endsAt?: string
  localizations?: Record<string, { title: string; body?: string; label: string }>
}

export interface AdvertisementStatus {
  state: 'unavailable' | 'ready' | 'cached' | 'empty'
  items: AdvertisementItem[]
}

export interface AdvertisementManagerOptions {
  now?: () => number
  platform?: string
  fetch?: typeof fetch
  configPath?: string
}

const LIMIT = 512 * 1024
const CACHE_AGE = 7 * 24 * 60 * 60 * 1000

const text = (value: unknown, max: number, required = true): boolean =>
  typeof value === 'string' && value.length <= max && (!required || Boolean((value as string).trim()))

const validLocalizations = (value: unknown): boolean =>
  value === undefined ||
  Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value as object).length <= 13 &&
  Object.entries(value as object).every(([locale, item]) =>
    isUiLocale(locale) && Boolean(item) && typeof item === 'object' &&
    text((item as Record<string, unknown>)['title'], 80) &&
    text((item as Record<string, unknown>)['body'], 180, false) &&
    text((item as Record<string, unknown>)['label'], 20),
  )

const secureUrl = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function advertisementVisible(item: AdvertisementItem, now: number, platform: string): boolean {
  return item.enabled &&
    (item.platform === 'all' || item.platform === platform) &&
    (!item.startsAt || Date.parse(item.startsAt) <= now) &&
    (!item.endsAt || Date.parse(item.endsAt) > now)
}

function validateAdvertisementFeed(value: unknown, key: string): { payload: { items: AdvertisementItem[] }; signature: string } {
  const feed = value as { payload: { schemaVersion: number; product: string; revision: string; publishedAt: string; items: unknown[] }; signature: string }
  const p = feed?.payload
  if (!p || p.schemaVersion !== 1 || p.product !== 'prism-browser-advertisements' ||
      typeof p.revision !== 'string' || p.revision.length > 80 ||
      typeof p.publishedAt !== 'string' || !Number.isFinite(Date.parse(p.publishedAt)) ||
      !Array.isArray(p.items) || p.items.length > 20 ||
      new Set(p.items.map((i: unknown) => (i as Record<string, unknown>)?.['id'])).size !== p.items.length ||
      typeof feed.signature !== 'string' || Buffer.from(feed.signature, 'base64').length !== 64 ||
      !verify(null, Buffer.from(canonicalJson(p)), createPublicKey(key), Buffer.from(feed.signature, 'base64'))) {
    throw Error('广告签名无效')
  }
  for (const ad of p.items) {
    const a = ad as Record<string, unknown>
    if (!ad || typeof a['id'] !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(a['id'] as string) ||
        typeof a['title'] !== 'string' || !(a['title'] as string).trim() || (a['title'] as string).length > 80 ||
        typeof a['body'] !== 'string' || (a['body'] as string).length > 180 ||
        typeof a['label'] !== 'string' || !(a['label'] as string).trim() || (a['label'] as string).length > 20 ||
        !validLocalizations(a['localizations']) || !secureUrl(a['url']) ||
        typeof a['enabled'] !== 'boolean' ||
        !Number.isInteger(a['order']) || (a['order'] as number) < 0 || (a['order'] as number) > 999 ||
        !Number.isInteger(a['durationSeconds']) || (a['durationSeconds'] as number) < 5 || (a['durationSeconds'] as number) > 60 ||
        !['sage', 'sand', 'slate'].includes(a['tone'] as string) ||
        !['all', 'darwin', 'win32'].includes(a['platform'] as string) ||
        [a['startsAt'], a['endsAt']].some((t) => t !== undefined && (typeof t !== 'string' || !Number.isFinite(Date.parse(t as string)))) ||
        (a['startsAt'] && a['endsAt'] && Date.parse(a['startsAt'] as string) >= Date.parse(a['endsAt'] as string))) {
      throw Error('广告字段无效')
    }
  }
  return structuredClone(feed) as { payload: { items: AdvertisementItem[] }; signature: string }
}

async function limitedJson(response: Response): Promise<unknown> {
  if (!response.ok || Number(response.headers.get('content-length')) > LIMIT || !response.body) throw Error('广告响应无效')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > LIMIT) throw Error('广告响应过大')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export class AdvertisementManager {
  private vaultPath: string
  private resourcesPath: string
  private options: AdvertisementManagerOptions

  private items: AdvertisementItem[] = []
  private state: AdvertisementStatus['state'] = 'unavailable'
  private inFlight?: Promise<AdvertisementStatus>

  constructor(vaultPath: string, resourcesPath: string, options: AdvertisementManagerOptions = {}) {
    this.vaultPath = vaultPath
    this.resourcesPath = resourcesPath
    this.options = options
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  status(): AdvertisementStatus {
    const platform = this.options.platform ?? process.platform
    return {
      state: this.state,
      items: structuredClone(
        this.items
          .filter((ad) => advertisementVisible(ad, this.now(), platform))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      ),
    }
  }

  actionUrl(id: string): string {
    const ad = this.status().items.find((item) => item.id === id)
    if (!ad) throw Error('该内容已下架或不在展示时间内')
    return ad.url
  }

  check(): Promise<AdvertisementStatus> {
    if (!this.inFlight) this.inFlight = this.refresh().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  private async refresh(): Promise<AdvertisementStatus> {
    const cachePath = join(this.vaultPath, 'advertisements-cache.json')
    let key: string | undefined
    try {
      const config = validateConfig(JSON.parse(await readFile(this.options.configPath ?? join(this.resourcesPath, 'license-config.json'), 'utf8')))
      key = config.licensePublicKey
      try {
        const response = await (this.options.fetch ?? fetch)(activationUrl(config.activationBaseUrl, '/v1/advertisements/current'), {
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(7000),
        })
        const envelope = await limitedJson(response) as { schemaVersion: number; feed: unknown }
        if (envelope?.schemaVersion !== 1) throw Error('广告响应格式无效')
        const feed = envelope.feed === null ? null : validateAdvertisementFeed(envelope.feed, key)
        this.items = feed?.payload.items ?? []
        this.state = this.items.length ? 'ready' : 'empty'
        try {
          await mkdir(this.vaultPath, { recursive: true })
          const temporary = `${cachePath}.tmp`
          await writeFile(temporary, JSON.stringify({ fetchedAt: this.now(), feed }), { mode: 0o600 })
          await rename(temporary, cachePath)
        } catch { /* ignore cache write errors */ }
        return this.status()
      } catch {
        const text2 = await readFile(cachePath, 'utf8')
        if (Buffer.byteLength(text2) > LIMIT) throw Error('广告缓存过大')
        const cache = JSON.parse(text2) as { fetchedAt: number; feed: unknown }
        if (!Number.isFinite(cache.fetchedAt) || cache.fetchedAt > this.now() || this.now() - cache.fetchedAt > CACHE_AGE) throw Error('广告缓存已过期')
        this.items = cache.feed === null ? [] : validateAdvertisementFeed(cache.feed, key!).payload.items
        this.state = this.items.length ? 'cached' : 'empty'
      }
    } catch {
      this.items = []
      this.state = 'unavailable'
    }
    return this.status()
  }
}
