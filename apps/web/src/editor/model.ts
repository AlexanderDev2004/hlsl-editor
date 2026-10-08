// Editor Model: Schema-defined Foldkit state plus the pure bridge to the
// framework-independent graph domain (packages/graph, packages/shader-nodes).

import { Option, Schema } from 'effect'
import { modifyFields } from 'foldkit/struct'

import type { Graph } from '@hlsl-editor/graph'
import { createNodeOfType, isNodeType } from '@hlsl-editor/shader-nodes'

// EDITOR GRAPH (Schema mirror of the domain graph; ports are derived from
// the node registry so they are not stored)

export const Vec2 = Schema.Struct({ x: Schema.Number, y: Schema.Number })
export type Vec2 = typeof Vec2.Type

export const EditorNode = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  position: Vec2,
  params: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Array(Schema.Number)]),
  ),
})
export type EditorNode = typeof EditorNode.Type

export const EditorEdge = Schema.Struct({
  id: Schema.String,
  sourceNodeId: Schema.String,
  sourcePort: Schema.String,
  targetNodeId: Schema.String,
  targetPort: Schema.String,
})
export type EditorEdge = typeof EditorEdge.Type

// A named, colored frame around a set of nodes (Unreal-style comment box).
// Membership is by id; the frame's bounds are derived from the member nodes,
// so it follows them as they move. Edges between members render inside it.
export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  nodeIds: Schema.Array(Schema.String),
})
export type Group = typeof Group.Type

export const Snapshot = Schema.Struct({
  nodes: Schema.Array(EditorNode),
  edges: Schema.Array(EditorEdge),
  groups: Schema.Array(Group),
  outputNodeId: Schema.Option(Schema.String),
  nextNode: Schema.Number,
  nextEdge: Schema.Number,
  nextGroup: Schema.Number,
})
export type Snapshot = typeof Snapshot.Type

// Copied nodes plus the edges whose both endpoints were copied. Edge ids
// here still refer to the originals; paste remaps them to fresh ids.
export const Clipboard = Schema.Struct({
  nodes: Schema.Array(EditorNode),
  edges: Schema.Array(EditorEdge),
})
export type Clipboard = typeof Clipboard.Type

// The right-click "add node" menu: where it opened (world coordinates for the
// new node, client pixels for the popup) and its search query.
export const ContextMenu = Schema.Struct({
  worldX: Schema.Number,
  worldY: Schema.Number,
  clientX: Schema.Number,
  clientY: Schema.Number,
  search: Schema.String,
})
export type ContextMenu = typeof ContextMenu.Type

export const DragState = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('idle') }),
  Schema.Struct({
    mode: Schema.Literal('node'),
    nodeId: Schema.String,
    lastX: Schema.Number,
    lastY: Schema.Number,
    moved: Schema.Boolean,
    before: Snapshot,
  }),
  Schema.Struct({
    mode: Schema.Literal('pan'),
    lastX: Schema.Number,
    lastY: Schema.Number,
    moved: Schema.Boolean,
    origX: Schema.Number,
    origY: Schema.Number,
  }),
  Schema.Struct({
    mode: Schema.Literal('group'),
    groupId: Schema.String,
    lastX: Schema.Number,
    lastY: Schema.Number,
    moved: Schema.Boolean,
    before: Snapshot,
  }),
  Schema.Struct({
    mode: Schema.Literal('marquee'),
    lastX: Schema.Number,
    lastY: Schema.Number,
    moved: Schema.Boolean,
    startWorldX: Schema.Number,
    startWorldY: Schema.Number,
    currentWorldX: Schema.Number,
    currentWorldY: Schema.Number,
    worldPerPixel: Schema.Number,
  }),
])
export type DragState = typeof DragState.Type

export const PendingConnection = Schema.Struct({
  active: Schema.Boolean,
  fromNodeId: Schema.String,
  fromPort: Schema.String,
})
export type PendingConnection = typeof PendingConnection.Type

// MODEL

export const Model = Schema.Struct({
  nodes: Schema.Array(EditorNode),
  edges: Schema.Array(EditorEdge),
  outputNodeId: Schema.Option(Schema.String),
  nextNode: Schema.Number,
  nextEdge: Schema.Number,
  selectedNodeIds: Schema.Array(Schema.String),
  selectedEdgeId: Schema.Option(Schema.String),
  hoveredEdgeId: Schema.Option(Schema.String),
  groups: Schema.Array(Group),
  selectedGroupId: Schema.Option(Schema.String),
  nextGroup: Schema.Number,
  viewport: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    zoom: Schema.Number,
  }),
  drag: DragState,
  pending: PendingConnection,
  past: Schema.Array(Snapshot),
  future: Schema.Array(Snapshot),
  newNodeType: Schema.String,
  searchText: Schema.String,
  status: Schema.String,
  suppressClick: Schema.Boolean,
  storageAvailable: Schema.Boolean,
  clipboard: Schema.Option(Clipboard),
  pasteOffset: Schema.Number,
  minimapVisible: Schema.Boolean,
  contextMenu: Schema.Option(ContextMenu),
  simulateLoading: Schema.Boolean,
  loadingVariant: Schema.Union([
    Schema.Literal('border'),
    Schema.Literal('overlay'),
  ]),
})
export type Model = typeof Model.Type

export const STORAGE_KEY = 'hlsl-editor:graph:v1'

// SEED (demo graph: Float(2) * Float(5) -> Fragment Output)

function seedNode(
  id: string,
  type: string,
  x: number,
  y: number,
  params: Record<string, number | Array<number>>,
): EditorNode {
  return { id, type, position: { x, y }, params }
}

