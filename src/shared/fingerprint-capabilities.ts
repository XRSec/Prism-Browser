import rawCapabilities from './fingerprint-capabilities.json'

export type FingerprintFlagCategory = 'identity' | 'hardware' | 'locale' | 'network' | 'rendering' | 'spoofing'
export type FingerprintFlagStatus = 'supported' | 'deprecated' | 'removed'

export interface FingerprintFlagCapability {
  category: FingerprintFlagCategory
  minMajor: number
  maxMajor: number | null
  status: FingerprintFlagStatus
  requiresFingerprintKernel: boolean
  notes: string
}

export interface FingerprintMajorRange {
  id: string
  minMajor: number
  maxMajor: number | null
  label: string
  notes: string
}

export interface FingerprintCapabilitiesTable {
  schemaVersion: number
  kernelFamily: string
  majorRanges: FingerprintMajorRange[]
  flags: Record<string, FingerprintFlagCapability>
}

export interface KernelCapabilitySummary {
  version: string | undefined
  major: number | undefined
  range: FingerprintMajorRange | undefined
  supportedFlags: string[]
  unsupportedFlags: string[]
}

const CAPABILITIES = rawCapabilities as FingerprintCapabilitiesTable

function normalizeFlagName(flag: string): string {
  const trimmed = flag.trim().split('=')[0]
  return trimmed.startsWith('--') ? trimmed : `--${trimmed}`
}

export function parseKernelMajorVersion(version: string | undefined): number | undefined {
  const match = version?.trim().match(/^(\d+)/)
  return match ? Number(match[1]) : undefined
}

export function loadFingerprintCapabilities(): FingerprintCapabilitiesTable {
  return CAPABILITIES
}

export function fingerprintFlagCapability(flag: string): FingerprintFlagCapability | undefined {
  return CAPABILITIES.flags[normalizeFlagName(flag)]
}

export function isFingerprintFlagSupported(
  flag: string,
  version: string | undefined,
  fingerprintKernel = true
): boolean {
  const capability = fingerprintFlagCapability(flag)
  if (!capability || capability.status === 'removed') return false
  if (capability.requiresFingerprintKernel && !fingerprintKernel) return false
  const major = parseKernelMajorVersion(version)
  if (major === undefined) return true
  if (major < capability.minMajor) return false
  if (capability.maxMajor !== null && major > capability.maxMajor) return false
  return true
}

export function unsupportedFingerprintFlags(
  flags: string[],
  version: string | undefined,
  fingerprintKernel = true
): string[] {
  const seen = new Set<string>()
  const unsupported: string[] = []
  for (const rawFlag of flags) {
    const normalized = normalizeFlagName(rawFlag)
    if (seen.has(normalized) || !CAPABILITIES.flags[normalized]) continue
    seen.add(normalized)
    if (!isFingerprintFlagSupported(normalized, version, fingerprintKernel)) {
      unsupported.push(normalized)
    }
  }
  return unsupported
}

export function kernelCapabilityProfile(
  version: string | undefined,
  fingerprintKernel = true
): KernelCapabilitySummary {
  const major = parseKernelMajorVersion(version)
  const range = major === undefined
    ? undefined
    : CAPABILITIES.majorRanges.find((entry) => major >= entry.minMajor && (entry.maxMajor === null || major <= entry.maxMajor))
  const supportedFlags: string[] = []
  const unsupportedFlags: string[] = []
  for (const flag of Object.keys(CAPABILITIES.flags)) {
    if (isFingerprintFlagSupported(flag, version, fingerprintKernel)) supportedFlags.push(flag)
    else unsupportedFlags.push(flag)
  }
  return { version, major, range, supportedFlags, unsupportedFlags }
}
