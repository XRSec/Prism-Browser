import { createHash, createPublicKey, verify } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { BrowserExtension } from '../shared/types'
import type { Logger } from './app-logger'

interface ChromeExtensionManifest {
  manifest_version?: number
  name?: string
  version?: string
  description?: string
  key?: string
  default_locale?: string
}

const WEB_STORE_HOST = 'chromewebstore.google.com'
const UPDATE_HOST = 'clients2.google.com'
const DOWNLOAD_HOST = 'clients2.googleusercontent.com'
const CRX3_MAGIC = Buffer.from('Cr24')
const CRX3_CONTEXT = Buffer.from('CRX3 SignedData\0', 'ascii')
const MAX_CRX_BYTES = 200 * 1024 * 1024
const MAX_ARCHIVE_FILES = 20_000
const MAX_REDIRECTS = 3

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0; let shift = 0; let offset = start
  while (offset < buffer.length && shift <= 49) {
    const byte = buffer[offset++]
    value += (byte & 127) * 2 ** shift
    if ((byte & 128) === 0) return { value, next: offset }
    shift += 7
  }
  throw new Error('CRX3 元数据格式无效')
}

interface ProtoField { number: number; wireType: number; bytes?: Buffer }

function parseProto(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = []; let offset = 0
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset); offset = tag.next
    const number = Math.floor(tag.value / 8); const wireType = tag.value & 7
    if (!number) throw new Error('CRX3 元数据字段无效')
    if (wireType === 2) {
      const length = readVarint(buffer, offset); offset = length.next
      if (length.value < 0 || offset + length.value > buffer.length) throw new Error('CRX3 元数据长度无效')
      fields.push({ number, wireType, bytes: buffer.subarray(offset, offset + length.value) })
      offset += length.value
    } else if (wireType === 0) { const value = readVarint(buffer, offset); offset = value.next; fields.push({ number, wireType }) }
    else if (wireType === 1) { if (offset + 8 > buffer.length) throw new Error('CRX3 元数据长度无效'); offset += 8; fields.push({ number, wireType }) }
    else if (wireType === 5) { if (offset + 4 > buffer.length) throw new Error('CRX3 元数据长度无效'); offset += 4; fields.push({ number, wireType }) }
    else throw new Error('CRX3 元数据包含不支持的字段')
  }
  return fields
}

function parseProof(buffer: Buffer): { publicKey: Buffer; signature: Buffer } {
  const fields = parseProto(buffer)
  const publicKey = fields.find((f) => f.number === 1 && f.wireType === 2)?.bytes
  const signature = fields.find((f) => f.number === 2 && f.wireType === 2)?.bytes
  if (!publicKey?.length || !signature?.length) throw new Error('CRX3 签名证明不完整')
  return { publicKey, signature }
}

function extensionIdFromPublicKey(publicKey: Buffer): string {
  const hex = createHash('sha256').update(publicKey).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
}

function parseChromeWebStoreUrl(input: string): { extensionId: string; listingUrl: string } {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new Error('请输入有效的 Chrome 应用商店地址') }
  if (url.protocol !== 'https:' || url.hostname !== WEB_STORE_HOST) throw new Error('只支持 Chrome 应用商店的 HTTPS 地址')
  const segments = url.pathname.split('/').filter(Boolean)
  const extensionId = segments.at(-1)?.toLowerCase() ?? ''
  if (!/^[a-p]{32}$/.test(extensionId) || !segments.includes('detail')) throw new Error('地址中没有有效的 Chrome 扩展 ID')
  return { extensionId, listingUrl: `https://${WEB_STORE_HOST}/detail/${extensionId}` }
}

