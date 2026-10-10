// Editor Model: Schema-defined Foldkit state plus the pure bridge to the
// framework-independent graph domain (packages/graph, packages/shader-nodes).

import { Option, Schema } from 'effect'
import { modifyFields } from 'foldkit/struct'

import type { Graph, GraphEdge, GraphNode } from '@hlsl-editor/graph'
import type {
  FunctionArg,
  FunctionDefSource,
} from '@hlsl-editor/shader-compiler'
import {
  NODE_REGISTRY,
  createNodeOfType,
  isNodeType,
} from '@hlsl-editor/shader-nodes'
import { isMvp1Type } from '@hlsl-editor/shader-types'

import { DEFAULT_KEYMAP } from './shortcuts'

// EDITOR GRAPH (Schema mirror of the domain graph; ports are derived from
// the node registry so they are not stored)

export const Vec2 = Schema.Struct({ x: Schema.Number, y: Schema.Number })
export type Vec2 = typeof Vec2.Type

// Editor node. Ports normally derive from the node registry; function
// nodes (FunctionInput/FunctionCall) carry per-instance `ports` instead,
// and a FunctionCall stores the invoked FunctionDef id in `ref`.
export const EditorPortDef = Schema.Struct({
  name: Schema.String,
  direction: Schema.Union([Schema.Literal('in'), Schema.Literal('out')]),
  valueType: Schema.String,
  required: Schema.Boolean,
})
export type EditorPortDef = typeof EditorPortDef.Type

export const EditorNode = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  position: Vec2,
  params: Schema.Record(
    Schema.String,
    Schema.Union([Schema.Number, Schema.Array(Schema.Number)]),
  ),
  ports: Schema.optional(Schema.Array(EditorPortDef)),
  ref: Schema.optional(Schema.String),
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

// A collapsed selection (Unreal-style Collapse Nodes). The member nodes stay
// in the graph — validation and codegen are unchanged — but the view hides
// them behind a single container node. `nodeIds` are the hidden members.
export const CollapsedNode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  nodeIds: Schema.Array(Schema.String),
})
export type CollapsedNode = typeof CollapsedNode.Type

// A Material Function: a named, reusable subgraph. `nodes` contains the
// extracted nodes plus FunctionInput/FunctionOutput markers; FunctionCall
// nodes on the canvas reference it by id.
export const FunctionDef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  nodes: Schema.Array(EditorNode),
  edges: Schema.Array(EditorEdge),
})
export type FunctionDef = typeof FunctionDef.Type

