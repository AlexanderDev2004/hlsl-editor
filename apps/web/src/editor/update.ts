// Pure state transitions. Every branch returns the next Model and,
// only when a side effect is needed, the Commands that request it.

import { Option, Predicate } from 'effect'
import { type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import {
  evaluateGraph,
  generate,
  upstreamPortType,
} from '@hlsl-editor/shader-compiler'
import {
  NODE_REGISTRY,
  isNodeType,
  isRerouteType,
} from '@hlsl-editor/shader-nodes'
import {
  type HlslType,
  canConnect,
  connectionErrorMessage,
} from '@hlsl-editor/shader-types'

import { hiddenNodeIds } from './collapse'
import { isValidGroupColor, normalizeHexColor } from './color-picker'
import {
  CopyHlsl,
  DownloadJson,
  LoadGraph,
  LoadSettings,
  PersistGraph,
  PersistSettings,
  PickImportFile,
} from './commands'
import { DEFAULT_GROUP_COLOR } from './groups'
import {
  REROUTE_SIZE,
  ZOOM_STEP,
  clampZoom,
  nodeHeight,
  nodeHeightFor,
  nodeWidth,
} from './layout'
import { nodesInRect, worldRect } from './marquee'
import { Message } from './message'
import {
  type CollapsedNode,
  type EditorEdge,
  type EditorNode,
  type EditorPortDef,
  type FunctionDef,
  type Group,
  type LogEntry,
  type Model,
  emptyModel,
  fromSerialized,
  pushHistory,
  restoreSnapshot,
  seedModel,
  takeSnapshot,
  toDomainFunctions,
  toDomainGraph,
} from './model'
import { isLoadingVariant } from './node-status'
import {
  declarationOfUsage,
  isNamedRerouteLink,
  usagesOfDeclaration,
} from './reroutes'
import { defaultOnSelectNodeFit } from './search'
import {
  DEFAULT_KEYMAP,
  bindingFromKeyEvent,
  bindingOwner,
  commandById,
  formatShortcut,
  isShortcutPlatform,
  parseShortcutSettings,
  serializeShortcutSettings,
} from './shortcuts'

type UpdateReturn = Update.Return<Model, Message>

function withStatus(model: Model, status: string): Model {
  return modifyFields(model, { status: () => status })
}

// Logs a session-console entry (newest first, capped) and mirrors it into
// the status bar. Levels: error, warning, success, info, system.
const LOG_CAP = 200

function withLog(model: Model, level: LogEntry['level'], text: string): Model {
  const entry: LogEntry = { id: model.nextLogId, level, text }
  return modifyFields(model, {
    status: () => text,
    logs: () => [entry, ...model.logs].slice(0, LOG_CAP),
    nextLogId: () => model.nextLogId + 1,
  })
}

interface DecodedPortDef {
  name: string
  direction: 'in' | 'out'
  valueType: string
  required: boolean
}

interface DecodedNode {
  id: string
  type: string
  position: { x: number; y: number }
  params: Record<string, number | Array<number>>
  ports?: Array<DecodedPortDef>
  ref?: string
}

interface DecodedEdge {
  id: string
  source: { nodeId: string; port: string }
  target: { nodeId: string; port: string }
}

function safeParse(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return null
  }
}

function decodePosition(raw: unknown): { x: number; y: number } | null {
  if (!Predicate.isObject(raw) || !('x' in raw) || !('y' in raw)) {
    return null
  }
  if (!Predicate.isNumber(raw.x) || !Predicate.isNumber(raw.y)) {
    return null
  }
  return { x: raw.x, y: raw.y }
}

function decodeParams(
  raw: unknown,
): Record<string, number | Array<number>> | null {
  if (!Predicate.isObject(raw)) {
    return null
  }
  const decoded = Object.entries(raw).map(
    ([key, value]): readonly [string, number | Array<number>] | null => {
      if (Predicate.isNumber(value)) {
        return [key, value]
      }
      if (Array.isArray(value)) {
        const nums = value.filter(Predicate.isNumber)
        if (nums.length === value.length) {
          return [key, nums]
        }
      }
      return null
    },
  )
  if (decoded.some(entry => entry === null)) {
    return null
  }
  return Object.fromEntries(
    decoded.flatMap(entry => (entry === null ? [] : [entry])),
  )
}

// Per-instance ports serialize only on function node kinds (FunctionInput
// carries the argument name/type, FunctionCall mirrors the signature).
function decodePorts(raw: unknown): Array<DecodedPortDef> | null {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    return null
  }
  const ports: Array<DecodedPortDef> = []
  for (const item of raw) {
    if (
      !Predicate.isObject(item) ||
      !('name' in item) ||
      !('direction' in item) ||
      !('valueType' in item) ||
      !('required' in item)
    ) {
      return null
    }
    if (
      !Predicate.isString(item.name) ||
      !Predicate.isString(item.valueType) ||
      !Predicate.isBoolean(item.required) ||
      (item.direction !== 'in' && item.direction !== 'out')
    ) {
      return null
    }
    ports.push({
      name: item.name,
      direction: item.direction,
      valueType: item.valueType,
      required: item.required,
    })
  }
  return ports
}

function decodeNode(raw: unknown): DecodedNode | null {
  if (
    !Predicate.isObject(raw) ||
    !('id' in raw) ||
    !('type' in raw) ||
    !('position' in raw) ||
    !('params' in raw)
  ) {
    return null
  }
  if (!Predicate.isString(raw.id) || !Predicate.isString(raw.type)) {
    return null
  }
  const position = decodePosition(raw.position)
  const params = decodeParams(raw.params)
  if (position === null || params === null) {
    return null
  }
  const ports = decodePorts('ports' in raw ? raw.ports : undefined)
  if (ports === null) {
    return null
  }
  const ref = 'ref' in raw && Predicate.isString(raw.ref) ? raw.ref : undefined
  return {
    id: raw.id,
    type: raw.type,
    position,
    params,
    ...(ports.length > 0 ? { ports } : {}),
    ...(ref !== undefined ? { ref } : {}),
  }
}

function decodeEndpoint(raw: unknown): { nodeId: string; port: string } | null {
  if (!Predicate.isObject(raw) || !('nodeId' in raw) || !('port' in raw)) {
    return null
  }
  if (!Predicate.isString(raw.nodeId) || !Predicate.isString(raw.port)) {
    return null
  }
  return { nodeId: raw.nodeId, port: raw.port }
}

function decodeEdge(raw: unknown): DecodedEdge | null {
  if (
    !Predicate.isObject(raw) ||
    !('id' in raw) ||
    !('source' in raw) ||
    !('target' in raw)
  ) {
    return null
  }
  if (!Predicate.isString(raw.id)) {
    return null
  }
  const source = decodeEndpoint(raw.source)
  const target = decodeEndpoint(raw.target)
  if (source === null || target === null) {
    return null
  }
  return { id: raw.id, source, target }
}

function decodeCollapsed(raw: unknown): CollapsedNode | null {
  if (
    !Predicate.isObject(raw) ||
    !('id' in raw) ||
    !('name' in raw) ||
    !('nodeIds' in raw)
  ) {
    return null
  }
  if (
    !Predicate.isString(raw.id) ||
    !Predicate.isString(raw.name) ||
    !Array.isArray(raw.nodeIds)
  ) {
    return null
  }
  const nodeIds = raw.nodeIds.filter(Predicate.isString)
  if (nodeIds.length !== raw.nodeIds.length) {
    return null
  }
  return { id: raw.id, name: raw.name, nodeIds }
}

function decodeRerouteNames(raw: unknown): Record<string, string> | null {
  if (raw === undefined) {
    return {}
  }
  if (!Predicate.isObject(raw)) {
    return null
  }
  const names: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Predicate.isString(value)) {
      return null
    }
    names[key] = value
  }
  return names
}

function parseGraphText(text: string):
  | {
      ok: true
      data: {
        version: number
        nodes: Array<DecodedNode>
        edges: Array<DecodedEdge>
        outputNodeId: string | null
        rerouteNames: Record<string, string>
        collapsed: Array<CollapsedNode>
        functions: Array<{
          id: string
          name: string
          nodes: Array<DecodedNode>
          edges: Array<DecodedEdge>
        }>
      }
    }
  | { ok: false; reason: string } {
  const raw: unknown = safeParse(text)
  if (
    !Predicate.isObject(raw) ||
    !('version' in raw) ||
    !('nodes' in raw) ||
    !('edges' in raw)
  ) {
    return { ok: false, reason: 'Import file is not a graph object.' }
  }
  // Version 1 predates Material Functions (functions default to empty);
  // version 2 adds the functions array.
  if (raw.version !== 1 && raw.version !== 2) {
    return {
      ok: false,
      reason: `Unsupported graph version: ${String(raw.version)}.`,
    }
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    return { ok: false, reason: 'Import file is missing nodes or edges.' }
  }
  const nodes = raw.nodes.map(decodeNode)
  if (nodes.some(n => n === null)) {
    return { ok: false, reason: 'Import file contains an invalid node.' }
  }
  const edges = raw.edges.map(decodeEdge)
  if (edges.some(e => e === null)) {
    return { ok: false, reason: 'Import file contains an invalid edge.' }
  }
  const outputNodeId =
    'outputNodeId' in raw && Predicate.isString(raw.outputNodeId)
      ? raw.outputNodeId
      : null
  const rerouteNames = decodeRerouteNames(
    'rerouteNames' in raw ? raw.rerouteNames : undefined,
  )
  if (rerouteNames === null) {
    return { ok: false, reason: 'Import file has invalid reroute names.' }
  }
  const collapsedRaw = 'collapsed' in raw ? raw.collapsed : []
  if (!Array.isArray(collapsedRaw)) {
    return { ok: false, reason: 'Import file has invalid collapsed groups.' }
  }
  const collapsed = collapsedRaw.map(decodeCollapsed)
  if (collapsed.some(c => c === null)) {
    return { ok: false, reason: 'Import file has an invalid collapsed group.' }
  }
  const functionsRaw = 'functions' in raw ? raw.functions : []
  if (!Array.isArray(functionsRaw)) {
    return { ok: false, reason: 'Import file has invalid functions.' }
  }
  const functions: Array<{
    id: string
    name: string
    nodes: Array<DecodedNode>
    edges: Array<DecodedEdge>
  }> = []
  for (const fn of functionsRaw) {
    if (
      !Predicate.isObject(fn) ||
      !('id' in fn) ||
      !('name' in fn) ||
      !('nodes' in fn) ||
      !('edges' in fn) ||
      !Predicate.isString(fn.id) ||
      !Predicate.isString(fn.name) ||
      !Array.isArray(fn.nodes) ||
      !Array.isArray(fn.edges)
    ) {
      return { ok: false, reason: 'Import file has an invalid function.' }
    }
    const fnNodes = fn.nodes.map(decodeNode)
    if (fnNodes.some(n => n === null)) {
      return { ok: false, reason: 'Import file has an invalid function node.' }
    }
    const fnEdges = fn.edges.map(decodeEdge)
    if (fnEdges.some(e => e === null)) {
      return { ok: false, reason: 'Import file has an invalid function edge.' }
    }
    functions.push({
      id: fn.id,
      name: fn.name,
      nodes: fnNodes.flatMap(n => (n === null ? [] : [n])),
      edges: fnEdges.flatMap(e => (e === null ? [] : [e])),
    })
  }
  return {
    ok: true,
    data: {
      version: typeof raw.version === 'number' ? raw.version : 1,
      nodes: nodes.flatMap(n => (n === null ? [] : [n])),
      edges: edges.flatMap(e => (e === null ? [] : [e])),
      outputNodeId,
      rerouteNames,
      collapsed: collapsed.flatMap(c => (c === null ? [] : [c])),
      functions,
    },
  }
}

