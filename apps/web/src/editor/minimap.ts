// Minimap geometry.
//
// The minimap is a fixed-size thumbnail of the whole graph. These pure
// helpers compute the world-space bounds worth showing (every node plus the
// current viewport, so the viewport marker stays visible when panned away)
// and the uniform scale/offset that fits those bounds into the thumbnail.
// The view maps world coordinates through the result.

import { NODE_W, nodeHeight } from './layout'
import type { EditorNode } from './model'

export const MINIMAP_W = 200
export const MINIMAP_H = 140
export const MINIMAP_PAD = 8

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function sceneBounds(
  nodes: ReadonlyArray<EditorNode>,
  view: { x: number; y: number; width: number; height: number },
): Bounds {
  let minX = view.x
  let minY = view.y
  let maxX = view.x + view.width
  let maxY = view.y + view.height
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + NODE_W)
    maxY = Math.max(maxY, node.position.y + nodeHeight(node.type))
  }
  return { minX, minY, maxX, maxY }
}

export interface MinimapTransform {
  scale: number
  offsetX: number
  offsetY: number
}

export function minimapTransform(
  bounds: Bounds,
  width: number,
  height: number,
  padding: number,
): MinimapTransform {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1)
  const spanY = Math.max(bounds.maxY - bounds.minY, 1)
  const usableW = Math.max(width - padding * 2, 1)
  const usableH = Math.max(height - padding * 2, 1)
  const scale = Math.min(usableW / spanX, usableH / spanY)
  return {
    scale,
    offsetX: padding + (usableW - spanX * scale) / 2 - bounds.minX * scale,
    offsetY: padding + (usableH - spanY * scale) / 2 - bounds.minY * scale,
  }
}
