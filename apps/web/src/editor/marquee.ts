// Marquee (rubber-band) selection geometry.
//
// The pointerdown handler converts the initial client point into world
// coordinates (and a world-per-pixel scale) via the SVG's screen transform,
// then pointer moves are tracked as screen deltas. These pure helpers turn the
// two world corners into a rectangle and hit-test nodes against it, shared by
// update (selection) and view (the drawn band).

import { NODE_W, nodeHeight } from './layout'
import type { Model } from './model'

export interface WorldRect {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function worldRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): WorldRect {
  return {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2),
  }
}

export function nodesInRect(
  model: Model,
  rect: WorldRect,
): ReadonlyArray<string> {
  return model.nodes
    .filter(node => {
      const width = NODE_W
      const height = nodeHeight(node.type)
      return (
        node.position.x < rect.maxX &&
        node.position.x + width > rect.minX &&
        node.position.y < rect.maxY &&
        node.position.y + height > rect.minY
      )
    })
    .map(node => node.id)
}
