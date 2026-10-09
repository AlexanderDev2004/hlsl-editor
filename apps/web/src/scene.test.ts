import { Option } from 'effect'
import {
  all,
  click,
  doubleClick,
  expect,
  expectAll,
  given,
  hover,
  pointerDown,
  pointerUp,
  role,
  scene,
  selector,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { seedModel, update, view } from './main'

describe('editor view', () => {
  test('header, panels, and seeded HLSL render', () => {
    scene(
      { update, view },
      given(seedModel()),
      expect(text('HLSL Editor')).toExist(),
      expect(role('button', { name: 'Add node' })).toExist(),
      expect(role('button', { name: 'Save' })).toExist(),
      expect(role('button', { name: 'Export' })).toExist(),
      expect(role('button', { name: 'Import' })).toExist(),
      expect(text('Generated HLSL')).toExist(),
      expect(text('Problems (0)')).toExist(),
    )
  })

  test('adding a node through the palette updates the canvas', () => {
    scene(
      { update, view },
      given(seedModel()),
      click(role('button', { name: 'Add node' })),
      expect(text('Added Float (n5).')).toExist(),
    )
  })

  test('node search filters and selects a matching node', () => {
    scene(
      { update, view },
      given(seedModel()),
      type(role('textbox', { name: 'Search nodes' }), 'mult'),
      expect(text('Multiply')).toExist(),
      click(text('Multiply')),
      expect(text('Selected n3.')).toExist(),
    )
  })

  test('zoom slider drives the viewport zoom', () => {
    scene(
      { update, view },
      given(seedModel()),
      type(role('slider', { name: 'Zoom' }), '150'),
      expect(text('150%')).toExist(),
    )
  })

  test('simulate loading renders the border variant on every node', () => {
    scene(
      { update, view },
      given(seedModel()),
      click(role('button', { name: 'Simulate loading' })),
      expectAll(all.selector('.node-status-border')).toHaveCount(4),
    )
  })

  test('overlay loading variant renders a spinner on every node', () => {
    scene(
      { update, view },
      given({
        ...seedModel(),
        simulateLoading: true,
        loadingVariant: 'overlay',
      }),
      expectAll(all.selector('.node-status-spinner')).toHaveCount(4),
    )
  })

  test('hovering an edge highlights its two nodes', () => {
    scene(
      { update, view },
      given(seedModel()),
      expectAll(all.selector('.graph-edge')).toHaveCount(3),
      hover(selector('.graph-edge')),
      expectAll(all.selector('.node-highlight')).toHaveCount(2),
    )
  })

  test('clicking an edge selects it for deletion', () => {
    scene(
      { update, view },
      given(seedModel()),
      click(selector('.graph-edge')),
      expect(text('Selected edge e1. Press Delete to remove it.')).toExist(),
    )
  })

  test('left-dragging the background draws a selection band', () => {
    scene(
      { update, view },
      given(seedModel()),
      pointerDown(selector('.graph-canvas'), { clientX: 0, clientY: 0 }),
      expect(selector('.marquee')).toExist(),
    )
  })

  test('middle-dragging the background pans instead of selecting', () => {
    scene(
      { update, view },
      given(seedModel()),
      pointerDown(selector('.graph-canvas'), { button: 1 }),
      expect(selector('.marquee')).toBeAbsent(),
    )
  })

  test('the minimap can be hidden and shown again', () => {
    scene(
      { update, view },
      given(seedModel()),
      expect(selector('.minimap')).toExist(),
      expect(selector('.minimap-viewport')).toExist(),
      click(role('button', { name: 'Hide minimap' })),
      expect(selector('.minimap')).toBeAbsent(),
      click(role('button', { name: 'Show minimap' })),
      expect(selector('.minimap')).toExist(),
    )
  })

  test('right-clicking the canvas opens a searchable add-node menu', () => {
    scene(
      { update, view },
      given(seedModel()),
      pointerDown(selector('.graph-canvas'), {
        button: 2,
        clientX: 300,
        clientY: 200,
      }),
      expect(selector('.context-menu')).toExist(),
      expect(role('button', { name: 'Add Multiply' })).toExist(),
      type(role('textbox', { name: 'Search nodes to add' }), 'comb'),
      expect(role('button', { name: 'Add Combine' })).toExist(),
      expect(role('button', { name: 'Add Multiply' })).toBeAbsent(),
      click(role('button', { name: 'Add Combine' })),
      expect(selector('.context-menu')).toBeAbsent(),
      expect(text('Added Combine (n5).')).toExist(),
    )
  })

  test('grouping a selected node draws a frame and opens the group inspector', () => {
    scene(
      { update, view },
      given(seedModel()),
      type(role('textbox', { name: 'Search nodes' }), 'mult'),
      click(text('Multiply')),
      click(role('button', { name: 'Group' })),
      expect(selector('.graph-group')).toExist(),
      expect(role('textbox', { name: 'Group name' })).toExist(),
      click(role('button', { name: 'Ungroup group' })),
      expect(selector('.graph-group')).toBeAbsent(),
    )
  })

  test('invalid graph shows an error state instead of code', () => {
    scene(
      { update, view },
      given({
        ...seedModel(),
        nodes: [],
        edges: [],
        outputNodeId: Option.none(),
      }),
      expect(text('Problems (1)')).toExist(),
      expect(text('Graph is invalid. Fix the problems below.')).toExist(),
    )
  })

  test('settings show commands, record state, and macOS display mode', () => {
    scene(
      { update, view },
      given({ ...seedModel(), shortcutPlatform: 'macos' }),
      click(role('button', { name: 'Settings' })),
      expect(text('Shortcut display')).toExist(),
      expect(text('⌘C')).toExist(),
      click(role('button', { name: 'Record shortcut for Copy selection' })),
      expect(text('Press keys…')).toExist(),
      click(role('button', { name: 'Cancel recording for Copy selection' })),
      click(role('button', { name: 'Close settings' })),
      expect(text('Shortcut display')).toBeAbsent(),
    )
  })

  test('the group custom color picker renders wheel, fields, and actions', () => {
    scene(
      { update, view },
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
      expect(text('Custom color')).toExist(),
      expect(role('textbox', { name: 'Color hex' })).toExist(),
      expect(role('spinbutton', { name: 'Color R' })).toExist(),
      expect(role('button', { name: 'Apply custom color' })).toExist(),
      click(role('button', { name: 'Cancel custom color' })),
      expect(text('Custom color')).toBeAbsent(),
    )
  })

  test('Play previews the evaluated color and closes', () => {
    scene(
      { update, view },
      given(seedModel()),
      click(role('button', { name: 'Play' })),
      expect(text('▶ Play preview')).toExist(),
      expect(selector('.play-checker')).toExist(),
      // Seed graph: Float(2) * Float(5) = 10, splatted to float4.
      expect(text('10.0000')).toExist(),
      click(role('button', { name: 'Close play preview' })),
      expect(selector('.play-checker')).toBeAbsent(),
    )
  })

  test('Play on a broken graph shows guidance instead of a preview', () => {
    scene(
      { update, view },
      given({
        ...seedModel(),
        nodes: [],
        edges: [],
        outputNodeId: Option.none(),
      }),
      click(role('button', { name: 'Play' })),
      expect(text('Cannot play: fix 1 problem first.')).toExist(),
      expect(selector('.play-checker')).toBeAbsent(),
    )
  })

  test('the log panel lists entries, clears, and hides', () => {
    scene(
      { update, view },
      given({
        ...seedModel(),
        logs: [
          {
            id: 2,
            level: 'error',
            text: 'Type mismatch: Expected float, Received float3.',
          },
          { id: 1, level: 'system', text: 'Session console ready.' },
        ],
        nextLogId: 3,
      }),
      expect(selector('.log-panel')).toExist(),
      expect(text('Type mismatch: Expected float, Received float3.')).toExist(),
      expect(text('Session console ready.')).toExist(),
      expect(text('1 error')).toExist(),
      click(role('button', { name: 'Clear log panel' })),
      expect(text('No entries yet. Connect nodes or edit the graph.')).toExist(),
      click(role('button', { name: 'Close log panel' })),
      expect(selector('.log-panel')).toBeAbsent(),
      click(role('button', { name: 'Toggle log panel' })),
      expect(selector('.log-panel')).toExist(),
    )
  })

  test('double-clicking a wire inserts a reroute and opens its inspector', () => {
    scene(
      { update, view },
      given(seedModel()),
      doubleClick(selector('.graph-edge')),
      expect(role('button', { name: 'Convert to Named Reroute' })).toExist(),
    )
  })

  test('collapsing a selection hides members behind a container', () => {
    scene(
      { update, view },
      given({ ...seedModel(), selectedNodeIds: ['n1', 'n2'] }),
      click(role('button', { name: 'Collapse' })),
      expect(selector('.collapsed-node')).toExist(),
      expect(role('textbox', { name: 'Collapsed name' })).toExist(),
      click(role('button', { name: 'Expand' })),
      expect(selector('.collapsed-node')).toBeAbsent(),
    )
  })

  test('pressing a port starts a live wire preview', () => {
    scene(
      { update, view },
      given({ ...seedModel(), edges: [] }),
      pointerDown(selector('.graph-port-out'), { clientX: 100, clientY: 140 }),
      expect(selector('.wire-preview')).toExist(),
    )
  })

  test('dragging a wire from a port to a port connects the nodes', () => {
    scene(
      { update, view },
      given({ ...seedModel(), edges: [] }),
      pointerDown(selector('.graph-port-out'), { clientX: 100, clientY: 140 }),
      pointerUp(selector('.graph-port-in')),
      expect(text('Connected n1.out to n3.a.')).toExist(),
    )
  })
})