function applyImported(model: Model, text: string, pushUndo: boolean): Model {
  const parsed = parseGraphText(text)
  if (!parsed.ok) {
    return withLog(model, 'error', parsed.reason)
  }
  const restored = fromSerialized(parsed.data)
  const base = pushUndo ? pushHistory(model) : model
  return modifyFields(
    withLog(
      base,
      'success',
      `Imported graph with ${restored.nodes.length} nodes.`,
    ),
    {
      nodes: () => restored.nodes,
      edges: () => restored.edges,
      groups: () => [],
      collapsed: () => restored.collapsed,
      nextCollapsed: () => restored.nextCollapsed,
      rerouteNames: () => restored.rerouteNames,
      outputNodeId: () => restored.outputNodeId,
      nextNode: () => restored.nextNode,
      nextEdge: () => restored.nextEdge,
      nextGroup: () => 1,
      functions: () => restored.functions,
      nextFunction: () => restored.nextFunction,
      selectedNodeIds: () => [],
      selectedGroupId: () => Option.none(),
      selectedCollapsedId: () => Option.none(),
      pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    },
  )
}

// Removes the selected nodes, edge, or group in one history entry.
// Deleting an edge only drops the wire; its nodes stay, so the user can
// connect them again. Deleting a group removes the frame only.
function deleteSelection(model: Model): Model {
  const nodeIds = model.selectedNodeIds
  const edgeId = Option.getOrNull(model.selectedEdgeId)
  const groupId = Option.getOrNull(model.selectedGroupId)
  const collapsedId = Option.getOrNull(model.selectedCollapsedId)
  if (
    nodeIds.length === 0 &&
    edgeId === null &&
    groupId === null &&
    collapsedId === null
  ) {
    return withStatus(model, 'Nothing selected to delete.')
  }
  const gone = new Set(nodeIds)
  const nodes = model.nodes.filter(n => !gone.has(n.id))
  const edges = model.edges.filter(
    e =>
      e.id !== edgeId && !gone.has(e.sourceNodeId) && !gone.has(e.targetNodeId),
  )
  // Drop deleted nodes from every group, and remove any group left empty.
  const groups = model.groups
    .filter(group => group.id !== groupId)
    .map(group => ({
      ...group,
      nodeIds: group.nodeIds.filter(id => !gone.has(id)),
    }))
    .filter(group => group.nodeIds.length > 0)
  const collapsed = model.collapsed
    .filter(entry => entry.id !== collapsedId)
    .map(entry => ({
      ...entry,
      nodeIds: entry.nodeIds.filter(id => !gone.has(id)),
    }))
    .filter(entry => entry.nodeIds.length > 0)
  const rerouteNames = Object.fromEntries(
    Object.entries(model.rerouteNames).filter(([key]) => !gone.has(key)),
  )
  const outputId = Option.getOrNull(model.outputNodeId)
  const outputGone = outputId !== null && gone.has(outputId)
  const base = pushHistory(model)
  const message =
    nodeIds.length > 0
      ? `Deleted ${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'}.`
      : groupId !== null
        ? `Deleted ${groupId}.`
        : collapsedId !== null
          ? `Deleted ${collapsedId}.`
          : `Deleted edge ${edgeId ?? ''}.`
  return modifyFields(withLog(base, 'info', message), {
    nodes: () => nodes,
    edges: () => edges,
    groups: () => groups,
    collapsed: () => collapsed,
    rerouteNames: () => rerouteNames,
    outputNodeId: () => (outputGone ? Option.none() : base.outputNodeId),
    selectedNodeIds: () => [],
    selectedEdgeId: () => Option.none(),
    selectedGroupId: () => Option.none(),
    selectedCollapsedId: () => Option.none(),
    pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
  })
}

function closeContextMenu(model: Model): Model {
  return modifyFields(model, { contextMenu: () => Option.none() })
}

function dismissNodeMenu(model: Model): Model {
  return modifyFields(model, { nodeMenu: () => Option.none() })
}

function dismissColorPicker(model: Model): Model {
  return modifyFields(model, { colorPicker: () => Option.none() })
}

// Cancels an in-flight wire and closes the add-node menu. Escape routes here
// when no overlay owns the key.
function cancelPending(model: Model): Model {
  return modifyFields(model, {
    pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    contextMenu: () => Option.none(),
    nodeMenu: () => Option.none(),
    drag: () => (model.drag.mode === 'wire' ? { mode: 'idle' } : model.drag),
    status: () => 'Connection cancelled.',
  })
}

// Wraps the selected nodes in a named, colored group. Membership only — the
// frame is derived from the member nodes' positions.
function groupSelection(model: Model): Model {
  const members = model.selectedNodeIds
  if (members.length === 0) {
    return withStatus(model, 'Select nodes to group first.')
  }
  const id = `g${model.nextGroup}`
  const group: Group = {
    id,
    name: `Group ${model.nextGroup}`,
    color: DEFAULT_GROUP_COLOR,
    nodeIds: [...members],
  }
  // A node belongs to at most one group, so drop it from any existing group
  // and prune groups left empty.
  const groups = model.groups
    .map(existing => ({
      ...existing,
      nodeIds: existing.nodeIds.filter(nodeId => !members.includes(nodeId)),
    }))
    .filter(existing => existing.nodeIds.length > 0)
  const base = pushHistory(model)
  return modifyFields(base, {
    groups: () => [...groups, group],
    nextGroup: () => model.nextGroup + 1,
    selectedGroupId: () => Option.some(id),
    selectedNodeIds: () => [],
    selectedEdgeId: () => Option.none(),
    status: () =>
      `Grouped ${members.length} node${members.length === 1 ? '' : 's'}.`,
  })
}

// Removes the selected group (the frame only; its nodes stay).
function ungroupSelected(model: Model): Model {
  const groupId = Option.getOrNull(model.selectedGroupId)
  if (groupId === null) {
    return withStatus(model, 'Select a group to ungroup.')
  }
  const base = pushHistory(model)
  return modifyFields(base, {
    groups: () => model.groups.filter(group => group.id !== groupId),
    selectedGroupId: () => Option.none(),
    status: () => `Ungrouped ${groupId}.`,
  })
}

