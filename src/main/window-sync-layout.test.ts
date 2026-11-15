/**
 * Purpose: Unit tests for pure window sync layout algorithms (optimal grid, master size, multi-monitor, Hamilton distribution).
 * Context: Tests src/main/window-sync-layout.ts logic in isolation with vitest.
 * Usage: npx vitest run src/main/window-sync-layout.test.ts
 * Prerequisites: Vitest test runner.
 */

import { describe, expect, it } from 'vitest'
import {
  computeMasterSizeGrid,
  computeOptimalGrid,
  computeOverlapLayout,
  distributeAcrossDisplays,
  distributeCountsHamilton,
  orderedProfileIds
} from './window-sync-layout'

describe('window-sync-layout', () => {
  describe('orderedProfileIds', () => {
    it('主窗口 profileId 必须严格排在第 1 位', () => {
      const main = 'profile-master'
      const followers = ['profile-2', 'profile-3', 'profile-1']
      const ordered = orderedProfileIds(main, followers)
      expect(ordered[0]).toBe('profile-master')
      expect(ordered).toEqual(['profile-master', 'profile-2', 'profile-3', 'profile-1'])
    })

    it('主窗口包含在从属列表中时应去重且仍排首位', () => {
      const main = 'profile-master'
      const followers = ['profile-1', 'profile-master', 'profile-2']
      const ordered = orderedProfileIds(main, followers)
      expect(ordered).toEqual(['profile-master', 'profile-1', 'profile-2'])
    })

    it('未指定主窗口时保持从属窗口原有顺序并去重', () => {
      const followers = ['profile-1', 'profile-2', 'profile-1', 'profile-3']
      const ordered = orderedProfileIds(undefined, followers)
      expect(ordered).toEqual(['profile-1', 'profile-2', 'profile-3'])
    })

    it('空列表与空字符串安全处理', () => {
      expect(orderedProfileIds('', [])).toEqual([])
      expect(orderedProfileIds('   ', ['  ', 'a'])).toEqual(['a'])
    })
  })

  describe('computeOptimalGrid', () => {
    const wideWorkArea = { x: 0, y: 0, width: 2560, height: 1440 }
    const gap = 10

    it('窗口数为 0 时返回空数组', () => {
      expect(computeOptimalGrid(0, wideWorkArea)).toEqual([])
    })

    it('窗口数为 1 时占满整个工作区（留出 gap 边距）', () => {
      const slots = computeOptimalGrid(1, wideWorkArea, { gap: 10 })
      expect(slots).toHaveLength(1)
      expect(slots[0]).toEqual({
        x: 10,
        y: 10,
        width: 2540,
        height: 1420
      })
    })

    it('宽屏 3 个窗口应最优选择 3x1 纵向阅读比例而非 2x2 留白', () => {
      const slots = computeOptimalGrid(3, wideWorkArea, { gap })
      expect(slots).toHaveLength(3)
      // 3x1 columns: 3 columns, 1 row
      expect(slots[0].y).toBe(gap)
      expect(slots[1].y).toBe(gap)
      expect(slots[2].y).toBe(gap)
      // Height should be workArea.height - 2*gap = 1420
      expect(slots[0].height).toBe(1420)
      // Total span fills available width: right edge of slot 2 is 2560 - gap = 2550
      expect(slots[2].x + slots[2].width).toBe(2550)
    })

    it('宽屏 6 个窗口应选择 3x2 排布', () => {
      const slots = computeOptimalGrid(6, wideWorkArea, { gap })
      expect(slots).toHaveLength(6)
      // Top row: slots 0, 1, 2
      expect(slots[0].y).toBe(slots[1].y)
      expect(slots[1].y).toBe(slots[2].y)
      // Bottom row: slots 3, 4, 5
      expect(slots[3].y).toBe(slots[4].y)
      expect(slots[3].y).toBeGreaterThan(slots[0].y)
      // Pixel-perfect bounds check
      expect(slots[2].x + slots[2].width).toBe(2560 - gap)
      expect(slots[5].y + slots[5].height).toBe(1440 - gap)
    })

    it('宽屏 8 个窗口应选择 4x2 排布（0 槽位浪费）', () => {
      const slots = computeOptimalGrid(8, wideWorkArea, { gap })
      expect(slots).toHaveLength(8)
      // 4 columns x 2 rows
      expect(slots[0].y).toBe(slots[3].y)
      expect(slots[4].y).toBe(slots[7].y)
      expect(slots[3].x + slots[3].width).toBe(2560 - gap)
      expect(slots[7].y + slots[7].height).toBe(1440 - gap)
    })

    it('竖屏 3 个窗口应选择 1x3 横切排布，竖屏 6 个窗口选择 2x3', () => {
      const portraitWorkArea = { x: 0, y: 0, width: 1080, height: 1920 }
      const slots3 = computeOptimalGrid(3, portraitWorkArea, { gap })
      expect(slots3).toHaveLength(3)
      // 1 column x 3 rows
      expect(slots3[0].x).toBe(slots3[1].x)
      expect(slots3[1].x).toBe(slots3[2].x)
      expect(slots3[0].width).toBe(1080 - 2 * gap)

      const slots6 = computeOptimalGrid(6, portraitWorkArea, { gap })
      expect(slots6).toHaveLength(6)
      // 2 columns x 3 rows
      expect(slots6[0].y).toBe(slots6[1].y)
      expect(slots6[2].y).toBe(slots6[3].y)
      expect(slots6[4].y).toBe(slots6[5].y)
    })

    it('像素余数完美平分，无边界漂移或溢出', () => {
      // 1920 width, gap 10, 3 columns: available = 1920 - 40 = 1880. 1880 % 3 = 2.
      // col 0 gets 627, col 1 gets 627, col 2 gets 626.
      const area = { x: 100, y: 50, width: 1920, height: 1080 }
      const slots = computeOptimalGrid(3, area, { gap: 10 })
      expect(slots[0].x).toBe(110)
      expect(slots[2].x + slots[2].width).toBe(100 + 1920 - 10)
      expect(slots[0].y + slots[0].height).toBe(50 + 1080 - 10)
    })

    it('gap 为 0 时正常排布（Windows 规范）', () => {
      const area = { x: 0, y: 0, width: 1920, height: 1080 }
      const slots = computeOptimalGrid(4, area, { gap: 0 })
      expect(slots).toHaveLength(4)
      expect(slots[0].x).toBe(0)
      expect(slots[0].y).toBe(0)
      expect(slots[1].x + slots[1].width).toBe(1920)
      expect(slots[3].y + slots[3].height).toBe(1080)
    })
  })

  describe('computeMasterSizeGrid', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 }
    const masterSize = { width: 500, height: 400 }

    it('按主窗口尺寸排布，首个窗口位于左上角', () => {
      const slots = computeMasterSizeGrid(4, masterSize, workArea, 10)
      expect(slots).toHaveLength(4)
      expect(slots[0]).toEqual({
        x: 10,
        y: 10,
        width: 500,
        height: 400
      })
      // Every slot has identical master dimensions
      for (const slot of slots) {
        expect(slot.width).toBe(500)
        expect(slot.height).toBe(400)
      }
      // Width 1920 - 10 = 1910; (500 + 10) = 510; cols = floor(1910 / 510) = 3
      // Slot 1: col 1
      expect(slots[1].x).toBe(10 + 510)
      expect(slots[1].y).toBe(10)
      // Slot 2: col 2
      expect(slots[2].x).toBe(10 + 1020)
      expect(slots[2].y).toBe(10)
      // Slot 3: col 0, row 1
      expect(slots[3].x).toBe(10)
      expect(slots[3].y).toBe(10 + 410)
    })

    it('数量为 0 时返回空数组', () => {
      expect(computeMasterSizeGrid(0, masterSize, workArea)).toEqual([])
    })
  })

  describe('distributeCountsHamilton', () => {
    it('按显示器面积比例精确分配窗口数量，总和保持一致', () => {
      // 2560x1440 (3.68M) vs 1512x982 (1.48M) -> ~71% vs ~29%
      const weights = [3686400, 1484784]
      const counts6 = distributeCountsHamilton(6, weights)
      expect(counts6).toEqual([4, 2])
      expect(counts6.reduce((a, b) => a + b, 0)).toBe(6)

      const counts3 = distributeCountsHamilton(3, weights)
      expect(counts3).toEqual([2, 1])
      expect(counts3.reduce((a, b) => a + b, 0)).toBe(3)
    })

    it('当 count >= displays.length 时每块屏幕至少分配 1 个窗口', () => {
      const weights = [10000000, 100]
      const counts = distributeCountsHamilton(2, weights)
      expect(counts[0]).toBe(1)
      expect(counts[1]).toBe(1)
    })

    it('当 count < displays.length 时优先分配给首块（主）显示器', () => {
      const weights = [1000, 1000, 1000]
      const counts1 = distributeCountsHamilton(1, weights)
      expect(counts1).toEqual([1, 0, 0])
      const counts2 = distributeCountsHamilton(2, weights)
      expect(counts2).toEqual([1, 1, 0])
    })

    it('权重相等有余数时优先分配给主显示器（index 0）', () => {
      const weights = [1000, 1000]
      const counts = distributeCountsHamilton(5, weights)
      expect(counts).toEqual([3, 2])
    })
  })

  describe('distributeAcrossDisplays', () => {
    const displays = [
      { id: 1, workArea: { x: 0, y: 0, width: 2560, height: 1440 }, isMaster: true },
      { id: 2, workArea: { x: 2560, y: 0, width: 1920, height: 1080 } }
    ]

    it('多屏幕分配时主窗口（slot 0）必须位于第 1 块（主）屏幕左上角', () => {
      const slots = distributeAcrossDisplays(6, displays, 'optimal', { gap: 10 })
      expect(slots).toHaveLength(6)

      // Slot 0 is on Display 1 (x: 0, y: 0)
      expect(slots[0].x).toBe(10)
      expect(slots[0].y).toBe(10)

      // The last slots should be on Display 2 (x >= 2560)
      const display2Slots = slots.filter((s) => s.x >= 2560)
      expect(display2Slots.length).toBeGreaterThan(0)
    })

    it('多屏幕 master-size 模式下所有窗口保持统一尺寸并分布', () => {
      const masterSize = { width: 600, height: 450 }
      const slots = distributeAcrossDisplays(4, displays, 'master-size', { masterSize, gap: 10 })
      expect(slots).toHaveLength(4)
      for (const slot of slots) {
        expect(slot.width).toBe(600)
        expect(slot.height).toBe(450)
      }
      expect(slots[0].x).toBe(10)
      expect(slots[0].y).toBe(10)
    })

    it('单屏幕模式降级平铺', () => {
      const single = [displays[0]]
      const slots = distributeAcrossDisplays(3, single, 'optimal', { gap: 10 })
      expect(slots).toHaveLength(3)
      expect(slots[0].x).toBe(10)
      expect(slots[2].x + slots[2].width).toBe(2550)
    })
  })

  describe('computeOverlapLayout', () => {
    it('主窗口位于起点，后续窗口错落阶梯层叠', () => {
      const workArea = { x: 100, y: 100, width: 1920, height: 1080 }
      const slots = computeOverlapLayout(3, workArea, { width: 600, height: 400 }, 10, 32)
      expect(slots).toHaveLength(3)
      expect(slots[0].x).toBe(110)
      expect(slots[0].y).toBe(110)
      expect(slots[1].x).toBe(110 + 32)
      expect(slots[1].y).toBe(110 + 32)
      expect(slots[2].x).toBe(110 + 64)
      expect(slots[2].y).toBe(110 + 64)
    })
  })
})
