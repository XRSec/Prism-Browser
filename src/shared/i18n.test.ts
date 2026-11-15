import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { formatList, getLocale, isUiLocale, languages, quote, resolveLocale, setLocale, subscribeLocale, t, translateMessage } from './i18n'
import { suffixedProfileName } from './profile-name'
import { defaultProfileDraft } from './defaults'
import { geoConflictConfirmationMessage, GEOIP_CONFLICT_CONFIRMATION_PREFIX } from './network-identity'

afterEach(() => setLocale('zh-CN'))

const folder = join(process.cwd(), 'src/shared/locales')
const source = JSON.parse(readFileSync(join(folder, 'zh-CN.json'), 'utf8')) as Record<string, string>
const catalogs = Object.fromEntries(languages.map(({ value }) =>
  [value, JSON.parse(readFileSync(join(folder, `${value}.json`), 'utf8')) as Record<string, string>]))
// Latin words in a source key that are names, protocols, file names or API values
// and must appear unchanged in every translation. Generic words may be translated.
const TRANSLATABLE_LATIN = new Set(['Cookie', 'AI', 'ID', 'MB', 'GB', 'CPU', 'GPU', 'Audio'])
const latinTerms = (key: string) => [...key.replace(/\{\d+\}/g, ' ').matchAll(/[A-Za-z][A-Za-z0-9._+-]*[A-Za-z0-9]/g)]
  .map(match => match[0]).filter(term => !TRANSLATABLE_LATIN.has(term))
// Official localized names of the Chrome Web Store (stems allow inflection).
const CHROME_WEB_STORE: Record<string, string> = {
  'zh-TW': 'Chrome 線上應用程式商店', en: 'Chrome Web Store', es: 'Chrome Web Store', fr: 'Chrome Web Store', 'pt-BR': 'Chrome Web Store',
  ru: 'нтернет-магазин', uk: 'нтернет-магазин', tr: 'Chrome Web Mağaza', vi: 'Cửa hàng Chrome trực tuyến',
  th: 'Chrome เว็บสโตร์', ja: 'Chrome ウェブストア', hi: 'Chrome वेब स्टोर'
}
// Simplified-only characters that occur in the source catalog (OpenCC STCharacters).
const SIMPLIFIED_ONLY = new Set('与专业两个为举义书买产仅从仓优会传伪体储关内写冲决况凑凭击则创删务动区协单历压参双发变叠号听启响围国图坏声处备复头实对导将尔尝尽属带帮并库应开异当录径态总悬战户执扩扫护拟拥拦择损换数断无旧时显暂机权条来构标栏桥检没测浏湾溃滚点状独环现监盖盘码础离称稳签类紧约级纹线组终经绑结绕络绝统继绪续维缓编缩网联脚节获虑补装见规视览计认让议记许设访证识诊试话询该详语误请诺读负败账购贴费资车转轮软载辅辑输迁过运还这进远连迟选递遗钟钥钮铺链销错键镜长门闭问间阶际险随隐静页项顺须预频题颜额风饰验')
const QUOTES: Record<string, [string, string]> = {
  'zh-TW': ['「', '」'], ja: ['「', '」'], fr: ['«\u00a0', '\u00a0»'], ru: ['«', '»'], uk: ['«', '»']
}

