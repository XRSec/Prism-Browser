import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defaultPlatform, defaultProfileDraft } from '../shared/defaults'
import { applyHardwareProfile, defaultHardwareProfileId, hardwareProfile } from '../shared/hardware-profiles'
import en from '../shared/locales/en.json'
import { localeForCountry } from '../shared/network-identity'
import type { BrowserProfile, HardwareProfileId, ProfileDraft } from '../shared/types'
import { normalizeUrl, validateProfileDraft } from '../shared/validation'
import type { ProfileStore } from './profile-store'

const CREATION_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_CREATION_RECEIPTS = 1000

const profileCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
  group: z.string().max(40).optional(),
  tags: z.array(z.string().max(30)).max(20).optional(),
  startUrls: z.array(z.string().max(2048)).max(50).optional(),
  color: z.string().regex(/^#[a-f\d]{6}$/i).optional(),
  kernelVersion: z.string().regex(/^(?:\d+(?:\.\d+){3})?$/).optional(),
  extensionIds: z.array(z.string().uuid()).max(50).optional(),
  proxy: z.object({
    protocol: z.enum(['direct', 'http', 'https', 'socks5']),
    host: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(1000).optional(),
    password: z.string().max(1000).optional()
  }).strict().optional(),
  fingerprint: z.object({
    seed: z.number().int().min(0).max(4294967295).optional(),
    platform: z.enum(['macos', 'windows']).optional(),
    hardwareProfileId: z.string().max(80).optional(),
    brand: z.enum(['Chrome', 'Edge']).optional(),
    brandVersion: z.string().max(40).optional(),
    language: z.string().max(100).optional(),
    acceptLanguages: z.string().max(200).optional(),
    timezone: z.string().max(100).optional(),
    networkIdentityMode: z.enum(['proxy', 'manual']).optional(),
    proxyExitPolicy: z.enum(['block', 'warn']).optional(),
    webrtcPolicy: z.enum(['proxy_only', 'public_only', 'default']).optional()
  }).strict().optional()
}).strict()

const requestKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/)
  .optional()
  .describe('Unique key for this creation request. Reuse with the same input when retrying; deduplicated for 24 hours, including app restarts.')

const createProfileSchema = profileCreateInputSchema.extend({ requestKey: requestKeySchema })
const createProfilesSchema = z.object({
  profiles: z.array(profileCreateInputSchema).min(1).max(50),
  requestKey: requestKeySchema
}).strict()

type RawProfileInput = z.infer<typeof profileCreateInputSchema> & { requestKey?: string }

function profileCreateIssues(issues: z.ZodIssue[]): Array<{ path: string; message: string }> {
  return issues.slice(0, 20).map((issue) => ({
    path: issue.path.reduce<string>(
      (text, key) => (typeof key === 'number' ? `${text}[${key}]` : text ? `${text}.${String(key)}` : String(key)),
      ''
    ) || '(body)',
    message: issue.message.slice(0, 200)
  }))
}

export class ProfileCreationError extends Error {
  readonly code: string
  readonly details?: Array<{ path: string; message: string }>
  readonly retryable = false

  constructor(code: string, message: string, details?: Array<{ path: string; message: string }>) {
    super(message)
    this.code = code
    this.details = details
  }
}

const englishCatalog = en as Record<string, string>
const english = (message: string): string => englishCatalog[message]?.trim() || message

const VALIDATION_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['代理地址', 'proxy.host'],
  ['代理主机名', 'proxy.host'],
  ['代理端口', 'proxy.port'],
  ['代理凭据', 'proxy.password'],
  ['时区必须', 'fingerprint.timezone'],
  ['界面语言必须', 'fingerprint.language'],
  ['浏览器品牌版本', 'fingerprint.brandVersion'],
  ['语言、Accept-Language', 'fingerprint'],
  ['语言或时区', 'fingerprint'],
  ['绑定内核版本', 'kernelVersion'],
  ['修改浏览器内核', 'kernelVersion'],
  ['环境名称', 'name'],
  ['环境标记颜色', 'color'],
  ['环境备注', 'note'],
  ['环境分组', 'group'],
  ['最多设置 20 个标签', 'tags'],
  ['环境扩展配置', 'extensionIds'],
  ['启动页', 'startUrls'],
  ['硬件模板', 'fingerprint.hardwareProfileId']
]

