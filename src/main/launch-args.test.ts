import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { buildLaunchArgs } from './launch-args'

describe('buildLaunchArgs', () => {
  it('应包含 --disable-features=TabGroups 以关闭标签页分组', () => {
    const profile: BrowserProfile = {
      ...defaultProfileDraft(),
      id: 'profile-1',
      serialNumber: 1,
      status: 'closed',
      favorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const args = buildLaunchArgs(profile, {
      userDataDir: '/tmp/prism-profile-test'
    })

    expect(args).toContain('--disable-features=TabGroups')
  })
})
