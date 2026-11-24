import type { BrowserProfile, EngineStatus } from './types'
import { effectiveDisabledSpoofing } from './hardware-profiles'
import {
  fingerprintFlagCapability,
  isFingerprintFlagSupported,
  parseKernelMajorVersion
} from './fingerprint-capabilities'

export function fingerprintVersionWarning(brandVersion: string, engine: EngineStatus | null): string | undefined {
  if (!brandVersion.trim() || !engine?.fingerprintKernel || !engine.version) return undefined
  const requestedMajor = parseKernelMajorVersion(brandVersion)
  const engineMajor = parseKernelMajorVersion(engine.version)
  if (requestedMajor === undefined || engineMajor === undefined) return undefined
  if (requestedMajor !== engineMajor) return `品牌版本 ${brandVersion} 与指纹内核 ${engine.version} 的主版本不一致`
  if (brandVersion.trim() !== engine.version) return `启动时会将品牌版本 ${brandVersion} 统一为实际内核版本 ${engine.version}`
  return undefined
}

export function resolveFingerprintBrandVersion(brandVersion: string, engine: Pick<EngineStatus, 'fingerprintKernel' | 'version'>): string {
  if (engine.fingerprintKernel && engine.version) return engine.version
  return brandVersion.trim()
}

export function assertFingerprintKernelCompatibility(profile: BrowserProfile, engine: EngineStatus): void {
  const requestedMajor = parseKernelMajorVersion(profile.fingerprint.brandVersion)
  const engineMajor = parseKernelMajorVersion(engine.version)
  if (profile.fingerprint.brandVersion.trim() && engine.fingerprintKernel && requestedMajor !== undefined
      && engineMajor !== undefined && requestedMajor !== engineMajor) {
    throw new Error(`品牌版本 ${profile.fingerprint.brandVersion} 与指纹内核 ${engine.version} 的主版本不一致，请留空自动匹配`)
  }
  if (!engine.fingerprintKernel || !engine.version) return
  if (effectiveDisabledSpoofing(profile.fingerprint).length
      && !isFingerprintFlagSupported('--disable-spoofing', engine.version, engine.fingerprintKernel)) {
    const minMajor = fingerprintFlagCapability('--disable-spoofing')?.minMajor ?? 144
    throw new Error(`选择性关闭指纹伪装需要 Fingerprint Chromium ${minMajor} 或更高版本，当前为 ${engine.version}`)
  }
}
