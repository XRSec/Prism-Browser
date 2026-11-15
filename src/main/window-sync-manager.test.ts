/**
 * Purpose: Unit tests for WindowSyncManager layout integration, master-first ordering, and multi-display execution.
 * Context: Tests src/main/window-sync-manager.ts with mocked Electron screen and launcher CDP session.
 * Usage: npx vitest run src/main/window-sync-manager.test.ts
 * Prerequisites: Vitest test runner.
 */

import { describe, expect, it, vi } from 'vitest'
import { WindowSyncManager } from './window-sync-manager'
import type { WindowArea } from '../shared/types'

vi.mock('electron', () => {
  const displays = [
    {
      id: 1,
      label: 'Main Display',
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1440 },
      scaleFactor: 2
    },
    {
      id: 2,
      label: 'Secondary Display',
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      workArea: { x: 2560, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    }
  ]
  return {
    screen: {
      getAllDisplays: () => displays,
      getPrimaryDisplay: () => displays[0],
      getDisplayMatching: (area: { x: number; y: number; width: number; height: number }) => {
        if (area.x >= 2560) return displays[1]
        return displays[0]
      }
    }
  }
})

describe('WindowSyncManager', () => {
  function createManager(options?: {
    boundsMap?: Record<string, { left: number; top: number; width: number; height: number }>
    runningIds?: string[]
  }) {
    const running = options?.runningIds ?? ['p-main', 'p-f1', 'p-f2', 'p-f3']
    const bounds: Record<string, { left: number; top: number; width: number; height: number }> =
      options?.boundsMap ?? {
        'p-main': { left: 50, top: 50, width: 800, height: 600 },
        'p-f1': { left: 100, top: 100, width: 600, height: 400 },
        'p-f2': { left: 200, top: 200, width: 600, height: 400 },
        'p-f3': { left: 300, top: 300, width: 600, height: 400 }
      }

    const setBoundsCalls: Array<{ profileId: string; bounds: { left: number; top: number; width: number; height: number } }> = []

    const launcher = {
      runningProfileIds: () => running,
      startWindowSyncCapture: vi.fn(),
      applyWindowSyncAction: vi.fn(),
      browserProcessId: vi.fn().mockReturnValue(1234),
      setBrowserWindowBounds: vi.fn().mockImplementation(async (profileId, b) => {
        setBoundsCalls.push({ profileId, bounds: b })
        bounds[profileId] = b
      }),
      browserWindowBounds: vi.fn().mockImplementation(async (profileId) => {
        return bounds[profileId] ?? { left: 0, top: 0, width: 600, height: 450 }
      }),
      bringBrowserToFront: vi.fn(),
      minimizeBrowser: vi.fn(),
      browserPageUrls: vi.fn().mockResolvedValue(['https://example.com']),
      replaceBrowserTabs: vi.fn(),
      closeBrowserTabs: vi.fn(),
      visitBrowser: vi.fn()
    }

    const licensing = {
      status: () => ({ plan: 'pro' })
    }

    const manager = new WindowSyncManager(launcher, licensing, () => {}, undefined, 'darwin')

    return { manager, launcher, setBoundsCalls, bounds }
  }

  it('getDisplays 返回映射的显示器列表及主屏标识', () => {
    const { manager } = createManager()
    const displays = manager.getDisplays()
    expect(displays).toHaveLength(2)
    expect(displays[0].id).toBe(1)
    expect(displays[0].isPrimary).toBe(true)
    expect(displays[1].id).toBe(2)
    expect(displays[1].isPrimary).toBe(false)
  })

  it('tile 最优平铺：主窗口始终排在首位且铺满屏幕', async () => {
    const { manager, setBoundsCalls } = createManager()

    await manager.tile(['p-f1', 'p-f2', 'p-main'], 'grid', undefined, false, {
      mainProfileId: 'p-main'
    })

    expect(setBoundsCalls).toHaveLength(3)
    const mainCall = setBoundsCalls.find((c) => c.profileId === 'p-main')
    expect(mainCall).toBeDefined()
    // Main window must be at index 0 slot (x: gap = 10, y: gap = 10)
    expect(mainCall?.bounds.left).toBe(10)
    expect(mainCall?.bounds.top).toBe(10)
  })

  it('tile 统一大小模式：根据主窗口尺寸排布所有窗口且主窗口位于第 1 位', async () => {
    const { manager, setBoundsCalls } = createManager({
      boundsMap: {
        'p-main': { left: 50, top: 50, width: 700, height: 500 },
        'p-f1': { left: 100, top: 100, width: 400, height: 300 },
        'p-f2': { left: 200, top: 200, width: 400, height: 300 }
      },
      runningIds: ['p-main', 'p-f1', 'p-f2']
    })

    await manager.tile(['p-f1', 'p-main', 'p-f2'], 'grid', undefined, true, {
      mainProfileId: 'p-main'
    })

    expect(setBoundsCalls).toHaveLength(3)
    // All windows must have width 700 and height 500
    for (const call of setBoundsCalls) {
      expect(call.bounds.width).toBe(700)
      expect(call.bounds.height).toBe(500)
    }
    // Main window is at slot 0
    const mainCall = setBoundsCalls.find((c) => c.profileId === 'p-main')
    expect(mainCall?.bounds.left).toBe(10)
    expect(mainCall?.bounds.top).toBe(10)
  })

  it('uniformSize 将从属窗口尺寸同步为主窗口并按网格排列，主窗口位于首位', async () => {
    const { manager, setBoundsCalls } = createManager({
      boundsMap: {
        'p-main': { left: 50, top: 50, width: 640, height: 480 },
        'p-f1': { left: 0, top: 0, width: 200, height: 200 },
        'p-f2': { left: 0, top: 0, width: 300, height: 300 }
      },
      runningIds: ['p-main', 'p-f1', 'p-f2']
    })

    await manager.uniformSize('p-main', ['p-f1', 'p-f2'])

    expect(setBoundsCalls).toHaveLength(3)
    for (const call of setBoundsCalls) {
      expect(call.bounds.width).toBe(640)
      expect(call.bounds.height).toBe(480)
    }
    const mainCall = setBoundsCalls.find((c) => c.profileId === 'p-main')
    expect(mainCall?.bounds.left).toBe(10)
    expect(mainCall?.bounds.top).toBe(10)
  })

  it('跨屏幕平铺（displayMode: all）将窗口合理分布于多块屏幕且主窗口在主屏首位', async () => {
    const { manager, setBoundsCalls } = createManager({
      boundsMap: {
        'p-main': { left: 50, top: 50, width: 600, height: 400 },
        'p-f1': { left: 0, top: 0, width: 600, height: 400 },
        'p-f2': { left: 0, top: 0, width: 600, height: 400 },
        'p-f3': { left: 0, top: 0, width: 600, height: 400 }
      },
      runningIds: ['p-main', 'p-f1', 'p-f2', 'p-f3']
    })

    await manager.tile(['p-f1', 'p-f2', 'p-f3'], 'grid', undefined, false, {
      displayMode: 'all',
      mainProfileId: 'p-main'
    })

    expect(setBoundsCalls).toHaveLength(4)
    const mainCall = setBoundsCalls.find((c) => c.profileId === 'p-main')
    // Main window on Display 1 (left = 10, top = 10)
    expect(mainCall?.bounds.left).toBe(10)
    expect(mainCall?.bounds.top).toBe(10)

    // Some followers should be on Display 2 (left >= 2560)
    const display2Calls = setBoundsCalls.filter((c) => c.bounds.left >= 2560)
    expect(display2Calls.length).toBeGreaterThan(0)
  })

  it('overlap 重叠排列将主窗口置于起点，后续窗口错落阶梯', async () => {
    const { manager, setBoundsCalls } = createManager({
      runningIds: ['p-main', 'p-f1', 'p-f2']
    })

    await manager.tile(['p-f1', 'p-f2'], 'overlap', undefined, false, {
      mainProfileId: 'p-main'
    })

    expect(setBoundsCalls).toHaveLength(3)
    const mainCall = setBoundsCalls.find((c) => c.profileId === 'p-main')
    expect(mainCall?.bounds.left).toBe(10)
    expect(mainCall?.bounds.top).toBe(10)
  })
})
