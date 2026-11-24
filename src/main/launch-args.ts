import type { BrowserProfile, ProxyCheckSummary } from '../shared/types'
import { effectiveDisabledSpoofing, effectiveFingerprintSeed } from '../shared/hardware-profiles'
import { hardwareProfile } from '../shared/hardware-profiles'
import { resolveFingerprintBrandVersion } from '../shared/fingerprint-consistency'
import { effectiveNetworkIdentity } from '../shared/network-identity'
import {
  fingerprintFlagCapability,
  isFingerprintFlagSupported,
  parseKernelMajorVersion
} from '../shared/fingerprint-capabilities'

export interface LaunchArgumentOptions {
  userDataDir: string
  proxyUrl?: string
  remoteDebuggingPort?: number
  extensionPaths?: string[]
  engineVersion?: string
  fingerprintKernel?: boolean
  hostHardwareConcurrency?: number
  hostPlatformVersion?: string
  proxyIdentity?: ProxyCheckSummary
  allowGeoConflict?: boolean
}

export type LaunchArgAuditSource =
  | 'fingerprint-config'
  | 'hardware-profile'
  | 'network-identity'
  | 'engine-align'
  | 'webrtc-policy'

export type LaunchArgAuditStatus = 'applied' | 'skipped-unsupported' | 'compat-ignored'

export interface LaunchFingerprintArgAuditEntry {
  flag: string
  value: string
  source: LaunchArgAuditSource
  status: LaunchArgAuditStatus
  reason?: string
}

export interface LaunchFingerprintAuditResult {
  args: string[]
  audit: LaunchFingerprintArgAuditEntry[]
}

export function profileWindowName(profile: Pick<BrowserProfile, 'serialNumber' | 'name'>): string {
  const name = profile.name
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Prism 环境'
  return `[${profile.serialNumber}] ${name}`
}

