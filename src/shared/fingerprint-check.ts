import type { BrowserBrand, BrowserProfile, ProxyCheckSummary } from './types'
import { effectiveDisabledSpoofing, effectiveGpuIdentity, hardwareProfile } from './hardware-profiles'
import { effectiveNetworkIdentity } from './network-identity'
import { resolveFingerprintBrandVersion } from './fingerprint-consistency'
import { kernelCapabilityProfile, parseKernelMajorVersion } from './fingerprint-capabilities'

export type FingerprintCheckStatus = 'match' | 'mismatch' | 'info'
export type FingerprintCheckOverallStatus = 'pass' | 'warn' | 'fail'

export interface ExpectedFingerprintOptions {
  engineVersion?: string
  fingerprintKernel?: boolean
  hostHardwareConcurrency?: number
  hostPlatformVersion?: string
  proxyIdentity?: ProxyCheckSummary
  allowGeoConflict?: boolean
  launchArgs?: string[]
  skippedFlags?: Array<{ flag: string; reason?: string }>
}

export interface ExpectedFingerprintSnapshot {
  fingerprintKernel: boolean
  engineVersion?: string
  capabilityRange?: string
  platform: 'MacIntel' | 'Win32'
  userAgentPlatform: 'macOS' | 'Windows'
  brand: BrowserBrand
  brandVersion?: string
  brandMajor?: number
  webdriver: false
  hardwareConcurrency: number
  platformVersion?: string
  language: string
  languages: string[]
  timezone: string
  networkIdentitySource: 'manual' | 'proxy'
  screenWidth: number
  screenHeight: number
  hardwareProfileId: string
  gpuModel?: string
  gpuMode: 'host-native' | 'spoofed' | 'default'
  canvasMode: 'host-native' | 'spoofed'
  clientRectsMode: 'host-native' | 'spoofed'
  launchFlags: string[]
  skippedFlags?: Array<{ flag: string; reason?: string }>
}

export interface RuntimeUserAgentDataBrand {
  brand: string
  version: string
}

export interface RuntimeUserAgentData {
  platform?: string
  mobile?: boolean
  brands?: RuntimeUserAgentDataBrand[]
  fullVersionList?: RuntimeUserAgentDataBrand[]
  platformVersion?: string
  architecture?: string
  model?: string
}

export interface RuntimeFingerprintSnapshot {
  pageUrl: string
  pageTitle?: string
  userAgent: string
  userAgentData?: RuntimeUserAgentData
  webdriver: boolean
  platform: string
  hardwareConcurrency: number | null
  language: string
  languages: string[]
  timezone: string
  screenWidth: number | null
  screenHeight: number | null
  devicePixelRatio: number | null
  webglVendor?: string
  webglRenderer?: string
  canvasHash?: string
  clientRectsHash?: string
}

export interface FingerprintCheckItem {
  key: string
  label: string
  category: 'automation' | 'identity' | 'locale' | 'hardware' | 'rendering'
  expected: string
  runtime: string
  status: FingerprintCheckStatus
  detail?: string
}

export interface FingerprintCheckReport {
  profileId: string
  profileName: string
  checkedAt: string
  overallStatus: FingerprintCheckOverallStatus
  summary: {
    matchCount: number
    mismatchCount: number
    infoCount: number
    highlights: string[]
  }
  expected: ExpectedFingerprintSnapshot
  runtime: RuntimeFingerprintSnapshot
  checks: FingerprintCheckItem[]
}

/**
 * Self-contained page-context script evaluated via CDP `Runtime.evaluate`
 * (`awaitPromise: true`, `returnByValue: true`) to collect runtime fingerprint signals.
 */
