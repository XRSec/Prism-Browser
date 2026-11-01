import type { AnnouncementStatus, ProductAnnouncement } from '../shared/types'
import type { Logger } from './app-logger'

export const GITHUB_REPO = 'XRSec/Prism-Browser'
export const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

type FetchLike = typeof fetch

function compareVersions(first: string, second: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const [core, prerelease = ''] = value.split('-', 2)
    return {
      core: core.split('.').map((item) => Number(item)),
      prerelease: prerelease ? prerelease.split('.') : []
    }
  }
  const left = parse(first)
  const right = parse(second)
  for (let index = 0; index < 3; index++) {
    if ((left.core[index] ?? 0) !== (right.core[index] ?? 0)) {
      return (left.core[index] ?? 0) - (right.core[index] ?? 0)
    }
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index++) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1
    if (a === b) continue
    const aNumber = /^\d+$/.test(a)
    const bNumber = /^\d+$/.test(b)
    if (aNumber && bNumber) return Number(a) - Number(b)
    if (aNumber !== bNumber) return aNumber ? -1 : 1
    return a.localeCompare(b)
  }
  return 0
}

export class AnnouncementManager {
  private current: AnnouncementStatus = { state: 'disabled', message: '暂时无法检查更新' }

  constructor(
    private readonly resourcesPath: string,
    private readonly currentVersion: string,
    private readonly logger?: Logger,
    private readonly configOverride?: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly now: () => number = () => Date.now()
  ) {}

  status(): AnnouncementStatus {
    return structuredClone(this.current)
  }

  async check(): Promise<AnnouncementStatus> {
    try {
      const response = await this.fetchImpl(GITHUB_RELEASES_URL, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github.v3+json',
          'user-agent': `Prism-Browser/${this.currentVersion}`
        },
        signal: AbortSignal.timeout(10_000)
      })

      if (!response.ok) {
        if (response.status === 404) {
          this.current = { state: 'none', message: '暂无版本更新' }
          return this.status()
        }
        if (response.status === 403) {
          this.current = {
            state: 'available',
            message: 'GitHub API 访问达到限额，请直接前往 Release 页面',
            announcement: {
              id: 'github-rate-limited',
              title: 'Prism Browser GitHub Releases',
              body: 'GitHub API 请求次数受限，可直接访问官方 Release 页面下载更新。',
              severity: 'info',
              publishedAt: new Date().toISOString(),
              platforms: ['all', 'darwin', 'win32'],
              action: {
                label: '访问 Release 页面',
                url: `https://github.com/${GITHUB_REPO}/releases`
              }
            }
          }
          return this.status()
        }
        throw new Error(`GitHub 返回 HTTP ${response.status}`)
      }

      const text = await response.text()
      const release = JSON.parse(text)
      const tagName = typeof release.tag_name === 'string' ? release.tag_name : ''
      const latestVersion = tagName.replace(/^v/, '')
      if (!latestVersion) {
        this.current = { state: 'none', message: '暂无适用于当前版本的更新' }
        return this.status()
      }

      const assets = Array.isArray(release.assets) ? release.assets : []
      let targetAssetUrl = release.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`
      let actionLabel = '前往 GitHub 下载'

      if (this.platform === 'darwin') {
        const dmg = assets.find((a: any) => typeof a.name === 'string' && a.name.endsWith('.dmg'))
        const zip = assets.find((a: any) => typeof a.name === 'string' && a.name.endsWith('.zip'))
        const best = dmg ?? zip
        if (best?.browser_download_url) {
          targetAssetUrl = best.browser_download_url
          actionLabel = dmg ? '下载 DMG 安装包' : '下载 ZIP 压缩包'
        }
      } else if (this.platform === 'win32') {
        const exe = assets.find((a: any) => typeof a.name === 'string' && a.name.endsWith('.exe'))
        const msi = assets.find((a: any) => typeof a.name === 'string' && a.name.endsWith('.msi'))
        const zip = assets.find((a: any) => typeof a.name === 'string' && a.name.endsWith('.zip'))
        const best = exe ?? msi ?? zip
        if (best?.browser_download_url) {
          targetAssetUrl = best.browser_download_url
          actionLabel = exe ? '下载 EXE 安装包' : msi ? '下载 MSI 安装包' : '下载 ZIP 压缩包'
        }
      }

      const updateAvailable = compareVersions(latestVersion, this.currentVersion) > 0
      const announcement: ProductAnnouncement = {
        id: tagName,
        title: release.name || `Prism Browser ${tagName}`,
        body: release.body || '新版本已在 GitHub 发布，点击下方按钮前往下载。',
        severity: 'info',
        publishedAt: release.published_at || new Date().toISOString(),
        latestVersion,
        platforms: ['all', 'darwin', 'win32'],
        action: {
          label: actionLabel,
          url: targetAssetUrl
        }
      }

      this.current = updateAvailable
        ? { state: 'available', message: `发现新版本 ${latestVersion}`, announcement }
        : { state: 'current', message: '当前已是最新版本', announcement }

      return this.status()
    } catch (error) {
      this.logger?.error('检查 GitHub 仓库版本更新失败', error)
      this.current = { state: 'error', message: error instanceof Error ? error.message : String(error) }
      return this.status()
    }
  }
}

export { compareVersions }