export function auditLaunchFingerprintArgs(
  profile: BrowserProfile,
  options: LaunchArgumentOptions
): LaunchFingerprintAuditResult {
  const fp = profile.fingerprint
  const hardware = hardwareProfile(fp.hardwareProfileId)
  const hardwareConcurrency = hardware?.hostMatched && options.hostHardwareConcurrency
    ? options.hostHardwareConcurrency
    : fp.hardwareConcurrency
  const platformVersion = hardware?.hostMatched && options.hostPlatformVersion
    ? options.hostPlatformVersion
    : fp.platformVersion
  const seed = effectiveFingerprintSeed(fp)
  const disabledSpoofing = effectiveDisabledSpoofing(fp)
  const hasEngineContext = options.fingerprintKernel !== undefined || Boolean(options.engineVersion)
  const fingerprintKernel = options.fingerprintKernel === true
  const brandVersion = resolveFingerprintBrandVersion(fp.brandVersion, {
    fingerprintKernel,
    version: options.engineVersion
  })
  const networkIdentity = effectiveNetworkIdentity(fp, options.proxyIdentity, {
    allowGeoConflict: options.allowGeoConflict
  })

  const args: string[] = [`--user-data-dir=${options.userDataDir}`]
  const audit: LaunchFingerprintArgAuditEntry[] = []

  const pushManagedFlag = (flag: string, value: string, source: LaunchArgAuditSource): void => {
    const formatted = `${flag}=${value}`
    if (!hasEngineContext) {
      args.push(formatted)
      audit.push({ flag, value, source, status: 'applied' })
      return
    }
    const cap = fingerprintFlagCapability(flag)
    if (cap?.requiresFingerprintKernel && !fingerprintKernel) {
      args.push(formatted)
      audit.push({
        flag,
        value,
        source,
        status: 'compat-ignored',
        reason: '兼容模式内核不会应用指纹伪装参数'
      })
      return
    }
    if (!isFingerprintFlagSupported(flag, options.engineVersion, fingerprintKernel)) {
      const minMajor = cap?.minMajor
      const major = parseKernelMajorVersion(options.engineVersion)
      audit.push({
        flag,
        value,
        source,
        status: 'skipped-unsupported',
        reason: minMajor && major !== undefined
          ? `Chromium ${major} 不支持 ${flag}（需 ${minMajor}+）`
          : `当前内核不支持 ${flag}`
      })
      return
    }
    args.push(formatted)
    audit.push({ flag, value, source, status: 'applied' })
  }

  const pushBooleanManagedFlag = (flag: string, source: LaunchArgAuditSource): void => {
    if (hasEngineContext && !isFingerprintFlagSupported(flag, options.engineVersion, fingerprintKernel)) {
      audit.push({ flag, value: 'true', source, status: 'skipped-unsupported', reason: `当前内核不支持 ${flag}` })
      return
    }
    args.push(flag)
    audit.push({ flag, value: 'true', source, status: 'applied' })
  }

  pushManagedFlag('--fingerprint', String(seed), 'hardware-profile')
  pushManagedFlag('--fingerprint-platform', fp.platform, 'hardware-profile')
  pushManagedFlag('--fingerprint-brand', fp.brand, 'fingerprint-config')
  pushManagedFlag('--fingerprint-hardware-concurrency', String(hardwareConcurrency), 'hardware-profile')
  pushManagedFlag('--fingerprint-screen-width', String(fp.screenWidth), 'hardware-profile')
  pushManagedFlag('--fingerprint-screen-height', String(fp.screenHeight), 'hardware-profile')
  pushManagedFlag('--fingerprint-language', networkIdentity.language, 'network-identity')
  pushManagedFlag('--lang', networkIdentity.language, 'network-identity')
  pushManagedFlag('--accept-lang', networkIdentity.acceptLanguages, 'network-identity')
  pushManagedFlag('--timezone', networkIdentity.timezone, 'network-identity')

  args.push(
    `--window-size=${profile.window.mode === 'custom' ? profile.window.width : fp.screenWidth},${profile.window.mode === 'custom' ? profile.window.height : fp.screenHeight}`,
    `--window-name=${profileWindowName(profile)}`,
    `--prism-profile-serial=${profile.serialNumber}`,
    `--prism-profile-id=${profile.id}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=TabGroups'
  )

  if (process.platform === 'darwin') {
    args.push('--use-mock-keychain', '--password-store=basic')
  } else if (process.platform === 'linux') {
    args.push('--password-store=basic')
  }

  if (profile.window.mode === 'custom') args.push(`--window-position=${profile.window.x},${profile.window.y}`)

  if (platformVersion) pushManagedFlag('--fingerprint-platform-version', platformVersion, 'hardware-profile')
  if (brandVersion) pushManagedFlag('--fingerprint-brand-version', brandVersion, 'engine-align')
  if (fp.renderIdentityVersion !== undefined) {
    pushManagedFlag('--fingerprint-render-identity', `v${fp.renderIdentityVersion}`, 'hardware-profile')
  }
  if (networkIdentity.latitude !== undefined && networkIdentity.longitude !== undefined) {
    pushManagedFlag(
      '--fingerprint-location',
      `${networkIdentity.latitude},${networkIdentity.longitude},${networkIdentity.accuracyMeters ?? 25000}`,
      'network-identity'
    )
  }
  if (disabledSpoofing.length) pushManagedFlag('--disable-spoofing', disabledSpoofing.join(','), 'fingerprint-config')
  if (fp.webrtcPolicy === 'proxy_only') {
    pushBooleanManagedFlag('--disable-non-proxied-udp', 'webrtc-policy')
    pushManagedFlag('--webrtc-ip-handling-policy', 'disable_non_proxied_udp', 'webrtc-policy')
  } else if (fp.webrtcPolicy === 'public_only') {
    pushManagedFlag('--webrtc-ip-handling-policy', 'default_public_interface_only', 'webrtc-policy')
  }
  if (options.proxyUrl) {
    args.push('--disable-quic')
    args.push('--dns-prefetch-disable')
    args.push('--no-pings')
    args.push(`--proxy-server=${options.proxyUrl}`)
    const defaultBypass = 'localhost;127.0.0.1'
    const customBypass = profile.proxy.bypassList?.trim()
    const bypassList = customBypass ? `${defaultBypass};${customBypass}` : defaultBypass
    args.push(`--proxy-bypass-list=${bypassList}`)
  }
  if (options.remoteDebuggingPort) args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`)
  if (options.extensionPaths?.length) args.push(`--load-extension=${options.extensionPaths.join(',')}`)
  args.push(...profile.startUrls)
  return { args, audit }
}

export function buildLaunchArgs(profile: BrowserProfile, options: LaunchArgumentOptions): string[] {
  return auditLaunchFingerprintArgs(profile, options).args
}