export const RUNTIME_FINGERPRINT_COLLECTOR_SCRIPT = `(async () => {
  const fnv1a = (input) => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  let userAgentData;
  if (navigator.userAgentData) {
    const base = {
      platform: navigator.userAgentData.platform || '',
      mobile: Boolean(navigator.userAgentData.mobile),
      brands: Array.isArray(navigator.userAgentData.brands)
        ? navigator.userAgentData.brands.map((b) => ({ brand: String(b.brand || ''), version: String(b.version || '') }))
        : []
    };
    try {
      if (typeof navigator.userAgentData.getHighEntropyValues === 'function') {
        const high = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'model']);
        if (Array.isArray(high.fullVersionList)) {
          base.fullVersionList = high.fullVersionList.map((b) => ({ brand: String(b.brand || ''), version: String(b.version || '') }));
        }
        if (typeof high.platformVersion === 'string') base.platformVersion = high.platformVersion;
        if (typeof high.architecture === 'string') base.architecture = high.architecture;
        if (typeof high.model === 'string') base.model = high.model;
      }
    } catch {}
    userAgentData = base;
  }

  let webglVendor;
  let webglRenderer;
  try {
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl') || glCanvas.getContext('webgl2');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        webglVendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '');
        webglRenderer = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      } else {
        webglVendor = String(gl.getParameter(gl.VENDOR) || '');
        webglRenderer = String(gl.getParameter(gl.RENDERER) || '');
      }
    }
  } catch {}

  let canvasHash;
  try {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 60;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial, sans-serif';
      ctx.fillStyle = '#f60';
      ctx.fillRect(10, 8, 80, 24);
      ctx.fillStyle = '#069';
      ctx.fillText('PrismFP-153', 14, 12);
      ctx.strokeStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.beginPath();
      ctx.arc(160, 30, 18, 0, Math.PI * 2);
      ctx.stroke();
      canvasHash = fnv1a(c.toDataURL());
    }
  } catch {}

  let clientRectsHash;
  try {
    const parent = document.body || document.documentElement;
    if (parent) {
      const probe = document.createElement('span');
      probe.textContent = 'PrismRectProbe_1234567890_Wm';
      probe.style.cssText = 'position:fixed;left:-9999px;top:-9999px;font-size:16px;font-family:sans-serif;line-height:normal;';
      parent.appendChild(probe);
      try {
        const rects = Array.from(probe.getClientRects()).map((r) => [r.x, r.y, r.width, r.height].map((n) => Number(n).toFixed(4)).join(','));
        clientRectsHash = fnv1a(rects.join('|'));
      } finally {
        probe.remove();
      }
    }
  } catch {}

  let timezone = '';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {}

  return {
    pageUrl: String(location.href || ''),
    pageTitle: String(document.title || ''),
    userAgent: String(navigator.userAgent || ''),
    userAgentData,
    webdriver: Boolean(navigator.webdriver),
    platform: String(navigator.platform || ''),
    hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    language: String(navigator.language || ''),
    languages: Array.isArray(navigator.languages) ? navigator.languages.map((item) => String(item)) : [],
    timezone,
    screenWidth: typeof window.screen?.width === 'number' ? window.screen.width : null,
    screenHeight: typeof window.screen?.height === 'number' ? window.screen.height : null,
    devicePixelRatio: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : null,
    webglVendor,
    webglRenderer,
    canvasHash,
    clientRectsHash
  };
})()`

function extractFingerprintLaunchFlags(launchArgs: string[]): string[] {
  return launchArgs.filter((arg) =>
    arg.startsWith('--fingerprint')
    || arg.startsWith('--disable-spoofing')
    || arg.startsWith('--lang=')
    || arg.startsWith('--accept-lang=')
    || arg.startsWith('--timezone=')
    || arg === '--disable-non-proxied-udp'
    || arg.startsWith('--webrtc-ip-handling-policy=')
  )
}

export function buildExpectedFingerprint(
  profile: BrowserProfile,
  options: ExpectedFingerprintOptions = {}
): ExpectedFingerprintSnapshot {
  const fp = profile.fingerprint
  const fingerprintKernel = options.fingerprintKernel === true
  const hardware = hardwareProfile(fp.hardwareProfileId)
  const hardwareConcurrency = hardware?.hostMatched && options.hostHardwareConcurrency
    ? options.hostHardwareConcurrency
    : fp.hardwareConcurrency
  const platformVersion = hardware?.hostMatched && options.hostPlatformVersion
    ? options.hostPlatformVersion
    : fp.platformVersion
  const brandVersion = resolveFingerprintBrandVersion(fp.brandVersion, {
    fingerprintKernel,
    version: options.engineVersion
  })
  const networkIdentity = effectiveNetworkIdentity(fp, options.proxyIdentity, {
    allowGeoConflict: options.allowGeoConflict
  })
  const disabledSpoofing = effectiveDisabledSpoofing(fp)
  const gpu = effectiveGpuIdentity(fp)
  const capability = kernelCapabilityProfile(options.engineVersion, fingerprintKernel)

  return {
    fingerprintKernel,
    engineVersion: options.engineVersion,
    capabilityRange: capability.range?.id,
    platform: fp.platform === 'macos' ? 'MacIntel' : 'Win32',
    userAgentPlatform: fp.platform === 'macos' ? 'macOS' : 'Windows',
    brand: fp.brand,
    brandVersion: brandVersion || undefined,
    brandMajor: parseKernelMajorVersion(brandVersion || options.engineVersion),
    webdriver: false,
    hardwareConcurrency,
    platformVersion: platformVersion || undefined,
    language: networkIdentity.language,
    languages: networkIdentity.acceptLanguages.split(',').map((item) => item.trim()).filter(Boolean),
    timezone: networkIdentity.timezone,
    networkIdentitySource: networkIdentity.source,
    screenWidth: fp.screenWidth,
    screenHeight: fp.screenHeight,
    hardwareProfileId: fp.hardwareProfileId,
    gpuModel: gpu?.model,
    gpuMode: disabledSpoofing.includes('gpu') ? 'host-native' : gpu ? 'spoofed' : 'default',
    canvasMode: disabledSpoofing.includes('canvas') ? 'host-native' : 'spoofed',
    clientRectsMode: disabledSpoofing.includes('clientrects') ? 'host-native' : 'spoofed',
    launchFlags: options.launchArgs ? extractFingerprintLaunchFlags(options.launchArgs) : [],
    ...(options.skippedFlags?.length ? { skippedFlags: options.skippedFlags } : {})
  }
}

