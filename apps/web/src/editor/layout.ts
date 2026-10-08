// Shared canvas layout math. Imported by both view (rendering) and
// update (fit-view calculations) so the two can never drift apart.

import { NODE_REGISTRY, isNodeType } from '@hlsl-editor/shader-nodes'

export const NODE_W = 200
export const HEADER_H = 30
export const ROW_H = 24
export const PAD = 8
export const BASE_W = 1600
export const BASE_H = 1000

export const ZOOM_MIN = 0.25
export const ZOOM_MAX = 3
export const ZOOM_STEP = 1.25

export function clampZoom(zoom: number): number {
  if (zoom < ZOOM_MIN) {
    return ZOOM_MIN
  }
  if (zoom > ZOOM_MAX) {
    return ZOOM_MAX
  }
  return zoom
}

export function nodeHeight(type: string): number {
  if (!isNodeType(type)) {
    return 64
  }
  const def = NODE_REGISTRY[type]
  const rows = Math.max(def.inputs.length, def.outputs.length, 1)
  return HEADER_H + rows * ROW_H + PAD * 2
}

export function portY(_type: string, index: number): number {
  return HEADER_H + PAD + index * ROW_H + ROW_H / 2
}