export const Snapshot = Schema.Struct({
  nodes: Schema.Array(EditorNode),
  edges: Schema.Array(EditorEdge),
  groups: Schema.Array(Group),
  collapsed: Schema.Array(CollapsedNode),
  nextCollapsed: Schema.Number,
  rerouteNames: Schema.Record(Schema.String, Schema.String),
  outputNodeId: Schema.Option(Schema.String),
  nextNode: Schema.Number,
  nextEdge: Schema.Number,
  nextGroup: Schema.Number,
  functions: Schema.Array(FunctionDef),
  nextFunction: Schema.Number,
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

// The right-click menu for a specific node (reroute actions, align/distribute).
export const NodeMenu = Schema.Struct({
  nodeId: Schema.String,
  clientX: Schema.Number,
  clientY: Schema.Number,
})
export type NodeMenu = typeof NodeMenu.Type

export const ColorPickerState = Schema.Struct({
  groupId: Schema.String,
  originalColor: Schema.String,
  draft: Schema.String,
})
export type ColorPickerState = typeof ColorPickerState.Type

// Snapshot of one Play run: raw RGBA components of the Fragment Output.
export const PlayState = Schema.Struct({
  color: Schema.Tuple([
    Schema.Number,
    Schema.Number,
    Schema.Number,
    Schema.Number,
  ]),
})
export type PlayState = typeof PlayState.Type

// Session console: connection attempts, edits, persistence, and Play are
// logged here with a level so the user can see what the editor did and why
// a connection was rejected. Newest first, capped in `withLog`.
export const LogEntry = Schema.Struct({
  id: Schema.Number,
  level: Schema.Union([
    Schema.Literal('error'),
    Schema.Literal('warning'),
    Schema.Literal('success'),
    Schema.Literal('info'),
    Schema.Literal('system'),
  ]),
  text: Schema.String,
})
export type LogEntry = typeof LogEntry.Type

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
  // Dragging a wire out of a port. `fromDirection` is the direction of the
  // port the drag started from; releasing on an opposite-direction port
  // connects, releasing on empty canvas offers to add a node there.
  Schema.Struct({
    mode: Schema.Literal('wire'),
    fromNodeId: Schema.String,
    fromPort: Schema.String,
    fromDirection: Schema.Union([Schema.Literal('in'), Schema.Literal('out')]),
    lastX: Schema.Number,
    lastY: Schema.Number,
    worldX: Schema.Number,
    worldY: Schema.Number,
    clientX: Schema.Number,
    clientY: Schema.Number,
    moved: Schema.Boolean,
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
  collapsed: Schema.Array(CollapsedNode),
  selectedCollapsedId: Schema.Option(Schema.String),
  nextCollapsed: Schema.Number,
  functions: Schema.Array(FunctionDef),
  nextFunction: Schema.Number,
  rerouteNames: Schema.Record(Schema.String, Schema.String),
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
  nodeMenu: Schema.Option(NodeMenu),
  colorPicker: Schema.Option(ColorPickerState),
  play: Schema.Option(PlayState),
  logs: Schema.Array(LogEntry),
  nextLogId: Schema.Number,
  logPanelOpen: Schema.Boolean,
  simulateLoading: Schema.Boolean,
  loadingVariant: Schema.Union([
    Schema.Literal('border'),
    Schema.Literal('overlay'),
  ]),
  settingsOpen: Schema.Boolean,
  recordingAction: Schema.Option(Schema.String),
  shortcutPlatform: Schema.Union([
    Schema.Literal('windows'),
    Schema.Literal('macos'),
  ]),
  keymap: Schema.Record(Schema.String, Schema.String),
})
export type Model = typeof Model.Type

export const STORAGE_KEY = 'hlsl-editor:graph:v1'
export const SETTINGS_KEY = 'hlsl-editor:settings:v1'

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
      seedNode('n1', 'Float', 420, 380, { value: 2 }),
      seedNode('n2', 'Float', 420, 560, { value: 5 }),
      seedNode('n3', 'Multiply', 720, 450, {}),
      seedNode('n4', 'FragmentOutput', 1020, 450, {}),
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
    collapsed: [],
    selectedCollapsedId: Option.none(),
    nextCollapsed: 1,
    functions: [],
    nextFunction: 1,
    rerouteNames: {},
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
    nodeMenu: Option.none(),
    colorPicker: Option.none(),
    play: Option.none(),
    logs: [],
    nextLogId: 1,
    logPanelOpen: true,
    simulateLoading: false,
    loadingVariant: 'border',
    settingsOpen: false,
    recordingAction: Option.none(),
    shortcutPlatform: 'windows',
    keymap: { ...DEFAULT_KEYMAP },
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
    collapsed: model.collapsed,
    nextCollapsed: model.nextCollapsed,
    rerouteNames: model.rerouteNames,
    outputNodeId: model.outputNodeId,
    nextNode: model.nextNode,
    nextEdge: model.nextEdge,
    nextGroup: model.nextGroup,
    functions: model.functions,
    nextFunction: model.nextFunction,
  }
}

export function pushHistory(model: Model): Model {
  const past = [...model.past, takeSnapshot(model)]
  const trimmed = past.length > 100 ? past.slice(past.length - 100) : past
  // Any undoable edit invalidates a running Play preview.
  return modifyFields(model, {
    past: () => trimmed,
    future: () => [],
    play: () => Option.none(),
  })
}

