// Pure view: Model -> Document. All derived data (validation, HLSL)
// is computed here from the Model; the Model itself stays minimal.

import { Option } from 'effect'
import { type Document, type Html, type HtmlBuilder } from 'foldkit/html'

import { generate, validate } from '@hlsl-editor/shader-compiler'
import {
  NODE_REGISTRY,
  NODE_TYPES,
  isNodeType,
} from '@hlsl-editor/shader-nodes'

import { GROUP_COLORS, GROUP_HEADER, GROUP_PAD, groupBounds } from './groups'
import {
  BASE_H,
  BASE_W,
  HEADER_H,
  NODE_W,
  ZOOM_MAX,
  ZOOM_MIN,
  nodeHeight,
  portY,
} from './layout'
import { nodesInRect, worldRect } from './marquee'
import { Message } from './message'
import {
  MINIMAP_H,
  MINIMAP_PAD,
  MINIMAP_W,
  minimapTransform,
  sceneBounds,
} from './minimap'
import { type EditorNode, type Group, type Model, toDomainGraph } from './model'
import {
  LOADING_VARIANTS,
  type LoadingVariant,
  type NodeStatus,
  deriveNodeStatuses,
} from './node-status'
import { defaultOnSearch, nodeLabel } from './search'
import {
  SHORTCUT_CATEGORIES,
  SHORTCUT_COMMANDS,
  SHORTCUT_PLATFORMS,
  type ShortcutCommand,
  bindingFor,
  bindingsEqual,
  formatShortcut,
} from './shortcuts'

function portPosition(
  node: EditorNode,
  portName: string,
  direction: 'in' | 'out',
): { x: number; y: number } | null {
  if (!isNodeType(node.type)) {
    return null
  }
  const def = NODE_REGISTRY[node.type]
  const list = direction === 'in' ? def.inputs : def.outputs
  const index = list.findIndex(p => p.name === portName)
  if (index < 0) {
    return null
  }
  return {
    x: node.position.x + (direction === 'in' ? 0 : NODE_W),
    y: node.position.y + portY(node.type, index),
  }
}

// Converts a client-space pointer position into world coordinates using the
// SVG's own screen transform, which accounts for the viewBox, zoom, pan, and
// the default `xMidYMid meet` fit. Falls back to the zoom approximation when
// the transform is unavailable (for example a detached test element), so the
// math stays usable without a live canvas.
function pointerToWorld(
  model: Model,
  target: EventTarget | null,
  clientX: number,
  clientY: number,
): { x: number; y: number; worldPerPixel: number } {
  const svg = target instanceof SVGElement ? target.ownerSVGElement : null
  if (svg !== null && typeof svg.getScreenCTM === 'function') {
    const ctm = svg.getScreenCTM()
    if (ctm !== null) {
      const inverse = ctm.inverse()
      const x = inverse.a * clientX + inverse.c * clientY + inverse.e
      const y = inverse.b * clientX + inverse.d * clientY + inverse.f
      const worldPerPixel = Math.hypot(inverse.a, inverse.b)
      if (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Number.isFinite(worldPerPixel) &&
        worldPerPixel > 0
      ) {
        return { x, y, worldPerPixel }
      }
    }
  }
  const zoom = model.viewport.zoom
  return {
    x: model.viewport.x + clientX / zoom,
    y: model.viewport.y + clientY / zoom,
    worldPerPixel: 1 / zoom,
  }
}

const TYPE_COLORS: Record<string, string> = {
  float: '#58a6ff',
  float2: '#3fb950',
  float3: '#d29922',
  float4: '#f778ba',
}

function typeColor(type: string): string {
  return TYPE_COLORS[type] ?? '#8b949e'
}

const STATUS_COLORS: Record<NodeStatus, string> = {
  initial: '#30363d',
  loading: '#58a6ff',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
}

function statusHeaderFill(status: NodeStatus): string {
  if (status === 'error') {
    return '#5a1d1d'
  }
  if (status === 'warning') {
    return '#4a3a12'
  }
  return '#21262d'
}

