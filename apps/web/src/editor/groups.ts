// Node grouping geometry (Unreal-style comment box).
//
// A group is just a name, a color, and a set of node ids. Its frame is
// derived from the current positions of those nodes, so it follows them as
// they move and needs no stored geometry.

import { NODE_W, nodeHeight } from './layout'
import type { EditorNode, Group } from './model'

export const GROUP_PAD = 16
export const GROUP_HEADER = 22

export const GROUP_COLORS = [
  '#58a6ff',
  '#3fb950',
  '#d29922',
  '#f778ba',
  '#a371f7',
  '#f85149',
  '#22d3ee',
  '#8b949e',
]

export const DEFAULT_GROUP_COLOR = '#58a6ff'

export interface GroupRect {
  x: number
  y: number
  width: number
  height: number
}

export function groupBounds(
  group: Group,
  nodes: ReadonlyArray<EditorNode>,
): GroupRect | null {
  const members = nodes.filter(node => group.nodeIds.includes(node.id))
  if (members.length === 0) {
    return null
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of members) {
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x + NODE_W)
    maxY = Math.max(maxY, node.position.y + nodeHeight(node.type))
  }
  return {
    x: minX - GROUP_PAD,
    y: minY - GROUP_PAD - GROUP_HEADER,
    width: maxX - minX + GROUP_PAD * 2,
    height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER,
  }
}
