import { describe, expect, it } from 'vitest'
import {
  fingerprintFlagCapability,
  isFingerprintFlagSupported,
  kernelCapabilityProfile,
  loadFingerprintCapabilities,
  parseKernelMajorVersion,
  unsupportedFingerprintFlags
} from './fingerprint-capabilities'

describe('fingerprint-capabilities', () => {
  it('loads the single-source capabilities table without non-Prism flags', () => {
    const table = loadFingerprintCapabilities()
    expect(table.schemaVersion).toBe(1)
    expect(table.flags['--fingerprint']).toBeDefined()
    expect(table.flags['--fingerprint-brand-version']).toBeDefined()
    expect(table.flags['--fingerprint-render-identity']?.minMajor).toBe(144)
    expect(table.flags['--disable-spoofing']?.minMajor).toBe(144)
    expect(table.flags['--fingerprint-location']).toBeDefined()
    expect(table.flags['--fingerprint-screen-width']).toBeDefined()
    expect(table.flags['--fingerprint-screen-height']).toBeDefined()
    expect(table.flags['--disable-non-proxied-udp']).toBeDefined()
    expect(table.flags['--fingerprinting-canvas-image-data-noise']).toBeUndefined()
  })

  it('parses major versions and evaluates flag support across 142, 144, and 153.x', () => {
    expect(parseKernelMajorVersion('153.0.7900.12')).toBe(153)
    expect(isFingerprintFlagSupported('--disable-spoofing', '142.0.7444.175', true)).toBe(false)
    expect(isFingerprintFlagSupported('--fingerprint-render-identity', '142.0.7444.175', true)).toBe(false)
    expect(isFingerprintFlagSupported('--fingerprint', '142.0.7444.175', true)).toBe(true)
    expect(isFingerprintFlagSupported('--disable-spoofing=gpu', '144.0.7559.132', true)).toBe(true)
    expect(isFingerprintFlagSupported('--fingerprint-render-identity', '153.0.7900.12', true)).toBe(true)
    expect(isFingerprintFlagSupported('--fingerprint', '153.0.7900.12', false)).toBe(false)
    expect(isFingerprintFlagSupported('--disable-non-proxied-udp', '153.0.7900.12', false)).toBe(true)
  })

  it('summarizes kernel capability ranges and unsupported flags', () => {
    const profile153 = kernelCapabilityProfile('153.0.7900.12', true)
    expect(profile153.major).toBe(153)
    expect(profile153.range?.id).toBe('prism-153-plus')
    expect(profile153.unsupportedFlags).toEqual([])

    const unsupported142 = unsupportedFingerprintFlags(
      ['--fingerprint=123', '--disable-spoofing=gpu', '--fingerprint-render-identity=v4', '--timezone=UTC'],
      '142.0.7444.175',
      true
    )
    expect(unsupported142).toEqual(['--disable-spoofing', '--fingerprint-render-identity'])
    expect(fingerprintFlagCapability('disable-spoofing')?.minMajor).toBe(144)
  })
})