function validationIssue(error: unknown): { field: string; message: string } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    field: VALIDATION_FIELDS.find(([prefix]) => message.startsWith(prefix))?.[1] ?? '',
    message: english(message)
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`
}

function acceptLanguagesForLanguage(language: string): string {
  const countryPart = language.split('-')[1]
  const known = countryPart ? localeForCountry(countryPart) : undefined
  if (known && known.language === language) return known.acceptLanguages
  const base = language.split('-')[0]
  return [...new Set(base === 'en' ? [language, 'en-US', 'en'] : [language, base, 'en-US', 'en'])].join(',')
}

interface CreationReceipt {
  keyHash: string
  payloadHash: string
  profileIds: string[]
  createdAt: number
}

export class ProfileCreationService {
  private receipts: CreationReceipt[] = []

  constructor(
    private readonly profiles: ProfileStore,
    private readonly onCreated: (profile: BrowserProfile) => void = () => undefined,
    private readonly extensionExists: (id: string) => boolean = () => true
  ) {}

  private creationRequest(scope: string, requestKey: string, payload: string): { keyHash: string; payloadHash: string } {
    const storeAny = this.profiles as unknown as {
      creationRequest?: (s: string, k: string, p: string) => { keyHash: string; payloadHash: string }
    }
    if (typeof storeAny.creationRequest === 'function') {
      return storeAny.creationRequest(scope, requestKey, payload)
    }
    const digest = (label: string, val: string): string =>
      createHash('sha256').update(`${label}\0${val}`).digest('hex')
    return {
      keyHash: digest('request-key', `${scope}:${requestKey}`),
      payloadHash: digest('payload', payload)
    }
  }

  private creationReplay(request: { keyHash: string; payloadHash: string }): BrowserProfile[] | undefined {
    const storeAny = this.profiles as unknown as {
      creationReplay?: (r: { keyHash: string; payloadHash: string }) => BrowserProfile[] | undefined
    }
    if (typeof storeAny.creationReplay === 'function') {
      return storeAny.creationReplay(request)
    }
    this.receipts = this.receipts.filter((item) => Date.now() - item.createdAt < CREATION_RETENTION_MS)
    const receipt = this.receipts.find((item) => item.keyHash === request.keyHash)
    if (!receipt) return undefined
    if (receipt.payloadHash !== request.payloadHash) {
      throw new ProfileCreationError('IDEMPOTENCY_CONFLICT', 'Request key was already used with different input')
    }
    const existingIds = new Set(this.profiles.list().map((p) => p.id))
    if (receipt.profileIds.some((id) => !existingIds.has(id))) {
      throw new ProfileCreationError(
        'IDEMPOTENCY_RESULT_GONE',
        'A profile from this request was deleted; use a new request key to create again'
      )
    }
    return receipt.profileIds.map((id) => this.profiles.get(id))
  }

  async create(
    input: unknown,
    batch: boolean,
    scope: 'api' | 'mcp',
    authorize: () => void
  ): Promise<BrowserProfile[]> {
    authorize()
    const parsed = (batch ? createProfilesSchema : createProfileSchema).safeParse(input)
    if (!parsed.success) {
      throw new ProfileCreationError(
        'INVALID_PROFILE_INPUT',
        'Invalid profile creation request; see details',
        profileCreateIssues(parsed.error.issues)
      )
    }
    const value = parsed.data
    const rawProfiles: RawProfileInput[] = 'profiles' in value ? value.profiles : [value]
    const request = value.requestKey
      ? this.creationRequest(
          scope,
          value.requestKey,
          canonical({
            batch,
            profiles: rawProfiles.map(({ ...p }) => {
              delete p.requestKey
              return p
            })
          })
        )
      : undefined
    const replayed = request && this.creationReplay(request)
    if (replayed) return replayed

    const offset = this.profiles.list().length
    const results = rawProfiles.map((raw, index) => this.draft(raw, offset + index + 1))
    const issues = results.flatMap((result, index) =>
      result.issues.map(({ field, message }) => ({
        path: batch ? `profiles[${index}]${field ? `.${field}` : ''}` : field || '(body)',
        message
      }))
    )
    if (issues.length) {
      throw new ProfileCreationError(
        'INVALID_PROFILE_INPUT',
        batch ? 'Some profiles are invalid; no profiles were created' : 'The profile is invalid and was not created',
        issues.slice(0, 20)
      )
    }

    const drafts = results.map((result) => result.draft!)
    if (request && this.receipts.length >= MAX_CREATION_RECEIPTS) {
      throw new ProfileCreationError('IDEMPOTENCY_CAPACITY', 'The 24-hour creation request limit has been reached')
    }

    const storeAny = this.profiles as unknown as {
      createMany: (d: ProfileDraft[], req?: unknown, auth?: () => void) => Promise<BrowserProfile[]>
    }
    const created = await storeAny.createMany(drafts, request, authorize)
    if (request) {
      this.receipts.push({
        keyHash: request.keyHash,
        payloadHash: request.payloadHash,
        profileIds: created.map((p) => p.id),
        createdAt: Date.now()
      })
    }
    for (const profile of created) this.onCreated(profile)
    return created
  }

  private draft(
    raw: RawProfileInput,
    ordinal: number
  ): { draft?: ProfileDraft; issues: Array<{ field: string; message: string }> } {
    const issues: Array<{ field: string; message: string }> = []
    const requestedTemplate = raw.fingerprint?.hardwareProfileId as HardwareProfileId | undefined
    const template = requestedTemplate === undefined ? undefined : hardwareProfile(requestedTemplate)
    if (requestedTemplate !== undefined && !template) {
      issues.push({ field: 'fingerprint.hardwareProfileId', message: 'Unknown hardware template ID' })
    } else if (template && raw.fingerprint?.platform && template.platform !== raw.fingerprint.platform) {
      issues.push({
        field: 'fingerprint.hardwareProfileId',
        message: `This template is for ${template.platform}, but fingerprint.platform is ${raw.fingerprint.platform}`
      })
    } else if (template?.hostMatched && template.platform !== defaultPlatform()) {
      issues.push({
        field: 'fingerprint.hardwareProfileId',
        message: `This host hardware template only works on ${template.platform} computers`
      })
    }
    raw.extensionIds?.forEach((id, index) => {
      if (!this.extensionExists(id)) {
        issues.push({ field: `extensionIds[${index}]`, message: 'No installed extension has this ID' })
      }
    })
    raw.startUrls?.forEach((url, index) => {
      try {
        const normalized = normalizeUrl(url)
        if (!normalized) return
        const parsed = new URL(normalized)
        if (parsed.username || parsed.password) {
          issues.push({ field: `startUrls[${index}]`, message: 'Start URLs cannot contain a user name or password' })
        }
      } catch (error) {
        issues.push({
          field: `startUrls[${index}]`,
          message: error instanceof TypeError ? 'Invalid URL' : english(error instanceof Error ? error.message : String(error))
        })
      }
    })
    if (issues.length) return { issues }

    const defaults = defaultProfileDraft(ordinal)
    const platform = template?.platform ?? raw.fingerprint?.platform ?? defaults.fingerprint.platform
    const hardwareProfileId = template?.id ?? defaultHardwareProfileId(platform)
    const { fingerprint: fingerprintInput, proxy: proxyInput, ...fields } = raw
    delete fields.requestKey
    const fingerprint = applyHardwareProfile(
      { ...defaults.fingerprint, ...fingerprintInput, platform, hardwareProfileId },
      hardwareProfileId,
      { refreshSeededGpu: true }
    )
    if (fingerprintInput?.language && !fingerprintInput.acceptLanguages) {
      fingerprint.acceptLanguages = acceptLanguagesForLanguage(fingerprintInput.language)
    }
    const draft: ProfileDraft = {
      ...defaults,
      ...fields,
      name: fields.name ?? `API ${ordinal}`,
      fingerprint,
      proxy: { ...defaults.proxy, ...proxyInput }
    }
    try {
      return { draft: validateProfileDraft(draft), issues }
    } catch (error) {
      return { issues: [validationIssue(error)] }
    }
  }
}
