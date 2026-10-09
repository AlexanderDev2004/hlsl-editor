// Color math and honeycomb geometry for the custom group color picker.
// Pure: no Foldkit, no DOM, shared by update (validation) and view (rendering).

import { Array } from 'effect'

const HEX_COLOR = /^#([0-9a-f]{6})$/i

export function isValidGroupColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

// Accepts `#rrggbb` or `rrggbb` in any case and returns lowercase `#rrggbb`.
export function normalizeHexColor(value: string): string | null {
  const withHash = value.startsWith('#') ? value : `#${value}`
  return HEX_COLOR.test(withHash) ? withHash.toLowerCase() : null
}

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export function hexToRgb(hex: string): Rgb | null {
  const match = HEX_COLOR.exec(hex)
  const digits = match?.[1]
  if (digits === undefined) {
    return null
  }
  return {
    r: parseInt(digits.slice(0, 2), 16),
    g: parseInt(digits.slice(2, 4), 16),
    b: parseInt(digits.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const channel = (n: number): string =>
    clampRgbChannel(n).toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}

export function clampRgbChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function rgbFromChannels(r: number, g: number, b: number): Rgb {
  return { r: clampRgbChannel(r), g: clampRgbChannel(g), b: clampRgbChannel(b) }
}

export function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => {
    const k = (n + h / 30) % 12
    return clampRgbChannel(
      255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))),
    )
  }
  return rgbToHex({ r: f(0), g: f(8), b: f(4) })
}

// Honeycomb layout: flat-top hexagons, ring k holding the k-th saturation
// level, hue sweeping by angle, white at the centre.
export interface PickerCell {
  readonly points: string
  readonly color: string
}

const CELL = 12
const RINGS = 5

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
]

function ringCoords(k: number): Array<{ q: number; r: number }> {
  const cells: Array<{ q: number; r: number }> = []
  let q = 0
  let r = -k
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < k; step++) {
      cells.push({ q, r })
      q += DIRECTIONS[side]?.[0] ?? 0
      r += DIRECTIONS[side]?.[1] ?? 0
    }
  }
  return cells
}

function polygonPoints(cx: number, cy: number): string {
  return [0, 60, 120, 180, 240, 300]
    .map(angle => {
      const rad = (angle * Math.PI) / 180
      const x = cx + CELL * Math.cos(rad)
      const y = cy + CELL * Math.sin(rad)
      return `${round(x)},${round(y)}`
    })
    .join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

function buildWheel(): Array<PickerCell> {
  const cx = PICKER_W / 2
  const cy = PICKER_W / 2
  const centre: PickerCell = {
    points: polygonPoints(cx, cy),
    color: '#ffffff',
  }
  const cells = [centre]
  for (let k = 1; k <= RINGS; k++) {
    for (const { q, r } of ringCoords(k)) {
      const x = cx + CELL * 1.5 * q
      const y = cy + CELL * Math.sqrt(3) * (r + q / 2)
      const hue = ((Math.atan2(y - cy, x - cx) * 180) / Math.PI + 360) % 360
      cells.push({
        points: polygonPoints(x, y),
        color: hslToHex(hue, k / RINGS, 0.55),
      })
    }
  }
  return cells
}

function buildGrayscale(): Array<PickerCell> {
  const steps = 8
  const spacing = CELL * 2
  const width = (steps - 1) * spacing
  const y = PICKER_H - CELL
  return Array.makeBy(steps, i => {
    const x = (PICKER_W - width) / 2 + i * spacing
    return {
      points: polygonPoints(x, y),
      color: hslToHex(0, 0, 1 - i / (steps - 1)),
    }
  })
}

export const PICKER_W = (RINGS * 1.5 + 1) * CELL * 2
export const PICKER_H = (RINGS * Math.sqrt(3) + 1) * CELL * 2 + CELL * 3.2

export const HONEYCOMB: ReadonlyArray<PickerCell> = buildWheel()
export const GRAYSCALE: ReadonlyArray<PickerCell> = buildGrayscale()
