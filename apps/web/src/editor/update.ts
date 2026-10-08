// Pure state transitions. Every branch returns the next Model and,
// only when a side effect is needed, the Commands that request it.

import { Option, Predicate } from 'effect'
import { type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { generate, upstreamPortType } from '@hlsl-editor/shader-compiler'
import { NODE_REGISTRY, isNodeType } from '@hlsl-editor/shader-nodes'
import { canConnect, connectionErrorMessage } from '@hlsl-editor/shader-types'

import {
  CopyHlsl,
  DownloadJson,
  LoadGraph,
  PersistGraph,
  PickImportFile,
} from './commands'
import { ZOOM_STEP, clampZoom } from './layout'
import { nodesInRect, worldRect } from './marquee'
import { Message } from './message'
import {
  type EditorEdge,
  type EditorNode,
  type Model,
  emptyModel,
  fromSerialized,
  pushHistory,
  restoreSnapshot,
  seedModel,
  takeSnapshot,
  toDomainGraph,
} from './model'
import { isLoadingVariant } from './node-status'
import { defaultOnSelectNodeFit } from './search'

type UpdateReturn = Update.Return<Model, Message>

function withStatus(model: Model, status: string): Model {
  return modifyFields(model, { status: () => status })
}

interface DecodedNode {
  id: string
  type: string
  position: { x: number; y: number }
  params: Record<string, number | Array<number>>
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
  return { id: raw.id, type: raw.type, position, params }
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

function parseGraphText(text: string):
  | {
      ok: true
      data: {
        version: number
        nodes: Array<DecodedNode>
        edges: Array<DecodedEdge>
        outputNodeId: string | null
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
  if (raw.version !== 1) {
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
  return {
    ok: true,
    data: {
      version: 1,
      nodes: nodes.flatMap(n => (n === null ? [] : [n])),
      edges: edges.flatMap(e => (e === null ? [] : [e])),
      outputNodeId,
    },
  }
}

function applyImported(model: Model, text: string, pushUndo: boolean): Model {
  const parsed = parseGraphText(text)
  if (!parsed.ok) {
    return withStatus(model, parsed.reason)
  }
  const restored = fromSerialized(parsed.data)
  const base = pushUndo ? pushHistory(model) : model
  return modifyFields(base, {
    nodes: () => restored.nodes,
    edges: () => restored.edges,
    outputNodeId: () => restored.outputNodeId,
    nextNode: () => restored.nextNode,
    nextEdge: () => restored.nextEdge,
    selectedNodeIds: () => [],
    pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    status: () => `Imported graph with ${restored.nodes.length} nodes.`,
  })
}

// Removes the selected nodes and/or the selected edge in one history entry.
// Deleting an edge only drops the wire; its nodes stay, so the user can
// connect them again.
function deleteSelection(model: Model): Model {
  const nodeIds = model.selectedNodeIds
  const edgeId = Option.getOrNull(model.selectedEdgeId)
  if (nodeIds.length === 0 && edgeId === null) {
    return withStatus(model, 'Nothing selected to delete.')
  }
  const gone = new Set(nodeIds)
  const nodes = model.nodes.filter(n => !gone.has(n.id))
  const edges = model.edges.filter(
    e =>
      e.id !== edgeId && !gone.has(e.sourceNodeId) && !gone.has(e.targetNodeId),
  )
  const outputId = Option.getOrNull(model.outputNodeId)
  const outputGone = outputId !== null && gone.has(outputId)
  const base = pushHistory(model)
  const status =
    nodeIds.length > 0
      ? `Deleted ${nodeIds.length} node${nodeIds.length === 1 ? '' : 's'}.`
      : `Deleted edge ${edgeId ?? ''}.`
  return modifyFields(base, {
    nodes: () => nodes,
    edges: () => edges,
    outputNodeId: () => (outputGone ? Option.none() : model.outputNodeId),
    selectedNodeIds: () => [],
    selectedEdgeId: () => Option.none(),
    pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    status: () => status,
  })
}

function closeContextMenu(model: Model): Model {
  return modifyFields(model, { contextMenu: () => Option.none() })
}

// Shared by the toolbar "Add node" button and the right-click menu. Validates
// the type and the single-Fragment-Output rule, then inserts and selects it.
function addNodeAt(model: Model, type: string, x: number, y: number): Model {
  if (!isNodeType(type)) {
    return withStatus(model, `Unknown node type: ${type}.`)
  }
  if (type === 'FragmentOutput' && Option.isSome(model.outputNodeId)) {
    return withStatus(
      model,
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
  return modifyFields(base, {
    nodes: () => [...model.nodes, node],
    outputNodeId: () =>
      type === 'FragmentOutput' ? Option.some(id) : model.outputNodeId,
    nextNode: () => model.nextNode + 1,
    selectedNodeIds: () => [id],
    status: () => `Added ${type} (${id}).`,
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
    return withStatus(model, 'Cannot connect: node not found.')
  }
  const sourcePortDef = sourceNode.ports.find(
    p => p.name === fromPort && p.direction === 'out',
  )
  const targetPortDef = targetNode.ports.find(
    p => p.name === toPort && p.direction === 'in',
  )
  if (sourcePortDef === undefined) {
    return withStatus(
      model,
      `Cannot connect: ${fromNodeId}.${fromPort} is not an output port. Start from an output (right side).`,
    )
  }
  if (targetPortDef === undefined) {
    return withStatus(
      model,
      `Cannot connect: ${toNodeId}.${toPort} is not an input port. End on an input (left side).`,
    )
  }
  if (fromNodeId === toNodeId) {
    return withStatus(model, 'Cannot connect a node to itself.')
  }
  if (
    model.edges.some(
      e => e.targetNodeId === toNodeId && e.targetPort === toPort,
    )
  ) {
    return withStatus(
      model,
      `Input ${toNodeId}.${toPort} is already connected. Disconnect it first.`,
    )
  }
  const sourceType = upstreamPortType(graph, fromNodeId, fromPort)
  if (sourceType === null) {
    return withStatus(
      model,
      'Cannot connect: source type is not ready yet. Connect its inputs first.',
    )
  }
  const targetDef = isNodeType(targetNode.type)
    ? NODE_REGISTRY[targetNode.type]
    : null
  const targetInput = targetDef?.inputs.find(i => i.name === toPort)
  const allowed =
    targetInput?.accepts ??
    (targetPortDef !== undefined ? [targetPortDef.valueType] : [])
  const ok = allowed.some(t => canConnect(sourceType, t))
  if (!ok) {
    const single = allowed.length === 1 ? allowed[0] : undefined
    const expected = single !== undefined ? single : allowed.join(' | ')
    return withStatus(model, connectionErrorMessage(expected, sourceType))
  }
  const edge: EditorEdge = {
    id: `e${model.nextEdge}`,
    sourceNodeId: fromNodeId,
    sourcePort: fromPort,
    targetNodeId: toNodeId,
    targetPort: toPort,
  }
  const base = pushHistory(model)
  return modifyFields(base, {
    edges: () => [...model.edges, edge],
    nextEdge: () => model.nextEdge + 1,
    pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
    status: () =>
      `Connected ${fromNodeId}.${fromPort} to ${toNodeId}.${toPort}.`,
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
      return { model }
    },
    EndedDrag: () => {
      if (model.drag.mode === 'marquee') {
        const drag = model.drag
        if (!drag.moved) {
          return {
            model: modifyFields(model, {
              drag: () => ({ mode: 'idle' }),
              selectedNodeIds: () => [],
              selectedEdgeId: () => Option.none(),
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
        )
        return {
          model: modifyFields(model, {
            drag: () => ({ mode: 'idle' }),
            selectedNodeIds: () => ids,
            selectedEdgeId: () => Option.none(),
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
    CancelledPending: () => ({
      model: modifyFields(model, {
        pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
        contextMenu: () => Option.none(),
        status: () => 'Connection cancelled.',
      }),
    }),
    OpenedContextMenu: ({ worldX, worldY, clientX, clientY }) => ({
      model: modifyFields(model, {
        contextMenu: () =>
          Option.some({ worldX, worldY, clientX, clientY, search: '' }),
        selectedNodeIds: () => [],
        selectedEdgeId: () => Option.none(),
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
      return {
        model: closeContextMenu(
          addNodeAt(model, nodeType, menu.worldX, menu.worldY),
        ),
      }
    },
    DismissedContextMenu: () => ({ model: closeContextMenu(model) }),
    PreventedNativeContextMenu: () => ({ model }),
    ToggledMinimap: () => ({
      model: modifyFields(model, {
        minimapVisible: () => !model.minimapVisible,
      }),
    }),
    UpdatedParam: ({ nodeId, key, valueText }) => {
      const value = Number.parseFloat(valueText)
      if (!Number.isFinite(value)) {
        return { model: withStatus(model, `Invalid number: "${valueText}".`) }
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
        model: modifyFields(base, {
          nodes: () =>
            model.nodes.map(n =>
              n.id === nodeId
                ? { ...n, params: { ...n.params, [key]: value } }
                : n,
            ),
          status: () => `Set ${nodeId}.${key} to ${value}.`,
        }),
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
      return {
        model: modifyFields(base, {
          nodes: () => [...model.nodes, ...newNodes],
          edges: () => [...model.edges, ...newEdges],
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
          version: 1,
          nodes: model.nodes,
          edges: model.edges,
          outputNodeId: Option.getOrNull(model.outputNodeId),
        },
        null,
        2,
      )
      return { model, commands: [PersistGraph({ json })] }
    },
    CompletedPersistGraph: () => ({
      model: withStatus(model, 'Saved to browser storage.'),
    }),
    FailedPersistGraph: ({ reason }) => ({
      model: withStatus(model, `Save failed: ${reason}`),
    }),
    CompletedLoadGraph: ({ json }) => {
      const parsed = parseGraphText(json)
      if (!parsed.ok) {
        return {
          model: withStatus(model, `Stored graph is invalid: ${parsed.reason}`),
        }
      }
      const restored = fromSerialized(parsed.data)
      return {
        model: modifyFields(model, {
          nodes: () => restored.nodes,
          edges: () => restored.edges,
          outputNodeId: () => restored.outputNodeId,
          nextNode: () => restored.nextNode,
          nextEdge: () => restored.nextEdge,
          selectedNodeIds: () => [],
          status: () =>
            `Loaded saved graph with ${restored.nodes.length} nodes.`,
        }),
      }
    },
    CompletedLoadEmpty: () => ({ model: seedModel() }),
    FailedLoadGraph: ({ reason }) => ({
      model: withStatus(
        seedModel(),
        `Could not read saved graph (${reason}). Showing demo graph.`,
      ),
    }),
    RequestedNew: () => {
      const base = pushHistory(model)
      return {
        model: modifyFields(base, {
          nodes: () => [],
          edges: () => [],
          outputNodeId: () => Option.none(),
          nextNode: () => 1,
          nextEdge: () => 1,
          selectedNodeIds: () => [],
          pending: () => ({ active: false, fromNodeId: '', fromPort: '' }),
          status: () => 'New graph. Add nodes from the palette.',
        }),
      }
    },
    RequestedExport: () => {
      const json = JSON.stringify(
        {
          version: 1,
          nodes: model.nodes,
          edges: model.edges,
          outputNodeId: Option.getOrNull(model.outputNodeId),
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
      model: withStatus(model, `Import failed: ${reason}`),
    }),
    RequestedCopyHlsl: () => {
      const result = generate(toDomainGraph(model))
      if (!result.ok) {
        const first = result.errors[0]
        return {
          model: withStatus(
            model,
            `Cannot copy: ${first !== undefined ? first.message : 'graph is invalid.'}`,
          ),
        }
      }
      return { model, commands: [CopyHlsl({ code: result.code })] }
    },
    CompletedCopyHlsl: () => ({
      model: withStatus(model, 'HLSL copied to clipboard.'),
    }),
    FailedCopyHlsl: ({ reason }) => ({
      model: withStatus(model, `Copy failed: ${reason}`),
    }),
    DismissedStatus: () => ({ model: withStatus(model, '') }),
  })

export const init: () => UpdateReturn = () => ({
  model: emptyModel(),
  commands: [LoadGraph()],
})
