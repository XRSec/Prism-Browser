/**
 * Purpose: Pure layout calculations for multi-window sync grid, master-size, and multi-display tiling.
 * Context: Used by WindowSyncManager for window arrangement and monitor distribution in Prism Browser.
 * Usage: Import pure functions (computeOptimalGrid, computeMasterSizeGrid, distributeAcrossDisplays, etc.).
 * Prerequisites: Positive dimensions and non-negative counts.
 */

export interface WindowSlot {
  x: number
  y: number
  width: number
  height: number
}

export interface OptimalGridOptions {
  gap?: number
  minWidth?: number
  minHeight?: number
  targetAspect?: number
}

export interface DisplayWorkArea {
  id: number
  workArea: WindowSlot
  isPrimary?: boolean
  isMaster?: boolean
}

/**
 * Ensures mainProfileId is strictly first in order, followed by followers deduplicated.
 */
export function orderedProfileIds(mainProfileId: string | undefined, followerProfileIds: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  if (mainProfileId && typeof mainProfileId === 'string' && mainProfileId.trim()) {
    result.push(mainProfileId)
    seen.add(mainProfileId)
  }

  for (const id of followerProfileIds) {
    if (id && typeof id === 'string' && id.trim() && !seen.has(id)) {
      result.push(id)
      seen.add(id)
    }
  }

  return result
}

/**
 * Scores a candidate (cols, rows) grid. Lower score is better.
 * Penalizes empty slots, aspect ratio divergence from comfortable browser reading, and dimension violations.
 */
export function scoreGridCandidate(
  cols: number,
  rows: number,
  count: number,
  workArea: WindowSlot,
  gap: number,
  minWidth: number,
  minHeight: number,
  targetAspect: number
): number {
  const totalAvailableW = Math.max(1, workArea.width - gap * (cols + 1))
  const totalAvailableH = Math.max(1, workArea.height - gap * (rows + 1))
  const cellW = totalAvailableW / cols
  const cellH = totalAvailableH / rows
  const cellAspect = cellW / cellH

  const wastedSlots = cols * rows - count
  const aspectDiff = Math.abs(Math.log(cellAspect / targetAspect))

  // Base penalties: empty slot waste and aspect ratio comfort
  let score = wastedSlots * 15 + aspectDiff * 20

  // Heavy penalties for violating minimum window dimensions
  if (cellW < minWidth) {
    score += 1000 + (minWidth - cellW) * 10
  }
  if (cellH < minHeight) {
    score += 1000 + (minHeight - cellH) * 10
  }

  return score
}

/**
 * Computes optimal grid slots filling workArea without leaving large gaps or wasting slots.
 * Handles pixel remainders so windows cleanly fill the workArea with zero drift.
 */
export function computeOptimalGrid(
  count: number,
  workArea: WindowSlot,
  options?: OptimalGridOptions
): WindowSlot[] {
  if (count <= 0) return []
  const gap = options?.gap ?? 10
  const minWidth = options?.minWidth ?? 320
  const minHeight = options?.minHeight ?? 240
  const targetAspect = options?.targetAspect ?? 1.15

  if (count === 1) {
    return [{
      x: workArea.x + gap,
      y: workArea.y + gap,
      width: Math.max(1, workArea.width - 2 * gap),
      height: Math.max(1, workArea.height - 2 * gap)
    }]
  }

  let bestCols = 1
  let bestRows = count
  let lowestScore = Number.POSITIVE_INFINITY

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols)
    const score = scoreGridCandidate(cols, rows, count, workArea, gap, minWidth, minHeight, targetAspect)
    if (score < lowestScore) {
      lowestScore = score
      bestCols = cols
      bestRows = rows
    }
  }

  const totalAvailableW = Math.max(0, workArea.width - gap * (bestCols + 1))
  const totalAvailableH = Math.max(0, workArea.height - gap * (bestRows + 1))

  const baseW = Math.floor(totalAvailableW / bestCols)
  const remW = totalAvailableW % bestCols
  const baseH = Math.floor(totalAvailableH / bestRows)
  const remH = totalAvailableH % bestRows

  const slots: WindowSlot[] = []
  for (let i = 0; i < count; i++) {
    const col = i % bestCols
    const row = Math.floor(i / bestCols)

    const w = baseW + (col < remW ? 1 : 0)
    const h = baseH + (row < remH ? 1 : 0)
    const x = workArea.x + gap * (col + 1) + col * baseW + Math.min(col, remW)
    const y = workArea.y + gap * (row + 1) + row * baseH + Math.min(row, remH)

    slots.push({ x, y, width: Math.max(1, w), height: Math.max(1, h) })
  }

  return slots
}

/**
 * Computes uniform-size slots where every window matches masterSize and wraps sequentially.
 */