export function seedModel(): Model {
  return {
    nodes: [
      seedNode('n1', 'Float', 80, 120, { value: 2 }),
      seedNode('n2', 'Float', 80, 300, { value: 5 }),
      seedNode('n3', 'Multiply', 380, 190, {}),
      seedNode('n4', 'FragmentOutput', 680, 190, {}),
    ],
    edges: [
      {
        id: 'e1',
        sourceNodeId: 'n1',
        sourcePort: 'out',
        targetNodeId: 'n3',
        targetPort: 'a',
      },
      {
        id: 'e2',
        sourceNodeId: 'n2',
        sourcePort: 'out',
        targetNodeId: 'n3',
        targetPort: 'b',
      },
      {
        id: 'e3',
        sourceNodeId: 'n3',
        sourcePort: 'out',
        targetNodeId: 'n4',
        targetPort: 'color',
      },
    ],
    outputNodeId: Option.some('n4'),
    nextNode: 5,
    nextEdge: 4,
    selectedNodeIds: [],
    selectedEdgeId: Option.none(),
    hoveredEdgeId: Option.none(),
    groups: [],
    selectedGroupId: Option.none(),
    nextGroup: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    drag: { mode: 'idle' },
    pending: { active: false, fromNodeId: '', fromPort: '' },
    past: [],
    future: [],
    newNodeType: 'Float',
    searchText: '',
    status: 'Seeded demo graph. Select a node to inspect it.',
    suppressClick: false,
    storageAvailable: true,
    clipboard: Option.none(),
    pasteOffset: 1,
    minimapVisible: true,
    contextMenu: Option.none(),
    simulateLoading: false,
    loadingVariant: 'border',
  }
}

export function emptyModel(): Model {
  return {
    ...seedModel(),
    nodes: [],
    edges: [],
    outputNodeId: Option.none(),
    nextNode: 1,
    nextEdge: 1,
    status: 'New graph. Add nodes from the palette.',
  }
}

export function takeSnapshot(model: Model): Snapshot {
  return {
    nodes: model.nodes,
    edges: model.edges,
    groups: model.groups,
    outputNodeId: model.outputNodeId,
    nextNode: model.nextNode,
    nextEdge: model.nextEdge,
    nextGroup: model.nextGroup,
  }
}

export function pushHistory(model: Model): Model {
  const past = [...model.past, takeSnapshot(model)]
  const trimmed = past.length > 100 ? past.slice(past.length - 100) : past
  return modifyFields(model, { past: () => trimmed, future: () => [] })
}

export function restoreSnapshot(model: Model, snap: Snapshot): Model {
  return modifyFields(model, {
    nodes: () => snap.nodes,
    edges: () => snap.edges,
    groups: () => snap.groups,
    outputNodeId: () => snap.outputNodeId,
    nextNode: () => snap.nextNode,
    nextEdge: () => snap.nextEdge,
    nextGroup: () => snap.nextGroup,
    selectedNodeIds: () => [],
    selectedEdgeId: () => Option.none(),
    hoveredEdgeId: () => Option.none(),
    selectedGroupId: () => Option.none(),
    pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    suppressClick: () => false,
  })
}

// DOMAIN BRIDGE (editor state -> framework-independent graph)

function toMutableParams(
  params: Record<string, number | ReadonlyArray<number>>,
): Record<string, number | Array<number>> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === 'number' ? value : [...value],
    ]),
  )
}

export function toDomainGraph(model: Model): Graph {
  const nodes = model.nodes.flatMap(node => {
    if (!isNodeType(node.type)) {
      return []
    }
    return [
      createNodeOfType(
        node.type,
        node.id,
        node.position,
        toMutableParams(node.params),
      ),
    ]
  })
  return {
    version: 1,
    nodes,
    edges: model.edges.map(e => ({
      id: e.id,
      source: { nodeId: e.sourceNodeId, port: e.sourcePort },
      target: { nodeId: e.targetNodeId, port: e.targetPort },
    })),
    outputNodeId: Option.getOrNull(model.outputNodeId),
  }
}

export function fromSerialized(data: {
  version: number
  nodes: Array<{
    id: string
    type: string
    position: { x: number; y: number }
    params: Record<string, number | Array<number>>
  }>
  edges: Array<{
    id: string
    source: { nodeId: string; port: string }
    target: { nodeId: string; port: string }
  }>
  outputNodeId: string | null
}): Pick<Model, 'nodes' | 'edges' | 'outputNodeId' | 'nextNode' | 'nextEdge'> {
  const nodes: Array<EditorNode> = data.nodes
    .filter(n => isNodeType(n.type))
    .map(n => ({
      id: n.id,
      type: n.type,
      position: { ...n.position },
      params: { ...n.params },
    }))
  const edges: Array<EditorEdge> = data.edges.map(e => ({
    id: e.id,
    sourceNodeId: e.source.nodeId,
    sourcePort: e.source.port,
    targetNodeId: e.target.nodeId,
    targetPort: e.target.port,
  }))
  let maxNode = 0
  let maxEdge = 0
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(n.id)
    if (m !== null && m[1] !== undefined) {
      const v = Number.parseInt(m[1], 10)
      if (Number.isFinite(v) && v > maxNode) {
        maxNode = v
      }
    }
  }
  for (const e of edges) {
    const m = /^e(\d+)$/.exec(e.id)
    if (m !== null && m[1] !== undefined) {
      const v = Number.parseInt(m[1], 10)
      if (Number.isFinite(v) && v > maxEdge) {
        maxEdge = v
      }
    }
  }
  return {
    nodes,
    edges,
    outputNodeId:
      data.outputNodeId === null
        ? Option.none()
        : Option.some(data.outputNodeId),
    nextNode: maxNode + 1,
    nextEdge: maxEdge + 1,
  }
}
