// Collapsed-node geometry (Unreal-style Collapse Nodes).
//
// A collapsed entry is a name plus the ids of the nodes it hides. The
// container's bounds are derived from the hidden nodes' current positions, so
// it follows them; boundary wires are re-anchored to the container by the
// view. The member nodes stay in the graph, so validation and codegen are
// unaffected.

import { nodeHeight, nodeWidth } from './layout'
import type { CollapsedNode, EditorNode, Model } from './model'

export const COLLAPSE_PAD = 20
export const COLLAPSE_HEADER = 24

export interface CollapsedRect {
  x: number
  y: number
  width: number
  height: number
}

export function hiddenNodeIds(model: Model): ReadonlySet<string> {
  return new Set(model.collapsed.flatMap(entry => entry.nodeIds))
}

export function collapsedBounds(
  collapsed: CollapsedNode,
  nodes: ReadonlyArray<EditorNode>,
): CollapsedRect | null {
  const members = nodes.filter(node => collapsed.nodeIds.includes(node.id))
  if (members.length === 0) {
    return null
  }
  const minX = Math.min(...members.map(node => node.position.x))
  const minY = Math.min(...members.map(node => node.position.y))
  const maxX = Math.max(
    ...members.map(node => node.position.x + nodeWidth(node.type)),
  )
  const maxY = Math.max(
    ...members.map(node => node.position.y + nodeHeight(node.type)),
  )
  return {
    x: minX - COLLAPSE_PAD,
    y: minY - COLLAPSE_PAD - COLLAPSE_HEADER,
    width: maxX - minX + COLLAPSE_PAD * 2,
    height: maxY - minY + COLLAPSE_PAD * 2 + COLLAPSE_HEADER,
  }
}