function verifyCrx3(crx: Buffer, expectedExtensionId: string): { extensionId: string; publicKey: Buffer; archive: Buffer } {
  if (!/^[a-p]{32}$/.test(expectedExtensionId)) throw new Error('Chrome 扩展 ID 无效')
  if (crx.length < 16 || !crx.subarray(0, 4).equals(CRX3_MAGIC)) throw new Error('下载内容不是有效的 CRX 文件')
  if (crx.readUInt32LE(4) !== 3) throw new Error('仅支持 CRX3 扩展包')
  const headerLength = crx.readUInt32LE(8)
  const archiveOffset = 12 + headerLength
  if (headerLength <= 0 || archiveOffset >= crx.length) throw new Error('CRX3 文件头长度无效')
  const header = crx.subarray(12, archiveOffset)
  const fields = parseProto(header)
  const signedHeader = fields.find((f) => f.number === 10000 && f.wireType === 2)?.bytes
  if (!signedHeader?.length) throw new Error('CRX3 缺少签名数据')
  const crxId = parseProto(signedHeader).find((f) => f.number === 1 && f.wireType === 2)?.bytes
  if (!crxId || crxId.length !== 16) throw new Error('CRX3 扩展身份无效')
  const archive = crx.subarray(archiveOffset)
  if (archive.readUInt32LE(0) !== 67324752) throw new Error('CRX3 内容不是有效的 ZIP 扩展包')
  const length = Buffer.alloc(4); length.writeUInt32LE(signedHeader.length)
  const signedPayload = Buffer.concat([CRX3_CONTEXT, length, signedHeader, archive])
  const proofs = fields.filter((f) => (f.number === 2 || f.number === 3) && f.wireType === 2 && f.bytes).map((f) => parseProof(f.bytes!))
  for (const proof of proofs) {
    const digest = createHash('sha256').update(proof.publicKey).digest().subarray(0, 16)
    if (!digest.equals(crxId) || extensionIdFromPublicKey(proof.publicKey) !== expectedExtensionId) continue
    try {
      const key = createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' })
      if (verify('sha256', signedPayload, key, proof.signature)) return { extensionId: expectedExtensionId, publicKey: proof.publicKey, archive }
    } catch { /* try next proof */ }
  }
  throw new Error('CRX3 签名或扩展 ID 校验失败')
}

function crc32(buffer: Buffer): number {
  let crc = 4294967295
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0) }
  return (crc ^ 4294967295) >>> 0
}

function safeArchivePath(name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name)) throw new Error('扩展包包含不安全的文件路径')
  const normalized = posix.normalize(name)
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('扩展包包含越界文件路径')
  return normalized.replace(/\/$/, '')
}

async function extractVerifiedZip(archive: Buffer, destination: string): Promise<void> {
  const minimum = Math.max(0, archive.length - 65557); let eocd = -1
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 101010256) { eocd = offset; break }
  }
  if (eocd < 0) throw new Error('扩展 ZIP 目录无效')
  const fileCount = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (fileCount === 65535 || centralOffset === 4294967295 || centralSize === 4294967295) throw new Error('不支持 ZIP64 扩展包')
  if (fileCount > MAX_ARCHIVE_FILES || centralOffset + centralSize > eocd) throw new Error('扩展 ZIP 目录超出限制')
  const seen = new Set<string>(); let offset = centralOffset; let totalBytes = 0
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (let index = 0; index < fileCount; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 33639248) throw new Error('扩展 ZIP 文件项无效')
    const flags = archive.readUInt16LE(offset + 8); const method = archive.readUInt16LE(offset + 10)
    const checksum = archive.readUInt32LE(offset + 16); const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24); const nameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30); const commentLength = archive.readUInt16LE(offset + 32)
    const externalAttributes = archive.readUInt32LE(offset + 38); const localOffset = archive.readUInt32LE(offset + 42)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > archive.length) throw new Error('扩展 ZIP 文件名无效')
    const rawName = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const relative = safeArchivePath(rawName); offset = nextOffset
    if (!relative) continue
    if (seen.has(relative)) throw new Error('扩展 ZIP 包含重复文件')
    seen.add(relative)
    const unixMode = externalAttributes >>> 16
    if ((unixMode & 61440) === 40960) throw new Error('扩展 ZIP 不能包含符号链接')
    if (rawName.endsWith('/')) { await mkdir(join(destination, relative), { recursive: true, mode: 0o700 }); continue }
    if ((flags & 1) !== 0) throw new Error('不支持加密的扩展 ZIP')
    if (method !== 0 && method !== 8) throw new Error('扩展 ZIP 使用了不支持的压缩方式')
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 67324752) throw new Error('扩展 ZIP 本地文件头无效')
    const localNameLength = archive.readUInt16LE(localOffset + 26); const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    if (dataOffset + compressedSize > archive.length) throw new Error('扩展 ZIP 文件内容不完整')
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize)
    const content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_CRX_BYTES + 1 })
    if (content.length !== uncompressedSize || crc32(content) !== checksum) throw new Error('扩展 ZIP 文件校验失败')
    totalBytes += content.length
    if (totalBytes > MAX_CRX_BYTES) throw new Error('扩展解压后不能超过 200 MB')
    const target = join(destination, relative)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { mode: 0o600 })
  }
  if (offset !== centralOffset + centralSize) throw new Error('扩展 ZIP 中央目录长度不一致')
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_CRX_BYTES) throw new Error('商店扩展包不能超过 200 MB')
  if (!response.body) throw new Error('Chrome 应用商店未返回扩展内容')
  const chunks: Buffer[] = []; let bytes = 0
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength
    if (bytes > MAX_CRX_BYTES) throw new Error('商店扩展包不能超过 200 MB')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, bytes)
}

