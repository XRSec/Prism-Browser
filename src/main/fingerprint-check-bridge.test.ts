import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FingerprintCheckBridge } from './fingerprint-check-bridge'
import { buildExpectedFingerprint, compareFingerprintExpectedVsRuntime } from '../shared/fingerprint-check'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FingerprintCheckBridge', () => {
  it('serves authenticated fingerprint checks and removes descriptor on stop', async () => {
    const runtimeDir = await mkdtemp(join(tmpdir(), 'prism-fp-bridge-'))
    tempDirs.push(runtimeDir)

    const profile: BrowserProfile = {
      ...defaultProfileDraft(1),
      id: 'profile-1',
      serialNumber: 1,
      status: 'running',
      favorite: false,
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z'
    }
    profile.fingerprint.hardwareProfileId = 'macos-host'
    profile.fingerprint.platform = 'macos'
    const expected = buildExpectedFingerprint(profile, { engineVersion: '153.0.7900.12', fingerprintKernel: true })
    const sampleReport = compareFingerprintExpectedVsRuntime(profile.id, profile.name, expected, {
      pageUrl: 'https://example.com/',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/153.0.0.0',
      webdriver: false,
      platform: expected.platform,
      hardwareConcurrency: expected.hardwareConcurrency,
      language: expected.language,
      languages: expected.languages,
      timezone: expected.timezone,
      screenWidth: expected.screenWidth,
      screenHeight: expected.screenHeight,
      devicePixelRatio: 2
    })

    const checkFingerprint = vi.fn(async () => sampleReport)
    const bridge = new FingerprintCheckBridge({
      runtimeDirectory: runtimeDir,
      isMcpEnabled: () => true,
      isProfileAllowed: (id) => id === 'profile-1',
      hasProfile: (id) => id === 'profile-1' || id === 'profile-denied',
      checkFingerprint
    })

    await bridge.start()
    const descriptor = JSON.parse(await readFile(join(runtimeDir, 'fingerprint-check-bridge.json'), 'utf8')) as {
      endpoint: string
      token: string
    }

    const unauthorized = await fetch(`${descriptor.endpoint}/v1/mcp/profiles/profile-1/check-fingerprint`, {
      method: 'POST'
    })
    expect(unauthorized.status).toBe(401)

    const denied = await fetch(`${descriptor.endpoint}/v1/mcp/profiles/profile-denied/check-fingerprint`, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}` }
    })
    expect(denied.status).toBe(403)
    expect((await denied.json()).error.code).toBe('PROFILE_NOT_ALLOWED')

    const ok = await fetch(`${descriptor.endpoint}/v1/mcp/profiles/profile-1/check-fingerprint`, {
      method: 'POST',
      headers: { authorization: `Bearer ${descriptor.token}` }
    })
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { result: typeof sampleReport }
    expect(body.result.overallStatus).toBe('pass')
    expect(checkFingerprint).toHaveBeenCalledWith('profile-1')

    await bridge.stop()
    await expect(readFile(join(runtimeDir, 'fingerprint-check-bridge.json'), 'utf8')).rejects.toThrow()
  })
})
