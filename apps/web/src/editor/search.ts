// Node search seam.
//
// Default behavior: case-insensitive substring match against the node's
// display label (falling back to its id); selecting a result selects the
// node and fits the viewport to it.
//
// Both halves are exported pure functions so future callers (a palette with
// fuzzy matching, a minimap, tests) can override them: pass a custom
// `onSearch` to replace matching, or a custom `onSelectNode` to replace
// what selection does. `update.ts` wires the defaults.

import { NODE_REGISTRY, isNodeType } from '@hlsl-editor/shader-nodes'

import { BASE_H, BASE_W, nodeHeight, nodeWidth } from './layout'
import type { EditorNode } from './model'

export function nodeLabel(node: Pick<EditorNode, 'id' | 'type'>): string {
  if (isNodeType(node.type)) {
    return NODE_REGISTRY[node.type].label
  }
  return node.type
}

export function defaultOnSearch(
  nodes: ReadonlyArray<EditorNode>,
  query: string,
): Array<EditorNode> {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return []
  }
  return nodes.filter(node => {
    const haystacks = [nodeLabel(node).toLowerCase(), node.id.toLowerCase()]
    return haystacks.some(hay => hay.includes(needle))
  })
}

export function defaultOnSelectNodeFit(
  viewport: { x: number; y: number; zoom: number },
  node: Pick<EditorNode, 'position' | 'type'>,
): { x: number; y: number } {
  const viewW = BASE_W / viewport.zoom
  const viewH = BASE_H / viewport.zoom
  return {
    x: node.position.x + nodeWidth(node.type) / 2 - viewW / 2,
    y: node.position.y + nodeHeight(node.type) / 2 - viewH / 2,
  }
}