// Extracts the selected nodes into a Material Function (Unreal-style):
// internal wiring is preserved, every incoming wire becomes a function
// argument (named after the consumed input port), the single outgoing wire
// becomes the return value, and the selection is replaced by one
// FunctionCall node whose ports mirror the new signature.
function createFunctionFromSelection(model: Model): Model {
  const selectedIds = new Set(model.selectedNodeIds)
  const selected = model.nodes.filter(n => selectedIds.has(n.id))
  if (selected.length === 0) {
    return withLog(
      model,
      'error',
      'Select nodes to extract into a function first.',
    )
  }
  const invalid = selected.find(
    n =>
      n.type === 'FragmentOutput' ||
      n.type === 'FunctionCall' ||
      n.type === 'FunctionInput' ||
      n.type === 'FunctionOutput' ||
      isRerouteType(n.type),
  )
  if (invalid !== undefined) {
    const reason =
      invalid.type === 'FragmentOutput'
        ? 'the Fragment Output must stay on the main graph'
        : invalid.type === 'FunctionCall'
          ? 'nested functions are not supported'
          : `${invalid.type} nodes cannot be part of an extraction`
    return withLog(model, 'error', `Cannot create a function: ${reason}.`)
  }
  const graph = toDomainGraph(model)
  const argEdges = model.edges.filter(
    e => selectedIds.has(e.targetNodeId) && !selectedIds.has(e.sourceNodeId),
  )
  const outEdges = model.edges.filter(
    e => selectedIds.has(e.sourceNodeId) && !selectedIds.has(e.targetNodeId),
  )
  if (outEdges.length !== 1) {
    return withLog(
      model,
      'error',
      outEdges.length === 0
        ? 'Cannot create a function: the selection has no outgoing wire. Connect it to something outside the selection first.'
        : `Cannot create a function: the selection has ${outEdges.length} outgoing wires; exactly one is required.`,
    )
  }
  const outEdge = outEdges[0]
  if (outEdge === undefined) {
    return model
  }
  const returnType = upstreamPortType(
    graph,
    outEdge.sourceNodeId,
    outEdge.sourcePort,
  )
  if (returnType === null) {
    return withLog(
      model,
      'error',
      'Cannot create a function: the output type cannot be resolved yet.',
    )
  }
  const argDefs: Array<{ edge: EditorEdge; name: string; type: HlslType }> = []
  const usedArgNames = new Set<string>()
  for (const edge of argEdges) {
    const type = upstreamPortType(graph, edge.sourceNodeId, edge.sourcePort)
    if (type === null) {
      return withLog(
        model,
        'error',
        `Cannot create a function: the type of ${edge.sourceNodeId}.${edge.sourcePort} is not resolved yet.`,
      )
    }
    let baseName = edge.targetPort.replace(/[^A-Za-z0-9_]/g, '')
    if (baseName === '' || /^[0-9]/.test(baseName)) {
      baseName = 'Value'
    }
    let name = baseName
    let suffix = 2
    while (usedArgNames.has(name)) {
      name = `${baseName}${suffix}`
      suffix += 1
    }
    usedArgNames.add(name)
    argDefs.push({ edge, name, type })
  }
  const fnId = `f${model.nextFunction}`
  const fnName = `Fn${model.nextFunction}`
  const callId = `n${model.nextNode}`
  const centroid = {
    x: Math.round(
      selected.reduce((sum, n) => sum + n.position.x, 0) / selected.length,
    ),
    y: Math.round(
      selected.reduce((sum, n) => sum + n.position.y, 0) / selected.length,
    ),
  }
  // Function definition: the extracted nodes, one FunctionInput per argument
  // (its out port IS the argument), and one FunctionOutput for the return.
  const defNodes: Array<FunctionDef['nodes'][number]> = [
    ...selected.map(n => ({ ...n })),
    ...argDefs.map((arg, i): EditorNode => ({
      id: `${fnId}_arg${i}`,
      type: 'FunctionInput',
      position: { x: 0, y: i * 120 },
      params: {},
      ports: [
        {
          name: arg.name,
          direction: 'out',
          valueType: arg.type,
          required: false,
        },
      ],
    })),
    {
      id: `${fnId}_out`,
      type: 'FunctionOutput',
      position: { x: 300, y: 0 },
      params: {},
    },
  ]
  const defEdges: Array<FunctionDef['edges'][number]> = [
    ...model.edges
      .filter(
        e => selectedIds.has(e.sourceNodeId) && selectedIds.has(e.targetNodeId),
      )
      .map(e => ({ ...e })),
    ...argDefs.map((arg, i): EditorEdge => ({
      id: `${fnId}_arg${i}e`,
      sourceNodeId: `${fnId}_arg${i}`,
      sourcePort: arg.name,
      targetNodeId: arg.edge.targetNodeId,
      targetPort: arg.edge.targetPort,
    })),
    {
      id: `${fnId}_rete`,
      sourceNodeId: outEdge.sourceNodeId,
      sourcePort: outEdge.sourcePort,
      targetNodeId: `${fnId}_out`,
      targetPort: 'in',
    },
  ]
  const callNode: EditorNode = {
    id: callId,
    type: 'FunctionCall',
    position: centroid,
    params: {},
    ref: fnId,
    ports: [
      ...argDefs.map((arg): EditorPortDef => ({
        name: arg.name,
        direction: 'in',
        valueType: arg.type,
        required: true,
      })),
      { name: 'out', direction: 'out', valueType: returnType, required: false },
    ],
  }
  const internalEdgeIds = new Set(
    model.edges
      .filter(
        e => selectedIds.has(e.sourceNodeId) && selectedIds.has(e.targetNodeId),
      )
      .map(e => e.id),
  )
  const argEdgeById = new Map(argDefs.map(arg => [arg.edge.id, arg]))
  const rewiredEdges: Array<EditorEdge> = model.edges
    .filter(e => !internalEdgeIds.has(e.id) && e.id !== outEdge.id)
    .map(e => {
      const arg = argEdgeById.get(e.id)
      return arg === undefined
        ? e
        : { ...e, targetNodeId: callId, targetPort: arg.name }
    })
  const callOutputEdge: EditorEdge = {
    id: `e${model.nextEdge}`,
    sourceNodeId: callId,
    sourcePort: 'out',
    targetNodeId: outEdge.targetNodeId,
    targetPort: outEdge.targetPort,
  }
  const fnDef: FunctionDef = {
    id: fnId,
    name: fnName,
    nodes: defNodes,
    edges: defEdges,
  }
  const base = pushHistory(model)
  return modifyFields(
    withLog(
      base,
      'success',
      `Created ${fnName}(${argDefs.map(a => a.name).join(', ')}) — the selection was replaced by ${callId}.`,
    ),
    {
      nodes: () => [
        ...base.nodes.filter(n => !selectedIds.has(n.id)),
        callNode,
      ],
      edges: () => [...rewiredEdges, callOutputEdge],
      functions: () => [...base.functions, fnDef],
      groups: () =>
        base.groups
          .map(group => ({
            ...group,
            nodeIds: group.nodeIds.filter(id => !selectedIds.has(id)),
          }))
          .filter(group => group.nodeIds.length > 0),
      collapsed: () =>
        base.collapsed
          .map(entry => ({
            ...entry,
            nodeIds: entry.nodeIds.filter(id => !selectedIds.has(id)),
          }))
          .filter(entry => entry.nodeIds.length > 0),
      nextNode: () => base.nextNode + 1,
      nextEdge: () => base.nextEdge + 1,
      nextFunction: () => base.nextFunction + 1,
      selectedNodeIds: () => [callId],
      selectedEdgeId: () => Option.none(),
      selectedGroupId: () => Option.none(),
      selectedCollapsedId: () => Option.none(),
      pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    },
  )
}

// Shared by the toolbar "Add node" button and the right-click menu. Validates
// the type and the single-Fragment-Output rule, then inserts and selects it.
function addNodeAt(model: Model, type: string, x: number, y: number): Model {
  if (!isNodeType(type)) {
    return withLog(model, 'error', `Unknown node type: ${type}.`)
  }
  if (
    type === 'FunctionCall' ||
    type === 'FunctionInput' ||
    type === 'FunctionOutput'
  ) {
    return withLog(
      model,
      'error',
      'Function nodes are created by selecting nodes and choosing Create Function.',
    )
  }
  if (type === 'FragmentOutput' && Option.isSome(model.outputNodeId)) {
    return withLog(
      model,
      'error',
      'There is already a Fragment Output. Only one is allowed.',
    )
  }
  const id = `n${model.nextNode}`
  const node = {
    id,
    type,
    position: { x, y },
    params: { ...NODE_REGISTRY[type].defaultParams },
  }
  const base = pushHistory(model)
  return modifyFields(withLog(base, 'info', `Added ${type} (${id}).`), {
    nodes: () => [...base.nodes, node],
    outputNodeId: () =>
      type === 'FragmentOutput' ? Option.some(id) : base.outputNodeId,
    nextNode: () => base.nextNode + 1,
    selectedNodeIds: () => [id],
  })
}

function attemptConnect(
  model: Model,
  fromNodeId: string,
  fromPort: string,
  toNodeId: string,
  toPort: string,
): Model {
  const graph = toDomainGraph(model)
  const sourceNode = graph.nodes.find(n => n.id === fromNodeId)
  const targetNode = graph.nodes.find(n => n.id === toNodeId)
  if (sourceNode === undefined || targetNode === undefined) {
    return withLog(model, 'error', 'Cannot connect: node not found.')
  }
  const sourcePortDef = sourceNode.ports.find(
    p => p.name === fromPort && p.direction === 'out',
  )
  const targetPortDef = targetNode.ports.find(
    p => p.name === toPort && p.direction === 'in',
  )
  if (sourcePortDef === undefined) {
    return withLog(
      model,
      'error',
      `Cannot connect: ${fromNodeId}.${fromPort} is not an output port. Start from an output (right side).`,
    )
  }
  if (targetPortDef === undefined) {
    return withLog(
      model,
      'error',
      `Cannot connect: ${toNodeId}.${toPort} is not an input port. End on an input (left side).`,
    )
  }
  if (fromNodeId === toNodeId) {
    return withLog(model, 'error', 'Cannot connect a node to itself.')
  }
  if (
    model.edges.some(
      e => e.targetNodeId === toNodeId && e.targetPort === toPort,
    )
  ) {
    return withLog(
      model,
      'error',
      `Input ${toNodeId}.${toPort} is already connected. Disconnect it first.`,
    )
  }
  const sourceType = upstreamPortType(graph, fromNodeId, fromPort)
  if (sourceType === null) {
    return withLog(
      model,
      'error',
      'Cannot connect: source type is not ready yet. Connect its inputs first.',
    )
  }
  // Instance ports (FunctionCall arguments) declare exactly their own type;
  // registry ports carry their accepts list on the domain node.
  const allowed = targetPortDef.accepts ?? [targetPortDef.valueType]
  const ok = allowed.some(t => canConnect(sourceType, t))
  if (!ok) {
    const single = allowed.length === 1 ? allowed[0] : undefined
    const expected = single !== undefined ? single : allowed.join(' | ')
    return withLog(model, 'error', connectionErrorMessage(expected, sourceType))
  }
  const edge: EditorEdge = {
    id: `e${model.nextEdge}`,
    sourceNodeId: fromNodeId,
    sourcePort: fromPort,
    targetNodeId: toNodeId,
    targetPort: toPort,
  }
  const base = pushHistory(model)
  return modifyFields(
    withLog(
      base,
      'success',
      `Connected ${fromNodeId}.${fromPort} to ${toNodeId}.${toPort}.`,
    ),
    {
      edges: () => [...base.edges, edge],
      nextEdge: () => base.nextEdge + 1,
      pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    },
  )
}

// Direction of a named port on a node, or null when the node or port is
// unknown. Shared by the wire-drag handlers. Instance ports (on function
// nodes) are checked first; the registry covers every other kind.
function portDirectionOf(
  model: Model,
  nodeId: string,
  port: string,
): 'in' | 'out' | null {
  const node = model.nodes.find(n => n.id === nodeId)
  if (node === undefined || !isNodeType(node.type)) {
    return null
  }
  if (node.ports !== undefined) {
    const found = node.ports.find(p => p.name === port)
    return found?.direction ?? null
  }
  const def = NODE_REGISTRY[node.type]
  if (def.inputs.some(p => p.name === port)) {
    return 'in'
  }
  if (def.outputs.some(p => p.name === port)) {
    return 'out'
  }
  return null
}

// Connects a freshly added node to the port a wire was dragged from, when the
// wire was dropped on empty canvas. Best-effort: if no port on the new node
// accepts the wire, the node is still added and a hint is left in the status.
function autoConnectFromPending(model: Model, newNodeId: string): Model {
  if (!model.pending.active) {
    return model
  }
  const { fromNodeId, fromPort } = model.pending
  const sourceDir = portDirectionOf(model, fromNodeId, fromPort)
  const newNode = model.nodes.find(n => n.id === newNodeId)
  if (
    sourceDir === null ||
    newNode === undefined ||
    !isNodeType(newNode.type)
  ) {
    return model
  }
  const graph = toDomainGraph(model)
  const sourceType = upstreamPortType(graph, fromNodeId, fromPort)
  if (sourceType === null) {
    return model
  }
  const newDef = NODE_REGISTRY[newNode.type]
  if (sourceDir === 'out') {
    const target = newDef.inputs.find(input =>
      (input.accepts ?? [input.valueType]).some(t => canConnect(sourceType, t)),
    )
    if (target === undefined) {
      return withStatus(
        model,
        `Added ${newNode.type}. Connect an input to ${fromNodeId}.${fromPort}.`,
      )
    }
    return attemptConnect(model, fromNodeId, fromPort, newNodeId, target.name)
  }
  const sourceNode = model.nodes.find(n => n.id === fromNodeId)
  const sourceDef =
    sourceNode !== undefined && isNodeType(sourceNode.type)
      ? NODE_REGISTRY[sourceNode.type]
      : null
  const sourceInput = sourceDef?.inputs.find(i => i.name === fromPort)
  const allowed =
    sourceInput?.accepts ??
    (sourceInput !== undefined ? [sourceInput.valueType] : [])
  const output = newDef.outputs.find(out => {
    const outType = upstreamPortType(graph, newNodeId, out.name)
    return outType !== null && allowed.some(t => canConnect(outType, t))
  })
  if (output === undefined) {
    return withStatus(
      model,
      `Added ${newNode.type}. Connect its output to ${fromNodeId}.${fromPort}.`,
    )
  }
  return attemptConnect(model, newNodeId, output.name, fromNodeId, fromPort)
}

