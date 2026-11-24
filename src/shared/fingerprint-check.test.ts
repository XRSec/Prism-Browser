import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from './defaults'
import type { BrowserProfile, ProxyCheckSummary } from './types'
import {
  RUNTIME_FINGERPRINT_COLLECTOR_SCRIPT,
  buildExpectedFingerprint,
  compareFingerprintExpectedVsRuntime,
  type RuntimeFingerprintSnapshot
} from './fingerprint-check'

function makeProfile(overrides: Partial<BrowserProfile['fingerprint']> = {}): BrowserProfile {
  const draft = defaultProfileDraft(7)
  return {
    ...draft,
    id: 'profile-fp-test',
    serialNumber: 7,
    status: 'running',
    favorite: false,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    fingerprint: {
      ...draft.fingerprint,
      platform: 'macos',
      platformVersion: '15.0.0',
      brand: 'Chrome',
      brandVersion: '',
      hardwareProfileId: 'macos-m1',
      gpuBucket: 0,
      renderIdentityVersion: 4,
      hardwareConcurrency: 8,
      screenWidth: 1440,
      screenHeight: 900,
      language: 'en-US',
      acceptLanguages: 'en-US,en',
      timezone: 'America/New_York',
      networkIdentityMode: 'manual',
      disabledSpoofing: [],
      ...overrides
    }
  }
}

function makeMatchingRuntime(): RuntimeFingerprintSnapshot {
  return {
    pageUrl: 'https://example.com/',
    pageTitle: 'Example Domain',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    userAgentData: {
      platform: 'macOS',
      mobile: false,
      brands: [{ brand: 'Google Chrome', version: '153' }],
      fullVersionList: [{ brand: 'Google Chrome', version: '153.0.7900.12' }],
      platformVersion: '15.0.0'
    },
    webdriver: false,
    platform: 'MacIntel',
    hardwareConcurrency: 8,
    language: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
    screenWidth: 1440,
    screenHeight: 900,
    devicePixelRatio: 2,
    webglVendor: 'Google Inc. (Apple)',
    webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    canvasHash: '1a2b3c4d',
    clientRectsHash: '5e6f7a8b'
  }
}

describe('fingerprint-check', () => {
  it('computes expected values from profile, proxy identity, and engine version', () => {
    const proxyCheck: ProxyCheckSummary = {
      ok: true,
      ip: '1.2.3.4',
      latencyMs: 42,
      countryCode: 'JP',
      timezone: 'Asia/Tokyo',
      latitude: 35.6762,
      longitude: 139.6503,
      checkedAt: '2026-11-24T00:00:00.000Z'
    }
    const profile = makeProfile({ networkIdentityMode: 'proxy' })
    const expected = buildExpectedFingerprint(profile, {
      engineVersion: '153.0.7900.12',
      fingerprintKernel: true,
      proxyIdentity: proxyCheck
    })

    expect(expected.networkIdentitySource).toBe('proxy')
    expect(expected.language).toBe('ja-JP')
    expect(expected.languages).toEqual(['ja-JP', 'ja', 'en-US', 'en'])
    expect(expected.timezone).toBe('Asia/Tokyo')
    expect(expected.brandVersion).toBe('153.0.7900.12')
    expect(expected.brandMajor).toBe(153)
    expect(expected.capabilityRange).toBe('prism-153-plus')
    expect(expected.gpuMode).toBe('spoofed')
    expect(expected.gpuModel).toBe('Apple M1')
  })

  it('passes when runtime signals match expected values', () => {
    const profile = makeProfile()
    const expected = buildExpectedFingerprint(profile, {
      engineVersion: '153.0.7900.12',
      fingerprintKernel: true
    })
    const report = compareFingerprintExpectedVsRuntime(profile.id, profile.name, expected, makeMatchingRuntime())

    expect(report.overallStatus).toBe('pass')
    expect(report.summary.mismatchCount).toBe(0)
    expect(report.summary.highlights).toEqual([])
    expect(report.checks.find((c) => c.key === 'webdriver')?.status).toBe('match')
    expect(report.checks.find((c) => c.key === 'timezone')?.status).toBe('match')
    expect(report.checks.find((c) => c.key === 'webgl')?.status).toBe('match')
  })

  it('flags webdriver leaks, timezone/language drift, screen and core mismatches', () => {
    const profile = makeProfile()
    const expected = buildExpectedFingerprint(profile, {
      engineVersion: '153.0.7900.12',
      fingerprintKernel: true
    })
    const drifted: RuntimeFingerprintSnapshot = {
      ...makeMatchingRuntime(),
      webdriver: true,
      timezone: 'Asia/Shanghai',
      language: 'zh-CN',
      languages: ['zh-CN', 'zh'],
      hardwareConcurrency: 16,
      screenWidth: 1920,
      screenHeight: 1080,
      webglRenderer: 'ANGLE (Intel, Intel Iris Plus)'
    }
    const report = compareFingerprintExpectedVsRuntime(profile.id, profile.name, expected, drifted)

    expect(report.overallStatus).toBe('fail')
    expect(report.summary.mismatchCount).toBeGreaterThanOrEqual(6)
    expect(report.summary.highlights.some((h) => h.includes('webdriver'))).toBe(true)
    expect(report.summary.highlights.some((h) => h.includes('时区漂移'))).toBe(true)
    expect(report.summary.highlights.some((h) => h.includes('语言漂移'))).toBe(true)
    expect(report.summary.highlights.some((h) => h.includes('屏幕尺寸不一致'))).toBe(true)
    expect(report.summary.highlights.some((h) => h.includes('CPU 核心数不一致'))).toBe(true)
    expect(report.summary.highlights.some((h) => h.includes('WebGL GPU 不一致'))).toBe(true)
  })

  it('includes a valid self-contained collector script', () => {
    expect(RUNTIME_FINGERPRINT_COLLECTOR_SCRIPT).toContain('navigator.webdriver')
    expect(RUNTIME_FINGERPRINT_COLLECTOR_SCRIPT).toContain('WEBGL_debug_renderer_info')
    expect(RUNTIME_FINGERPRINT_COLLECTOR_SCRIPT).toContain('getClientRects')
  })
})
