import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 确保环境 profile 的 Chromium 首选项符合要求：
 * - 默认关闭书签栏常驻显示 (bookmark_bar.show_on_all_tabs = false)
 */
export async function ensureDefaultProfilePreferences(userDataDir: string): Promise<void> {
  const defaultDir = join(userDataDir, 'Default')
  const prefPath = join(defaultDir, 'Preferences')

  try {
    await mkdir(defaultDir, { recursive: true })

    let prefs: Record<string, any> = {}
    try {
      const content = await readFile(prefPath, 'utf8')
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prefs = parsed
      }
    } catch {
      prefs = {}
    }

    const bookmarkBar =
      typeof prefs.bookmark_bar === 'object' && prefs.bookmark_bar !== null && !Array.isArray(prefs.bookmark_bar)
        ? prefs.bookmark_bar
        : {}

    if (bookmarkBar.show_on_all_tabs !== false) {
      prefs.bookmark_bar = {
        ...bookmarkBar,
        show_on_all_tabs: false
      }
      await writeFile(prefPath, JSON.stringify(prefs, null, 2), { encoding: 'utf8' })
    }
  } catch {
    // 容错处理：首选项写入失败不阻断环境启动流程
  }
}