// Topmost visible node whose bounds contain a world point, or null. Used to
// decide whether a wire dropped on the canvas landed on empty space.
function nodeAtWorldPoint(model: Model, x: number, y: number): string | null {
  const hidden = hiddenNodeIds(model)
  const found = [...model.nodes].reverse().find(n => {
    if (hidden.has(n.id) || !isNodeType(n.type)) {
      return false
    }
    return (
      x >= n.position.x &&
      x <= n.position.x + nodeWidth(n.type) &&
      y >= n.position.y &&
      y <= n.position.y + nodeHeightFor(n.type, n.ports)
    )
  })
  return found?.id ?? null
}

function nextRerouteName(model: Model): string {
  const count = model.nodes.filter(
    node => node.type === 'NamedRerouteDeclaration',
  ).length
  return `Reroute ${count + 1}`
}

function insertRerouteOnEdge(
  model: Model,
  edgeId: string,
  worldX: number,
  worldY: number,
): Model {
  const edge = model.edges.find(e => e.id === edgeId)
  if (edge === undefined) {
    return withStatus(model, 'No wire to split.')
  }
  const id = `n${model.nextNode}`
  const node: EditorNode = {
    id,
    type: 'Reroute',
    position: { x: worldX - REROUTE_SIZE / 2, y: worldY - REROUTE_SIZE / 2 },
    params: {},
  }
  const into: EditorEdge = {
    id: `e${model.nextEdge}`,
    sourceNodeId: edge.sourceNodeId,
    sourcePort: edge.sourcePort,
    targetNodeId: id,
    targetPort: 'in',
  }
  const outOf: EditorEdge = {
    id: `e${model.nextEdge + 1}`,
    sourceNodeId: id,
    sourcePort: 'out',
    targetNodeId: edge.targetNodeId,
    targetPort: edge.targetPort,
  }
  const base = pushHistory(model)
  return modifyFields(base, {
    nodes: () => [...model.nodes, node],
    edges: () => [...model.edges.filter(e => e.id !== edgeId), into, outOf],
    nextNode: () => model.nextNode + 1,
    nextEdge: () => model.nextEdge + 2,
    selectedNodeIds: () => [id],
    selectedEdgeId: () => Option.none(),
    status: () => `Inserted reroute ${id}.`,
  })
}

// Replaces a plain Reroute with a declaration/usage pair joined by a hidden
// link edge. The declaration takes the reroute's input, the usage its outputs.
function convertRerouteToNamed(model: Model, nodeId: string): Model {
  const node = model.nodes.find(n => n.id === nodeId)
  if (node === undefined || node.type !== 'Reroute') {
    return withStatus(model, 'Select a reroute to convert.')
  }
  const declarationId = `n${model.nextNode}`
  const usageId = `n${model.nextNode + 1}`
  const declaration: EditorNode = {
    id: declarationId,
    type: 'NamedRerouteDeclaration',
    position: { ...node.position },
    params: {},
  }
  const usage: EditorNode = {
    id: usageId,
    type: 'NamedRerouteUsage',
    position: {
      x: node.position.x + REROUTE_SIZE + 40,
      y: node.position.y,
    },
    params: {},
  }
  const link: EditorEdge = {
    id: `e${model.nextEdge}`,
    sourceNodeId: declarationId,
    sourcePort: 'out',
    targetNodeId: usageId,
    targetPort: 'in',
  }
  const edges = model.edges.flatMap(edge => {
    if (edge.targetNodeId === nodeId && edge.targetPort === 'in') {
      return [{ ...edge, targetNodeId: declarationId, targetPort: 'in' }]
    }
    if (edge.sourceNodeId === nodeId && edge.sourcePort === 'out') {
      return [{ ...edge, sourceNodeId: usageId, sourcePort: 'out' }]
    }
    return [edge]
  })
  const base = pushHistory(model)
  const rerouteNames = {
    ...model.rerouteNames,
    [declarationId]: nextRerouteName(model),
  }
  return modifyFields(base, {
    nodes: () => [
      ...model.nodes.filter(n => n.id !== nodeId),
      declaration,
      usage,
    ],
    edges: () => [...edges, link],
    nextNode: () => model.nextNode + 2,
    nextEdge: () => model.nextEdge + 1,
    rerouteNames: () => rerouteNames,
    selectedNodeIds: () => [usageId],
    selectedEdgeId: () => Option.none(),
    status: () => `Converted ${nodeId} to named reroute ${declarationId}.`,
  })
}

// Collapses a declaration/usage pair back into a single Reroute.
function convertNamedRerouteToReroute(model: Model, nodeId: string): Model {
  const node = model.nodes.find(n => n.id === nodeId)
  if (node === undefined) {
    return model
  }
  if (
    node.type !== 'NamedRerouteDeclaration' &&
    node.type !== 'NamedRerouteUsage'
  ) {
    return withStatus(model, 'Select a named reroute to convert.')
  }
  const declarationId =
    node.type === 'NamedRerouteDeclaration'
      ? nodeId
      : declarationOfUsage(model, nodeId)
  if (declarationId === null) {
    return withStatus(model, 'This usage has no declaration.')
  }
  const usages = usagesOfDeclaration(model, declarationId)
  const usageId = usages[0]
  if (usageId === undefined) {
    return withStatus(model, 'This declaration has no usage.')
  }
  if (usages.length > 1) {
    return withStatus(
      model,
      'This reroute has multiple usages; delete the extras before converting.',
    )
  }
  const rerouteId = `n${model.nextNode}`
  const declaration = model.nodes.find(n => n.id === declarationId)
  const reroute: EditorNode = {
    id: rerouteId,
    type: 'Reroute',
    position: declaration?.position ?? node.position,
    params: {},
  }
  const removed = new Set([declarationId, usageId])
  const edges = model.edges.flatMap(edge => {
    if (isNamedRerouteLink(model, edge)) {
      return []
    }
    if (edge.targetNodeId === declarationId) {
      return [{ ...edge, targetNodeId: rerouteId, targetPort: 'in' }]
    }
    if (edge.sourceNodeId === usageId) {
      return [{ ...edge, sourceNodeId: rerouteId, sourcePort: 'out' }]
    }
    return [edge]
  })
  const names = Object.fromEntries(
    Object.entries(model.rerouteNames).filter(([key]) => key !== declarationId),
  )
  const base = pushHistory(model)
  return modifyFields(base, {
    nodes: () => [...model.nodes.filter(n => !removed.has(n.id)), reroute],
    edges: () => edges,
    nextNode: () => model.nextNode + 1,
    rerouteNames: () => names,
    selectedNodeIds: () => [rerouteId],
    selectedEdgeId: () => Option.none(),
    status: () => `Converted ${declarationId} to a plain reroute.`,
  })
}

function addNamedRerouteUsage(model: Model, declarationId: string): Model {
  const declaration = model.nodes.find(
    n => n.id === declarationId && n.type === 'NamedRerouteDeclaration',
  )
  if (declaration === undefined) {
    return withStatus(model, 'Select a reroute declaration first.')
  }
  const usageId = `n${model.nextNode}`
  const usage: EditorNode = {
    id: usageId,
    type: 'NamedRerouteUsage',
    position: { x: declaration.position.x, y: declaration.position.y + 80 },
    params: {},
  }
  const link: EditorEdge = {
    id: `e${model.nextEdge}`,
    sourceNodeId: declarationId,
    sourcePort: 'out',
    targetNodeId: usageId,
    targetPort: 'in',
  }
  const base = pushHistory(model)
  return modifyFields(base, {
    nodes: () => [...model.nodes, usage],
    edges: () => [...model.edges, link],
    nextNode: () => model.nextNode + 1,
    nextEdge: () => model.nextEdge + 1,
    selectedNodeIds: () => [usageId],
    status: () => `Added usage ${usageId}.`,
  })
}

function renameReroute(
  model: Model,
  declarationId: string,
  name: string,
): Model {
  if (model.nodes.every(n => n.id !== declarationId)) {
    return model
  }
  const rerouteNames = { ...model.rerouteNames, [declarationId]: name }
  return modifyFields(model, {
    rerouteNames: () => rerouteNames,
  })
}

function selectRerouteUsages(model: Model, declarationId: string): Model {
  const usages = usagesOfDeclaration(model, declarationId)
  if (usages.length === 0) {
    return withStatus(model, 'This reroute has no usages.')
  }
  return modifyFields(model, {
    selectedNodeIds: () => usages,
    selectedEdgeId: () => Option.none(),
    selectedGroupId: () => Option.none(),
    status: () =>
      `Selected ${usages.length} usage${usages.length === 1 ? '' : 's'}.`,
  })
}

function selectRerouteDeclaration(model: Model, usageId: string): Model {
  const declarationId = declarationOfUsage(model, usageId)
  if (declarationId === null) {
    return withStatus(model, 'This usage has no declaration.')
  }
  return modifyFields(model, {
    selectedNodeIds: () => [declarationId],
    selectedEdgeId: () => Option.none(),
    selectedGroupId: () => Option.none(),
    status: () => `Selected declaration ${declarationId}.`,
  })
}

// ALIGN & DISTRIBUTE (Unreal-style)

function alignNodes(model: Model, mode: string): Model {
  const selected = model.nodes.filter(n => model.selectedNodeIds.includes(n.id))
  if (selected.length < 2) {
    return withStatus(model, 'Select at least two nodes to align.')
  }
  const left = Math.min(...selected.map(n => n.position.x))
  const right = Math.max(...selected.map(n => n.position.x + nodeWidth(n.type)))
  const top = Math.min(...selected.map(n => n.position.y))
  const bottom = Math.max(
    ...selected.map(n => n.position.y + nodeHeight(n.type)),
  )
  const aligners: Record<string, (n: EditorNode) => { x: number; y: number }> =
    {
      left: n => ({ x: left, y: n.position.y }),
      right: n => ({ x: right - nodeWidth(n.type), y: n.position.y }),
      top: n => ({ x: n.position.x, y: top }),
      bottom: n => ({ x: n.position.x, y: bottom - nodeHeight(n.type) }),
      centerX: n => ({
        x: (left + right) / 2 - nodeWidth(n.type) / 2,
        y: n.position.y,
      }),
      centerY: n => ({
        x: n.position.x,
        y: (top + bottom) / 2 - nodeHeight(n.type) / 2,
      }),
    }
  const aligner = aligners[mode]
  if (aligner === undefined) {
    return model
  }
  const base = pushHistory(model)
  return modifyFields(base, {
    nodes: () =>
      model.nodes.map(n =>
        model.selectedNodeIds.includes(n.id)
          ? { ...n, position: aligner(n) }
          : n,
      ),
    status: () => `Aligned ${selected.length} nodes (${mode}).`,
  })
}