// A node wrapper that shows one of five states. The node body border takes
// the status colour; the loading state adds chrome on top, either a
// travelling dashed border (`border`) or a dimming overlay with a spinner
// (`overlay`).
function nodeStatusIndicator(
  h: HtmlBuilder<Message>,
  status: NodeStatus,
  variant: LoadingVariant,
  width: number,
  height: number,
): Html {
  if (status !== 'loading') {
    return h.empty
  }
  const color = STATUS_COLORS.loading
  if (variant === 'overlay') {
    const r = 16
    return h.g(
      [h.Class('node-status-indicator')],
      [
        h.rect([
          h.X('0'),
          h.Y('0'),
          h.Width(String(width)),
          h.Height(String(height)),
          h.Rx('8'),
          h.Fill('#0d1117'),
          h.FillOpacity('0.7'),
        ]),
        h.circle([
          h.Cx(String(width / 2)),
          h.Cy(String(height / 2)),
          h.R(String(r)),
          h.Fill('none'),
          h.Stroke(color),
          h.StrokeWidth('3'),
          h.StrokeLinecap('round'),
          h.StrokeDasharray(`${r} ${r * 3}`),
          h.Class('node-status-spinner'),
        ]),
      ],
    )
  }
  return h.rect([
    h.X('0'),
    h.Y('0'),
    h.Width(String(width)),
    h.Height(String(height)),
    h.Rx('8'),
    h.Fill('none'),
    h.Stroke(color),
    h.StrokeWidth('2.5'),
    h.StrokeDasharray('18 14'),
    h.Class('node-status-border'),
  ])
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(40, Math.abs(x2 - x1) / 2)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

const HIGHLIGHT_COLOR = '#22d3ee'

// An edge lights up when hovered or selected. The nodes it connects light
// up with it, so the user can read where a wire goes at a glance.
function activeEdgeIds(model: Model): ReadonlySet<string> {
  const ids = new Set<string>()
  const hovered = Option.getOrNull(model.hoveredEdgeId)
  if (hovered !== null) {
    ids.add(hovered)
  }
  const selected = Option.getOrNull(model.selectedEdgeId)
  if (selected !== null) {
    ids.add(selected)
  }
  return ids
}

function highlightedNodeIds(model: Model): ReadonlySet<string> {
  const active = activeEdgeIds(model)
  return model.edges.reduce<Set<string>>((acc, edge) => {
    if (!active.has(edge.id)) {
      return acc
    }
    const next = new Set(acc)
    next.add(edge.sourceNodeId)
    next.add(edge.targetNodeId)
    return next
  }, new Set())
}

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => {
  const graph = toDomainGraph(model)
  const errors = validate(graph)
  const result = generate(graph)
  const errorNodes = new Set(
    errors.flatMap(e => (e.nodeId !== undefined ? [e.nodeId] : [])),
  )
  const errorPorts = new Set(
    errors.flatMap(e => (e.portId !== undefined ? [e.portId] : [])),
  )
  const nodeStatuses = deriveNodeStatuses(model, errorNodes)

  return {
    title: `HLSL Editor — ${model.nodes.length} nodes`,
    body: h.div(
      [
        h.Class(
          'h-screen flex flex-col bg-neutral-950 text-neutral-200 text-sm',
        ),
      ],
      [
        headerView(model, h),
        h.div(
          [h.Class('flex-1 flex min-h-0')],
          [
            canvasView(model, h, errorPorts, nodeStatuses),
            h.div(
              [
                h.Class(
                  'w-[380px] shrink-0 border-l border-neutral-800 flex flex-col min-h-0 bg-neutral-900',
                ),
              ],
              [
                inspectorView(model, h),
                hlslView(model, h, result),
                problemsView(model, h, errors),
              ],
            ),
          ],
        ),
        statusView(model, h),
        settingsView(model, h),
      ],
    ),
  }
}

function headerView(
  model: Model,
  h: HtmlBuilder<Message>,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [
      h.Class(
        'flex items-center gap-2 px-3 py-2 border-b border-neutral-800 bg-neutral-900',
      ),
    ],
    [
      h.span([h.Class('font-semibold text-neutral-100 mr-2')], ['HLSL Editor']),
      searchView(model, h),
      h.select(
        [
          h.OnChange(value => Message.ChangedNewNodeType({ nodeType: value })),
          h.Value(model.newNodeType),
          h.Class('bg-neutral-800 border border-neutral-700 rounded px-2 py-1'),
          h.AriaLabel('Node type to add'),
        ],
        NODE_TYPES.map(t =>
          h.option([h.Value(t)], [isNodeType(t) ? NODE_REGISTRY[t].label : t]),
        ),
      ),
      h.button(
        [
          h.OnClick(
            Message.RequestedAddNode({
              x: Math.round(
                model.viewport.x +
                  BASE_W / model.viewport.zoom / 2 -
                  NODE_W / 2 +
                  ((model.nextNode * 37) % 160),
              ),
              y: Math.round(
                model.viewport.y +
                  BASE_H / model.viewport.zoom / 2 -
                  60 +
                  ((model.nextNode * 53) % 160),
              ),
            }),
          ),
          h.Class('bg-sky-700 hover:bg-sky-600 text-white rounded px-3 py-1'),
        ],
        ['Add node'],
      ),
      h.button(
        [
          h.OnClick(Message.RequestedNew()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
        ],
        ['New'],
      ),
      h.button(
        [
          h.OnClick(Message.RequestedSave()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
        ],
        ['Save'],
      ),
      h.button(
        [
          h.OnClick(Message.RequestedExport()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
        ],
        ['Export'],
      ),
      h.button(
        [
          h.OnClick(Message.RequestedImport()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
        ],
        ['Import'],
      ),
      h.button(
        [
          h.OnClick(Message.RequestedDeleteSelection()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
        ],
        ['Delete'],
      ),
      h.button(
        [
          h.OnClick(Message.PressedGroupSelection()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
          h.Title('Group selected nodes (Ctrl/Cmd+G)'),
        ],
        ['Group'],
      ),
      h.button(
        [
          h.OnClick(Message.PressedUngroupSelection()),
          h.Class(
            'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
          h.Title('Ungroup selected group (Ctrl/Cmd+Shift+G)'),
        ],
        ['Ungroup'],
      ),
      h.button(
        [
          h.OnClick(Message.OpenedSettings()),
          h.Class(
            'ml-auto bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
          ),
          h.AriaLabel('Settings'),
        ],
        ['Settings'],
      ),
      h.span(
        [h.Class('text-neutral-500')],
        [`${model.nodes.length} nodes · ${model.edges.length} edges`],
      ),
    ],
  )
}

function settingsView(model: Model, h: HtmlBuilder<Message>): Html {
  if (!model.settingsOpen) {
    return h.empty
  }
  return h.div(
    [h.Class('fixed inset-0 z-40 flex items-center justify-center')],
    [
      h.div([
        h.Class('absolute inset-0 bg-black/60'),
        h.OnClick(Message.ClosedSettings()),
      ]),
      h.div(
        [
          h.Class(
            'relative w-[640px] max-h-[80vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl',
          ),
        ],
        [
          h.div(
            [
              h.Class(
                'flex items-center px-3 py-2 border-b border-neutral-800',
              ),
            ],
            [
              h.span([h.Class('font-semibold text-neutral-100')], ['Settings']),
              h.button(
                [
                  h.OnClick(Message.ClosedSettings()),
                  h.Class(
                    'ml-auto text-neutral-400 hover:text-neutral-100 px-2 leading-none',
                  ),
                  h.AriaLabel('Close settings'),
                ],
                ['×'],
              ),
            ],
          ),
          shortcutPlatformToggle(model, h),
          h.div(
            [h.Class('flex-1 overflow-auto min-h-0')],
            SHORTCUT_CATEGORIES.flatMap(category => [
              h.div(
                [
                  h.Class(
                    'px-3 pt-3 pb-1 text-[10px] uppercase tracking-wide text-neutral-500',
                  ),
                ],
                [category],
              ),
              ...SHORTCUT_COMMANDS.filter(
                command => command.category === category,
              ).map(command => shortcutRow(model, h, command)),
            ]),
          ),
          h.div(
            [
              h.Class(
                'flex items-center gap-3 px-3 py-2 border-t border-neutral-800',
              ),
            ],
            [
              h.span(
                [h.Class('text-xs text-neutral-500')],
                ['Click Record, then press the keys you want. Esc cancels.'],
              ),
              h.button(
                [
                  h.OnClick(Message.ResetAllShortcuts()),
                  h.Class(
                    'ml-auto bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
                  ),
                  h.AriaLabel('Reset all shortcuts'),
                ],
                ['Reset all'],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

function shortcutPlatformToggle(model: Model, h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class('flex items-center gap-2 px-3 py-2 border-b border-neutral-800')],
    [
      h.span([h.Class('text-neutral-400')], ['Shortcut display']),
      ...SHORTCUT_PLATFORMS.map(platform =>
        h.button(
          [
            h.OnClick(Message.ChangedShortcutPlatform({ platform })),
            h.Class(
              platform === model.shortcutPlatform
                ? 'bg-sky-700 text-white rounded px-2 py-0.5'
                : 'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-0.5',
            ),
            h.AriaPressed(
              platform === model.shortcutPlatform ? 'true' : 'false',
            ),
            h.AriaLabel(
              `${platform === 'macos' ? 'macOS' : 'Windows'} shortcut display`,
            ),
          ],
          [platform === 'macos' ? 'macOS' : 'Windows'],
        ),
      ),
    ],
  )
}

function shortcutRow(
  model: Model,
  h: HtmlBuilder<Message>,
  command: ShortcutCommand,
): Html {
  const recording = Option.getOrNull(model.recordingAction) === command.id
  const binding = bindingFor(model.keymap, command)
  const changed = !bindingsEqual(binding, command.defaultBinding)
  return h.div(
    [h.Class('flex items-center gap-2 px-3 py-2 border-b border-neutral-800')],
    [
      h.span([h.Class('flex-1 text-neutral-200')], [command.label]),
      recording
        ? h.span(
            [h.Class('font-mono px-2 py-0.5 rounded text-amber-300')],
            ['Press keys…'],
          )
        : h.span(
            [
              h.Class(
                'font-mono px-2 py-0.5 bg-neutral-800 rounded text-neutral-300 min-w-24 text-center',
              ),
            ],
            [formatShortcut(binding, model.shortcutPlatform)],
          ),
      recording
        ? h.button(
            [
              h.OnClick(Message.CancelledShortcutRecording()),
              h.Class(
                'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-0.5',
              ),
              h.AriaLabel(`Cancel recording for ${command.label}`),
            ],
            ['Cancel'],
          )
        : h.button(
            [
              h.OnClick(
                Message.StartedShortcutRecording({ actionId: command.id }),
              ),
              h.Class(
                'bg-sky-700 hover:bg-sky-600 text-white rounded px-2 py-0.5',
              ),
              h.AriaLabel(`Record shortcut for ${command.label}`),
            ],
            ['Record'],
          ),
      changed
        ? h.button(
            [
              h.OnClick(Message.ResetShortcut({ actionId: command.id })),
              h.Class(
                'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-0.5',
              ),
              h.AriaLabel(`Reset shortcut for ${command.label}`),
            ],
            ['Reset'],
          )
        : h.empty,
    ],
  )
}

function searchView(
  model: Model,
  h: HtmlBuilder<Message>,
): ReturnType<HtmlBuilder<Message>['div']> {
  const query = model.searchText.trim()
  const results = defaultOnSearch(model.nodes, model.searchText)
  return h.div(
    [h.Class('relative')],
    [
      h.input([
        h.Type('text'),
        h.Value(model.searchText),
        h.Placeholder('Search nodes…'),
        h.OnInput(text => Message.ChangedSearch({ text })),
        h.Class(
          'w-56 bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-100 placeholder:text-neutral-500',
        ),
        h.AriaLabel('Search nodes'),
      ]),
      query === ''
        ? h.empty
        : h.div(
            [
              h.Class(
                'absolute left-0 top-full mt-1 w-72 max-h-64 overflow-auto bg-neutral-900 border border-neutral-700 rounded shadow-lg z-20 flex flex-col',
              ),
            ],
            results.length === 0
              ? [
                  h.div(
                    [h.Class('px-2 py-1 text-neutral-500')],
                    ['No matching nodes.'],
                  ),
                ]
              : results.map(node =>
                  h.keyed('button')(
                    node.id,
                    [
                      h.OnClick(
                        Message.SelectedSearchResult({ nodeId: node.id }),
                      ),
                      h.Class(
                        'flex items-center gap-2 px-2 py-1 text-left hover:bg-neutral-800',
                      ),
                    ],
                    [
                      h.span([h.Class('text-neutral-200')], [nodeLabel(node)]),
                      h.span(
                        [h.Class('ml-auto text-xs text-neutral-500')],
                        [node.id],
                      ),
                    ],
                  ),
                ),
          ),
    ],
  )
}

function canvasView(
  model: Model,
  h: HtmlBuilder<Message>,
  errorPorts: Set<string>,
  nodeStatuses: ReadonlyMap<string, NodeStatus>,
): ReturnType<HtmlBuilder<Message>['div']> {
  const dragging = model.drag.mode !== 'idle'
  const activeEdges = activeEdgeIds(model)
  const marquee =
    model.drag.mode === 'marquee'
      ? worldRect(
          model.drag.startWorldX,
          model.drag.startWorldY,
          model.drag.currentWorldX,
          model.drag.currentWorldY,
        )
      : null
  const highlightedNodes = new Set([
    ...highlightedNodeIds(model),
    ...(marquee !== null ? nodesInRect(model, marquee) : []),
  ])
  const w = BASE_W / model.viewport.zoom
  const ww = BASE_H / model.viewport.zoom
  return h.div(
    [h.Class('flex-1 relative min-w-0 bg-neutral-950')],
    [
      h.div(
        [
          h.Class(
            'absolute top-2 left-2 flex items-center gap-2 z-10 bg-neutral-900/85 border border-neutral-800 rounded px-2 py-1',
          ),
        ],
        [
          h.input([
            h.Type('range'),
            h.Min(String(Math.round(ZOOM_MIN * 100))),
            h.Max(String(Math.round(ZOOM_MAX * 100))),
            h.Step('5'),
            h.Value(String(Math.round(model.viewport.zoom * 100))),
            h.OnInput(valueText => Message.ChangedZoom({ valueText })),
            h.Class('w-40 accent-sky-500'),
            h.AriaLabel('Zoom'),
          ]),
          h.span(
            [h.Class('w-10 text-right text-neutral-400')],
            [`${Math.round(model.viewport.zoom * 100)}%`],
          ),
          h.button(
            [
              h.OnClick(Message.ResetView()),
              h.Class(
                'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-1',
              ),
            ],
            ['Reset'],
          ),
          h.span([h.Class('w-px h-5 bg-neutral-700')]),
          h.button(
            [
              h.OnClick(Message.ToggledSimulateLoading()),
              h.Class(
                model.simulateLoading
                  ? 'bg-sky-700 hover:bg-sky-600 text-white rounded px-2 py-1'
                  : 'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-1',
              ),
            ],
            ['Simulate loading'],
          ),
          h.select(
            [
              h.OnChange(variant => Message.ChangedLoadingVariant({ variant })),
              h.Value(model.loadingVariant),
              h.Class(
                'bg-neutral-800 border border-neutral-700 rounded px-2 py-1',
              ),
              h.AriaLabel('Loading variant'),
            ],
            LOADING_VARIANTS.map(variant =>
              h.option(
                [h.Value(variant)],
                [variant === 'border' ? 'Border' : 'Overlay'],
              ),
            ),
          ),
        ],
      ),
      h.svg(
        [
          h.Width('100%'),
          h.Height('100%'),
          h.ViewBox(`${model.viewport.x} ${model.viewport.y} ${w} ${ww}`),
          h.OnPointerMove((_sx, _sy) =>
            dragging
              ? Option.some(Message.MovedPointer({ x: _sx, y: _sy }))
              : Option.none(),
          ),
          h.OnPointerUp(() =>
            dragging ? Option.some(Message.EndedDrag()) : Option.none(),
          ),
          h.OnContextMenu(Message.PreventedNativeContextMenu()),
        ],
        [
          h.rect([
            h.X(String(model.viewport.x - 2000)),
            h.Y(String(model.viewport.y - 2000)),
            h.Width(String(w + 4000)),
            h.Height(String(ww + 4000)),
            h.Fill('#0a0a0b'),
            h.Class('graph-canvas'),
            h.OnPointerDown(
              (
                _pointerType,
                button,
                screenX,
                screenY,
                _timeStamp,
                clientX,
                clientY,
                _pointerId,
                target,
              ) => {
                if (button === 1) {
                  return Option.some(
                    Message.StartedPan({ x: screenX, y: screenY }),
                  )
                }
                if (button === 2) {
                  const start = pointerToWorld(model, target, clientX, clientY)
                  return Option.some(
                    Message.OpenedContextMenu({
                      worldX: start.x,
                      worldY: start.y,
                      clientX,
                      clientY,
                    }),
                  )
                }
                if (button !== 0) {
                  return Option.none()
                }
                const start = pointerToWorld(model, target, clientX, clientY)
                return Option.some(
                  Message.StartedMarquee({
                    worldX: start.x,
                    worldY: start.y,
                    worldPerPixel: start.worldPerPixel,
                    screenX,
                    screenY,
                  }),
                )
              },
            ),
          ]),
          marquee !== null
            ? h.rect([
                h.X(String(marquee.minX)),
                h.Y(String(marquee.minY)),
                h.Width(String(marquee.maxX - marquee.minX)),
                h.Height(String(marquee.maxY - marquee.minY)),
                h.Fill('rgba(34,211,238,0.12)'),
                h.Stroke(HIGHLIGHT_COLOR),
                h.StrokeWidth('1'),
                h.StrokeDasharray('6 4'),
                h.PointerEvents('none'),
                h.Class('marquee'),
              ])
            : h.empty,
          ...model.groups.flatMap(group => {
            const rect = groupBounds(group, model.nodes)
            if (rect === null) {
              return []
            }
            const selected =
              Option.getOrNull(model.selectedGroupId) === group.id
            return [
              h.g(
                [h.Class('graph-group')],
                [
                  h.rect([
                    h.X(String(rect.x)),
                    h.Y(String(rect.y)),
                    h.Width(String(rect.width)),
                    h.Height(String(rect.height)),
                    h.Rx('10'),
                    h.Fill(group.color),
                    h.FillOpacity('0.08'),
                    h.Stroke(group.color),
                    h.StrokeWidth(selected ? '2.5' : '1.5'),
                    h.Cursor('pointer'),
                    h.OnClick(Message.SelectedGroup({ groupId: group.id })),
                  ]),
                  h.rect([
                    h.X(String(rect.x)),
                    h.Y(String(rect.y)),
                    h.Width(String(rect.width)),
                    h.Height(String(GROUP_HEADER)),
                    h.Rx('10'),
                    h.Fill(group.color),
                    h.FillOpacity('0.22'),
                    h.PointerEvents('none'),
                  ]),
                  h.text(
                    [
                      h.X(String(rect.x + GROUP_PAD / 2)),
                      h.Y(String(rect.y + 15)),
                      h.Fill('#f0f6fc'),
                      h.FontSize('12'),
                      h.FontWeight('600'),
                      h.PointerEvents('none'),
                    ],
                    [group.name],
                  ),
                  h.rect([
                    h.X(String(rect.x)),
                    h.Y(String(rect.y)),
                    h.Width(String(rect.width)),
                    h.Height(String(GROUP_HEADER)),
                    h.Fill('transparent'),
                    h.Cursor('move'),
                    h.Class('graph-group-header'),
                    h.OnClick(Message.SelectedGroup({ groupId: group.id })),
                    h.OnPointerDown((_t, button, sx, sy) =>
                      button === 0
                        ? Option.some(
                            Message.StartedGroupDrag({
                              groupId: group.id,
                              x: sx,
                              y: sy,
                            }),
                          )
                        : Option.none(),
                    ),
                  ]),
                ],
              ),
            ]
          }),
          ...model.edges.flatMap(edge => {
            const from = model.nodes.find(n => n.id === edge.sourceNodeId)
            const to = model.nodes.find(n => n.id === edge.targetNodeId)
            if (from === undefined || to === undefined) {
              return []
            }
            const p1 = portPosition(from, edge.sourcePort, 'out')
            const p2 = portPosition(to, edge.targetPort, 'in')
            if (p1 === null || p2 === null) {
              return []
            }
            const d = edgePath(p1.x, p1.y, p2.x, p2.y)
            const invalid = errorPorts.has(
              `${edge.targetNodeId}:${edge.targetPort}`,
            )
            const active = activeEdges.has(edge.id)
            const stroke = invalid
              ? '#f85149'
              : active
                ? HIGHLIGHT_COLOR
                : '#3fb950'
            return [
              // A wide, invisible stroke gives the thin wire a usable hit
              // area for hover and click.
              h.path([
                h.D(d),
                h.Fill('none'),
                h.Stroke('transparent'),
                h.StrokeWidth('16'),
                h.PointerEvents('stroke'),
                h.Cursor('pointer'),
                h.Class('graph-edge'),
                h.OnClick(Message.SelectedEdge({ edgeId: edge.id })),
                h.OnMouseEnter(Message.HoveredEdge({ edgeId: edge.id })),
                h.OnMouseLeave(Message.UnhoveredEdge({ edgeId: edge.id })),
              ]),
              h.path([
                h.D(d),
                h.Fill('none'),
                h.Stroke(stroke),
                h.StrokeWidth(active ? '3.5' : invalid ? '2.5' : '2'),
                h.PointerEvents('none'),
              ]),
            ]
          }),
          ...model.nodes.map(node =>
            nodeView(
              model,
              h,
              node,
              nodeStatuses.get(node.id) ?? 'initial',
              highlightedNodes.has(node.id),
            ),
          ),
        ],
      ),
      minimapView(model, h),
      contextMenuView(model, h),
    ],
  )
}

function minimapView(model: Model, h: HtmlBuilder<Message>): Html {
  if (!model.minimapVisible) {
    return h.button(
      [
        h.OnClick(Message.ToggledMinimap()),
        h.Class(
          'absolute bottom-3 right-3 z-10 bg-neutral-900/90 hover:bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-300',
        ),
        h.AriaLabel('Show minimap'),
        h.Title('Show minimap'),
      ],
      ['▸'],
    )
  }
  const viewW = BASE_W / model.viewport.zoom
  const viewH = BASE_H / model.viewport.zoom
  const bounds = sceneBounds(model.nodes, {
    x: model.viewport.x,
    y: model.viewport.y,
    width: viewW,
    height: viewH,
  })
  const t = minimapTransform(bounds, MINIMAP_W, MINIMAP_H, MINIMAP_PAD)
  const mx = (x: number): string => String(x * t.scale + t.offsetX)
  const my = (y: number): string => String(y * t.scale + t.offsetY)
  return h.div(
    [
      h.Class(
        'minimap absolute bottom-3 right-3 z-10 bg-neutral-900/90 border border-neutral-700 rounded shadow-lg p-1',
      ),
    ],
    [
      h.div(
        [h.Class('flex items-center justify-between px-1 pb-1')],
        [
          h.span(
            [h.Class('text-[10px] uppercase tracking-wide text-neutral-500')],
            ['Minimap'],
          ),
          h.button(
            [
              h.OnClick(Message.ToggledMinimap()),
              h.Class(
                'text-neutral-400 hover:text-neutral-100 px-1 leading-none',
              ),
              h.AriaLabel('Hide minimap'),
              h.Title('Hide minimap'),
            ],
            ['×'],
          ),
        ],
      ),
      h.svg(
        [
          h.Width(String(MINIMAP_W)),
          h.Height(String(MINIMAP_H)),
          h.ViewBox(`0 0 ${MINIMAP_W} ${MINIMAP_H}`),
          h.Class('block rounded bg-neutral-950'),
        ],
        [
          ...model.edges.flatMap(edge => {
            const from = model.nodes.find(n => n.id === edge.sourceNodeId)
            const to = model.nodes.find(n => n.id === edge.targetNodeId)
            if (from === undefined || to === undefined) {
              return []
            }
            return [
              h.line([
                h.X1(mx(from.position.x + NODE_W)),
                h.Y1(my(from.position.y + nodeHeight(from.type) / 2)),
                h.X2(mx(to.position.x)),
                h.Y2(my(to.position.y + nodeHeight(to.type) / 2)),
                h.Stroke('#3fb950'),
                h.StrokeWidth('1'),
              ]),
            ]
          }),
          ...model.nodes.map(node =>
            h.rect([
              h.X(mx(node.position.x)),
              h.Y(my(node.position.y)),
              h.Width(String(Math.max(NODE_W * t.scale, 3))),
              h.Height(String(Math.max(nodeHeight(node.type) * t.scale, 2))),
              h.Rx('1'),
              h.Fill('#30363d'),
              h.Stroke('#58a6ff'),
              h.StrokeWidth('0.5'),
            ]),
          ),
          h.rect([
            h.X(mx(model.viewport.x)),
            h.Y(my(model.viewport.y)),
            h.Width(String(Math.max(viewW * t.scale, 4))),
            h.Height(String(Math.max(viewH * t.scale, 4))),
            h.Fill('rgba(34,211,238,0.10)'),
            h.Stroke(HIGHLIGHT_COLOR),
            h.StrokeWidth('1'),
            h.Class('minimap-viewport'),
          ]),
        ],
      ),
    ],
  )
}

function contextMenuView(model: Model, h: HtmlBuilder<Message>): Html {
  const menu = Option.getOrNull(model.contextMenu)
  if (menu === null) {
    return h.empty
  }
  const query = menu.search.trim().toLowerCase()
  const types = NODE_TYPES.filter(type => {
    if (query === '') {
      return true
    }
    const def = NODE_REGISTRY[type]
    return (
      def.label.toLowerCase().includes(query) ||
      type.toLowerCase().includes(query)
    )
  })
  return h.div(
    [
      h.Class(
        'context-menu fixed z-30 w-56 max-h-80 overflow-auto bg-neutral-900 border border-neutral-700 rounded shadow-xl flex flex-col',
      ),
      h.Style({ left: `${menu.clientX}px`, top: `${menu.clientY}px` }),
    ],
    [
      h.input([
        h.Type('text'),
        h.Value(menu.search),
        h.Placeholder('Search nodes…'),
        h.OnInput(text => Message.ChangedContextMenuSearch({ text })),
        h.Autofocus(true),
        h.Class(
          'bg-neutral-800 border-b border-neutral-700 px-2 py-1 text-neutral-100 placeholder:text-neutral-500',
        ),
        h.AriaLabel('Search nodes to add'),
      ]),
      types.length === 0
        ? h.div([h.Class('px-2 py-1 text-neutral-500')], ['No matching nodes.'])
        : h.div(
            [h.Class('flex flex-col')],
            types.map(type =>
              h.button(
                [
                  h.OnClick(
                    Message.SelectedContextMenuNode({ nodeType: type }),
                  ),
                  h.Class(
                    'context-menu-item flex items-center gap-2 px-2 py-1 text-left hover:bg-sky-800',
                  ),
                  h.AriaLabel(`Add ${NODE_REGISTRY[type].label}`),
                ],
                [
                  h.span(
                    [h.Class('text-neutral-200')],
                    [NODE_REGISTRY[type].label],
                  ),
                  h.span(
                    [h.Class('ml-auto text-xs text-neutral-500')],
                    [NODE_REGISTRY[type].category],
                  ),
                ],
              ),
            ),
          ),
    ],
  )
}

function nodeView(
  model: Model,
  h: HtmlBuilder<Message>,
  node: EditorNode,
  status: NodeStatus,
  highlighted: boolean,
): ReturnType<HtmlBuilder<Message>['g']> {
  const selected = model.selectedNodeIds.includes(node.id)
  const height = nodeHeight(node.type)
  const label = isNodeType(node.type)
    ? NODE_REGISTRY[node.type].label
    : node.type
  const inputs = isNodeType(node.type) ? NODE_REGISTRY[node.type].inputs : []
  const outputs = isNodeType(node.type) ? NODE_REGISTRY[node.type].outputs : []
  const accent = STATUS_COLORS[status]
  const emphasised = selected || status === 'error' || status === 'warning'
  return h.g(
    [h.Transform(`translate(${node.position.x},${node.position.y})`)],
    [
      h.rect([
        h.X('0'),
        h.Y('0'),
        h.Width(String(NODE_W)),
        h.Height(String(height)),
        h.Rx('8'),
        h.Fill('#161b22'),
        h.Stroke(accent),
        h.StrokeWidth(emphasised ? '2' : '1'),
        h.OnClick(Message.SelectedNode({ nodeId: node.id })),
      ]),
      selected
        ? h.rect([
            h.X('-3'),
            h.Y('-3'),
            h.Width(String(NODE_W + 6)),
            h.Height(String(height + 6)),
            h.Rx('11'),
            h.Fill('none'),
            h.Stroke('#58a6ff'),
            h.StrokeWidth('2'),
          ])
        : highlighted
          ? h.rect([
              h.X('-3'),
              h.Y('-3'),
              h.Width(String(NODE_W + 6)),
              h.Height(String(height + 6)),
              h.Rx('11'),
              h.Fill('none'),
              h.Stroke(HIGHLIGHT_COLOR),
              h.StrokeWidth('2'),
              h.StrokeDasharray('6 4'),
              h.Class('node-highlight'),
            ])
          : h.empty,
      h.rect([
        h.X('0'),
        h.Y('0'),
        h.Width(String(NODE_W)),
        h.Height(String(HEADER_H)),
        h.Rx('8'),
        h.Fill(statusHeaderFill(status)),
        h.Cursor('grab'),
        h.OnPointerDown((_t, button, sx, sy) =>
          button === 0
            ? Option.some(
                Message.StartedNodeDrag({ nodeId: node.id, x: sx, y: sy }),
              )
            : Option.none(),
        ),
      ]),
      h.text(
        [h.X('10'), h.Y('20'), h.Fill('#f0f6fc'), h.FontSize('13')],
        [`${label} · ${node.id}`],
      ),
      ...inputs.flatMap((port, i) => {
        const y = portY(node.type, i)
        const armed = model.pending.active
        return [
          h.circle([
            h.Cx('0'),
            h.Cy(String(y)),
            h.R(armed ? '8' : '6'),
            h.Fill(typeColor(port.valueType)),
            h.Stroke('#0d1117'),
            h.StrokeWidth('2'),
            h.Cursor('pointer'),
            h.OnClick(
              Message.ClickedPort({ nodeId: node.id, port: port.name }),
            ),
          ]),
          h.text(
            [
              h.X('14'),
              h.Y(String(y + 4)),
              h.Fill('#8b949e'),
              h.FontSize('12'),
            ],
            [port.name],
          ),
        ]
      }),
      ...outputs.flatMap((port, i) => {
        const y = portY(node.type, i)
        const isArmed =
          model.pending.active &&
          model.pending.fromNodeId === node.id &&
          model.pending.fromPort === port.name
        return [
          h.text(
            [
              h.X(String(NODE_W - 14)),
              h.Y(String(y + 4)),
              h.Fill('#8b949e'),
              h.FontSize('12'),
              h.TextAnchor('end'),
            ],
            [port.name],
          ),
          h.circle([
            h.Cx(String(NODE_W)),
            h.Cy(String(y)),
            h.R(isArmed ? '9' : '6'),
            h.Fill(typeColor(port.valueType)),
            h.Stroke(isArmed ? '#ffffff' : '#0d1117'),
            h.StrokeWidth('2'),
            h.Cursor('pointer'),
            h.OnClick(
              Message.ClickedPort({ nodeId: node.id, port: port.name }),
            ),
          ]),
        ]
      }),
      nodeStatusIndicator(h, status, model.loadingVariant, NODE_W, height),
    ],
  )
}

function inspectorView(
  model: Model,
  h: HtmlBuilder<Message>,
): ReturnType<HtmlBuilder<Message>['div']> {
  const selectedGroup = model.groups.find(
    group => group.id === Option.getOrNull(model.selectedGroupId),
  )
  if (selectedGroup !== undefined) {
    return groupInspector(h, selectedGroup)
  }
  const selected = model.nodes.find(n => n.id === model.selectedNodeIds[0])
  return h.div(
    [h.Class('border-b border-neutral-800 p-3 max-h-64 overflow-auto')],
    [
      h.div([h.Class('font-semibold text-neutral-100 mb-2')], ['Inspector']),
      selected === undefined
        ? h.div(
            [h.Class('text-neutral-500')],
            ['Select a node to edit its values.'],
          )
        : inspectorFor(h, selected),
    ],
  )
}

function groupInspector(
  h: HtmlBuilder<Message>,
  group: Group,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [h.Class('border-b border-neutral-800 p-3 max-h-64 overflow-auto')],
    [
      h.div([h.Class('font-semibold text-neutral-100 mb-2')], ['Group']),
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.label(
            [h.Class('flex items-center gap-2')],
            [
              h.span([h.Class('w-12 text-neutral-400')], ['Name']),
              h.input([
                h.Type('text'),
                h.Value(group.name),
                h.OnInput(name =>
                  Message.RenamedGroup({ groupId: group.id, name }),
                ),
                h.Class(
                  'w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-100',
                ),
                h.AriaLabel('Group name'),
              ]),
            ],
          ),
          h.div(
            [h.Class('flex items-center gap-2')],
            [
              h.span([h.Class('w-12 text-neutral-400')], ['Color']),
              h.div(
                [h.Class('flex flex-wrap gap-1')],
                GROUP_COLORS.map(color =>
                  h.button(
                    [
                      h.OnClick(
                        Message.ChangedGroupColor({ groupId: group.id, color }),
                      ),
                      h.Class(
                        color === group.color
                          ? 'w-5 h-5 rounded border-2 border-white'
                          : 'w-5 h-5 rounded border border-neutral-600',
                      ),
                      h.Style({ backgroundColor: color }),
                      h.AriaLabel(`Set group color ${color}`),
                    ],
                    [' '],
                  ),
                ),
              ),
            ],
          ),
          h.div(
            [h.Class('text-neutral-500 text-xs')],
            [
              `${group.nodeIds.length} node${group.nodeIds.length === 1 ? '' : 's'}`,
            ],
          ),
          h.button(
            [
              h.OnClick(Message.PressedUngroupSelection()),
              h.Class(
                'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1',
              ),
              h.AriaLabel('Ungroup group'),
            ],
            ['Ungroup'],
          ),
        ],
      ),
    ],
  )
}

function inspectorFor(
  h: HtmlBuilder<Message>,
  node: EditorNode,
): ReturnType<HtmlBuilder<Message>['div']> {
  const keys =
    node.type === 'Float'
      ? ['value']
      : node.type === 'Float2'
        ? ['x', 'y']
        : node.type === 'Float3'
          ? ['x', 'y', 'z']
          : node.type === 'Float4'
            ? ['x', 'y', 'z', 'w']
            : []
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div([h.Class('text-neutral-400')], [`${node.type} (${node.id})`]),
      ...keys.map(key => {
        const raw = node.params[key]
        const current = typeof raw === 'number' ? raw : 0
        return h.label(
          [h.Class('flex items-center gap-2')],
          [
            h.span([h.Class('w-12 text-neutral-400')], [key]),
            h.input([
              h.Type('number'),
              h.Value(String(current)),
              h.OnInput(value =>
                Message.UpdatedParam({
                  nodeId: node.id,
                  key,
                  valueText: value,
                }),
              ),
              h.Class(
                'w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-neutral-100',
              ),
              h.AriaLabel(`${node.id} ${key}`),
            ]),
          ],
        )
      }),
      keys.length === 0
        ? h.div(
            [h.Class('text-neutral-500')],
            ['No editable values. Connect its ports.'],
          )
        : h.empty,
      h.button(
        [
          h.OnClick(Message.RequestedDeleteSelection()),
          h.Class(
            'bg-red-900 hover:bg-red-800 text-white rounded px-3 py-1 mt-1',
          ),
        ],
        ['Delete node'],
      ),
    ],
  )
}

function hlslView(
  _model: Model,
  h: HtmlBuilder<Message>,
  result: ReturnType<typeof generate>,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [h.Class('border-b border-neutral-800 p-3 flex flex-col min-h-0')],
    [
      h.div(
        [h.Class('flex items-center mb-2')],
        [
          h.span(
            [h.Class('font-semibold text-neutral-100')],
            ['Generated HLSL'],
          ),
          h.button(
            [
              h.OnClick(Message.RequestedCopyHlsl()),
              h.Class(
                'ml-auto bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-2 py-1',
              ),
            ],
            ['Copy'],
          ),
        ],
      ),
      result.ok
        ? h.pre(
            [
              h.Class(
                'bg-black rounded p-2 overflow-auto text-xs font-mono text-green-300 whitespace-pre-wrap',
              ),
            ],
            [result.code],
          )
        : h.div(
            [
              h.Class(
                'bg-red-950 border border-red-800 rounded p-2 text-red-200',
              ),
            ],
            ['Graph is invalid. Fix the problems below.'],
          ),
    ],
  )
}

function problemsView(
  _model: Model,
  h: HtmlBuilder<Message>,
  errors: ReturnType<typeof validate>,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [h.Class('p-3 flex-1 overflow-auto min-h-0')],
    [
      h.div(
        [h.Class('font-semibold text-neutral-100 mb-2')],
        [`Problems (${errors.length})`],
      ),
      errors.length === 0
        ? h.div([h.Class('text-neutral-500')], ['No problems.'])
        : h.div(
            [h.Class('flex flex-col gap-1')],
            errors.map(error =>
              h.div(
                [h.Class('bg-neutral-800 rounded px-2 py-1')],
                [
                  h.span(
                    [h.Class('text-red-400 font-mono text-xs mr-2')],
                    [error.code],
                  ),
                  h.span(
                    [h.Class('text-neutral-300 whitespace-pre-line')],
                    [error.message],
                  ),
                  error.nodeId !== undefined
                    ? h.button(
                        [
                          h.OnClick(
                            Message.SelectedNode({ nodeId: error.nodeId }),
                          ),
                          h.Class('ml-2 text-sky-400 hover:text-sky-300'),
                        ],
                        [`${error.nodeId}`],
                      )
                    : h.empty,
                ],
              ),
            ),
          ),
    ],
  )
}

function statusView(
  model: Model,
  h: HtmlBuilder<Message>,
): ReturnType<HtmlBuilder<Message>['div']> {
  const pending = model.pending.active
    ? `Connecting from ${model.pending.fromNodeId}.${model.pending.fromPort} — click an input port (Esc cancels).`
    : model.status
  return h.div(
    [
      h.Class(
        'flex items-center gap-3 px-3 py-1.5 border-t border-neutral-800 bg-neutral-900 text-xs text-neutral-400',
      ),
    ],
    [
      h.span([h.Class('truncate')], [pending === '' ? 'Ready.' : pending]),
      h.span(
        [h.Class('ml-auto shrink-0')],
        [
          'Del delete · Ctrl+G group · Ctrl+C/V copy · right-click canvas to add',
        ],
      ),
    ],
  )
}