export function restoreSnapshot(model: Model, snap: Snapshot): Model {
  return modifyFields(model, {
    nodes: () => snap.nodes,
    edges: () => snap.edges,
    groups: () => snap.groups,
    collapsed: () => snap.collapsed,
    nextCollapsed: () => snap.nextCollapsed,
    rerouteNames: () => snap.rerouteNames,
    outputNodeId: () => snap.outputNodeId,
    nextNode: () => snap.nextNode,
    nextEdge: () => snap.nextEdge,
    nextGroup: () => snap.nextGroup,
    functions: () => snap.functions,
    nextFunction: () => snap.nextFunction,
    selectedNodeIds: () => [],
    selectedEdgeId: () => Option.none(),
    hoveredEdgeId: () => Option.none(),
    selectedGroupId: () => Option.none(),
    selectedCollapsedId: () => Option.none(),
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

// Build one domain node from its editor form: registry ports by default,
// per-instance ports (and the function ref) when the editor node carries
// them.
function toDomainNode(node: EditorNode): GraphNode | null {
  if (!isNodeType(node.type)) {
    return null
  }
  const domain = createNodeOfType(
    node.type,
    node.id,
    node.position,
    toMutableParams(node.params),
  )
  if (node.ports !== undefined) {
    domain.ports = node.ports.map(p => ({
      id: `${node.id}:${p.name}`,
      name: p.name,
      direction: p.direction,
      valueType: p.valueType,
      required: p.required,
    }))
  }
  if (node.ref !== undefined) {
    domain.ref = node.ref
  }
  return domain
}

function toDomainEdges(edges: ReadonlyArray<EditorEdge>): Array<GraphEdge> {
  return edges.map(e => ({
    id: e.id,
    source: { nodeId: e.sourceNodeId, port: e.sourcePort },
    target: { nodeId: e.targetNodeId, port: e.targetPort },
  }))
}

export function toDomainGraph(model: Model): Graph {
  const nodes = model.nodes.flatMap(node => {
    const domain = toDomainNode(node)
    return domain === null ? [] : [domain]
  })
  return {
    version: 1,
    nodes,
    edges: toDomainEdges(model.edges),
    outputNodeId: Option.getOrNull(model.outputNodeId),
  }
}

// Convert stored Material Functions into the compiler's FunctionDefSource
// shape. A function's arguments come from its FunctionInput nodes (the out
// port name is the argument name, its type the argument type).
export function toDomainFunctions(
  functions: ReadonlyArray<FunctionDef>,
): Array<FunctionDefSource> {
  return functions.flatMap(fn => {
    const output = fn.nodes.find(n => n.type === 'FunctionOutput')
    if (output === undefined) {
      return []
    }
    const args: Array<FunctionArg> = []
    for (const node of fn.nodes) {
      if (node.type !== 'FunctionInput') {
        continue
      }
      const outPort = node.ports?.find(p => p.direction === 'out')
      if (outPort === undefined || !isMvp1Type(outPort.valueType)) {
        continue
      }
      args.push({ name: outPort.name, type: outPort.valueType })
    }
    const nodes = fn.nodes.flatMap(node => {
      const domain = toDomainNode(node)
      return domain === null ? [] : [domain]
    })
    return [
      {
        id: fn.id,
        name: fn.name,
        args,
        nodes,
        edges: toDomainEdges(fn.edges),
        outputNodeId: output.id,
      },
    ]
  })
}

// Imports arrive from untrusted JSON, so params are rebuilt from the node
// registry: only known keys with finite numbers survive, everything else
// falls back to the type's defaults. Keeps generated HLSL numeric no matter
// what a hand-edited file contains.
function sanitizeParams(
  type: string,
  params: Record<string, number | Array<number>>,
): Record<string, number | Array<number>> {
  if (!isNodeType(type)) {
    return { ...params }
  }
  const clean: Record<string, number | Array<number>> = {
    ...NODE_REGISTRY[type].defaultParams,
  }
  for (const [key, value] of Object.entries(params)) {
    if (
      key in NODE_REGISTRY[type].defaultParams &&
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      clean[key] = value
    }
  }
  return clean
}

// Function bodies deserialize through the same node/edge sanitization as
// the main graph; a function survives import only when structurally sane
// (valid unique HLSL identifier name, exactly one FunctionOutput).
export function fromSerialized(data: {
  version: number
  nodes: Array<{
    id: string
    type: string
    position: { x: number; y: number }
    params: Record<string, number | Array<number>>
    ports?: Array<{
      name: string
      direction: 'in' | 'out'
      valueType: string
      required: boolean
    }>
    ref?: string
  }>
  edges: Array<{
    id: string
    source: { nodeId: string; port: string }
    target: { nodeId: string; port: string }
  }>
  outputNodeId: string | null
  rerouteNames?: Record<string, string>
  collapsed?: Array<{
    id: string
    name: string
    nodeIds: ReadonlyArray<string>
  }>
  functions?: Array<{
    id: string
    name: string
    nodes: Array<{
      id: string
      type: string
      position: { x: number; y: number }
      params: Record<string, number | Array<number>>
      ports?: Array<{
        name: string
        direction: 'in' | 'out'
        valueType: string
        required: boolean
      }>
      ref?: string
    }>
    edges: Array<{
      id: string
      source: { nodeId: string; port: string }
      target: { nodeId: string; port: string }
    }>
  }>
}): Pick<
  Model,
  | 'nodes'
  | 'edges'
  | 'outputNodeId'
  | 'nextNode'
  | 'nextEdge'
  | 'rerouteNames'
  | 'collapsed'
  | 'nextCollapsed'
  | 'functions'
  | 'nextFunction'
> {
  const nodes: Array<EditorNode> = data.nodes
    .filter(n => isNodeType(n.type))
    .map(n => ({
      id: n.id,
      type: n.type,
      position: { ...n.position },
      params: sanitizeParams(n.type, n.params),
      ...sanitizePorts(n.type, n.ports),
      ...sanitizeRef(n.ref),
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
  const collapsed = data.collapsed ?? []
  let maxCollapsed = 0
  for (const c of collapsed) {
    const m = /^c(\d+)$/.exec(c.id)
    if (m !== null && m[1] !== undefined) {
      const v = Number.parseInt(m[1], 10)
      if (Number.isFinite(v) && v > maxCollapsed) {
        maxCollapsed = v
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
    rerouteNames: data.rerouteNames ?? {},
    collapsed: collapsed.map(c => ({ ...c, nodeIds: [...c.nodeIds] })),
    nextCollapsed: maxCollapsed + 1,
    ...sanitizeFunctions(data),
  }
}

// Per-instance ports only mean something on the function node kinds; for
// every registry type the registry's own ports win. Port values are
// sanitized: non-empty names, a known direction, an MVP1 value type.
function sanitizePorts(
  type: string,
  ports:
    | ReadonlyArray<{
        name: string
        direction: 'in' | 'out'
        valueType: string
        required: boolean
      }>
    | undefined,
): Pick<EditorNode, 'ports'> {
  const isFunctionKind =
    type === 'FunctionCall' ||
    type === 'FunctionInput' ||
    type === 'FunctionOutput'
  if (!isFunctionKind || ports === undefined) {
    return {}
  }
  const clean = ports.flatMap(p => {
    if (
      p.name === '' ||
      !isMvp1Type(p.valueType) ||
      (p.direction !== 'in' && p.direction !== 'out')
    ) {
      return []
    }
    return [
      {
        name: p.name,
        direction: p.direction,
        valueType: p.valueType,
        required: p.required,
      },
    ]
  })
  return clean.length > 0 ? { ports: clean } : {}
}

function sanitizeRef(ref: string | undefined): Pick<EditorNode, 'ref'> {
  return ref !== undefined && ref !== '' ? { ref } : {}
}

// Keep only structurally sane functions, rename them to unique valid HLSL
// identifiers, and recompute the next function counter from what survived.
function sanitizeFunctions(data: {
  functions?:
    | ReadonlyArray<{
        id: string
        name: string
        nodes: ReadonlyArray<{
          id: string
          type: string
          position: { x: number; y: number }
          params: Record<string, number | Array<number>>
          ports?: ReadonlyArray<{
            name: string
            direction: 'in' | 'out'
            valueType: string
            required: boolean
          }>
          ref?: string
        }>
        edges: ReadonlyArray<{
          id: string
          source: { nodeId: string; port: string }
          target: { nodeId: string; port: string }
        }>
      }>
    | undefined
}): Pick<Model, 'functions' | 'nextFunction'> {
  const raw = data.functions ?? []
  const functions: Array<FunctionDef> = []
  const usedNames = new Set<string>()
  let counter = 1
  for (const fn of raw) {
    const outputCount = fn.nodes.filter(n => n.type === 'FunctionOutput').length
    if (outputCount !== 1) {
      continue
    }
    const nodeIds = new Set(fn.nodes.map(n => n.id))
    if (
      fn.edges.some(
        e => !nodeIds.has(e.source.nodeId) || !nodeIds.has(e.target.nodeId),
      )
    ) {
      continue
    }
    const nodes: Array<EditorNode> = fn.nodes
      .filter(n => isNodeType(n.type))
      .map(n => ({
        id: n.id,
        type: n.type,
        position: { ...n.position },
        params: sanitizeParams(n.type, n.params),
        ...sanitizePorts(n.type, n.ports),
        ...sanitizeRef(n.ref),
      }))
    if (!nodes.some(n => n.type === 'FunctionOutput')) {
      continue
    }
    // Sanitize to a valid, unique HLSL identifier (call sites reference the
    // function by id, so renaming here cannot break anything).
    let name = fn.name.replace(/[^A-Za-z0-9_]/g, '')
    if (name === '' || /^[0-9]/.test(name)) {
      name = `Fn${counter}`
    }
    let unique = name
    let suffix = 2
    while (usedNames.has(unique)) {
      unique = `${name}_${suffix}`
      suffix += 1
    }
    usedNames.add(unique)
    functions.push({
      id: fn.id,
      name: unique,
      nodes,
      edges: fn.edges.map(e => ({
        id: e.id,
        sourceNodeId: e.source.nodeId,
        sourcePort: e.source.port,
        targetNodeId: e.target.nodeId,
        targetPort: e.target.port,
      })),
    })
    counter += 1
  }
  let maxFn = 0
  for (const fn of functions) {
    const m = /^Fn(\d+)$/.exec(fn.name)
    if (m !== null && m[1] !== undefined) {
      const v = Number.parseInt(m[1], 10)
      if (Number.isFinite(v) && v > maxFn) {
        maxFn = v
      }
    }
  }
  return { functions, nextFunction: maxFn + 1 }
}