async function downloadChromeWebStoreExtension(input: string, fetcher: typeof fetch = fetch): Promise<{ extensionId: string; listingUrl: string; downloadUrl: string; crx: Buffer }> {
  const parsed = parseChromeWebStoreUrl(input)
  const x = encodeURIComponent(`id=${parsed.extensionId}&uc`)
  let current = new URL(`https://${UPDATE_HOST}/service/update2/crx?response=redirect&prodversion=150.0.0.0&acceptformat=crx3&x=${x}`)
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetcher(current.toString(), {
      method: 'GET',
      headers: { 'user-agent': 'Mozilla/5.0 Prism Browser Extension Installer' },
      redirect: 'manual',
      signal: AbortSignal.timeout(60000)
    })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location || redirect === MAX_REDIRECTS) throw new Error('Chrome 应用商店重定向无效')
      const next = new URL(location, current)
      if (next.protocol !== 'https:' || (next.hostname !== UPDATE_HOST && next.hostname !== DOWNLOAD_HOST)) throw new Error('Chrome 应用商店返回了不可信的下载地址')
      current = next; continue
    }
    if (!response.ok) {
      if (response.status === 204 || response.status === 404) throw new Error('Chrome 应用商店中未找到该扩展，或当前地区不可用')
      throw new Error(`Chrome 应用商店下载失败（HTTP ${response.status}）`)
    }
    if (current.hostname !== DOWNLOAD_HOST && current.hostname !== UPDATE_HOST) throw new Error('扩展下载来源不可信')
    return { ...parsed, downloadUrl: current.toString(), crx: await readBoundedBody(response) }
  }
  throw new Error('Chrome 应用商店重定向次数过多')
}

const MAX_EXTENSION_BYTES = 200 * 1024 * 1024
const MAX_EXTENSION_FILES = 20_000

async function inspectDirectory(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('扩展目录不能包含符号链接')
    if (!info.isDirectory()) {
      bytes += info.size
      files += 1
      if (bytes > MAX_EXTENSION_BYTES) throw new Error('扩展目录不能超过 200 MB')
      if (files > MAX_EXTENSION_FILES) throw new Error('扩展文件数量不能超过 20000 个')
      return
    }
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  await visit(root)
  return { bytes, files }
}

export class ExtensionStore {
  private readonly root: string
  private readonly extensions = new Map<string, BrowserExtension>()