export function computeMasterSizeGrid(
  count: number,
  masterSize: { width: number; height: number },
  workArea: WindowSlot,
  gap = 10
): WindowSlot[] {
  if (count <= 0) return []
  const w = Math.max(1, Math.round(masterSize.width))
  const h = Math.max(1, Math.round(masterSize.height))

  const maxFittingCols = Math.floor((workArea.width - gap) / (w + gap))
  const cols = Math.max(1, Math.min(count, maxFittingCols))

  const slots: WindowSlot[] = []
  for (let i = 0; i < count; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = workArea.x + gap + col * (w + gap)
    const y = workArea.y + gap + row * (h + gap)
    slots.push({ x, y, width: w, height: h })
  }

  return slots
}

/**
 * Distributes window count across multiple weights using the Hamilton / Largest-Remainder method.
 * Master display (index 0) is guaranteed priority on tie-breaks.
 */
export function distributeCountsHamilton(count: number, weights: number[]): number[] {
  if (weights.length === 0 || count <= 0) {
    return weights.map(() => 0)
  }
  if (weights.length === 1) {
    return [count]
  }
  if (count < weights.length) {
    return weights.map((_, i) => (i < count ? 1 : 0))
  }

  const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1))
  const totalWeight = safeWeights.reduce((sum, w) => sum + w, 0)
  const remaining = count - weights.length
  const fractional = safeWeights.map((w) => (w / totalWeight) * remaining)
  const floorCounts = fractional.map((f) => Math.floor(f))
  const allocated = floorCounts.map((f) => f + 1)

  const currentSum = allocated.reduce((sum, c) => sum + c, 0)
  const needed = count - currentSum

  const remainders = fractional.map((f, i) => ({
    index: i,
    rem: f - floorCounts[i]
  }))
  remainders.sort((a, b) => b.rem - a.rem || a.index - b.index)

  for (let i = 0; i < needed; i++) {
    const target = remainders[i % remainders.length]
    allocated[target.index] += 1
  }

  return allocated
}

/**
 * Distributes and tiles windows across multiple displays.
 * When displays.length > 1, master display (displays[0]) receives the first slice, with slot 0 as master window.
 */
export function distributeAcrossDisplays(
  count: number,
  displays: DisplayWorkArea[],
  mode: 'optimal' | 'master-size',
  options?: {
    masterSize?: { width: number; height: number }
    gap?: number
    minWidth?: number
    minHeight?: number
    targetAspect?: number
  }
): WindowSlot[] {
  if (count <= 0 || displays.length === 0) return []
  const gap = options?.gap ?? 10

  if (displays.length === 1) {
    const singleArea = displays[0].workArea
    if (mode === 'master-size') {
      return computeMasterSizeGrid(
        count,
        options?.masterSize ?? { width: 800, height: 600 },
        singleArea,
        gap
      )
    }
    return computeOptimalGrid(count, singleArea, options)
  }

  const weights = displays.map((d) => Math.max(1, d.workArea.width * d.workArea.height))
  const distribution = distributeCountsHamilton(count, weights)
  const allSlots: WindowSlot[] = []

  for (let i = 0; i < displays.length; i++) {
    const assigned = distribution[i]
    if (assigned <= 0) continue
    const displayArea = displays[i].workArea
    const displaySlots =
      mode === 'master-size'
        ? computeMasterSizeGrid(
            assigned,
            options?.masterSize ?? { width: 800, height: 600 },
            displayArea,
            gap
          )
        : computeOptimalGrid(assigned, displayArea, options)
    allSlots.push(...displaySlots)
  }

  return allSlots
}

/**
 * Computes cascading / overlapping slots starting from master window at (x + gap, y + gap).
 */
export function computeOverlapLayout(
  count: number,
  workArea: WindowSlot,
  baseSize?: { width: number; height: number },
  gap = 10,
  step = 32
): WindowSlot[] {
  if (count <= 0) return []
  const width = baseSize?.width && baseSize.width > 0
    ? baseSize.width
    : Math.max(520, Math.floor(workArea.width * 0.6))
  const height = baseSize?.height && baseSize.height > 0
    ? baseSize.height
    : Math.max(420, Math.floor(workArea.height * 0.6))

  const maxOffsetLeft = Math.max(0, workArea.width - width - gap)
  const maxOffsetTop = Math.max(0, workArea.height - height - gap)

  const slots: WindowSlot[] = []
  for (let i = 0; i < count; i++) {
    const offsetLeft = maxOffsetLeft > 0 ? (i * step) % maxOffsetLeft : 0
    const offsetTop = maxOffsetTop > 0 ? (i * step) % maxOffsetTop : 0
    slots.push({
      x: workArea.x + gap + offsetLeft,
      y: workArea.y + gap + offsetTop,
      width,
      height
    })
  }
  return slots
}
