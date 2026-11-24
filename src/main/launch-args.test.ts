import { describe, expect, it } from 'vitest'
import { defaultProfileDraft } from '../shared/defaults'
import type { BrowserProfile } from '../shared/types'
import { auditLaunchFingerprintArgs, buildLaunchArgs } from './launch-args'

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

  it('未配置 bypassList 时使用默认代理绕过列表', () => {
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
      userDataDir: '/tmp/prism-profile-test',
      proxyUrl: 'http://127.0.0.1:8080'
    })

    expect(args).toContain('--proxy-bypass-list=localhost;127.0.0.1')
  })

  it('配置自定义 bypassList 时应拼接到默认代理绕过列表后', () => {
    const profile: BrowserProfile = {
      ...defaultProfileDraft(),
      id: 'profile-1',
      serialNumber: 1,
      status: 'closed',
      favorite: false,
      proxy: {
        protocol: 'http',
        host: 'proxy.example.com',
        port: 8080,
        username: '',
        password: '',
        bypassList: '*.myvaultwarden.com;192.168.*'
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const args = buildLaunchArgs(profile, {
      userDataDir: '/tmp/prism-profile-test',
      proxyUrl: 'http://proxy.example.com:8080'
    })

    expect(args).toContain('--proxy-bypass-list=localhost;127.0.0.1;*.myvaultwarden.com;192.168.*')
  })

  it('audits fingerprint args and filters flags unsupported by older kernels', () => {
    const profile: BrowserProfile = {
      ...defaultProfileDraft(),
      id: 'profile-audit',
      serialNumber: 2,
      status: 'closed',
      favorite: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    const legacy = auditLaunchFingerprintArgs(profile, {
      userDataDir: '/tmp/prism-profile-test',
      engineVersion: '142.0.7444.175',
      fingerprintKernel: true
    })
    expect(legacy.args.some((arg) => arg.startsWith('--fingerprint-render-identity='))).toBe(false)
    expect(legacy.audit.find((entry) => entry.flag === '--fingerprint-render-identity')?.status).toBe('skipped-unsupported')
    expect(legacy.audit.find((entry) => entry.flag === '--fingerprint')?.status).toBe('applied')

    const modern = auditLaunchFingerprintArgs(profile, {
      userDataDir: '/tmp/prism-profile-test',
      engineVersion: '153.0.7900.12',
      fingerprintKernel: true
    })
    expect(modern.args.some((arg) => arg.startsWith('--fingerprint-render-identity=v'))).toBe(true)
    expect(modern.audit.find((entry) => entry.flag === '--fingerprint-render-identity')?.status).toBe('applied')
  })
})
