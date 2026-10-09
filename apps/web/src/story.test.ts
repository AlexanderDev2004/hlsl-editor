import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import { validate } from '@hlsl-editor/shader-compiler'

import { PersistSettings } from './editor/commands'
import {
  Message,
  type Model,
  deriveNodeStatuses,
  emptyModel,
  seedModel,
  toDomainGraph,
  update,
} from './main'

describe('editor update', () => {
  test('RequestedAddNode adds a Float and selects it', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 10, y: 20 })),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(1)
        expect(m.nodes[0]?.type).toBe('Float')
        expect(m.selectedNodeIds).toEqual(['n1'])
      }),
    )
  })

  test('second FragmentOutput is rejected', () => {
    story(
      update,
      given({ ...seedModel(), newNodeType: 'FragmentOutput' }),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(4)
      }),
    )
  })

  test('RequestedNew starts a valid graph with one Fragment Output', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedNew()),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(1)
        expect(m.nodes[0]?.type).toBe('FragmentOutput')
        expect(Option.getOrNull(m.outputNodeId)).toBe('n1')
        expect(m.nextNode).toBe(2)
        // The unconnected color port is the only expected problem; the
        // output node itself is present, so MissingOutput is gone.
        expect(validate(toDomainGraph(m)).map(e => e.code)).toEqual([
          'MissingRequiredInput',
        ])
      }),
    )
  })

  test('RequestedPlay previews the evaluated output color', () => {
    story(
      update,
      given(seedModel()),
      message(Message.RequestedPlay()),
      Command.expectNone(),
      model((m: Model) => {
        // Seed graph: Float(2) * Float(5) -> color, splatted to float4.
        expect(Option.getOrNull(m.play)).toEqual({ color: [10, 10, 10, 10] })
        expect(m.status).toContain('Playing preview')
      }),
    )
  })

  test('RequestedPlay refuses a graph with problems', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedPlay()),
      Command.expectNone(),
      model((m: Model) => {
        expect(Option.isNone(m.play)).toBe(true)
        expect(m.status).toContain('Cannot play: fix 1 problem first.')
      }),
    )
  })

  test('DismissedPlay closes the preview', () => {
    story(
      update,
      given(seedModel()),
      message(Message.RequestedPlay()),
      message(Message.DismissedPlay()),
      Command.expectNone(),
      model((m: Model) => {
        expect(Option.isNone(m.play)).toBe(true)
      }),
    )
  })

  test('editing a param closes the stale Play preview', () => {
    story(
      update,
      given(seedModel()),
      message(Message.RequestedPlay()),
      message(
        Message.UpdatedParam({ nodeId: 'n1', key: 'value', valueText: '3' }),
      ),
      Command.expectNone(),
      model((m: Model) => {
        expect(Option.isNone(m.play)).toBe(true)
      }),
    )
  })

  test('imported params are sanitized against the node registry', () => {
    // JSON.parse turns 1e999 into Infinity, which decodeParams accepts;
    // sanitizeParams must replace it with the default and drop unknown keys.
    const text =
      '{"version":1,"nodes":[' +
      '{"id":"n1","type":"Float","position":{"x":0,"y":0},"params":{"value":1e999,"bogus":7}},' +
      '{"id":"n2","type":"FragmentOutput","position":{"x":10,"y":0},"params":{}}],' +
      '"edges":[{"id":"e1","source":{"nodeId":"n1","port":"out"},"target":{"nodeId":"n2","port":"color"}}],' +
      '"outputNodeId":"n2"}'
    story(
      update,
      given(emptyModel()),
      message(Message.CompletedImportFile({ text })),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.nodes[0]?.params).toEqual({ value: 0 })
      }),
    )
  })

  test('a rejected connection logs an error entry', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.ChangedNewNodeType({ nodeType: 'Float3' })),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(Message.ChangedNewNodeType({ nodeType: 'Combine' })),
      message(Message.RequestedAddNode({ x: 400, y: 0 })),
      message(Message.ClickedPort({ nodeId: 'n1', port: 'out' })),
      message(Message.ClickedPort({ nodeId: 'n2', port: 'x' })),
      Command.expectNone(),
      model((m: Model) => {
        // Combine.x takes scalars only; float3 cannot feed it. Entries 1-2
        // are the two "Added ..." infos from setting the scene up.
        expect(m.logs[0]?.level).toBe('error')
        expect(m.logs[0]?.text).toContain('Type mismatch')
        expect(m.logs[0]?.id).toBe(3)
        expect(m.nextLogId).toBe(4)
      }),
    )
  })

  test('a successful connection logs a success entry', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(Message.ChangedNewNodeType({ nodeType: 'FragmentOutput' })),
      message(Message.RequestedAddNode({ x: 400, y: 0 })),
      message(Message.ClickedPort({ nodeId: 'n1', port: 'out' })),
      message(Message.ClickedPort({ nodeId: 'n2', port: 'color' })),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.logs[0]?.level).toBe('success')
        expect(m.logs[0]?.text).toBe('Connected n1.out to n2.color.')
      }),
    )
  })

  test('an invalid param value logs a warning entry', () => {
    story(
      update,
      given(seedModel()),
      message(
        Message.UpdatedParam({ nodeId: 'n1', key: 'value', valueText: 'abc' }),
      ),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.logs[0]?.level).toBe('warning')
        expect(m.logs[0]?.text).toContain('Invalid number: "abc"')
      }),
    )
  })

  test('PressedClearLogs empties the console but keeps the id counter', () => {
    story(
      update,
      given(seedModel()),
      message(Message.RequestedPlay()),
      message(Message.PressedClearLogs()),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.logs).toEqual([])
        expect(m.nextLogId).toBeGreaterThan(1)
      }),
    )
  })

  test('ToggledLogPanel flips the panel visibility flag', () => {
    story(
      update,
      given({ ...seedModel(), logPanelOpen: false }),
      message(Message.ToggledLogPanel()),
      message(Message.ToggledLogPanel()),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.logPanelOpen).toBe(false)
      }),
    )
  })

  test('click-to-connect builds a valid edge with splat', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(Message.ChangedNewNodeType({ nodeType: 'FragmentOutput' })),
      message(Message.RequestedAddNode({ x: 400, y: 0 })),
      message(Message.ClickedPort({ nodeId: 'n1', port: 'out' })),
      message(Message.ClickedPort({ nodeId: 'n2', port: 'color' })),
      model((m: Model) => {
        expect(m.edges).toHaveLength(1)
        expect(m.status).toContain('Connected n1.out to n2.color')
      }),
    )
  })

  test('vector to output connection is rejected with readable error', () => {
    story(
      update,
      given({ ...emptyModel(), newNodeType: 'Float3' }),
      message(Message.RequestedAddNode({ x: 0, y: 400 })),
      message(Message.ChangedNewNodeType({ nodeType: 'FragmentOutput' })),
      message(Message.RequestedAddNode({ x: 400, y: 400 })),
      message(Message.ClickedPort({ nodeId: 'n1', port: 'out' })),
      message(Message.ClickedPort({ nodeId: 'n2', port: 'color' })),
      model((m: Model) => {
        expect(m.edges).toHaveLength(0)
        expect(m.status).toContain('Type mismatch')
      }),
    )
  })

  test('undo and redo restore snapshots', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(1)
      }),
      message(Message.PressedUndo()),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(0)
      }),
      message(Message.PressedRedo()),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(1)
      }),
    )
  })

  test('UpdatedParam commits finite numbers and rejects text', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(
        Message.UpdatedParam({ nodeId: 'n1', key: 'value', valueText: '2.5' }),
      ),
      model((m: Model) => {
        expect(m.nodes[0]?.params['value']).toBe(2.5)
      }),
      message(
        Message.UpdatedParam({ nodeId: 'n1', key: 'value', valueText: 'abc' }),
      ),
      model((m: Model) => {
        expect(m.nodes[0]?.params['value']).toBe(2.5)
        expect(m.status).toContain('Invalid number')
      }),
    )
  })

  test('search selects a matching node and fits the viewport', () => {
    story(
      update,
      given(seedModel()),
      message(Message.ChangedSearch({ text: 'mult' })),
      model((m: Model) => {
        expect(m.searchText).toBe('mult')
      }),
      message(Message.SelectedSearchResult({ nodeId: 'n3' })),
      model((m: Model) => {
        expect(m.selectedNodeIds).toEqual(['n3'])
        expect(m.searchText).toBe('')
        expect(m.viewport.x).not.toBe(0)
        expect(m.viewport.y).not.toBe(0)
      }),
    )
  })

  test('ClearedSearch empties the query', () => {
    story(
      update,
      given({ ...seedModel(), searchText: 'mult' }),
      message(Message.ClearedSearch()),
      model((m: Model) => {
        expect(m.searchText).toBe('')
      }),
    )
  })

  test('node status precedence: error, initial, warning, success', () => {
    const base = seedModel()
    const model: Model = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'n5', type: 'Add', position: { x: 0, y: 0 }, params: {} },
        {
          id: 'n6',
          type: 'Float',
          position: { x: 0, y: 0 },
          params: { value: 1 },
        },
      ],
      edges: [
        ...base.edges,
        {
          id: 'e4',
          sourceNodeId: 'n1',
          sourcePort: 'out',
          targetNodeId: 'n5',
          targetPort: 'a',
        },
      ],
    }
    const statuses = deriveNodeStatuses(model, new Set(['n3']))
    expect(statuses.get('n3')).toBe('error')
    expect(statuses.get('n6')).toBe('initial')
    expect(statuses.get('n5')).toBe('warning')
    expect(statuses.get('n4')).toBe('success')
  })

  test('simulated loading overrides every other status', () => {
    const statuses = deriveNodeStatuses(
      { ...seedModel(), simulateLoading: true },
      new Set(['n3']),
    )
    expect(statuses.get('n3')).toBe('loading')
    expect(statuses.get('n1')).toBe('loading')
  })

  test('ToggledSimulateLoading flips the flag', () => {
    story(
      update,
      given(seedModel()),
      message(Message.ToggledSimulateLoading()),
      model((m: Model) => {
        expect(m.simulateLoading).toBe(true)
      }),
    )
  })

  test('ChangedLoadingVariant accepts known variants and ignores others', () => {
    story(
      update,
      given(seedModel()),
      message(Message.ChangedLoadingVariant({ variant: 'overlay' })),
      model((m: Model) => {
        expect(m.loadingVariant).toBe('overlay')
      }),
      message(Message.ChangedLoadingVariant({ variant: 'nope' })),
      model((m: Model) => {
        expect(m.loadingVariant).toBe('overlay')
      }),
    )
  })

  test('hovering an edge sets and clears the hovered edge', () => {
    story(
      update,
      given(seedModel()),
      message(Message.HoveredEdge({ edgeId: 'e1' })),
      model((m: Model) => {
        expect(Option.getOrNull(m.hoveredEdgeId)).toBe('e1')
      }),
      message(Message.UnhoveredEdge({ edgeId: 'e2' })),
      model((m: Model) => {
        expect(Option.getOrNull(m.hoveredEdgeId)).toBe('e1')
      }),
      message(Message.UnhoveredEdge({ edgeId: 'e1' })),
      model((m: Model) => {
        expect(Option.isNone(m.hoveredEdgeId)).toBe(true)
      }),
    )
  })

  test('selecting an edge clears the node selection', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1'] }),
      message(Message.SelectedEdge({ edgeId: 'e1' })),
      model((m: Model) => {
        expect(Option.getOrNull(m.selectedEdgeId)).toBe('e1')
        expect(m.selectedNodeIds).toEqual([])
        expect(m.status).toContain('Selected edge e1')
      }),
    )
  })

  test('deleting a selected edge keeps its nodes and can reconnect', () => {
    story(
      update,
      given(seedModel()),
      message(Message.SelectedEdge({ edgeId: 'e1' })),
      message(Message.PressedDelete()),
      model((m: Model) => {
        expect(m.edges).toHaveLength(2)
        expect(m.nodes).toHaveLength(4)
        expect(Option.isNone(m.selectedEdgeId)).toBe(true)
      }),
      message(Message.ClickedPort({ nodeId: 'n1', port: 'out' })),
      message(Message.ClickedPort({ nodeId: 'n3', port: 'a' })),
      model((m: Model) => {
        expect(m.edges).toHaveLength(3)
        expect(
          m.edges.some(e => e.sourceNodeId === 'n1' && e.targetNodeId === 'n3'),
        ).toBe(true)
      }),
    )
  })

  test('delete removes selection and incident edges', () => {
    story(
      update,
      given(seedModel()),
      message(Message.SelectedNode({ nodeId: 'n3' })),
      message(Message.PressedDelete()),
      model((m: Model) => {
        expect(m.nodes.find(n => n.id === 'n3')).toBeUndefined()
        expect(m.edges).toHaveLength(0)
      }),
    )
  })

  test('copy and paste duplicates selected nodes with fresh ids and edges', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1', 'n3'] }),
      message(Message.PressedCopy()),
      model((m: Model) => {
        expect(Option.isSome(m.clipboard)).toBe(true)
        expect(m.status).toContain('Copied 2 nodes and 1 edge')
      }),
      message(Message.PressedPaste()),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(6)
        expect(m.edges).toHaveLength(4)
        expect([...m.selectedNodeIds].sort()).toEqual(['n5', 'n6'])
        const pastedNode = m.nodes.find(n => n.id === 'n5')
        expect(pastedNode?.position.x).toBe(460)
        expect(pastedNode?.position.y).toBe(420)
        const pastedEdge = m.edges.find(e => e.id === 'e4')
        expect(pastedEdge?.sourceNodeId).toBe('n5')
        expect(pastedEdge?.targetNodeId).toBe('n6')
        expect(m.nextNode).toBe(7)
        expect(m.nextEdge).toBe(5)
      }),
    )
  })

  test('pasting again cascades the offset', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1'] }),
      message(Message.PressedCopy()),
      message(Message.PressedPaste()),
      message(Message.PressedPaste()),
      model((m: Model) => {
        const first = m.nodes.find(n => n.id === 'n5')
        const second = m.nodes.find(n => n.id === 'n6')
        expect(first?.position.x).toBe(460)
        expect(second?.position.x).toBe(500)
      }),
    )
  })

  test('copying only the Fragment Output reports it cannot be duplicated', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n4'] }),
      message(Message.PressedCopy()),
      model((m: Model) => {
        expect(Option.isNone(m.clipboard)).toBe(true)
        expect(m.status).toContain('cannot be duplicated')
      }),
    )
  })

  test('pasting with an empty clipboard reports it', () => {
    story(
      update,
      given(seedModel()),
      message(Message.PressedPaste()),
      model((m: Model) => {
        expect(m.status).toContain('Clipboard is empty')
        expect(m.nodes).toHaveLength(4)
      }),
    )
  })

  test('marquee drag selects the nodes it overlaps', () => {
    story(
      update,
      given(seedModel()),
      message(
        Message.StartedMarquee({
          worldX: 0,
          worldY: 0,
          worldPerPixel: 1,
          screenX: 0,
          screenY: 0,
        }),
      ),
      message(Message.MovedPointer({ x: 960, y: 700 })),
      message(Message.EndedDrag()),
      model((m: Model) => {
        expect([...m.selectedNodeIds].sort()).toEqual(['n1', 'n2', 'n3'])
        expect(m.status).toContain('Selected 3 nodes')
        expect(m.drag.mode).toBe('idle')
      }),
    )
  })

  test('a marquee that never moves clears the selection', () => {
    story(
      update,
      given({
        ...seedModel(),
        selectedNodeIds: ['n1'],
        selectedEdgeId: Option.some('e1'),
      }),
      message(
        Message.StartedMarquee({
          worldX: 10,
          worldY: 10,
          worldPerPixel: 1,
          screenX: 10,
          screenY: 10,
        }),
      ),
      message(Message.EndedDrag()),
      model((m: Model) => {
        expect(m.selectedNodeIds).toEqual([])
        expect(Option.isNone(m.selectedEdgeId)).toBe(true)
      }),
    )
  })

  test('ToggledMinimap flips minimap visibility', () => {
    story(
      update,
      given(seedModel()),
      model((m: Model) => {
        expect(m.minimapVisible).toBe(true)
      }),
      message(Message.ToggledMinimap()),
      model((m: Model) => {
        expect(m.minimapVisible).toBe(false)
      }),
      message(Message.ToggledMinimap()),
      model((m: Model) => {
        expect(m.minimapVisible).toBe(true)
      }),
    )
  })

  test('right-click opens a context menu and clears selection', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1'] }),
      message(
        Message.OpenedContextMenu({
          worldX: 500,
          worldY: 400,
          clientX: 500,
          clientY: 400,
        }),
      ),
      model((m: Model) => {
        const menu = Option.getOrNull(m.contextMenu)
        expect(menu?.worldX).toBe(500)
        expect(menu?.worldY).toBe(400)
        expect(menu?.search).toBe('')
        expect(m.selectedNodeIds).toEqual([])
      }),
    )
  })

  test('the context menu search updates and selecting adds a node at its point', () => {
    story(
      update,
      given(seedModel()),
      message(
        Message.OpenedContextMenu({
          worldX: 500,
          worldY: 400,
          clientX: 500,
          clientY: 400,
        }),
      ),
      message(Message.ChangedContextMenuSearch({ text: 'mult' })),
      model((m: Model) => {
        expect(Option.getOrNull(m.contextMenu)?.search).toBe('mult')
      }),
      message(Message.SelectedContextMenuNode({ nodeType: 'Multiply' })),
      model((m: Model) => {
        const added = m.nodes.find(n => n.id === 'n5')
        expect(added?.type).toBe('Multiply')
        expect(added?.position.x).toBe(500)
        expect(added?.position.y).toBe(400)
        expect(m.selectedNodeIds).toEqual(['n5'])
        expect(Option.isNone(m.contextMenu)).toBe(true)
        expect(m.status).toContain('Added Multiply (n5)')
      }),
    )
  })

  test('Escape closes the context menu', () => {
    story(
      update,
      given({
        ...seedModel(),
        contextMenu: Option.some({
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
          search: '',
        }),
      }),
      message(Message.CancelledPending()),
      model((m: Model) => {
        expect(Option.isNone(m.contextMenu)).toBe(true)
      }),
    )
  })

  test('left-dragging the background closes the context menu', () => {
    story(
      update,
      given({
        ...seedModel(),
        contextMenu: Option.some({
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
          search: '',
        }),
      }),
      message(
        Message.StartedMarquee({
          worldX: 0,
          worldY: 0,
          worldPerPixel: 1,
          screenX: 0,
          screenY: 0,
        }),
      ),
      model((m: Model) => {
        expect(Option.isNone(m.contextMenu)).toBe(true)
      }),
    )
  })

  test('grouping selected nodes wraps them and selects the group', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1', 'n2'] }),
      message(Message.PressedGroupSelection()),
      model((m: Model) => {
        expect(m.groups).toHaveLength(1)
        expect(m.groups[0]?.nodeIds).toEqual(['n1', 'n2'])
        expect(Option.getOrNull(m.selectedGroupId)).toBe('g1')
        expect(m.selectedNodeIds).toEqual([])
        expect(m.nextGroup).toBe(2)
        expect(m.status).toContain('Grouped 2 nodes')
      }),
      message(Message.PressedUngroupSelection()),
      model((m: Model) => {
        expect(m.groups).toHaveLength(0)
        expect(Option.isNone(m.selectedGroupId)).toBe(true)
      }),
    )
  })

  test('grouping with nothing selected reports it', () => {
    story(
      update,
      given(seedModel()),
      message(Message.PressedGroupSelection()),
      model((m: Model) => {
        expect(m.groups).toHaveLength(0)
        expect(m.status).toContain('Select nodes to group')
      }),
    )
  })

  test('grouping reassigns a node that already belonged to a group', () => {
    story(
      update,
      given({
        ...seedModel(),
        selectedNodeIds: ['n2'],
        groups: [
          {
            id: 'g1',
            name: 'Old',
            color: '#58a6ff',
            nodeIds: ['n1', 'n2'],
          },
        ],
        nextGroup: 2,
      }),
      message(Message.PressedGroupSelection()),
      model((m: Model) => {
        expect(m.groups).toHaveLength(2)
        expect(m.groups.find(g => g.id === 'g1')?.nodeIds).toEqual(['n1'])
        expect(m.groups.find(g => g.id === 'g2')?.nodeIds).toEqual(['n2'])
      }),
    )
  })

  test('renaming a group and recoloring it with any valid hex', () => {
    story(
      update,
      given({
        ...seedModel(),
        groups: [
          { id: 'g1', name: 'Group 1', color: '#58a6ff', nodeIds: ['n1'] },
        ],
        nextGroup: 2,
      }),
      message(Message.RenamedGroup({ groupId: 'g1', name: 'Inputs' })),
      model((m: Model) => {
        expect(m.groups[0]?.name).toBe('Inputs')
      }),
      message(Message.ChangedGroupColor({ groupId: 'g1', color: '#3fb950' })),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#3fb950')
      }),
      message(Message.ChangedGroupColor({ groupId: 'g1', color: '#123456' })),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#123456')
      }),
      message(Message.ChangedGroupColor({ groupId: 'g1', color: 'nothex' })),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#123456')
      }),
    )
  })

  test('the custom group color picker drafts, applies, and closes', () => {
    story(
      update,
      given({
        ...seedModel(),
        groups: [
          { id: 'g1', name: 'Group 1', color: '#58a6ff', nodeIds: ['n1'] },
        ],
        nextGroup: 2,
      }),
      message(Message.OpenedGroupColorPicker({ groupId: 'g1' })),
      model((m: Model) => {
        const picker = Option.getOrNull(m.colorPicker)
        expect(picker?.groupId).toBe('g1')
        expect(picker?.draft).toBe('#58a6ff')
        expect(picker?.originalColor).toBe('#58a6ff')
      }),
      message(Message.EditedGroupColorDraft({ text: '#ff8800' })),
      model((m: Model) => {
        expect(Option.getOrNull(m.colorPicker)?.draft).toBe('#ff8800')
        expect(m.groups[0]?.color).toBe('#58a6ff')
      }),
      message(Message.AppliedGroupColorDraft()),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#ff8800')
        expect(Option.isNone(m.colorPicker)).toBe(true)
      }),
    )
  })

  test('applying an invalid group color draft keeps the picker open', () => {
    story(
      update,
      given({
        ...seedModel(),
        groups: [
          { id: 'g1', name: 'Group 1', color: '#58a6ff', nodeIds: ['n1'] },
        ],
        nextGroup: 2,
        colorPicker: Option.some({
          groupId: 'g1',
          originalColor: '#58a6ff',
          draft: 'nothex',
        }),
      }),
      message(Message.AppliedGroupColorDraft()),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#58a6ff')
        expect(Option.isSome(m.colorPicker)).toBe(true)
      }),
    )
  })

  test('cancelling or escaping the group color picker keeps the color', () => {
    story(
      update,
      given({
        ...seedModel(),
        groups: [
          { id: 'g1', name: 'Group 1', color: '#58a6ff', nodeIds: ['n1'] },
        ],
        nextGroup: 2,
        colorPicker: Option.some({
          groupId: 'g1',
          originalColor: '#58a6ff',
          draft: '#ff8800',
        }),
      }),
      message(Message.PressedEscape()),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#58a6ff')
        expect(Option.isNone(m.colorPicker)).toBe(true)
      }),
      message(Message.OpenedGroupColorPicker({ groupId: 'g1' })),
      message(Message.CancelledGroupColorPicker()),
      model((m: Model) => {
        expect(m.groups[0]?.color).toBe('#58a6ff')
        expect(Option.isNone(m.colorPicker)).toBe(true)
      }),
    )
  })

  test('opening the group color picker requires an existing group', () => {
    story(
      update,
      given(seedModel()),
      message(Message.OpenedGroupColorPicker({ groupId: 'missing' })),
      model((m: Model) => {
        expect(Option.isNone(m.colorPicker)).toBe(true)
      }),
    )
  })

  test('deleting a node prunes it from its group', () => {
    story(
      update,
      given({
        ...seedModel(),
        selectedNodeIds: ['n1'],
        groups: [
          { id: 'g1', name: 'Pair', color: '#58a6ff', nodeIds: ['n1', 'n2'] },
        ],
      }),
      message(Message.PressedDelete()),
      model((m: Model) => {
        expect(m.groups[0]?.nodeIds).toEqual(['n2'])
      }),
    )
  })

  test('deleting the last member drops its group', () => {
    story(
      update,
      given({
        ...seedModel(),
        selectedNodeIds: ['n1'],
        groups: [{ id: 'g1', name: 'Solo', color: '#58a6ff', nodeIds: ['n1'] }],
      }),
      message(Message.PressedDelete()),
      model((m: Model) => {
        expect(m.groups).toHaveLength(0)
      }),
    )
  })

  test('deleting a selected group removes the frame but keeps its nodes', () => {
    story(
      update,
      given({
        ...seedModel(),
        groups: [
          { id: 'g1', name: 'Pair', color: '#58a6ff', nodeIds: ['n1', 'n2'] },
        ],
        selectedGroupId: Option.some('g1'),
      }),
      message(Message.PressedDelete()),
      model((m: Model) => {
        expect(m.groups).toHaveLength(0)
        expect(m.nodes).toHaveLength(4)
        expect(m.status).toContain('Deleted g1')
      }),
    )
  })

  test('dragging a group header moves all of its member nodes', () => {
    story(
      update,
      given({
        ...seedModel(),
        groups: [
          { id: 'g1', name: 'Pair', color: '#58a6ff', nodeIds: ['n1', 'n2'] },
        ],
      }),
      message(Message.StartedGroupDrag({ groupId: 'g1', x: 0, y: 0 })),
      model((m: Model) => {
        expect(Option.getOrNull(m.selectedGroupId)).toBe('g1')
      }),
      message(Message.MovedPointer({ x: 100, y: 50 })),
      model((m: Model) => {
        expect(m.nodes.find(n => n.id === 'n1')?.position.x).toBe(520)
        expect(m.nodes.find(n => n.id === 'n1')?.position.y).toBe(430)
        expect(m.nodes.find(n => n.id === 'n2')?.position.y).toBe(610)
        expect(m.nodes.find(n => n.id === 'n3')?.position.x).toBe(720)
      }),
      message(Message.EndedDrag()),
      model((m: Model) => {
        expect(m.past).toHaveLength(1)
        expect(m.status).toContain('Moved g1')
      }),
    )
  })

  test('settings open, close, and Escape closes them first', () => {
    story(
      update,
      given(seedModel()),
      model((m: Model) => {
        expect(m.settingsOpen).toBe(false)
      }),
      message(Message.OpenedSettings()),
      model((m: Model) => {
        expect(m.settingsOpen).toBe(true)
      }),
      message(Message.PressedEscape()),
      model((m: Model) => {
        expect(m.settingsOpen).toBe(false)
      }),
      message(Message.PressedSettings()),
      model((m: Model) => {
        expect(m.settingsOpen).toBe(true)
      }),
      message(Message.ClosedSettings()),
      model((m: Model) => {
        expect(m.settingsOpen).toBe(false)
      }),
    )
  })

  test('recording a shortcut stores it and persists the settings', () => {
    story(
      update,
      given(seedModel()),
      message(Message.StartedShortcutRecording({ actionId: 'copy' })),
      model((m: Model) => {
        expect(Option.getOrNull(m.recordingAction)).toBe('copy')
      }),
      message(
        Message.CapturedShortcut({
          key: 'p',
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          isApple: false,
        }),
      ),
      Command.resolve(PersistSettings, Message.CompletedPersistSettings()),
      model((m: Model) => {
        expect(m.keymap['copy']).toBe('Mod+p')
        expect(Option.isNone(m.recordingAction)).toBe(true)
        expect(m.status).toContain('Ctrl+P')
      }),
    )
  })

  test('a conflicting recording is rejected and stays active', () => {
    story(
      update,
      given(seedModel()),
      message(Message.StartedShortcutRecording({ actionId: 'paste' })),
      message(
        Message.CapturedShortcut({
          key: 'c',
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          isApple: false,
        }),
      ),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.keymap['paste']).toBe('Mod+V')
        expect(Option.getOrNull(m.recordingAction)).toBe('paste')
        expect(m.status).toContain('already used')
      }),
    )
  })

  test('a modifier-only key press leaves recording active', () => {
    story(
      update,
      given(seedModel()),
      message(Message.StartedShortcutRecording({ actionId: 'copy' })),
      message(
        Message.CapturedShortcut({
          key: 'Control',
          ctrlKey: true,
          metaKey: false,
          altKey: false,
          shiftKey: false,
          isApple: false,
        }),
      ),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.keymap['copy']).toBe('Mod+C')
        expect(Option.getOrNull(m.recordingAction)).toBe('copy')
      }),
    )
  })

  test('cancelling and resetting shortcuts', () => {
    story(
      update,
      given({
        ...seedModel(),
        keymap: { ...seedModel().keymap, copy: 'Mod+P' },
      }),
      message(Message.StartedShortcutRecording({ actionId: 'copy' })),
      message(Message.CancelledShortcutRecording()),
      model((m: Model) => {
        expect(Option.isNone(m.recordingAction)).toBe(true)
        expect(m.keymap['copy']).toBe('Mod+P')
      }),
      message(Message.ResetShortcut({ actionId: 'copy' })),
      Command.resolve(PersistSettings, Message.CompletedPersistSettings()),
      model((m: Model) => {
        expect(m.keymap['copy']).toBe('Mod+C')
      }),
    )
  })

  test('ResetAllShortcuts restores every default binding', () => {
    story(
      update,
      given({
        ...seedModel(),
        keymap: { ...seedModel().keymap, copy: 'Mod+P', paste: 'Mod+U' },
      }),
      message(Message.ResetAllShortcuts()),
      Command.resolve(PersistSettings, Message.CompletedPersistSettings()),
      model((m: Model) => {
        expect(m.keymap['copy']).toBe('Mod+C')
        expect(m.keymap['paste']).toBe('Mod+V')
      }),
    )
  })

  test('ChangedShortcutPlatform switches display mode and persists', () => {
    story(
      update,
      given(seedModel()),
      message(Message.ChangedShortcutPlatform({ platform: 'macos' })),
      Command.resolve(PersistSettings, Message.CompletedPersistSettings()),
      model((m: Model) => {
        expect(m.shortcutPlatform).toBe('macos')
      }),
      message(Message.ChangedShortcutPlatform({ platform: 'nope' })),
      Command.expectNone(),
      model((m: Model) => {
        expect(m.shortcutPlatform).toBe('macos')
      }),
    )
  })

  test('CompletedLoadSettings applies a stored keymap', () => {
    story(
      update,
      given(seedModel()),
      message(
        Message.CompletedLoadSettings({
          json: JSON.stringify({
            version: 1,
            platform: 'macos',
            keymap: { copy: 'Mod+P' },
          }),
        }),
      ),
      model((m: Model) => {
        expect(m.shortcutPlatform).toBe('macos')
        expect(m.keymap['copy']).toBe('Mod+P')
        expect(m.keymap['paste']).toBe('Mod+V')
      }),
    )
  })

  test('seeding the demo graph preserves loaded settings', () => {
    story(
      update,
      given({
        ...emptyModel(),
        shortcutPlatform: 'macos',
        keymap: { ...emptyModel().keymap, copy: 'Mod+P' },
      }),
      message(Message.CompletedLoadEmpty()),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(4)
        expect(m.shortcutPlatform).toBe('macos')
        expect(m.keymap['copy']).toBe('Mod+P')
      }),
    )
  })

  test('InsertedRerouteOnEdge splits the wire through a reroute', () => {
    story(
      update,
      given(seedModel()),
      message(
        Message.InsertedRerouteOnEdge({
          edgeId: 'e1',
          worldX: 200,
          worldY: 150,
        }),
      ),
      Command.expectNone(),
      model((m: Model) => {
        const reroute = m.nodes.find(n => n.type === 'Reroute')
        expect(reroute).toBeDefined()
        expect(reroute?.position.x).toBe(185)
        expect(m.edges.some(e => e.id === 'e1')).toBe(false)
        expect(
          m.edges.some(
            e => e.sourceNodeId === 'n1' && e.targetNodeId === reroute?.id,
          ),
        ).toBe(true)
        expect(
          m.edges.some(
            e => e.sourceNodeId === reroute?.id && e.targetNodeId === 'n3',
          ),
        ).toBe(true)
        expect(m.selectedNodeIds).toEqual([reroute?.id])
      }),
    )
  })

  test('ConvertedRerouteToNamed creates a declaration/usage pair', () => {
    story(
      update,
      given({
        ...seedModel(),
        nodes: [
          ...seedModel().nodes,
          {
            id: 'n5',
            type: 'Reroute',
            position: { x: 240, y: 150 },
            params: {},
          },
        ],
        edges: [
          {
            id: 'e1',
            sourceNodeId: 'n1',
            sourcePort: 'out',
            targetNodeId: 'n5',
            targetPort: 'in',
          },
          {
            id: 'e2',
            sourceNodeId: 'n5',
            sourcePort: 'out',
            targetNodeId: 'n3',
            targetPort: 'a',
          },
          {
            id: 'e3',
            sourceNodeId: 'n2',
            sourcePort: 'out',
            targetNodeId: 'n3',
            targetPort: 'b',
          },
          {
            id: 'e4',
            sourceNodeId: 'n3',
            sourcePort: 'out',
            targetNodeId: 'n4',
            targetPort: 'color',
          },
        ],
        nextNode: 6,
        nextEdge: 5,
      }),
      message(Message.ConvertedRerouteToNamed({ nodeId: 'n5' })),
      model((m: Model) => {
        expect(m.nodes.some(n => n.id === 'n5')).toBe(false)
        const declaration = m.nodes.find(
          n => n.type === 'NamedRerouteDeclaration',
        )
        const usage = m.nodes.find(n => n.type === 'NamedRerouteUsage')
        expect(declaration).toBeDefined()
        expect(usage).toBeDefined()
        expect(
          m.edges.some(
            e =>
              e.sourceNodeId === declaration?.id &&
              e.targetNodeId === usage?.id,
          ),
        ).toBe(true)
        expect(
          m.edges.some(
            e => e.sourceNodeId === 'n1' && e.targetNodeId === declaration?.id,
          ),
        ).toBe(true)
        expect(
          m.edges.some(
            e => e.sourceNodeId === usage?.id && e.targetNodeId === 'n3',
          ),
        ).toBe(true)
        expect(m.rerouteNames[declaration?.id ?? '']).toBe('Reroute 1')
      }),
    )
  })

  test('AddedNamedRerouteUsage links a usage and selection follows it', () => {
    story(
      update,
      given({
        ...seedModel(),
        nodes: [
          ...seedModel().nodes,
          {
            id: 'n5',
            type: 'NamedRerouteDeclaration',
            position: { x: 240, y: 150 },
            params: {},
          },
        ],
        nextNode: 6,
      }),
      message(Message.AddedNamedRerouteUsage({ declarationId: 'n5' })),
      model((m: Model) => {
        const usage = m.nodes.find(n => n.type === 'NamedRerouteUsage')
        expect(usage).toBeDefined()
        expect(
          m.edges.some(
            e => e.sourceNodeId === 'n5' && e.targetNodeId === usage?.id,
          ),
        ).toBe(true)
      }),
      message(Message.SelectedRerouteUsages({ declarationId: 'n5' })),
      model((m: Model) => {
        expect(m.selectedNodeIds).toHaveLength(1)
        expect(m.nodes.find(n => n.id === m.selectedNodeIds[0])?.type).toBe(
          'NamedRerouteUsage',
        )
      }),
    )
  })

  test('SelectedRerouteDeclaration jumps from a usage to its declaration', () => {
    story(
      update,
      given({
        ...seedModel(),
        nodes: [
          ...seedModel().nodes,
          {
            id: 'n5',
            type: 'NamedRerouteDeclaration',
            position: { x: 240, y: 150 },
            params: {},
          },
          {
            id: 'n6',
            type: 'NamedRerouteUsage',
            position: { x: 240, y: 230 },
            params: {},
          },
        ],
        edges: [
          ...seedModel().edges,
          {
            id: 'e4',
            sourceNodeId: 'n5',
            sourcePort: 'out',
            targetNodeId: 'n6',
            targetPort: 'in',
          },
        ],
        nextNode: 7,
        nextEdge: 5,
      }),
      message(Message.SelectedRerouteDeclaration({ usageId: 'n6' })),
      model((m: Model) => {
        expect(m.selectedNodeIds).toEqual(['n5'])
      }),
    )
  })

  test('ConvertedNamedRerouteToReroute merges back to a plain reroute', () => {
    story(
      update,
      given({
        ...seedModel(),
        nodes: [
          ...seedModel().nodes,
          {
            id: 'n5',
            type: 'NamedRerouteDeclaration',
            position: { x: 240, y: 150 },
            params: {},
          },
          {
            id: 'n6',
            type: 'NamedRerouteUsage',
            position: { x: 300, y: 150 },
            params: {},
          },
        ],
        edges: [
          {
            id: 'e1',
            sourceNodeId: 'n1',
            sourcePort: 'out',
            targetNodeId: 'n5',
            targetPort: 'in',
          },
          {
            id: 'e2',
            sourceNodeId: 'n5',
            sourcePort: 'out',
            targetNodeId: 'n6',
            targetPort: 'in',
          },
          {
            id: 'e3',
            sourceNodeId: 'n6',
            sourcePort: 'out',
            targetNodeId: 'n3',
            targetPort: 'a',
          },
          {
            id: 'e4',
            sourceNodeId: 'n2',
            sourcePort: 'out',
            targetNodeId: 'n3',
            targetPort: 'b',
          },
          {
            id: 'e5',
            sourceNodeId: 'n3',
            sourcePort: 'out',
            targetNodeId: 'n4',
            targetPort: 'color',
          },
        ],
        nextNode: 7,
        nextEdge: 6,
      }),
      message(Message.ConvertedNamedRerouteToReroute({ nodeId: 'n5' })),
      model((m: Model) => {
        const reroute = m.nodes.find(n => n.type === 'Reroute')
        expect(reroute).toBeDefined()
        expect(m.nodes.some(n => n.type === 'NamedRerouteDeclaration')).toBe(
          false,
        )
        expect(
          m.edges.some(
            e => e.sourceNodeId === 'n1' && e.targetNodeId === reroute?.id,
          ),
        ).toBe(true)
        expect(
          m.edges.some(
            e => e.sourceNodeId === reroute?.id && e.targetNodeId === 'n3',
          ),
        ).toBe(true)
      }),
    )
  })

  test('RenamedReroute stores the display name', () => {
    story(
      update,
      given({
        ...seedModel(),
        nodes: [
          ...seedModel().nodes,
          {
            id: 'n5',
            type: 'NamedRerouteDeclaration',
            position: { x: 0, y: 0 },
            params: {},
          },
        ],
        nextNode: 6,
      }),
      message(Message.RenamedReroute({ declarationId: 'n5', name: 'Base UV' })),
      model((m: Model) => {
        expect(m.rerouteNames['n5']).toBe('Base UV')
      }),
    )
  })

  test('AlignedNodes lines up selected nodes on an edge', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1', 'n2'] }),
      message(Message.AlignedNodes({ mode: 'top' })),
      model((m: Model) => {
        const n1 = m.nodes.find(n => n.id === 'n1')
        const n2 = m.nodes.find(n => n.id === 'n2')
        expect(n1?.position.y).toBe(n2?.position.y)
      }),
    )
  })

  test('DistributedNodes spaces three nodes evenly', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1', 'n2', 'n3'] }),
      message(Message.DistributedNodes({ axis: 'horizontal' })),
      model((m: Model) => {
        const n1 = m.nodes.find(n => n.id === 'n1')?.position.x ?? 0
        const n2 = m.nodes.find(n => n.id === 'n2')?.position.x ?? 0
        const n3 = m.nodes.find(n => n.id === 'n3')?.position.x ?? 0
        expect(n2 - n1).toBeCloseTo(n3 - n2)
      }),
    )
  })

  test('CollapsedSelection hides members and Expand restores them', () => {
    story(
      update,
      given({ ...seedModel(), selectedNodeIds: ['n1', 'n2'] }),
      message(Message.CollapsedSelection()),
      model((m: Model) => {
        expect(m.collapsed).toHaveLength(1)
        expect(m.collapsed[0]?.nodeIds).toEqual(['n1', 'n2'])
        expect(Option.getOrNull(m.selectedCollapsedId)).toBe('c1')
      }),
      message(Message.ExpandedCollapsed({ collapsedId: 'c1' })),
      model((m: Model) => {
        expect(m.collapsed).toHaveLength(0)
      }),
    )
  })

  test('CompletedLoadGraph restores reroute names and collapsed groups', () => {
    const json = JSON.stringify({
      version: 1,
      nodes: [
        {
          id: 'n1',
          type: 'Float',
          position: { x: 0, y: 0 },
          params: { value: 1 },
        },
        {
          id: 'n4',
          type: 'FragmentOutput',
          position: { x: 400, y: 0 },
          params: {},
        },
        {
          id: 'n5',
          type: 'NamedRerouteDeclaration',
          position: { x: 200, y: 0 },
          params: {},
        },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'n5', port: 'out' },
          target: { nodeId: 'n4', port: 'color' },
        },
      ],
      outputNodeId: 'n4',
      rerouteNames: { n5: 'Base UV' },
      collapsed: [{ id: 'c1', name: 'Inputs', nodeIds: ['n1'] }],
    })
    story(
      update,
      given(emptyModel()),
      message(Message.CompletedLoadGraph({ json })),
      model((m: Model) => {
        expect(m.rerouteNames['n5']).toBe('Base UV')
        expect(m.collapsed).toHaveLength(1)
        expect(m.collapsed[0]?.name).toBe('Inputs')
        expect(m.nextCollapsed).toBe(2)
      }),
    )
  })

  test('dragging a wire from an output to an input connects the nodes', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(Message.ChangedNewNodeType({ nodeType: 'Multiply' })),
      message(Message.RequestedAddNode({ x: 400, y: 0 })),
      message(
        Message.StartedWireDrag({
          nodeId: 'n1',
          port: 'out',
          direction: 'out',
          screenX: 0,
          screenY: 0,
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
        }),
      ),
      message(Message.MovedPointer({ x: 120, y: 20 })),
      message(Message.DroppedWireOnPort({ nodeId: 'n2', port: 'a' })),
      model((m: Model) => {
        expect(m.edges).toHaveLength(1)
        expect(m.status).toContain('Connected n1.out to n2.a')
        expect(m.drag.mode).toBe('idle')
      }),
    )
  })

  test('dragging from an input to an output connects the nodes', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(Message.ChangedNewNodeType({ nodeType: 'Multiply' })),
      message(Message.RequestedAddNode({ x: 400, y: 0 })),
      message(
        Message.StartedWireDrag({
          nodeId: 'n2',
          port: 'a',
          direction: 'in',
          screenX: 0,
          screenY: 0,
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
        }),
      ),
      message(Message.MovedPointer({ x: -120, y: -20 })),
      message(Message.DroppedWireOnPort({ nodeId: 'n1', port: 'out' })),
      model((m: Model) => {
        expect(m.edges).toHaveLength(1)
        expect(m.status).toContain('Connected n1.out to n2.a')
      }),
    )
  })

  test('clicking a port then a target still connects through the wire state', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(Message.ChangedNewNodeType({ nodeType: 'Multiply' })),
      message(Message.RequestedAddNode({ x: 400, y: 0 })),
      message(
        Message.StartedWireDrag({
          nodeId: 'n1',
          port: 'out',
          direction: 'out',
          screenX: 0,
          screenY: 0,
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
        }),
      ),
      message(Message.DroppedWireOnPort({ nodeId: 'n1', port: 'out' })),
      model((m: Model) => {
        expect(m.pending.active).toBe(true)
        expect(m.drag.mode).toBe('idle')
      }),
      message(
        Message.StartedWireDrag({
          nodeId: 'n2',
          port: 'a',
          direction: 'in',
          screenX: 0,
          screenY: 0,
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
        }),
      ),
      model((m: Model) => {
        expect(m.edges).toHaveLength(1)
        expect(m.pending.active).toBe(false)
      }),
    )
  })

  test('dropping a wire on empty canvas offers a node that auto-connects', () => {
    story(
      update,
      given(emptyModel()),
      message(Message.RequestedAddNode({ x: 0, y: 0 })),
      message(
        Message.StartedWireDrag({
          nodeId: 'n1',
          port: 'out',
          direction: 'out',
          screenX: 0,
          screenY: 0,
          worldX: 0,
          worldY: 0,
          clientX: 0,
          clientY: 0,
        }),
      ),
      message(Message.MovedPointer({ x: 240, y: 160 })),
      message(Message.EndedDrag()),
      model((m: Model) => {
        expect(Option.isSome(m.contextMenu)).toBe(true)
        expect(m.pending.active).toBe(true)
        expect(m.pending.fromNodeId).toBe('n1')
      }),
      message(Message.SelectedContextMenuNode({ nodeType: 'Multiply' })),
      model((m: Model) => {
        expect(m.nodes).toHaveLength(2)
        expect(m.edges).toHaveLength(1)
        expect(m.edges[0]?.targetNodeId).toBe('n2')
        expect(m.edges[0]?.targetPort).toBe('a')
        expect(m.status).toContain('Connected n1.out to n2.a')
      }),
    )
  })
})

describe('texture and scene nodes', () => {
  test('Sample Texture 2D enum params commit from the inspector values', () => {
    story(
      update,
      given(seedModel()),
      message(Message.ChangedNewNodeType({ nodeType: 'SampleTexture2D' })),
      message(Message.RequestedAddNode({ x: 120, y: 120 })),
      message(
        Message.UpdatedParam({ nodeId: 'n5', key: 'Space', valueText: '1' }),
      ),
      message(
        Message.UpdatedParam({ nodeId: 'n5', key: 'Type', valueText: '1' }),
      ),
      Command.expectNone(),
      model((m: Model) => {
        const sample = m.nodes.find(n => n.id === 'n5')
        expect(sample?.params['Space']).toBe(1)
        expect(sample?.params['Type']).toBe(1)
        expect(m.logs[0]?.level).toBe('info')
        expect(m.logs[0]?.text).toContain('Set n5.Type to 1')
      }),
    )
  })
})