function distributeNodes(model: Model, axis: string): Model {
  const horizontal = axis === 'horizontal'
  const selected = model.nodes.filter(n => model.selectedNodeIds.includes(n.id))
  if (selected.length < 3) {
    return withStatus(model, 'Select at least three nodes to distribute.')
  }
  const center = (n: EditorNode): number =>
    horizontal
      ? n.position.x + nodeWidth(n.type) / 2
      : n.position.y + nodeHeight(n.type) / 2
  const sorted = [...selected].sort((a, b) => center(a) - center(b))
  const centers = sorted.map(center)
  const start = centers[0] ?? 0
  const end = centers[centers.length - 1] ?? 0
  const step = (end - start) / (sorted.length - 1)
  const placed = new Map(sorted.map((n, i) => [n.id, start + step * i]))
  const base = pushHistory(model)
  return modifyFields(base, {
    nodes: () =>
      model.nodes.map(n => {
        const c = placed.get(n.id)
        if (c === undefined) {
          return n
        }
        return horizontal
          ? {
              ...n,
              position: { x: c - nodeWidth(n.type) / 2, y: n.position.y },
            }
          : {
              ...n,
              position: { x: n.position.x, y: c - nodeHeight(n.type) / 2 },
            }
      }),
    status: () => `Distributed ${selected.length} nodes (${axis}).`,
  })
}

// COLLAPSE NODES
//
// The members stay in the graph (validation and codegen are unchanged); the
// view hides them behind one container and reroutes boundary wires to it.

function collapseSelection(model: Model): Model {
  const members = model.selectedNodeIds
  if (members.length === 0) {
    return withStatus(model, 'Select nodes to collapse first.')
  }
  const id = `c${model.nextCollapsed}`
  const collapsed: CollapsedNode = {
    id,
    name: `Collapsed ${model.nextCollapsed}`,
    nodeIds: [...members],
  }
  const existing = model.collapsed
    .map(entry => ({
      ...entry,
      nodeIds: entry.nodeIds.filter(nodeId => !members.includes(nodeId)),
    }))
    .filter(entry => entry.nodeIds.length > 0)
  const base = pushHistory(model)
  return modifyFields(base, {
    collapsed: () => [...existing, collapsed],
    nextCollapsed: () => model.nextCollapsed + 1,
    selectedCollapsedId: () => Option.some(id),
    selectedNodeIds: () => [],
    status: () =>
      `Collapsed ${members.length} node${members.length === 1 ? '' : 's'} into ${id}.`,
  })
}

function expandCollapsed(model: Model, collapsedId: string): Model {
  const entry = model.collapsed.find(c => c.id === collapsedId)
  if (entry === undefined) {
    return model
  }
  const base = pushHistory(model)
  return modifyFields(base, {
    collapsed: () => model.collapsed.filter(c => c.id !== collapsedId),
    selectedCollapsedId: () => Option.none(),
    status: () => `Expanded ${entry.name}.`,
  })
}

function renameCollapsed(
  model: Model,
  collapsedId: string,
  name: string,
): Model {
  return modifyFields(model, {
    collapsed: () =>
      model.collapsed.map(c => (c.id === collapsedId ? { ...c, name } : c)),
  })
}

