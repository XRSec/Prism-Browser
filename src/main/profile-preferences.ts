import { access, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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

/**
 * 确保环境 profile 继承公共扩展配置（如已登录的 Bitwarden 存储模版）
 */
export async function ensureSharedExtensionStorage(userDataDir: string): Promise<void> {
  try {
    const vaultPath = resolve(userDataDir, '..', '..', '..')
    const templateDir = join(vaultPath, 'templates', 'extensions')
    const targetParent = join(userDataDir, 'Default', 'Local Extension Settings')

    try {
      const templates = await readdir(templateDir, { withFileTypes: true })
      for (const entry of templates) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const targetPath = join(targetParent, entry.name)
        try {
          await access(targetPath)
        } catch {
          await mkdir(targetParent, { recursive: true })
          await cp(join(templateDir, entry.name), targetPath, {
            recursive: true,
            filter: (src) => !src.endsWith('LOCK')
          })
        }
      }
    } catch {
      // 模板目录不存在则跳过
    }
  } catch {
    // 容错处理：扩展模板复制失败不阻断环境启动流程
  }
}