describe('interface languages', () => {
  it('resolves supported OS variants and falls back to English', () => {
    for (const [input, expected] of Object.entries({ 'zh-Hant-HK': 'zh-TW', zh_TW: 'zh-TW', 'zh-Hans-CN': 'zh-CN', 'en-GB': 'en', 'pt-PT': 'pt-BR', 'ru-RU': 'ru', 'hi-IN': 'hi', 'de-DE': 'en' })) expect(resolveLocale(input)).toBe(expected)
    expect(languages).toHaveLength(13)
    expect(isUiLocale('__proto__')).toBe(false)
  })

  it('notifies subscribers only on a change and leaves profile defaults untouched', () => {
    const before = defaultProfileDraft(1)
    let events = 0
    const unsubscribe = subscribeLocale(() => events++)
    setLocale('en'); setLocale('en')
    expect(events).toBe(1)
    expect(getLocale()).toBe('en')
    const after = defaultProfileDraft(1)
    expect(after.fingerprint.language).toBe(before.fingerprint.language)
    expect(after.fingerprint.acceptLanguages).toBe(before.fingerprint.acceptLanguages)
    expect(after.fingerprint.timezone).toBe(before.fingerprint.timezone)
    unsubscribe(); setLocale('ru')
    expect(events).toBe(1)
  })

  it('interpolates user values without translating them and handles IPC errors', () => {
    setLocale('en')
    expect(t('环境 {0}', '中文名字')).toBe('Profile 中文名字')
    expect(translateMessage("Error invoking remote method 'profiles:create': Error: 环境名称不能超过 60 个字符")).toBe('Profile names must be 60 characters or fewer')
    expect(translateMessage('找不到文件 /tmp/example')).toBe('找不到文件 /tmp/example')
    expect(translateMessage('代理启动前检测失败：代理认证失败，请检查用户名和密码')).not.toMatch(/代理/)
    const conflict = `${GEOIP_CONFLICT_CONFIRMATION_PREFIX} GeoIP 数据源对代理地区判断不一致；继续使用可能导致 IP 地区与时区、语言或地理位置不一致，影响指纹效果。是否仍要启动？`
    const warning = geoConflictConfirmationMessage(conflict)
    expect(warning).toBeTruthy()
    for (const { value } of languages.filter(item => !['zh-CN', 'zh-TW', 'ja'].includes(item.value))) {
      setLocale(value)
      expect(translateMessage(warning)).not.toMatch(/[\u3400-\u9fff]/u)
      expect(geoConflictConfirmationMessage(conflict)).toBe(warning)
    }
  })

  it('ships every UI message and preserves interpolation placeholders in all catalogs', () => {
    for (const { value } of languages) {
      const catalog = catalogs[value]
      expect(Object.keys(catalog).sort(), value).toEqual(Object.keys(source).sort())
      for (const key of Object.keys(source)) {
        expect(typeof catalog[key], `${value}: ${key}`).toBe('string')
        expect([...catalog[key].matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), `${value}: ${key}`)
          .toEqual([...key.matchAll(/\{\d+\}/g)].map(m => m[0]).sort())
      }
    }
    const extractTranslationKeys = (content: string): string[] => {
      const keys: string[] = []
      const pattern = /(?<![A-Za-z0-9_$.])t\(\s*(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g
      for (const match of content.matchAll(pattern)) {
        const quoteChar = match[1]
        const raw = match[2]
        if (quoteChar === '`' && raw.includes('${')) continue
        keys.push(raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
      }
      return keys
    }
    for (const folder of ['src/renderer/src', 'src/main']) {
      for (const name of readdirSync(folder).filter(name => /\.tsx?$/.test(name) && !name.includes('.test.'))) {
        const path = join(folder, name)
        for (const key of extractTranslationKeys(readFileSync(path, 'utf8'))) {
          expect(source, `${path}: ${key}`).toHaveProperty(key)
        }
      }
    }
  })

  it('keeps catalogs clean: one sentence, names intact, spacing and script preserved', () => {
    for (const { value } of languages.filter(item => item.value !== 'zh-CN')) {
      const catalog = catalogs[value]
      for (const [key, text] of Object.entries(catalog)) {
        const where = `${value}: ${key}`
        expect(text.trim(), where).not.toBe('')
        // Merged neighbouring sentences or segment numbers from a translation tool
        expect(text.includes('\n') && !key.includes('\n'), where).toBe(false)
        expect(text, where).not.toMatch(/\[\d{3,}|【\d+】/)
        expect(/^\s/.test(text), where).toBe(/^\s/.test(key))
        expect(/\s$/.test(text), where).toBe(/\s$/.test(key))
        for (const term of latinTerms(key)) expect(text, `${where} → ${term}`).toContain(term)
        if (key.includes('Chrome 应用商店')) expect(text, where).toContain(CHROME_WEB_STORE[value])
        if (!['zh-TW', 'ja'].includes(value)) expect(text, where).not.toMatch(/[\u3400-\u9fff]/)
        if (value === 'zh-TW') expect([...text].filter(ch => SIMPLIFIED_ONLY.has(ch)).join(''), where).toBe('')
        if (key.includes('“{0}”')) {
          const [open, close] = QUOTES[value] ?? ['“', '”']
          expect(text, where).toContain(`${open}{0}${close}`)
        }
      }
    }
  })

  it('never translates user names inside messages and re-joins name lists per language', () => {
    setLocale('en')
    expect(translateMessage('环境“测试”正在运行，不能删除')).toContain('“测试”')
    expect(translateMessage('环境“测试”正在运行，不能删除')).not.toMatch(/Test/)
    expect(translateMessage('请先关闭环境“香港”')).toContain('香港')
    const list = translateMessage('该内核仍被 4 个环境固定使用（“测试”、“代理”、“香港”等），请先修改这些环境')
    expect(list).toContain('“测试”, “代理”, “香港”')
    expect(list).not.toMatch(/[、等]/)
    setLocale('fr')
    expect(translateMessage('该内核仍被 1 个环境固定使用（“测试”），请先修改这些环境')).toContain('«\u00a0测试\u00a0»')
    setLocale('ja')
    expect(translateMessage('该内核仍被 2 个环境固定使用（“A”、“B”），请先修改这些环境')).toContain('「A」、「B」')
  })

  it('translates composed status lines and nested provider errors', () => {
    for (const { value } of languages.filter(item => !['zh-CN', 'zh-TW', 'ja'].includes(item.value))) {
      setLocale(value)
      for (const message of [
        '203.0.113.8 · 120 ms · 结果已超过 24 小时 · GeoIP 双源一致',
        'GeoIP 数据源冲突（出口 IP：198.51.100.1 / 198.51.100.2；国家：JP / US）；继续使用可能影响时区、语言和地理位置的一致性，启动时将要求用户确认',
        '地理信息暂不可用：IP 检测结果无效；代理连接超时，请检查线路或更换代理',
        '内置 Fingerprint Chromium 可执行（版本 144.0.7559.132）',
        '主环境配置不可用，已从最近备份恢复',
        '已连接测试更新通道',
        'Windows · 本机硬件（推荐） · 本机 CPU · 本机内存 · 本机 GPU · 1920×1080',
        'macOS · Apple M3 Pro · 18GB · 12 核 · 18GB · Apple M3 Pro · 3024×1964'
      ]) expect(translateMessage(message), `${value}: ${message}`).not.toMatch(/[\u3400-\u9fff]/)
    }
  })

  it('translates a hardware template name followed by its summary', () => {
    setLocale('en')
    expect(translateMessage('Windows · 本机硬件（推荐） · 本机 CPU · 本机内存 · 本机 GPU · 1920×1080'))
      .toBe('Windows · Native Hardware (Recommended) · Native CPU · Native Memory · Native GPU · 1920×1080')
    expect(translateMessage('macOS · Apple M3 Pro · 18GB · 12 核 · 18GB · Apple M3 Pro · 3024×1964'))
      .toBe('macOS · Apple M3 Pro · 18GB · 12 cores · 18GB · Apple M3 Pro · 3024×1964')
  })

  it('formats lists and quotes for the interface language', () => {
    setLocale('en'); expect(formatList(['A', 'B'])).toBe('A, B'); expect(quote('x')).toBe('“x”')
    setLocale('ja'); expect(formatList(['A', 'B'])).toBe('A、B'); expect(quote('x')).toBe('「x」')
    setLocale('ru'); expect(quote('x')).toBe('«x»')
  })

  it('keeps generated profile names within the name limit in every language', () => {
    for (const { value } of languages) {
      setLocale(value)
      for (const template of ['{0} 副本', '{0}（导入）', '{0}（迁移）']) {
        const name = suffixedProfileName(template, '名'.repeat(60))
        expect(name.length, `${value}: ${template}`).toBeLessThanOrEqual(60)
        expect(name.startsWith('名'), `${value}: ${template}`).toBe(true)
      }
    }
    setLocale('zh-CN'); expect(suffixedProfileName('{0} 副本', '工作')).toBe('工作 副本')
  })

})