function normalizeLocale(value: string): string {
  return value.trim().toLowerCase()
}

function findBrandEntry(
  list: RuntimeUserAgentDataBrand[] | undefined,
  brand: BrowserBrand
): RuntimeUserAgentDataBrand | undefined {
  if (!list?.length) return undefined
  const needle = brand === 'Edge' ? 'edge' : 'chrome'
  return list.find((entry) => entry.brand.toLowerCase().includes(needle))
}

export function compareFingerprintExpectedVsRuntime(
  profileId: string,
  profileName: string,
  expected: ExpectedFingerprintSnapshot,
  runtime: RuntimeFingerprintSnapshot,
  checkedAt = new Date().toISOString()
): FingerprintCheckReport {
  const checks: FingerprintCheckItem[] = []
  const highlights: string[] = []

  // 1. WebDriver leak check (always critical)
  const webdriverMatch = runtime.webdriver === false
  checks.push({
    key: 'webdriver',
    label: 'WebDriver 自动化标识',
    category: 'automation',
    expected: 'false',
    runtime: String(runtime.webdriver),
    status: webdriverMatch ? 'match' : 'mismatch',
    detail: webdriverMatch ? undefined : 'navigator.webdriver 为 true，存在自动化特征泄漏'
  })
  if (!webdriverMatch) {
    highlights.push('webdriver 泄漏：navigator.webdriver 为 true')
  }

  // 2. navigator.platform
  const platformStatus: FingerprintCheckStatus = !expected.fingerprintKernel
    ? 'info'
    : runtime.platform === expected.platform
      ? 'match'
      : 'mismatch'
  checks.push({
    key: 'platform',
    label: 'navigator.platform',
    category: 'identity',
    expected: expected.fingerprintKernel ? expected.platform : `${expected.platform}（兼容模式不强制）`,
    runtime: runtime.platform || '—',
    status: platformStatus
  })
  if (platformStatus === 'mismatch') {
    highlights.push(`platform 不一致：期望 ${expected.platform}，实测 ${runtime.platform || '空'}`)
  }

  // 3. userAgent
  const uaBrandToken = expected.brand === 'Edge' ? 'Edg/' : 'Chrome/'
  const uaMajorToken = expected.brandMajor ? `${uaBrandToken}${expected.brandMajor}.` : uaBrandToken
  const uaOsToken = expected.userAgentPlatform === 'macOS' ? 'Macintosh' : 'Windows NT'
  const uaHasOs = runtime.userAgent.includes(uaOsToken)
  const uaHasBrand = runtime.userAgent.includes(uaMajorToken)
  const uaStatus: FingerprintCheckStatus = !expected.fingerprintKernel
    ? 'info'
    : uaHasOs && uaHasBrand
      ? 'match'
      : 'mismatch'
  checks.push({
    key: 'userAgent',
    label: 'User-Agent',
    category: 'identity',
    expected: expected.brandMajor ? `${expected.userAgentPlatform} · ${uaMajorToken}x` : expected.userAgentPlatform,
    runtime: runtime.userAgent || '—',
    status: uaStatus,
    detail: uaStatus === 'mismatch' ? 'User-Agent 系统或主版本与预期不符' : undefined
  })
  if (uaStatus === 'mismatch') {
    highlights.push(`User-Agent 不一致：未包含预期的 ${uaOsToken} / ${uaMajorToken}`)
  }

  // 4. userAgentData (UA-CH)
  const uach = runtime.userAgentData
  const uachBrand = findBrandEntry(uach?.fullVersionList, expected.brand) ?? findBrandEntry(uach?.brands, expected.brand)
  const uachPlatformOk = !uach?.platform || uach.platform === expected.userAgentPlatform
  const uachMajorOk = !expected.brandMajor || !uachBrand || Number(uachBrand.version.split('.')[0]) === expected.brandMajor
  const uachStatus: FingerprintCheckStatus = !expected.fingerprintKernel || !uach
    ? 'info'
    : uachPlatformOk && uachMajorOk && Boolean(uachBrand)
      ? 'match'
      : 'mismatch'
  checks.push({
    key: 'userAgentData',
    label: 'UA-CH (userAgentData)',
    category: 'identity',
    expected: `${expected.userAgentPlatform} · ${expected.brand} ${expected.brandVersion ?? expected.brandMajor ?? ''}`.trim(),
    runtime: uach
      ? `${uach.platform || '—'} · ${uachBrand ? `${uachBrand.brand} ${uachBrand.version}` : '未匹配品牌'}`
      : '不可用（仅安全上下文或浏览器不支持）',
    status: uachStatus
  })
  if (uachStatus === 'mismatch') {
    highlights.push(`UA-CH 不一致：期望 ${expected.userAgentPlatform} / ${expected.brand} ${expected.brandMajor ?? ''}`)
  }

  // 5. hardwareConcurrency
  const cpuStatus: FingerprintCheckStatus = !expected.fingerprintKernel || runtime.hardwareConcurrency === null
    ? 'info'
    : runtime.hardwareConcurrency === expected.hardwareConcurrency
      ? 'match'
      : 'mismatch'
  checks.push({
    key: 'hardwareConcurrency',
    label: 'CPU 核心数 (hardwareConcurrency)',
    category: 'hardware',
    expected: String(expected.hardwareConcurrency),
    runtime: runtime.hardwareConcurrency === null ? '—' : String(runtime.hardwareConcurrency),
    status: cpuStatus
  })
  if (cpuStatus === 'mismatch') {
    highlights.push(`CPU 核心数不一致：期望 ${expected.hardwareConcurrency}，实测 ${runtime.hardwareConcurrency}`)
  }

  // 6. language
  const langMatch = normalizeLocale(runtime.language) === normalizeLocale(expected.language)
  const langStatus: FingerprintCheckStatus = langMatch
    ? 'match'
    : expected.fingerprintKernel
      ? 'mismatch'
      : 'info'
  checks.push({
    key: 'language',
    label: '主语言 (navigator.language)',
    category: 'locale',
    expected: `${expected.language}（${expected.networkIdentitySource === 'proxy' ? '代理联动' : '手动配置'}）`,
    runtime: runtime.language || '—',
    status: langStatus
  })
  if (langStatus === 'mismatch') {
    highlights.push(`语言漂移：期望 ${expected.language}，实测 ${runtime.language || '空'}`)
  }

  // 7. languages
  const runtimeLanguagesNorm = runtime.languages.map(normalizeLocale)
  const expectedLanguagesNorm = expected.languages.map(normalizeLocale)
  const primaryLangMatches = runtimeLanguagesNorm[0] === expectedLanguagesNorm[0]
  const fullListMatches = runtimeLanguagesNorm.length === expectedLanguagesNorm.length
    && runtimeLanguagesNorm.every((item, idx) => item === expectedLanguagesNorm[idx])
  const langsStatus: FingerprintCheckStatus = fullListMatches
    ? 'match'
    : !expected.fingerprintKernel
      ? 'info'
      : primaryLangMatches
        ? 'info'
        : 'mismatch'
  checks.push({
    key: 'languages',
    label: '语言列表 (navigator.languages)',
    category: 'locale',
    expected: expected.languages.join(', '),
    runtime: runtime.languages.join(', ') || '—',
    status: langsStatus,
    detail: !fullListMatches && primaryLangMatches ? '主语言一致，次级回退列表有差异' : undefined
  })
  if (langsStatus === 'mismatch') {
    highlights.push(`语言列表漂移：期望 ${expected.languages.join(',')}，实测 ${runtime.languages.join(',') || '空'}`)
  }

  // 8. timezone
  const tzMatch = runtime.timezone === expected.timezone
  checks.push({
    key: 'timezone',
    label: '时区 (Intl TimeZone)',
    category: 'locale',
    expected: `${expected.timezone}（${expected.networkIdentitySource === 'proxy' ? '代理联动' : '手动配置'}）`,
    runtime: runtime.timezone || '—',
    status: tzMatch ? 'match' : 'mismatch'
  })
  if (!tzMatch) {
    highlights.push(`时区漂移：期望 ${expected.timezone}，实测 ${runtime.timezone || '空'}`)
  }

  // 9. screenWidth / screenHeight
  const screenKnown = runtime.screenWidth !== null && runtime.screenHeight !== null
  const screenMatch = runtime.screenWidth === expected.screenWidth && runtime.screenHeight === expected.screenHeight
  const screenStatus: FingerprintCheckStatus = !expected.fingerprintKernel || !screenKnown
    ? 'info'
    : screenMatch
      ? 'match'
      : 'mismatch'
  checks.push({
    key: 'screen',
    label: '屏幕尺寸 (screen.width × height)',
    category: 'hardware',
    expected: `${expected.screenWidth} × ${expected.screenHeight}`,
    runtime: screenKnown ? `${runtime.screenWidth} × ${runtime.screenHeight}` : '—',
    status: screenStatus
  })
  if (screenStatus === 'mismatch') {
    highlights.push(`屏幕尺寸不一致：期望 ${expected.screenWidth}×${expected.screenHeight}，实测 ${runtime.screenWidth}×${runtime.screenHeight}`)
  }

  // 10. devicePixelRatio
  checks.push({
    key: 'devicePixelRatio',
    label: '设备像素比 (devicePixelRatio)',
    category: 'hardware',
    expected: expected.userAgentPlatform === 'macOS' ? '通常为 2（Retina）或 1' : '通常为 1 / 1.25 / 1.5 / 2',
    runtime: runtime.devicePixelRatio === null ? '—' : String(runtime.devicePixelRatio),
    status: 'info'
  })

  // 11. WebGL Vendor & Renderer
  const renderer = runtime.webglRenderer ?? ''
  const gpuMatch = expected.gpuMode === 'spoofed' && expected.gpuModel
    ? renderer.toLowerCase().includes(expected.gpuModel.toLowerCase())
    : undefined
  const webglStatus: FingerprintCheckStatus = !expected.fingerprintKernel
    ? 'info'
    : expected.gpuMode === 'spoofed' && expected.gpuModel
      ? (gpuMatch ? 'match' : 'mismatch')
      : 'info'
  checks.push({
    key: 'webgl',
    label: 'WebGL 渲染器 (Vendor / Renderer)',
    category: 'rendering',
    expected: expected.gpuMode === 'host-native'
      ? '本机原生 GPU（host-native）'
      : expected.gpuModel ?? '默认渲染',
    runtime: [runtime.webglVendor, runtime.webglRenderer].filter(Boolean).join(' / ') || '不可用',
    status: webglStatus
  })
  if (webglStatus === 'mismatch') {
    highlights.push(`WebGL GPU 不一致：期望包含 ${expected.gpuModel}，实测 ${renderer || '不可用'}`)
  }

  // 12. Canvas & ClientRects hashes
  checks.push({
    key: 'canvasHash',
    label: 'Canvas 2D 哈希',
    category: 'rendering',
    expected: expected.canvasMode === 'host-native' ? '本机原生（host-native）' : '种子确定性伪装（spoofed）',
    runtime: runtime.canvasHash ?? '不可用',
    status: 'info'
  })
  checks.push({
    key: 'clientRectsHash',
    label: 'ClientRects 哈希',
    category: 'rendering',
    expected: expected.clientRectsMode === 'host-native' ? '本机原生（host-native）' : '种子确定性伪装（spoofed）',
    runtime: runtime.clientRectsHash ?? '不可用',
    status: 'info'
  })

  const matchCount = checks.filter((item) => item.status === 'match').length
  const mismatchCount = checks.filter((item) => item.status === 'mismatch').length
  const infoCount = checks.filter((item) => item.status === 'info').length
  const overallStatus: FingerprintCheckOverallStatus = mismatchCount > 0
    ? 'fail'
    : !expected.fingerprintKernel
      ? 'warn'
      : 'pass'

  return {
    profileId,
    profileName,
    checkedAt,
    overallStatus,
    summary: {
      matchCount,
      mismatchCount,
      infoCount,
      highlights
    },
    expected,
    runtime,
    checks
  }
}
