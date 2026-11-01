import { describe, expect, it } from 'vitest'
import { AnnouncementManager, compareVersions, GITHUB_RELEASES_URL } from './announcement-manager'

describe('AnnouncementManager (GitHub Releases)', () => {
  it('correctly compares semantic versions', () => {
    expect(compareVersions('0.3.23', '0.3.22')).toBeGreaterThan(0)
    expect(compareVersions('0.3.22', '0.3.23')).toBeLessThan(0)
    expect(compareVersions('0.3.23', '0.3.23')).toBe(0)
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0)
  })

  it('detects available update when GitHub release is newer', async () => {
    const mockRelease = {
      tag_name: 'v0.3.24',
      name: 'Prism Browser v0.3.24',
      body: 'Bug fixes and performance improvements.',
      published_at: '2026-11-01T12:00:00Z',
      html_url: 'https://github.com/XRSec/Prism-Browser/releases/tag/v0.3.24',
      assets: [
        {
          name: 'Prism.Browser-0.3.24-mac-arm64.dmg',
          browser_download_url: 'https://github.com/XRSec/Prism-Browser/releases/download/v0.3.24/Prism.Browser-0.3.24-mac-arm64.dmg'
        }
      ]
    }

    const mockFetch = async () => new Response(JSON.stringify(mockRelease), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })

    const manager = new AnnouncementManager('/resources', '0.3.23', undefined, undefined, mockFetch as any, 'darwin')
    const status = await manager.check()

    expect(status.state).toBe('available')
    expect(status.message).toContain('0.3.24')
    expect(status.announcement?.latestVersion).toBe('0.3.24')
    expect(status.announcement?.action?.url).toBe('https://github.com/XRSec/Prism-Browser/releases/download/v0.3.24/Prism.Browser-0.3.24-mac-arm64.dmg')
    expect(status.announcement?.action?.label).toContain('DMG')
  })

  it('marks as current when current version is equal or newer', async () => {
    const mockRelease = {
      tag_name: 'v0.3.23',
      name: 'Prism Browser v0.3.23',
      body: 'Release notes',
      published_at: '2026-11-01T12:00:00Z',
      html_url: 'https://github.com/XRSec/Prism-Browser/releases/tag/v0.3.23',
      assets: []
    }

    const mockFetch = async () => new Response(JSON.stringify(mockRelease), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })

    const manager = new AnnouncementManager('/resources', '0.3.23', undefined, undefined, mockFetch as any, 'darwin')
    const status = await manager.check()

    expect(status.state).toBe('current')
    expect(status.message).toBe('当前已是最新版本')
    expect(status.announcement?.latestVersion).toBe('0.3.23')
  })

  it('handles GitHub 403 rate limit gracefully', async () => {
    const mockFetch = async () => new Response('rate limit exceeded', { status: 403 })

    const manager = new AnnouncementManager('/resources', '0.3.23', undefined, undefined, mockFetch as any, 'darwin')
    const status = await manager.check()

    expect(status.state).toBe('available')
    expect(status.message).toContain('GitHub API')
    expect(status.announcement?.action?.url).toContain('github.com/XRSec/Prism-Browser/releases')
  })
})