  constructor(private readonly vaultPath: string, private readonly logger?: Logger) {
    this.root = join(vaultPath, 'extensions')
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        const metadata = JSON.parse(await readFile(join(this.root, entry.name, 'metadata.json'), 'utf8')) as BrowserExtension
        if (metadata.id !== entry.name || !/^[a-f\d-]{36}$/i.test(metadata.id)) throw new Error('扩展元数据 ID 无效')
        await access(join(this.root, entry.name, 'extension', 'manifest.json'))
        this.extensions.set(metadata.id, {
          ...metadata,
          globalEnabled: metadata.globalEnabled === true,
          path: join(this.root, entry.name, 'extension')
        })
      } catch (error) {
        this.logger?.error('忽略不完整的本地扩展', { id: entry.name, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  list(): BrowserExtension[] {
    return [...this.extensions.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map((item) => ({ ...item }))
  }

  paths(ids: string[]): string[] {
    const resolvedIds = [...new Set([
      ...ids,
      ...this.list().filter((extension) => extension.globalEnabled).map((extension) => extension.id)
    ])]
    return resolvedIds.map((id) => {
      const extension = this.extensions.get(id)
      if (!extension) throw new Error(`环境引用的扩展 ${id.slice(0, 8)} 不存在，请编辑环境配置`)
      return extension.path
    })
  }

  sourcePath(id: string): string {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('浏览器扩展 ID 无效')
    const extension = this.extensions.get(id)
    if (!extension) throw new Error('浏览器扩展不存在')
    return extension.path
  }

  async importWebStore(url: string, fetcher: typeof fetch = fetch): Promise<BrowserExtension> {
    const download = await downloadChromeWebStoreExtension(url, fetcher)
    const duplicate = this.list().find((e) => (e as any).storeId === download.extensionId)
    if (duplicate) throw new Error(`扩展"${duplicate.name}"已经从 Chrome 应用商店导入`)
    const verified = verifyCrx3(download.crx, download.extensionId)
    const temporary = join(this.root, `.web-store-${randomUUID()}`)
    const unpacked = join(temporary, 'extension')
    try {
      await extractVerifiedZip(verified.archive, unpacked)
      const manifestPath = join(unpacked, 'manifest.json')
      const manifest = await this.readManifest(manifestPath)
      if (manifest.key) {
        const encodedKey = manifest.key.replace(/\s/g, '')
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) || encodedKey.length % 4 !== 0) throw new Error('商店扩展 manifest 中的公钥无效')
        const manifestKey = Buffer.from(encodedKey, 'base64')
        if (!manifestKey.length || extensionIdFromPublicKey(manifestKey) !== download.extensionId) throw new Error('商店扩展 manifest 公钥与扩展 ID 不一致')
      } else {
        manifest.key = verified.publicKey.toString('base64')
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8', mode: 0o600 })
      }
      return await this.importValidatedDirectory(unpacked, { source: 'chrome-web-store', storeId: download.extensionId, sourceUrl: download.listingUrl })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  private async readManifest(manifestPath: string): Promise<ChromeExtensionManifest> {
    try {
      if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('扩展 manifest.json 不能超过 1 MB')
      return JSON.parse(await readFile(manifestPath, 'utf8')) as ChromeExtensionManifest
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('扩展 manifest.json 不是有效 JSON')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('所选目录缺少 manifest.json')
      throw error
    }
  }

  private async resolveMessage(source: string, value: string, manifest: ChromeExtensionManifest): Promise<string> {
    const match = /^__MSG_([^_].*?)__$/.exec(value)
    if (!match || typeof manifest.default_locale !== 'string' || !/^[A-Za-z0-9_@-]+$/.test(manifest.default_locale)) return value
    try {
      const messages = JSON.parse(await readFile(join(source, '_locales', manifest.default_locale, 'messages.json'), 'utf8')) as Record<string, { message?: string }>
      const entry = Object.entries(messages).find(([key]) => key.toLowerCase() === match[1].toLowerCase())?.[1]
      return typeof entry?.message === 'string' && entry.message.trim() ? entry.message.trim() : value
    } catch { return value }
  }

  private async importValidatedDirectory(source: string, origin: { source: string; storeId?: string; sourceUrl?: string }): Promise<BrowserExtension> {
    const manifestPath = join(source, 'manifest.json')
    const manifest = await this.readManifest(manifestPath)
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error('只支持 Manifest V2 或 V3 扩展')
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('扩展 manifest 缺少名称')
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('扩展 manifest 版本号无效')
    await inspectDirectory(source)
    const name = await this.resolveMessage(source, manifest.name, manifest)
    const id = randomUUID()
    const staging = join(this.root, `.import-${id}`)
    const target = join(this.root, id)
    await mkdir(staging, { recursive: true })
    try {
      await cp(source, join(staging, 'extension'), { recursive: true, errorOnExist: true })
      const extension: BrowserExtension = {
        id, name: name.startsWith('__MSG_') ? (origin.storeId ?? id.slice(0, 8)) : name.trim(),
        version: manifest.version, description: typeof manifest.description === 'string' ? manifest.description.trim() : '',
        manifestVersion: manifest.manifest_version, installedAt: new Date().toISOString(),
        path: join(target, 'extension'), globalEnabled: false,
        ...(origin.storeId ? { storeId: origin.storeId, sourceUrl: origin.sourceUrl } : {})
      }
      await writeFile(join(staging, 'metadata.json'), JSON.stringify(extension, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, target)
      this.extensions.set(id, extension)
      this.logger?.info('浏览器扩展已导入', { extensionId: id, name: extension.name, version: extension.version })
      return { ...extension }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async importDirectory(sourceInput: string): Promise<BrowserExtension> {
    const source = resolve(sourceInput)
    const root = resolve(this.root)
    if (source === root || source.startsWith(`${root}${sep}`)) throw new Error('不能从扩展仓库内部重复导入')
    const manifest = await this.readManifest(join(source, 'manifest.json'))
    if (manifest.manifest_version !== 2 && manifest.manifest_version !== 3) throw new Error('只支持 Manifest V2 或 V3 扩展')
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('扩展 manifest 缺少名称')
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('扩展 manifest 版本号无效')
    await inspectDirectory(source)
    const id = randomUUID()
    const staging = join(this.root, `.import-${id}`)
    const target = join(this.root, id)
    await mkdir(staging, { recursive: true })
    try {
      await cp(source, join(staging, 'extension'), { recursive: true, errorOnExist: true })
      const extension: BrowserExtension = {
        id,
        name: manifest.name.startsWith('__MSG_') ? basename(source) : manifest.name.trim(),
        version: manifest.version,
        description: typeof manifest.description === 'string' ? manifest.description.trim() : '',
        manifestVersion: manifest.manifest_version,
        installedAt: new Date().toISOString(),
        path: join(target, 'extension'),
        globalEnabled: false
      }
      await writeFile(join(staging, 'metadata.json'), JSON.stringify(extension, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(staging, target)
      this.extensions.set(id, extension)
      this.logger?.info('浏览器扩展已导入', { extensionId: id, name: extension.name, version: extension.version })
      return { ...extension }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async remove(id: string): Promise<void> {
    if (!/^[a-f\d-]{36}$/i.test(id) || !this.extensions.has(id)) throw new Error('浏览器扩展不存在')
    const recycle = join(this.vaultPath, 'recycle-bin', 'extensions')
    await mkdir(recycle, { recursive: true })
    await rename(join(this.root, id), join(recycle, `${id}-${Date.now()}`))
    this.extensions.delete(id)
    this.logger?.info('浏览器扩展已移入回收目录', { extensionId: id })
  }

  async setGlobalEnabled(id: string, enabled: boolean): Promise<BrowserExtension> {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('浏览器扩展 ID 无效')
    if (typeof enabled !== 'boolean') throw new Error('扩展全局启用状态无效')
    const current = this.extensions.get(id)
    if (!current) throw new Error('浏览器扩展不存在')
    const next = { ...current, globalEnabled: enabled }
    await writeFile(join(this.root, id, 'metadata.json'), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    this.extensions.set(id, next)
    this.logger?.info(enabled ? '浏览器扩展已全局启用' : '浏览器扩展已取消全局启用', { extensionId: id })
    return { ...next }
  }

  async rollbackMigrationImports(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.extensions.has(id)) continue
      this.extensions.delete(id)
      await rm(join(this.root, id), { recursive: true, force: true })
    }
  }
}