function selectCollapsed(model: Model, collapsedId: string): Model {
  if (model.collapsed.every(c => c.id !== collapsedId)) {
    return model
  }
  return modifyFields(model, {
    selectedCollapsedId: () => Option.some(collapsedId),
    selectedNodeIds: () => [],
    selectedGroupId: () => Option.none(),
    status: () => `Selected ${collapsedId}.`,
  })
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    RequestedAddNode: ({ x, y }) => ({
      model: addNodeAt(model, model.newNodeType, x, y),
    }),
    ChangedNewNodeType: ({ nodeType }) => ({
      model: modifyFields(model, { newNodeType: () => nodeType }),
    }),
    ChangedSearch: ({ text }) => ({
      model: modifyFields(model, { searchText: () => text }),
    }),
    ClearedSearch: () => ({
      model: modifyFields(model, { searchText: () => '' }),
    }),
    SelectedSearchResult: ({ nodeId }) => {
      const node = model.nodes.find(n => n.id === nodeId)
      if (node === undefined) {
        return { model }
      }
      const fitted = defaultOnSelectNodeFit(model.viewport, node)
      return {
        model: modifyFields(model, {
          selectedNodeIds: () => [nodeId],
          selectedEdgeId: () => Option.none(),
          viewport: () =>
            modifyFields(model.viewport, {
              x: () => fitted.x,
              y: () => fitted.y,
            }),
          searchText: () => '',
          status: () => `Selected ${nodeId}.`,
        }),
      }
    },
    ChangedZoom: ({ valueText }) => {
      const percent = Number.parseFloat(valueText)
      if (!Number.isFinite(percent)) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          viewport: () =>
            modifyFields(model.viewport, {
              zoom: () => clampZoom(percent / 100),
            }),
        }),
      }
    },
    StartedNodeDrag: ({ nodeId, x, y }) => ({
      model: modifyFields(model, {
        selectedNodeIds: () => [nodeId],
        contextMenu: () => Option.none(),
        nodeMenu: () => Option.none(),
        drag: () => ({
          mode: 'node',
          nodeId,
          lastX: x,
          lastY: y,
          moved: false,
          before: takeSnapshot(model),
        }),
      }),
    }),
    StartedPan: ({ x, y }) => ({
      model: modifyFields(model, {
        contextMenu: () => Option.none(),
        nodeMenu: () => Option.none(),
        drag: () => ({
          mode: 'pan',
          lastX: x,
          lastY: y,
          moved: false,
          origX: model.viewport.x,
          origY: model.viewport.y,
        }),
      }),
    }),
    StartedGroupDrag: ({ groupId, x, y }) => ({
      model: modifyFields(model, {
        selectedGroupId: () => Option.some(groupId),
        selectedNodeIds: () => [],
        selectedEdgeId: () => Option.none(),
        contextMenu: () => Option.none(),
        drag: () => ({
          mode: 'group',
          groupId,
          lastX: x,
          lastY: y,
          moved: false,
          before: takeSnapshot(model),
        }),
      }),
    }),
    StartedMarquee: ({ worldX, worldY, worldPerPixel, screenX, screenY }) => ({
      model: modifyFields(model, {
        contextMenu: () => Option.none(),
        drag: () => ({
          mode: 'marquee',
          lastX: screenX,
          lastY: screenY,
          moved: false,
          startWorldX: worldX,
          startWorldY: worldY,
          currentWorldX: worldX,
          currentWorldY: worldY,
          worldPerPixel,
        }),
      }),
    }),
    StartedWireDrag: ({
      nodeId,
      port,
      direction,
      screenX,
      screenY,
      worldX,
      worldY,
      clientX,
      clientY,
    }) => {
      // A click already armed a wire: pressing a compatible port connects it.
      if (model.pending.active) {
        const pendingDir = portDirectionOf(
          model,
          model.pending.fromNodeId,
          model.pending.fromPort,
        )
        if (pendingDir !== null && pendingDir !== direction) {
          return {
            model: attemptConnect(
              model,
              pendingDir === 'out' ? model.pending.fromNodeId : nodeId,
              pendingDir === 'out' ? model.pending.fromPort : port,
              pendingDir === 'out' ? nodeId : model.pending.fromNodeId,
              pendingDir === 'out' ? port : model.pending.fromPort,
            ),
          }
        }
      }
      return {
        model: modifyFields(model, {
          pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
          contextMenu: () => Option.none(),
          nodeMenu: () => Option.none(),
          drag: () => ({
            mode: 'wire',
            fromNodeId: nodeId,
            fromPort: port,
            fromDirection: direction,
            lastX: screenX,
            lastY: screenY,
            worldX,
            worldY,
            clientX,
            clientY,
            moved: false,
          }),
          status: () =>
            direction === 'out'
              ? 'Drag to an input port, or drop on empty canvas to add a node.'
              : 'Drag to an output port, or drop on empty canvas to add a node.',
        }),
      }
    },
    DroppedWireOnPort: ({ nodeId, port }) => {
      if (model.drag.mode !== 'wire') {
        return { model }
      }
      const drag = model.drag
      const targetDir = portDirectionOf(model, nodeId, port)
      const samePort = nodeId === drag.fromNodeId && port === drag.fromPort
      if (targetDir === null) {
        return {
          model: modifyFields(model, { drag: () => ({ mode: 'idle' }) }),
        }
      }
      // Released without moving: treat it as a click and arm click-to-connect.
      if (samePort && !drag.moved) {
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            pending: () => ({
              active: true,
              fromNodeId: nodeId,
              fromPort: port,
            }),
            status: () =>
              `Connecting from ${nodeId}.${port}. Click a compatible port.`,
          }),
        }
      }
      if (targetDir === drag.fromDirection) {
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            status: () => 'Connection cancelled.',
          }),
        }
      }
      const connected =
        drag.fromDirection === 'out'
          ? attemptConnect(model, drag.fromNodeId, drag.fromPort, nodeId, port)
          : attemptConnect(model, nodeId, port, drag.fromNodeId, drag.fromPort)
      return {
        model: modifyFields(connected, { drag: () => ({ mode: 'idle' }) }),
      }
    },
    MovedPointer: ({ x, y }) => {
      if (model.drag.mode === 'node') {
        const drag = model.drag
        const zoom = model.viewport.zoom
        const dx = (x - drag.lastX) / zoom
        const dy = (y - drag.lastY) / zoom
        if (dx === 0 && dy === 0) {
          return { model }
        }
        return {
          model: modifyFields(model, {
            nodes: () =>
              model.nodes.map(n =>
                n.id === drag.nodeId
                  ? {
                      ...n,
                      position: { x: n.position.x + dx, y: n.position.y + dy },
                    }
                  : n,
              ),
            drag: () =>
              modifyFields(drag, {
                lastX: () => x,
                lastY: () => y,
                moved: () => true,
              }),
          }),
        }
      }
      if (model.drag.mode === 'marquee') {
        const drag = model.drag
        const dx = (x - drag.lastX) * drag.worldPerPixel
        const dy = (y - drag.lastY) * drag.worldPerPixel
        if (dx === 0 && dy === 0) {
          return { model }
        }
        return {
          model: modifyFields(model, {
            drag: () =>
              modifyFields(drag, {
                lastX: () => x,
                lastY: () => y,
                moved: () => true,
                currentWorldX: () => drag.currentWorldX + dx,
                currentWorldY: () => drag.currentWorldY + dy,
              }),
          }),
        }
      }
      if (model.drag.mode === 'group') {
        const drag = model.drag
        const zoom = model.viewport.zoom
        const dx = (x - drag.lastX) / zoom
        const dy = (y - drag.lastY) / zoom
        if (dx === 0 && dy === 0) {
          return { model }
        }
        const group = model.groups.find(g => g.id === drag.groupId)
        const memberIds = new Set(group?.nodeIds ?? [])
        return {
          model: modifyFields(model, {
            nodes: () =>
              model.nodes.map(n =>
                memberIds.has(n.id)
                  ? {
                      ...n,
                      position: { x: n.position.x + dx, y: n.position.y + dy },
                    }
                  : n,
              ),
            drag: () =>
              modifyFields(drag, {
                lastX: () => x,
                lastY: () => y,
                moved: () => true,
              }),
          }),
        }
      }
      if (model.drag.mode === 'pan') {
        const drag = model.drag
        const zoom = model.viewport.zoom
        const dx = (x - drag.lastX) / zoom
        const dy = (y - drag.lastY) / zoom
        if (dx === 0 && dy === 0) {
          return { model }
        }
        return {
          model: modifyFields(model, {
            viewport: () =>
              modifyFields(model.viewport, {
                x: () => model.viewport.x - dx,
                y: () => model.viewport.y - dy,
              }),
            drag: () =>
              modifyFields(drag, {
                lastX: () => x,
                lastY: () => y,
                moved: () => true,
              }),
          }),
        }
      }
      if (model.drag.mode === 'wire') {
        const drag = model.drag
        const zoom = model.viewport.zoom
        const dx = x - drag.lastX
        const dy = y - drag.lastY
        if (dx === 0 && dy === 0) {
          return { model }
        }
        return {
          model: modifyFields(model, {
            drag: () =>
              modifyFields(drag, {
                lastX: () => x,
                lastY: () => y,
                moved: () => drag.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2,
                worldX: () => drag.worldX + dx / zoom,
                worldY: () => drag.worldY + dy / zoom,
                clientX: () => drag.clientX + dx,
                clientY: () => drag.clientY + dy,
              }),
          }),
        }
      }
      return { model }
    },
    EndedDrag: () => {
      if (model.drag.mode === 'wire') {
        const drag = model.drag
        if (!drag.moved) {
          // A click on a port arms click-to-connect rather than opening a menu.
          return {
            model: modifyFields(model, {
              drag: () => ({ mode: 'idle' }),
              pending: () => ({
                active: true,
                fromNodeId: drag.fromNodeId,
                fromPort: drag.fromPort,
              }),
              status: () =>
                `Connecting from ${drag.fromNodeId}.${drag.fromPort}. Click a compatible port.`,
            }),
          }
        }
        // Dropped on empty canvas: offer to add a node wired to the source.
        if (nodeAtWorldPoint(model, drag.worldX, drag.worldY) !== null) {
          return {
            model: modifyFields(model, {
              drag: () => ({ mode: 'idle' }),
              status: () => 'Connection cancelled.',
            }),
          }
        }
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            contextMenu: () =>
              Option.some({
                worldX: drag.worldX,
                worldY: drag.worldY,
                clientX: drag.clientX,
                clientY: drag.clientY,
                search: '',
              }),
            pending: () => ({
              active: true,
              fromNodeId: drag.fromNodeId,
              fromPort: drag.fromPort,
            }),
            status: () => 'Pick a node to add and connect to the wire.',
          }),
        }
      }
      if (model.drag.mode === 'marquee') {
        const drag = model.drag
        if (!drag.moved) {
          return {
            model: modifyFields(model, {
              drag: () => ({ mode: 'idle' }),
              selectedNodeIds: () => [],
              selectedEdgeId: () => Option.none(),
              selectedGroupId: () => Option.none(),
              pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
            }),
          }
        }
        const ids = nodesInRect(
          model,
          worldRect(
            drag.startWorldX,
            drag.startWorldY,
            drag.currentWorldX,
            drag.currentWorldY,
          ),
        ).filter(id => !hiddenNodeIds(model).has(id))
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            selectedNodeIds: () => ids,
            selectedEdgeId: () => Option.none(),
            selectedGroupId: () => Option.none(),
            suppressClick: () => true,
            status: () =>
              `Selected ${ids.length} node${ids.length === 1 ? '' : 's'}.`,
          }),
        }
      }
      if (model.drag.mode === 'node' && model.drag.moved) {
        const before = model.drag.before
        const movedId = model.drag.nodeId
        const past = [...model.past, before]
        const trimmed = past.length > 100 ? past.slice(past.length - 100) : past
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            past: () => trimmed,
            future: () => [],
            suppressClick: () => true,
            status: () => `Moved ${movedId}.`,
          }),
        }
      }
      if (model.drag.mode === 'group') {
        if (!model.drag.moved) {
          return {
            model: modifyFields(model, { drag: () => ({ mode: 'idle' }) }),
          }
        }
        const before = model.drag.before
        const movedId = model.drag.groupId
        const past = [...model.past, before]
        const trimmed = past.length > 100 ? past.slice(past.length - 100) : past
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            past: () => trimmed,
            future: () => [],
            suppressClick: () => true,
            status: () => `Moved ${movedId}.`,
          }),
        }
      }
      if (model.drag.mode === 'pan' && model.drag.moved) {
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            suppressClick: () => true,
          }),
        }
      }
      if (model.drag.mode === 'node' || model.drag.mode === 'pan') {
        // Treated as a click on the canvas: clear selection and pending wire.
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            selectedNodeIds: () => [],
            selectedEdgeId: () => Option.none(),
            pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
          }),
        }
      }
      return { model }
    },
    ClickedCanvas: () => {
      if (model.suppressClick) {
        return { model: modifyFields(model, { suppressClick: () => false }) }
      }
      return {
        model: modifyFields(model, {
          selectedNodeIds: () => [],
          selectedEdgeId: () => Option.none(),
          pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
          nodeMenu: () => Option.none(),
        }),
      }
    },
    SelectedNode: ({ nodeId }) => {
      if (model.suppressClick) {
        return { model: modifyFields(model, { suppressClick: () => false }) }
      }
      return {
        model: modifyFields(model, {
          selectedNodeIds: () => [nodeId],
          selectedEdgeId: () => Option.none(),
          selectedGroupId: () => Option.none(),
          contextMenu: () => Option.none(),
        }),
      }
    },
    HoveredEdge: ({ edgeId }) => ({
      model: modifyFields(model, {
        hoveredEdgeId: () => Option.some(edgeId),
      }),
    }),
    UnhoveredEdge: ({ edgeId }) => {
      if (Option.getOrNull(model.hoveredEdgeId) !== edgeId) {
        return { model }
      }
      return {
        model: modifyFields(model, { hoveredEdgeId: () => Option.none() }),
      }
    },
    SelectedEdge: ({ edgeId }) => {
      if (model.suppressClick) {
        return { model: modifyFields(model, { suppressClick: () => false }) }
      }
      return {
        model: modifyFields(model, {
          selectedEdgeId: () => Option.some(edgeId),
          selectedNodeIds: () => [],
          selectedGroupId: () => Option.none(),
          pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
          contextMenu: () => Option.none(),
          status: () => `Selected edge ${edgeId}. Press Delete to remove it.`,
        }),
      }
    },
    ClickedPort: ({ nodeId, port }) => {
      const node = model.nodes.find(n => n.id === nodeId)
      if (node === undefined || !isNodeType(node.type)) {
        return { model }
      }
      const def = NODE_REGISTRY[node.type]
      const isOutput = def.outputs.some(p => p.name === port)
      const isInput = def.inputs.some(p => p.name === port)
      if (!model.pending.active) {
        if (isOutput) {
          return {
            model: modifyFields(model, {
              selectedNodeIds: () => [nodeId],
              pending: () => ({
                active: true,
                fromNodeId: nodeId,
                fromPort: port,
              }),
              status: () =>
                `Connecting from ${nodeId}.${port}. Click an input port.`,
            }),
          }
        }
        return {
          model: withStatus(
            model,
            'Start a connection from an output port (right side).',
          ),
        }
      }
      if (
        model.pending.fromNodeId === nodeId &&
        model.pending.fromPort === port
      ) {
        return {
          model: modifyFields(model, {
            pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
            status: () => 'Connection cancelled.',
          }),
        }
      }
      if (isInput) {
        return {
          model: attemptConnect(
            model,
            model.pending.fromNodeId,
            model.pending.fromPort,
            nodeId,
            port,
          ),
        }
      }
      return {
        model: modifyFields(model, {
          pending: () => ({ active: true, fromNodeId: nodeId, fromPort: port }),
          status: () =>
            `Connecting from ${nodeId}.${port}. Click an input port.`,
        }),
      }
    },
    CancelledPending: () => ({ model: cancelPending(model) }),
    PressedEscape: () =>
      model.settingsOpen
        ? {
            model: modifyFields(model, {
              settingsOpen: () => false,
              recordingAction: () => Option.none(),
            }),
          }
        : Option.isSome(model.play)
          ? { model: modifyFields(model, { play: () => Option.none() }) }
          : Option.isSome(model.colorPicker)
            ? { model: dismissColorPicker(model) }
            : { model: cancelPending(model) },
    PressedSettings: () => ({
      model: modifyFields(model, {
        settingsOpen: () => !model.settingsOpen,
        recordingAction: () => Option.none(),
        contextMenu: () => Option.none(),
      }),
    }),
    OpenedSettings: () => ({
      model: modifyFields(model, {
        settingsOpen: () => true,
        recordingAction: () => Option.none(),
        contextMenu: () => Option.none(),
      }),
    }),
    ClosedSettings: () => ({
      model: modifyFields(model, {
        settingsOpen: () => false,
        recordingAction: () => Option.none(),
      }),
    }),
    StartedShortcutRecording: ({ actionId }) => {
      const command = commandById(actionId)
      if (command === undefined) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          settingsOpen: () => true,
          recordingAction: () => Option.some(actionId),
          status: () =>
            `Recording shortcut for "${command.label}" — press keys (Esc cancels).`,
        }),
      }
    },
    CancelledShortcutRecording: () => ({
      model: modifyFields(model, {
        recordingAction: () => Option.none(),
        status: () => 'Shortcut recording cancelled.',
      }),
    }),
    CapturedShortcut: ({
      key,
      ctrlKey,
      metaKey,
      altKey,
      shiftKey,
      isApple,
    }) => {
      const actionId = Option.getOrNull(model.recordingAction)
      if (actionId === null) {
        return { model }
      }
      const binding = Option.getOrNull(
        bindingFromKeyEvent(
          { key, ctrlKey, metaKey, altKey, shiftKey },
          isApple,
        ),
      )
      if (binding === null) {
        return { model }
      }
      const owner = bindingOwner(model.keymap, binding, actionId)
      if (owner !== null) {
        const ownerLabel = commandById(owner)?.label ?? owner
        return {
          model: withStatus(
            model,
            `Shortcut ${formatShortcut(binding, model.shortcutPlatform)} is already used by "${ownerLabel}".`,
          ),
        }
      }
      const keymap = { ...model.keymap, [actionId]: binding }
      const label = commandById(actionId)?.label ?? actionId
      return {
        model: modifyFields(model, {
          keymap: () => keymap,
          recordingAction: () => Option.none(),
          status: () =>
            `Shortcut for "${label}" set to ${formatShortcut(binding, model.shortcutPlatform)}.`,
        }),
        commands: [
          PersistSettings({
            json: serializeShortcutSettings({
              platform: model.shortcutPlatform,
              keymap,
            }),
          }),
        ],
      }
    },
    ResetShortcut: ({ actionId }) => {
      const command = commandById(actionId)
      if (command === undefined) {
        return { model }
      }
      const keymap = { ...model.keymap, [actionId]: command.defaultBinding }
      return {
        model: modifyFields(model, {
          keymap: () => keymap,
          recordingAction: () => Option.none(),
          status: () =>
            `Reset "${command.label}" to ${formatShortcut(command.defaultBinding, model.shortcutPlatform)}.`,
        }),
        commands: [
          PersistSettings({
            json: serializeShortcutSettings({
              platform: model.shortcutPlatform,
              keymap,
            }),
          }),
        ],
      }
    },
    ResetAllShortcuts: () => {
      const keymap = { ...DEFAULT_KEYMAP }
      return {
        model: modifyFields(model, {
          keymap: () => keymap,
          recordingAction: () => Option.none(),
          status: () => 'All shortcuts reset to defaults.',
        }),
        commands: [
          PersistSettings({
            json: serializeShortcutSettings({
              platform: model.shortcutPlatform,
              keymap,
            }),
          }),
        ],
      }
    },
    ChangedShortcutPlatform: ({ platform }) => {
      if (!isShortcutPlatform(platform)) {
        return { model }
      }
      return {
        model: modifyFields(model, { shortcutPlatform: () => platform }),
        commands: [
          PersistSettings({
            json: serializeShortcutSettings({
              platform,
              keymap: model.keymap,
            }),
          }),
        ],
      }
    },
    CompletedLoadSettings: ({ json }) => {
      const settings = parseShortcutSettings(safeParse(json))
      if (settings === null) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          shortcutPlatform: () => settings.platform,
          keymap: () => settings.keymap,
        }),
      }
    },
    CompletedLoadSettingsEmpty: () => ({ model }),
    FailedLoadSettings: ({ reason }) => ({
      model: withStatus(model, `Could not read saved settings (${reason}).`),
    }),
    CompletedPersistSettings: () => ({ model }),
    FailedPersistSettings: ({ reason }) => ({
      model: withStatus(model, `Could not save settings: ${reason}.`),
    }),
    OpenedContextMenu: ({ worldX, worldY, clientX, clientY }) => ({
      model: modifyFields(model, {
        contextMenu: () =>
          Option.some({ worldX, worldY, clientX, clientY, search: '' }),
        nodeMenu: () => Option.none(),
        selectedNodeIds: () => [],
        selectedEdgeId: () => Option.none(),
        selectedGroupId: () => Option.none(),
        selectedCollapsedId: () => Option.none(),
        pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
      }),
    }),
    ChangedContextMenuSearch: ({ text }) => {
      const menu = Option.getOrNull(model.contextMenu)
      if (menu === null) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          contextMenu: () => Option.some({ ...menu, search: text }),
        }),
      }
    },
    SelectedContextMenuNode: ({ nodeType }) => {
      const menu = Option.getOrNull(model.contextMenu)
      if (menu === null) {
        return { model }
      }
      const added = addNodeAt(model, nodeType, menu.worldX, menu.worldY)
      const newId = added.selectedNodeIds[0]
      const connected =
        newId === undefined ? added : autoConnectFromPending(added, newId)
      return { model: closeContextMenu(connected) }
    },
    DismissedContextMenu: () => ({ model: closeContextMenu(model) }),
    PreventedNativeContextMenu: () => ({ model }),
    SelectedGroup: ({ groupId }) => {
      const group = model.groups.find(g => g.id === groupId)
      if (group === undefined) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          selectedGroupId: () => Option.some(groupId),
          selectedNodeIds: () => [],
          selectedEdgeId: () => Option.none(),
          status: () => `Selected ${group.name}.`,
        }),
      }
    },
    PressedGroupSelection: () => ({ model: groupSelection(model) }),
    PressedUngroupSelection: () => ({ model: ungroupSelected(model) }),
    RenamedGroup: ({ groupId, name }) => {
      if (model.groups.every(group => group.id !== groupId)) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          groups: () =>
            model.groups.map(group =>
              group.id === groupId ? { ...group, name } : group,
            ),
        }),
      }
    },
    ChangedGroupColor: ({ groupId, color }) => {
      if (!isValidGroupColor(color)) {
        return { model }
      }
      if (model.groups.every(group => group.id !== groupId)) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          groups: () =>
            model.groups.map(group =>
              group.id === groupId ? { ...group, color } : group,
            ),
        }),
      }
    },
    OpenedGroupColorPicker: ({ groupId }) => {
      const group = model.groups.find(g => g.id === groupId)
      if (group === undefined) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          colorPicker: () =>
            Option.some({
              groupId: group.id,
              originalColor: group.color,
              draft: group.color,
            }),
        }),
      }
    },
    EditedGroupColorDraft: ({ text }) => ({
      model: modifyFields(model, {
        colorPicker: () =>
          Option.map(model.colorPicker, picker => ({
            groupId: picker.groupId,
            originalColor: picker.originalColor,
            draft: text,
          })),
      }),
    }),
    AppliedGroupColorDraft: () => {
      const picker = Option.getOrNull(model.colorPicker)
      if (picker === null) {
        return { model }
      }
      const color = normalizeHexColor(picker.draft)
      if (color === null || model.groups.every(g => g.id !== picker.groupId)) {
        return { model }
      }
      return {
        model: modifyFields(model, {
          groups: () =>
            model.groups.map(group =>
              group.id === picker.groupId ? { ...group, color } : group,
            ),
          colorPicker: () => Option.none(),
        }),
      }
    },
    CancelledGroupColorPicker: () => ({
      model: dismissColorPicker(model),
    }),
    ToggledMinimap: () => ({
      model: modifyFields(model, {
        minimapVisible: () => !model.minimapVisible,
      }),
    }),
    InsertedRerouteOnEdge: ({ edgeId, worldX, worldY }) => ({
      model: insertRerouteOnEdge(model, edgeId, worldX, worldY),
    }),
    ConvertedRerouteToNamed: ({ nodeId }) => ({
      model: dismissNodeMenu(convertRerouteToNamed(model, nodeId)),
    }),
    ConvertedNamedRerouteToReroute: ({ nodeId }) => ({
      model: dismissNodeMenu(convertNamedRerouteToReroute(model, nodeId)),
    }),
    AddedNamedRerouteUsage: ({ declarationId }) => ({
      model: dismissNodeMenu(addNamedRerouteUsage(model, declarationId)),
    }),
    RenamedReroute: ({ declarationId, name }) => ({
      model: renameReroute(model, declarationId, name),
    }),
    SelectedRerouteUsages: ({ declarationId }) => ({
      model: dismissNodeMenu(selectRerouteUsages(model, declarationId)),
    }),
    SelectedRerouteDeclaration: ({ usageId }) => ({
      model: dismissNodeMenu(selectRerouteDeclaration(model, usageId)),
    }),
    AlignedNodes: ({ mode }) => ({
      model: dismissNodeMenu(alignNodes(model, mode)),
    }),
    DistributedNodes: ({ axis }) => ({
      model: dismissNodeMenu(distributeNodes(model, axis)),
    }),
    CollapsedSelection: () => ({ model: collapseSelection(model) }),
    RequestedCreateFunction: () => ({
      model: createFunctionFromSelection(model),
    }),
    ExpandedCollapsed: ({ collapsedId }) => ({
      model: expandCollapsed(model, collapsedId),
    }),
    RenamedCollapsed: ({ collapsedId, name }) => ({
      model: renameCollapsed(model, collapsedId, name),
    }),
    SelectedCollapsed: ({ collapsedId }) => ({
      model: selectCollapsed(model, collapsedId),
    }),
    OpenedNodeMenu: ({ nodeId, clientX, clientY }) => ({
      model: modifyFields(model, {
        nodeMenu: () => Option.some({ nodeId, clientX, clientY }),
        contextMenu: () => Option.none(),
      }),
    }),
    DismissedNodeMenu: () => ({
      model: modifyFields(model, { nodeMenu: () => Option.none() }),
    }),
    UpdatedParam: ({ nodeId, key, valueText }) => {
      const value = Number.parseFloat(valueText)
      if (!Number.isFinite(value)) {
        return {
          model: withLog(model, 'warning', `Invalid number: "${valueText}".`),
        }
      }
      const node = model.nodes.find(n => n.id === nodeId)
      if (node === undefined || node.params[key] === undefined) {
        return { model }
      }
      if (node.params[key] === value) {
        return { model }
      }
      const base = pushHistory(model)
      return {
        model: modifyFields(
          withLog(base, 'info', `Set ${nodeId}.${key} to ${value}.`),
          {
            nodes: () =>
              base.nodes.map(n =>
                n.id === nodeId
                  ? { ...n, params: { ...n.params, [key]: value } }
                  : n,
              ),
          },
        ),
      }
    },
    RequestedDeleteSelection: () => ({
      model: deleteSelection(model),
    }),
    PressedDelete: () => ({ model: deleteSelection(model) }),
    PressedCopy: () => {
      const selected = new Set(model.selectedNodeIds)
      if (selected.size === 0) {
        return { model: withStatus(model, 'Nothing selected to copy.') }
      }
      const nodes = model.nodes.filter(
        node => selected.has(node.id) && node.type !== 'FragmentOutput',
      )
      if (nodes.length === 0) {
        return {
          model: withStatus(
            model,
            'Nothing to copy: the Fragment Output cannot be duplicated.',
          ),
        }
      }
      const copied = new Set(nodes.map(node => node.id))
      const edges = model.edges.filter(
        edge => copied.has(edge.sourceNodeId) && copied.has(edge.targetNodeId),
      )
      return {
        model: modifyFields(model, {
          clipboard: () => Option.some({ nodes, edges }),
          pasteOffset: () => 1,
          status: () =>
            `Copied ${nodes.length} node${nodes.length === 1 ? '' : 's'} and ${edges.length} edge${edges.length === 1 ? '' : 's'}.`,
        }),
      }
    },
    PressedPaste: () => {
      const clip = Option.getOrNull(model.clipboard)
      if (clip === null || clip.nodes.length === 0) {
        return { model: withStatus(model, 'Clipboard is empty.') }
      }
      const offset = 40 * model.pasteOffset
      let nextNode = model.nextNode
      const idMap = new Map<string, string>()
      const newNodes: Array<EditorNode> = clip.nodes.map(node => {
        const id = `n${nextNode}`
        nextNode += 1
        idMap.set(node.id, id)
        return {
          id,
          type: node.type,
          position: {
            x: node.position.x + offset,
            y: node.position.y + offset,
          },
          params: Object.fromEntries(
            Object.entries(node.params).map(([key, value]) => [
              key,
              typeof value === 'number' ? value : [...value],
            ]),
          ),
        }
      })
      let nextEdge = model.nextEdge
      const newEdges: Array<EditorEdge> = clip.edges.map(edge => {
        const id = `e${nextEdge}`
        nextEdge += 1
        return {
          id,
          sourceNodeId: idMap.get(edge.sourceNodeId) ?? edge.sourceNodeId,
          sourcePort: edge.sourcePort,
          targetNodeId: idMap.get(edge.targetNodeId) ?? edge.targetNodeId,
          targetPort: edge.targetPort,
        }
      })
      const base = pushHistory(model)
      const pastedNames = Object.fromEntries(
        clip.nodes.flatMap(node => {
          const name = model.rerouteNames[node.id]
          const mapped = idMap.get(node.id)
          return name !== undefined && mapped !== undefined
            ? [[mapped, name]]
            : []
        }),
      )
      const rerouteNames = { ...model.rerouteNames, ...pastedNames }
      return {
        model: modifyFields(base, {
          nodes: () => [...model.nodes, ...newNodes],
          edges: () => [...model.edges, ...newEdges],
          rerouteNames: () => rerouteNames,
          nextNode: () => nextNode,
          nextEdge: () => nextEdge,
          selectedNodeIds: () => newNodes.map(node => node.id),
          selectedEdgeId: () => Option.none(),
          pasteOffset: () => model.pasteOffset + 1,
          status: () =>
            `Pasted ${newNodes.length} node${newNodes.length === 1 ? '' : 's'}.`,
        }),
      }
    },
    PressedUndo: () => {
      const prev = model.past[model.past.length - 1]
      if (prev === undefined) {
        return { model: withStatus(model, 'Nothing to undo.') }
      }
      const future = [...model.future, takeSnapshot(model)]
      const past = model.past.slice(0, model.past.length - 1)
      return {
        model: modifyFields(restoreSnapshot(model, prev), {
          past: () => past,
          future: () => future,
          status: () => 'Undone.',
        }),
      }
    },
    PressedRedo: () => {
      const next = model.future[model.future.length - 1]
      if (next === undefined) {
        return { model: withStatus(model, 'Nothing to redo.') }
      }
      const past = [...model.past, takeSnapshot(model)]
      const future = model.future.slice(0, model.future.length - 1)
      return {
        model: modifyFields(restoreSnapshot(model, next), {
          past: () => past,
          future: () => future,
          status: () => 'Redone.',
        }),
      }
    },
    ZoomedIn: () => ({
      model: modifyFields(model, {
        viewport: () =>
          modifyFields(model.viewport, {
            zoom: () => clampZoom(model.viewport.zoom * ZOOM_STEP),
          }),
      }),
    }),
    ZoomedOut: () => ({
      model: modifyFields(model, {
        viewport: () =>
          modifyFields(model.viewport, {
            zoom: () => clampZoom(model.viewport.zoom / ZOOM_STEP),
          }),
      }),
    }),
    ResetView: () => ({
      model: modifyFields(model, { viewport: () => ({ x: 0, y: 0, zoom: 1 }) }),
    }),
    ToggledSimulateLoading: () => ({
      model: modifyFields(model, {
        simulateLoading: () => !model.simulateLoading,
      }),
    }),
    ChangedLoadingVariant: ({ variant }) => {
      if (!isLoadingVariant(variant)) {
        return { model }
      }
      return {
        model: modifyFields(model, { loadingVariant: () => variant }),
      }
    },
    RequestedSave: () => {
      const json = JSON.stringify(
        {
          version: 2,
          nodes: model.nodes,
          edges: model.edges,
          outputNodeId: Option.getOrNull(model.outputNodeId),
          rerouteNames: model.rerouteNames,
          collapsed: model.collapsed,
          functions: model.functions,
        },
        null,
        2,
      )
      return { model, commands: [PersistGraph({ json })] }
    },
    CompletedPersistGraph: () => ({
      model: withLog(model, 'system', 'Saved to browser storage.'),
    }),
    FailedPersistGraph: ({ reason }) => ({
      model: withLog(model, 'error', `Save failed: ${reason}`),
    }),
    CompletedLoadGraph: ({ json }) => {
      const parsed = parseGraphText(json)
      if (!parsed.ok) {
        return {
          model: withLog(
            model,
            'error',
            `Stored graph is invalid: ${parsed.reason}`,
          ),
        }
      }
      const restored = fromSerialized(parsed.data)
      return {
        model: modifyFields(
          withLog(
            model,
            'system',
            `Loaded saved graph with ${restored.nodes.length} nodes.`,
          ),
          {
            nodes: () => restored.nodes,
            edges: () => restored.edges,
            groups: () => [],
            collapsed: () => restored.collapsed,
            nextCollapsed: () => restored.nextCollapsed,
            rerouteNames: () => restored.rerouteNames,
            outputNodeId: () => restored.outputNodeId,
            nextNode: () => restored.nextNode,
            nextEdge: () => restored.nextEdge,
            nextGroup: () => 1,
            functions: () => restored.functions,
            nextFunction: () => restored.nextFunction,
            selectedNodeIds: () => [],
            selectedGroupId: () => Option.none(),
            selectedCollapsedId: () => Option.none(),
          },
        ),
      }
    },
    CompletedLoadEmpty: () => ({
      model: modifyFields(
        withLog(seedModel(), 'system', 'No saved graph. Demo graph loaded.'),
        {
          shortcutPlatform: () => model.shortcutPlatform,
          keymap: () => model.keymap,
        },
      ),
    }),
    FailedLoadGraph: ({ reason }) => ({
      model: withLog(
        modifyFields(seedModel(), {
          shortcutPlatform: () => model.shortcutPlatform,
          keymap: () => model.keymap,
        }),
        'warning',
        `Could not read saved graph (${reason}). Showing demo graph.`,
      ),
    }),
    RequestedNew: () => {
      const base = pushHistory(model)
      // A fresh graph starts valid: it always contains the one Fragment
      // Output that HLSL generation requires.
      return {
        model: modifyFields(
          withLog(base, 'system', 'New graph. Add nodes from the palette.'),
          {
            nodes: () => [
              {
                id: 'n1',
                type: 'FragmentOutput',
                position: { x: 1020, y: 450 },
                params: { ...NODE_REGISTRY['FragmentOutput'].defaultParams },
              },
            ],
            edges: () => [],
            groups: () => [],
            collapsed: () => [],
            nextCollapsed: () => 1,
            rerouteNames: () => ({}),
            outputNodeId: () => Option.some('n1'),
            nextNode: () => 2,
            nextEdge: () => 1,
            nextGroup: () => 1,
            selectedNodeIds: () => [],
            selectedGroupId: () => Option.none(),
            selectedCollapsedId: () => Option.none(),
            pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
          },
        ),
      }
    },
    RequestedExport: () => {
      const json = JSON.stringify(
        {
          version: 1,
          nodes: model.nodes,
          edges: model.edges,
          outputNodeId: Option.getOrNull(model.outputNodeId),
          rerouteNames: model.rerouteNames,
          collapsed: model.collapsed,
        },
        null,
        2,
      )
      return {
        model,
        commands: [DownloadJson({ json, filename: 'shader-graph.json' })],
      }
    },
    CompletedExport: () => ({
      model: withStatus(model, 'Exported shader-graph.json.'),
    }),
    RequestedImport: () => ({ model, commands: [PickImportFile()] }),
    CompletedImportFile: ({ text }) => ({
      model: applyImported(model, text, true),
    }),
    CancelledImportFile: () => ({
      model: withStatus(model, 'Import cancelled.'),
    }),
    FailedImportFile: ({ reason }) => ({
      model: withLog(model, 'error', `Import failed: ${reason}`),
    }),
    RequestedCopyHlsl: () => {
      const result = generate(toDomainGraph(model), {
        functions: toDomainFunctions(model.functions),
      })
      if (!result.ok) {
        const first = result.errors[0]
        return {
          model: withLog(
            model,
            'error',
            `Cannot copy: ${first !== undefined ? first.message : 'graph is invalid.'}`,
          ),
        }
      }
      return { model, commands: [CopyHlsl({ code: result.code })] }
    },
    CompletedCopyHlsl: () => ({
      model: withLog(model, 'system', 'HLSL copied to clipboard.'),
    }),
    FailedCopyHlsl: ({ reason }) => ({
      model: withLog(model, 'error', `Copy failed: ${reason}`),
    }),
    RequestedPlay: () => {
      const result = evaluateGraph(toDomainGraph(model), {
        functions: toDomainFunctions(model.functions),
      })
      if (!result.ok) {
        return {
          model: withLog(
            model,
            'error',
            `Cannot play: fix ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'} first.`,
          ),
        }
      }
      const [r, g, b, a] = result.color
      const fmt = (v: number): string =>
        Number.isFinite(v) ? String(Number(v.toFixed(4))) : String(v)
      return {
        model: modifyFields(
          withLog(
            model,
            'success',
            `Playing preview. Output = float4(${fmt(r)}, ${fmt(g)}, ${fmt(b)}, ${fmt(a)}).`,
          ),
          {
            play: () => Option.some({ color: result.color }),
            status: () => 'Playing preview. Edit the graph to stop.',
          },
        ),
      }
    },
    DismissedPlay: () => ({
      model: modifyFields(model, { play: () => Option.none() }),
    }),
    ToggledLogPanel: () => ({
      model: modifyFields(model, { logPanelOpen: () => !model.logPanelOpen }),
    }),
    PressedClearLogs: () => ({
      model: modifyFields(model, { logs: () => [] }),
    }),
    DismissedStatus: () => ({ model: withStatus(model, '') }),
  })

export const init: () => UpdateReturn = () => ({
  model: emptyModel(),
  commands: [LoadGraph(), LoadSettings()],
})
