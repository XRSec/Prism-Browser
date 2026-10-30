import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureDefaultProfilePreferences } from './profile-preferences'

describe('ensureDefaultProfilePreferences', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'prism-pref-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('在空 profile 目录下创建包含关闭书签栏的首选项文件', async () => {
    await ensureDefaultProfilePreferences(tempDir)
    const prefPath = join(tempDir, 'Default', 'Preferences')
    const content = JSON.parse(await readFile(prefPath, 'utf8'))
    expect(content.bookmark_bar).toEqual({ show_on_all_tabs: false })
  })

  it('保留已有首选项并在 show_on_all_tabs 不为 false 时更新', async () => {
    const prefPath = join(tempDir, 'Default', 'Preferences')
    await ensureDefaultProfilePreferences(tempDir)
    // 模拟写入其他用户首选项
    await writeFile(
      prefPath,
      JSON.stringify({
        theme: 'dark',
        bookmark_bar: { show_on_all_tabs: true, other_key: 123 }
      })
    )

    await ensureDefaultProfilePreferences(tempDir)
    const updated = JSON.parse(await readFile(prefPath, 'utf8'))
    expect(updated.theme).toBe('dark')
    expect(updated.bookmark_bar.show_on_all_tabs).toBe(false)
    expect(updated.bookmark_bar.other_key).toBe(123)
  })
})
