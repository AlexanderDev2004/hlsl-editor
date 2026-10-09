// Pure view: Model -> Document. All derived data (validation, HLSL)
// is computed here from the Model; the Model itself stays minimal.

import { Option } from 'effect'
import { type Document, type Html, type HtmlBuilder } from 'foldkit/html'

import { generate, validate } from '@hlsl-editor/shader-compiler'
import {
  NODE_REGISTRY,
  NODE_TYPES,
  isNodeType,
  isRerouteType,
} from '@hlsl-editor/shader-nodes'

import { collapsedBounds, hiddenNodeIds } from './collapse'
import {
  GRAYSCALE,
  HONEYCOMB,
  PICKER_H,
  PICKER_W,
  hexToRgb,
  normalizeHexColor,
  rgbFromChannels,
  rgbToHex,
} from './color-picker'
import { GROUP_COLORS, GROUP_HEADER, GROUP_PAD, groupBounds } from './groups'
import {
  BASE_H,
  BASE_W,
  HEADER_H,
  NODE_W,
  REROUTE_SIZE,
  ZOOM_MAX,
  ZOOM_MIN,
  nodeHeight,
  nodeWidth,
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
import {
  type CollapsedNode,
  type EditorEdge,
  type EditorNode,
  type Group,
  type LogEntry,
  type Model,
  toDomainGraph,
} from './model'
import {
  LOADING_VARIANTS,
  type LoadingVariant,
  type NodeStatus,
  deriveNodeStatuses,
} from './node-status'
import { declarationOfUsage, isNamedRerouteLink, rerouteName } from './reroutes'
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
    x: node.position.x + (direction === 'in' ? 0 : nodeWidth(node.type)),
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

const CATEGORY_COLORS: Record<string, string> = {
  Input: '#38bdf8',
  Math: '#34d399',
  Vector: '#fbbf24',
  Utility: '#a78bfa',
  Output: '#fb7185',
}

function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? '#8b949e'
}

// Named reroute declarations/usages are created through the reroute actions,
// never dropped in standalone (a lone usage has no declaration to link to).
const PALETTE_TYPES = NODE_TYPES.filter(
  type => type !== 'NamedRerouteDeclaration' && type !== 'NamedRerouteUsage',
)

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
          h.Fill('#0a0c10'),
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

const HIGHLIGHT_COLOR = '#38bdf8'

const NEUTRAL_WIRE = '#5b6572'

// Wires take the colour of the type that flows through them. Reroutes are
// transparent to the compiler, so the colour resolves through them to the
// upstream port that actually carries the value.
function resolvedSourceType(
  model: Model,
  edge: EditorEdge,
  depth?: number,
): string | null {
  const level = depth ?? 0
  if (level > 12) {
    return null
  }
  const source = model.nodes.find(n => n.id === edge.sourceNodeId)
  if (source === undefined) {
    return null
  }
  if (!isRerouteType(source.type)) {
    if (!isNodeType(source.type)) {
      return null
    }
    const port = NODE_REGISTRY[source.type].outputs.find(
      o => o.name === edge.sourcePort,
    )
    return port === undefined ? null : port.valueType
  }
  const upstream = model.edges.find(
    e => e.targetNodeId === source.id && e.targetPort === 'in',
  )
  return upstream === undefined
    ? null
    : resolvedSourceType(model, upstream, level + 1)
}

function wireColor(model: Model, edge: EditorEdge): string {
  const valueType = resolvedSourceType(model, edge)
  return valueType === null
    ? NEUTRAL_WIRE
    : (TYPE_COLORS[valueType] ?? NEUTRAL_WIRE)
}

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
      [h.Class('h-screen flex flex-col bg-[#0a0c10] text-neutral-200 text-sm')],
      [
        headerView(model, h),
        h.div(
          [h.Class('flex-1 flex min-h-0')],
          [
            canvasView(model, h, errorPorts, nodeStatuses),
            h.div(
              [
                h.Class(
                  'w-[380px] shrink-0 border-l border-[#1c2230] flex flex-col min-h-0 bg-[#0e1116]',
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
        logPanelView(model, h),
        settingsView(model, h),
        colorPickerView(model, h),
        playPreviewView(model, h),
      ],
    ),
  }
}

const HEADER_DIVIDER = 'h-5 w-px bg-[#1c2230] shrink-0'

function headerToolButton(
  h: HtmlBuilder<Message>,
  label: string,
  message: Message,
  title?: string,
): ReturnType<HtmlBuilder<Message>['button']> {
  return h.button(
    [
      h.OnClick(message),
      h.Class(
        'px-2.5 py-1 rounded-md text-[12.5px] text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800/80 border border-transparent transition-colors',
      ),
      ...(title === undefined ? [] : [h.Title(title)]),
    ],
    [label],
  )
}

function headerView(
  model: Model,
  h: HtmlBuilder<Message>,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [
      h.Class(
        'h-14 shrink-0 flex items-center gap-3 px-4 border-b border-[#1c2230] bg-[#0e1116]',
      ),
    ],
    [
      h.span(
        [h.Class('flex items-center gap-2.5 shrink-0')],
        [
          h.svg(
            [h.Width('26'), h.Height('26'), h.ViewBox('0 0 26 26')],
            [
              h.defs(
                [],
                [
                  h.linearGradient(
                    [
                      h.Id('brand-grad'),
                      h.X1('0'),
                      h.Y1('0'),
                      h.X2('1'),
                      h.Y2('1'),
                    ],
                    [
                      h.stop([h.Offset('0'), h.StopColor('#38bdf8')]),
                      h.stop([h.Offset('1'), h.StopColor('#6366f1')]),
                    ],
                  ),
                ],
              ),
              h.rect([
                h.X('1'),
                h.Y('1'),
                h.Width('24'),
                h.Height('24'),
                h.Rx('7'),
                h.Fill('url(#brand-grad)'),
              ]),
              h.circle([
                h.Cx('8.5'),
                h.Cy('8.5'),
                h.R('2.1'),
                h.Fill('#f0f9ff'),
              ]),
              h.circle([
                h.Cx('8.5'),
                h.Cy('17.5'),
                h.R('2.1'),
                h.Fill('#f0f9ff'),
              ]),
              h.circle([
                h.Cx('17.5'),
                h.Cy('13'),
                h.R('2.1'),
                h.Fill('#f0f9ff'),
              ]),
              h.path([
                h.D('M 8.5 8.5 L 17.5 13 M 8.5 17.5 L 17.5 13'),
                h.Stroke('#f0f9ff'),
                h.StrokeWidth('1.4'),
                h.Fill('none'),
              ]),
            ],
          ),
          h.span(
            [h.Class('leading-tight')],
            [
              h.span(
                [h.Class('block text-[13.5px] font-semibold text-neutral-100')],
                ['HLSL Editor'],
              ),
              h.span(
                [
                  h.Class(
                    'block text-[9.5px] uppercase tracking-[0.18em] text-neutral-500',
                  ),
                ],
                ['Shader graph'],
              ),
            ],
          ),
        ],
      ),
      h.div([h.Class(HEADER_DIVIDER)]),
      searchView(model, h),
      h.div(
        [
          h.Class(
            'flex items-stretch rounded-lg overflow-hidden border border-[#232a36] bg-[#12151c] shrink-0',
          ),
        ],
        [
          h.select(
            [
              h.OnChange(value =>
                Message.ChangedNewNodeType({ nodeType: value }),
              ),
              h.Value(model.newNodeType),
              h.Class(
                'bg-[#12151c] text-neutral-300 text-[12.5px] px-2.5 py-1.5 outline-none cursor-pointer',
              ),
              h.AriaLabel('Node type to add'),
            ],
            PALETTE_TYPES.map(t =>
              h.option(
                [h.Value(t)],
                [isNodeType(t) ? NODE_REGISTRY[t].label : t],
              ),
            ),
          ),
          h.div([h.Class('w-px bg-[#232a36]')]),
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
              h.Class(
                'bg-sky-500/15 hover:bg-sky-500/25 text-sky-300 px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              ),
            ],
            ['Add node'],
          ),
        ],
      ),
      h.div(
        [h.Class('flex items-center gap-0.5 ml-auto shrink-0')],
        [
          headerToolButton(
            h,
            'New',
            Message.RequestedNew(),
            'Start an empty graph',
          ),
          headerToolButton(
            h,
            'Save',
            Message.RequestedSave(),
            'Save to browser storage',
          ),
          headerToolButton(
            h,
            'Export',
            Message.RequestedExport(),
            'Download graph as JSON',
          ),
          headerToolButton(
            h,
            'Import',
            Message.RequestedImport(),
            'Load graph from JSON',
          ),
          h.button(
            [
              h.OnClick(Message.RequestedPlay()),
              h.Class(
                'px-3 py-1 rounded-md text-[12.5px] font-medium bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 transition-colors',
              ),
              h.AriaLabel('Play'),
              h.Title('Run the graph and preview its output color'),
            ],
            ['▶ Play'],
          ),
          h.div([h.Class(HEADER_DIVIDER)]),
          h.button(
            [
              h.OnClick(Message.ToggledLogPanel()),
              h.Class(
                'px-2.5 py-1 rounded-md text-[12.5px] transition-colors border ' +
                  (model.logPanelOpen
                    ? 'text-sky-300 bg-sky-500/10 border-sky-500/30'
                    : 'text-neutral-300 border-transparent hover:text-neutral-100 hover:bg-neutral-800/80'),
              ),
              h.AriaLabel('Toggle log panel'),
              h.Title('Show or hide the log panel'),
            ],
            ['Log'],
          ),
          h.div([h.Class(HEADER_DIVIDER)]),
          headerToolButton(
            h,
            'Delete',
            Message.RequestedDeleteSelection(),
            'Delete selection (Del)',
          ),
          headerToolButton(
            h,
            'Group',
            Message.PressedGroupSelection(),
            'Group selected nodes (Ctrl/Cmd+G)',
          ),
          headerToolButton(
            h,
            'Ungroup',
            Message.PressedUngroupSelection(),
            'Ungroup selected group (Ctrl/Cmd+Shift+G)',
          ),
          headerToolButton(
            h,
            'Collapse',
            Message.CollapsedSelection(),
            'Collapse selected nodes into a container',
          ),
          h.div([h.Class(HEADER_DIVIDER)]),
          h.span(
            [
              h.Class(
                'text-[11.5px] text-neutral-400 bg-[#12151c] border border-[#232a36] rounded-full px-3 py-1 tabular-nums shrink-0',
              ),
            ],
            [
              `${model.nodes.length} node${model.nodes.length === 1 ? '' : 's'} · ${model.edges.length} edge${model.edges.length === 1 ? '' : 's'}`,
            ],
          ),
          h.button(
            [
              h.OnClick(Message.OpenedSettings()),
              h.Class(
                'ml-1 px-2 py-1 rounded-md text-[15px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 border border-transparent transition-colors leading-none',
              ),
              h.AriaLabel('Settings'),
              h.Title('Keyboard shortcuts and settings'),
            ],
            ['⚙'],
          ),
        ],
      ),
    ],
  )
}

// Play runs the graph numerically and previews the Fragment Output color.
// The swatch clamps to [0,1] like an 8-bit UNORM render target, while the
// raw components stay printed so out-of-range results remain visible.
function playPreviewView(model: Model, h: HtmlBuilder<Message>): Html {
  const play = Option.getOrNull(model.play)
  if (play === null) {
    return h.empty
  }
  const [r, g, b, a] = play.color
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
  const byte = (v: number): number => Math.round(clamp01(v) * 255)
  const channel = (v: number): string => byte(v).toString(16).padStart(2, '0')
  const hex = `#${channel(r)}${channel(g)}${channel(b)}`
  const raw = (v: number): string =>
    Number.isFinite(v) ? v.toFixed(4) : v > 0 ? '∞' : Number.isNaN(v) ? 'NaN' : '-∞'
  const rows: Array<readonly [string, number]> = [
    ['R', r],
    ['G', g],
    ['B', b],
    ['A', a],
  ]
  return h.div(
    [h.Class('fixed inset-0 z-40 flex items-center justify-center')],
    [
      h.div([
        h.Class('absolute inset-0 bg-black/70 backdrop-blur-sm'),
        h.OnClick(Message.DismissedPlay()),
      ]),
      h.div(
        [
          h.Class(
            'relative w-[320px] flex flex-col gap-3 bg-[#0e1116] border border-[#232a36] rounded-2xl shadow-2xl shadow-black/60 p-4',
          ),
        ],
        [
          h.div(
            [h.Class('flex items-baseline gap-2')],
            [
              h.span(
                [h.Class('text-[13.5px] font-semibold text-neutral-100')],
                ['▶ Play preview'],
              ),
              h.span([h.Class('text-[11px] text-neutral-500')], [
                'SV_Target output',
              ]),
              h.button(
                [
                  h.OnClick(Message.DismissedPlay()),
                  h.Class(
                    'ml-auto text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md w-6 h-6 leading-none transition-colors',
                  ),
                  h.AriaLabel('Close play preview'),
                  h.Title('Close (Esc)'),
                ],
                ['✕'],
              ),
            ],
          ),
          h.div(
            [
              h.Class(
                'play-checker rounded-xl border border-[#1c2230] overflow-hidden',
              ),
            ],
            [
              h.div(
                [
                  h.Class('h-36 w-full'),
                  h.Style({
                    backgroundColor: `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${clamp01(a)})`,
                  }),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class('flex flex-col gap-1 font-mono text-[11.5px]')],
            [
              ...rows.map(([label, value]) =>
                h.div(
                  [h.Class('flex items-center gap-2')],
                  [
                    h.span(
                      [h.Class('w-4 text-neutral-500 font-sans')],
                      [label],
                    ),
                    h.span([h.Class('text-neutral-200')], [raw(value)]),
                    h.span(
                      [h.Class('ml-auto text-neutral-500')],
                      [`→ ${byte(value)}`],
                    ),
                  ],
                ),
              ),
              h.div(
                [h.Class('flex items-center gap-2 mt-1')],
                [
                  h.span([h.Class('w-4 text-neutral-500 font-sans')], ['HEX']),
                  h.span([h.Class('text-emerald-300')], [hex]),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class('text-[10.5px] text-neutral-500 leading-snug')],
            [
              'Raw float4 from the graph. The swatch clamps to [0,1] like an 8-bit UNORM render target.',
            ],
          ),
        ],
      ),
    ],
  )
}

// Session console: every connection attempt, edit, persistence action, and
// Play run lands here with a level. Newest first so the latest event is
// always visible without scrolling.
const LOG_LEVEL_STYLE: Record<LogEntry['level'], string> = {
  error: 'text-red-300',
  warning: 'text-amber-300',
  success: 'text-emerald-300',
  info: 'text-neutral-200',
  system: 'text-violet-300',
}

const LOG_LEVEL_DOT: Record<LogEntry['level'], string> = {
  error: 'bg-red-400',
  warning: 'bg-amber-300',
  success: 'bg-emerald-400',
  info: 'bg-neutral-500',
  system: 'bg-violet-400',
}

function logPanelView(model: Model, h: HtmlBuilder<Message>): Html {
  if (!model.logPanelOpen) {
    return h.empty
  }
  const counts = (['error', 'warning'] as const)
    .map(level => ({
      level,
      n: model.logs.filter(entry => entry.level === level).length,
    }))
    .filter(({ n }) => n > 0)
    .map(({ level, n }) =>
      h.span(
        [
          h.Class(
            (level === 'error'
              ? 'text-red-300 bg-red-500/10 border-red-500/30'
              : 'text-amber-300 bg-amber-500/10 border-amber-500/30') +
              ' text-[10px] border rounded-full px-1.5 py-px font-sans',
          ),
        ],
        [`${n} ${level}${n === 1 ? '' : 's'}`],
      ),
    )
  return h.div(
    [
      h.Class(
        'log-panel shrink-0 h-[150px] flex flex-col border-t border-[#1c2230] bg-[#0a0c10]',
      ),
    ],
    [
      h.div(
        [
          h.Class(
            'flex items-center gap-2 px-4 py-1.5 border-b border-[#161c26]',
          ),
        ],
        [
          h.span(
            [
              h.Class(
                'text-[10.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500',
              ),
            ],
            ['Log'],
          ),
          ...counts,
          h.button(
            [
              h.OnClick(Message.PressedClearLogs()),
              h.Class(
                'ml-auto text-[11px] text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md px-2 py-0.5 transition-colors',
              ),
              h.AriaLabel('Clear log panel'),
              h.Title('Clear all log entries'),
            ],
            ['Clear'],
          ),
          h.button(
            [
              h.OnClick(Message.ToggledLogPanel()),
              h.Class(
                'text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md w-5 h-5 leading-none transition-colors',
              ),
              h.AriaLabel('Close log panel'),
              h.Title('Hide the log panel'),
            ],
            ['✕'],
          ),
        ],
      ),
      h.div(
        [h.Class('flex-1 overflow-y-auto px-4 py-1.5 flex flex-col gap-0.5')],
        [
          model.logs.length === 0
            ? h.div(
                [h.Class('text-[11.5px] text-neutral-600 font-mono')],
                ['No entries yet. Connect nodes or edit the graph.'],
              )
            : h.empty,
          ...model.logs.map(entry =>
            h.div(
              [h.Class('flex items-start gap-2 font-mono text-[11.5px]')],
              [
                h.span(
                  [
                    h.Class(
                      `mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 ${LOG_LEVEL_DOT[entry.level]}`,
                    ),
                  ],
                ),
                h.span(
                  [
                    h.Class(
                      `w-14 shrink-0 uppercase text-[10px] leading-5 tracking-wide ${LOG_LEVEL_STYLE[entry.level]}`,
                    ),
                  ],
                  [entry.level],
                ),
                h.span(
                  [
                    h.Class(
                      `${LOG_LEVEL_STYLE[entry.level]} leading-5 whitespace-pre-wrap`,
                    ),
                  ],
                  [entry.text],
                ),
              ],
            ),
          ),
        ],
      ),
    ],
  )
}

// The custom group color picker: a honeycomb wheel with a grayscale row,
// a hex field, R/G/B channels, and New/Current previews. Draft edits stay
// in the Model; OK applies them to the group, Cancel and the backdrop
// discard them.
function colorPickerView(model: Model, h: HtmlBuilder<Message>): Html {
  const picker = Option.getOrNull(model.colorPicker)
  if (picker === null) {
    return h.empty
  }
  const groupName =
    model.groups.find(g => g.id === picker.groupId)?.name ?? picker.groupId
  const normalized = normalizeHexColor(picker.draft)
  const base = hexToRgb(picker.draft) ?? hexToRgb(picker.originalColor)
  const swatch = (label: string, color: string | null): Html =>
    h.div(
      [h.Class('flex flex-col items-center gap-1')],
      [
        h.div([
          h.Class(
            'w-8 h-8 rounded-md border ' +
              (color === null
                ? 'border-dashed border-neutral-600'
                : 'border-[#2a3240]'),
          ),
          h.Style(color === null ? {} : { backgroundColor: color }),
        ]),
        h.span(
          [h.Class('text-[9.5px] uppercase tracking-wide text-neutral-500')],
          [label],
        ),
      ],
    )
  return h.div(
    [h.Class('fixed inset-0 z-40 flex items-center justify-center')],
    [
      h.div([
        h.Class('absolute inset-0 bg-black/70 backdrop-blur-sm'),
        h.OnClick(Message.CancelledGroupColorPicker()),
      ]),
      h.div(
        [
          h.Class(
            'relative w-[300px] flex flex-col gap-3 bg-[#0e1116] border border-[#232a36] rounded-2xl shadow-2xl shadow-black/60 p-4',
          ),
        ],
        [
          h.div(
            [h.Class('flex items-baseline gap-2')],
            [
              h.span(
                [h.Class('text-[13.5px] font-semibold text-neutral-100')],
                ['Custom color'],
              ),
              h.span([h.Class('text-[11px] text-neutral-500')], [groupName]),
            ],
          ),
          h.svg(
            [
              h.Width(String(PICKER_W)),
              h.Height(String(PICKER_H)),
              h.ViewBox(`0 0 ${PICKER_W} ${PICKER_H}`),
              h.Class('block rounded-lg bg-[#0a0c10] border border-[#1c2230]'),
            ],
            [
              ...HONEYCOMB.map(cell =>
                h.polygon([
                  h.Points(cell.points),
                  h.Fill(cell.color),
                  h.Stroke(cell.color === normalized ? '#ffffff' : '#0a0c10'),
                  h.StrokeWidth(cell.color === normalized ? '2' : '1'),
                  h.Cursor('pointer'),
                  h.Class('picker-cell'),
                  h.OnClick(
                    Message.EditedGroupColorDraft({ text: cell.color }),
                  ),
                  h.AriaLabel(`Pick color ${cell.color}`),
                ]),
              ),
              ...GRAYSCALE.map(cell =>
                h.polygon([
                  h.Points(cell.points),
                  h.Fill(cell.color),
                  h.Stroke(cell.color === normalized ? '#ffffff' : '#0a0c10'),
                  h.StrokeWidth(cell.color === normalized ? '2' : '1'),
                  h.Cursor('pointer'),
                  h.Class('picker-cell'),
                  h.OnClick(
                    Message.EditedGroupColorDraft({ text: cell.color }),
                  ),
                  h.AriaLabel(`Pick grayscale ${cell.color}`),
                ]),
              ),
            ],
          ),
          h.div(
            [h.Class('flex items-center gap-2')],
            [
              h.span(
                [h.Class('w-12 text-[11.5px] text-neutral-400')],
                ['HTML'],
              ),
              h.input([
                h.Type('text'),
                h.Value(picker.draft),
                h.OnInput(text => Message.EditedGroupColorDraft({ text })),
                h.Class(
                  'flex-1 min-w-0 bg-[#12151c] border rounded-md px-2.5 py-1.5 text-[12.5px] font-mono text-neutral-100 focus:outline-none transition-colors ' +
                    (normalized === null
                      ? 'border-red-500/50'
                      : 'border-[#232a36] focus:border-sky-500/50'),
                ),
                h.AriaLabel('Color hex'),
                h.Spellcheck(false),
              ]),
              swatch('New', normalized),
              swatch('Current', picker.originalColor),
            ],
          ),
          h.div(
            [h.Class('flex items-center gap-2')],
            [
              h.span([h.Class('w-12 text-[11.5px] text-neutral-400')], ['RGB']),
              ...(
                [
                  ['R', 'r'],
                  ['G', 'g'],
                  ['B', 'b'],
                ] as const
              ).map(([label, key]) =>
                h.label(
                  [h.Class('flex items-center gap-1')],
                  [
                    h.span(
                      [h.Class('text-[10px] font-mono text-neutral-500')],
                      [label],
                    ),
                    h.input([
                      h.Type('number'),
                      h.Min('0'),
                      h.Max('255'),
                      h.Value(base === null ? '' : String(base[key])),
                      h.OnInput(valueText => {
                        const parsed = Number(valueText)
                        const from = base === null ? { r: 0, g: 0, b: 0 } : base
                        if (!Number.isFinite(parsed)) {
                          return Message.EditedGroupColorDraft({
                            text: rgbToHex(from),
                          })
                        }
                        const next = rgbFromChannels(
                          key === 'r' ? parsed : from.r,
                          key === 'g' ? parsed : from.g,
                          key === 'b' ? parsed : from.b,
                        )
                        return Message.EditedGroupColorDraft({
                          text: rgbToHex(next),
                        })
                      }),
                      h.Class(
                        'w-16 bg-[#12151c] border border-[#232a36] rounded-md px-2 py-1.5 text-[12px] text-neutral-100 focus:outline-none focus:border-sky-500/50 transition-colors',
                      ),
                      h.AriaLabel(`Color ${label}`),
                    ]),
                  ],
                ),
              ),
            ],
          ),
          h.div(
            [h.Class('flex items-center gap-2 mt-1')],
            [
              h.button(
                [
                  h.OnClick(Message.CancelledGroupColorPicker()),
                  h.Class(
                    'px-3 py-1.5 rounded-md text-[12.5px] text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800/80 border border-transparent transition-colors',
                  ),
                  h.AriaLabel('Cancel custom color'),
                ],
                ['Cancel'],
              ),
              h.button(
                [
                  h.OnClick(Message.AppliedGroupColorDraft()),
                  h.Class(
                    'ml-auto bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-300 rounded-md px-4 py-1.5 text-[12.5px] font-medium transition-colors ' +
                      (normalized === null
                        ? 'opacity-40 pointer-events-none'
                        : ''),
                  ),
                  h.AriaLabel('Apply custom color'),
                ],
                ['OK'],
              ),
            ],
          ),
        ],
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
        h.Class('absolute inset-0 bg-black/70 backdrop-blur-sm'),
        h.OnClick(Message.ClosedSettings()),
      ]),
      h.div(
        [
          h.Class(
            'relative w-[680px] max-h-[80vh] flex flex-col bg-[#0e1116] border border-[#232a36] rounded-2xl shadow-2xl shadow-black/60 overflow-hidden',
          ),
        ],
        [
          h.div(
            [
              h.Class(
                'flex items-center px-4 h-12 border-b border-[#1c2230] shrink-0',
              ),
            ],
            [
              h.span(
                [h.Class('text-[13.5px] font-semibold text-neutral-100')],
                ['Settings'],
              ),
              h.span(
                [h.Class('ml-3 text-[11.5px] text-neutral-500')],
                ['Keyboard shortcuts'],
              ),
              h.button(
                [
                  h.OnClick(Message.ClosedSettings()),
                  h.Class(
                    'ml-auto text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md px-2 py-0.5 leading-none text-[16px] transition-colors',
                  ),
                  h.AriaLabel('Close settings'),
                ],
                ['×'],
              ),
            ],
          ),
          shortcutPlatformToggle(model, h),
          h.div(
            [h.Class('flex-1 overflow-auto min-h-0 py-1')],
            SHORTCUT_CATEGORIES.flatMap(category => [
              h.div(
                [
                  h.Class(
                    'px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500',
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
                'flex items-center gap-3 px-4 py-3 border-t border-[#1c2230] shrink-0',
              ),
            ],
            [
              h.span(
                [h.Class('text-[11.5px] text-neutral-500')],
                ['Click Record, then press the keys you want. Esc cancels.'],
              ),
              h.button(
                [
                  h.OnClick(Message.ResetAllShortcuts()),
                  h.Class(
                    'ml-auto bg-[#1a2029] hover:bg-[#232b37] border border-[#2a3240] rounded-md px-3 py-1.5 text-[12px] text-neutral-200 transition-colors',
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
    [
      h.Class(
        'flex items-center gap-2 px-4 py-2.5 border-b border-[#1c2230] shrink-0',
      ),
    ],
    [
      h.span([h.Class('text-[12px] text-neutral-400')], ['Shortcut display']),
      ...SHORTCUT_PLATFORMS.map(platform =>
        h.button(
          [
            h.OnClick(Message.ChangedShortcutPlatform({ platform })),
            h.Class(
              platform === model.shortcutPlatform
                ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-md px-2.5 py-1 text-[11.5px] font-medium'
                : 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 border border-transparent rounded-md px-2.5 py-1 text-[11.5px] transition-colors',
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
    [
      h.Class(
        'flex items-center gap-3 px-4 py-2 border-b border-[#141a23] hover:bg-white/[0.02]',
      ),
    ],
    [
      h.span(
        [h.Class('flex-1 text-[12.5px] text-neutral-200')],
        [command.label],
      ),
      recording
        ? h.span(
            [
              h.Class(
                'font-mono px-2 py-0.5 rounded-md text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/25 min-w-24 text-center',
              ),
            ],
            ['Press keys…'],
          )
        : h.span(
            [
              h.Class(
                'font-mono px-2 py-0.5 bg-[#161b22] border border-[#2a3140] rounded-md text-[11px] text-neutral-300 min-w-24 text-center',
              ),
            ],
            [formatShortcut(binding, model.shortcutPlatform)],
          ),
      recording
        ? h.button(
            [
              h.OnClick(Message.CancelledShortcutRecording()),
              h.Class(
                'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md px-2 py-0.5 text-[11.5px] border border-transparent transition-colors',
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
                'text-sky-300 hover:bg-sky-500/10 rounded-md px-2 py-0.5 text-[11.5px] font-medium border border-transparent transition-colors',
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
                'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md px-2 py-0.5 text-[11.5px] border border-transparent transition-colors',
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
    [h.Class('relative shrink-0')],
    [
      h.input([
        h.Type('text'),
        h.Value(model.searchText),
        h.Placeholder('Search nodes…'),
        h.OnInput(text => Message.ChangedSearch({ text })),
        h.Class(
          'w-52 bg-[#12151c] border border-[#232a36] rounded-lg px-3 py-1.5 text-[12.5px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:border-sky-500/50 transition-colors',
        ),
        h.AriaLabel('Search nodes'),
      ]),
      query === ''
        ? h.empty
        : h.div(
            [
              h.Class(
                'absolute left-0 top-full mt-1.5 w-72 max-h-64 overflow-auto bg-[#12151c]/95 backdrop-blur border border-[#232a36] rounded-xl shadow-2xl shadow-black/50 z-20 flex flex-col p-1',
              ),
            ],
            results.length === 0
              ? [
                  h.div(
                    [h.Class('px-2.5 py-1.5 text-[12px] text-neutral-500')],
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
                        'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left hover:bg-neutral-800/70',
                      ),
                    ],
                    [
                      h.span(
                        [h.Class('text-[12.5px] text-neutral-200')],
                        [nodeLabel(node)],
                      ),
                      h.span(
                        [
                          h.Class(
                            'ml-auto text-[10.5px] font-mono text-neutral-500',
                          ),
                        ],
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
  const hidden = hiddenNodeIds(model)
  const collapsedRects = model.collapsed.flatMap(entry => {
    const rect = collapsedBounds(entry, model.nodes)
    return rect === null ? [] : [{ entry, rect }]
  })
  const nodeContainer = collapsedRects.reduce<
    Map<string, { x: number; y: number; width: number; height: number }>
  >((acc, { entry, rect }) => {
    entry.nodeIds.forEach(id => acc.set(id, rect))
    return acc
  }, new Map())
  const w = BASE_W / model.viewport.zoom
  const ww = BASE_H / model.viewport.zoom
  return h.div(
    [h.Class('flex-1 relative min-w-0 bg-[#0a0c10]')],
    [
      h.div(
        [
          h.Class(
            'absolute bottom-3 left-3 flex items-center gap-2 z-10 rounded-xl border border-[#232a36] bg-[#12151c]/90 backdrop-blur px-3 py-2 shadow-xl shadow-black/30',
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
            h.Class('w-32 accent-sky-400'),
            h.AriaLabel('Zoom'),
          ]),
          h.span(
            [
              h.Class(
                'w-10 text-right text-[11.5px] text-neutral-400 tabular-nums',
              ),
            ],
            [`${Math.round(model.viewport.zoom * 100)}%`],
          ),
          h.button(
            [
              h.OnClick(Message.ResetView()),
              h.Class(
                'text-[11.5px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 rounded-md px-2 py-0.5 border border-transparent transition-colors',
              ),
              h.AriaLabel('Reset view'),
              h.Title('Reset view'),
            ],
            ['Reset'],
          ),
          h.span([h.Class('w-px h-5 bg-[#232a36]')]),
          h.button(
            [
              h.OnClick(Message.ToggledSimulateLoading()),
              h.Class(
                model.simulateLoading
                  ? 'text-[11.5px] text-sky-300 bg-sky-500/15 border border-sky-500/30 rounded-md px-2 py-0.5'
                  : 'text-[11.5px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 border border-transparent rounded-md px-2 py-0.5 transition-colors',
              ),
              h.AriaPressed(model.simulateLoading ? 'true' : 'false'),
            ],
            ['Simulate loading'],
          ),
          h.select(
            [
              h.OnChange(variant => Message.ChangedLoadingVariant({ variant })),
              h.Value(model.loadingVariant),
              h.Class(
                'bg-[#12151c] border border-[#232a36] rounded-md px-1.5 py-0.5 text-[11.5px] text-neutral-300 outline-none cursor-pointer',
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
          h.defs(
            [],
            [
              h.pattern(
                [
                  h.Id('dot-grid'),
                  h.Width('26'),
                  h.Height('26'),
                  h.PatternUnits('userSpaceOnUse'),
                ],
                [
                  h.circle([
                    h.Cx('1.1'),
                    h.Cy('1.1'),
                    h.R('1.1'),
                    h.Fill('#1c232d'),
                  ]),
                ],
              ),
            ],
          ),
          h.rect([
            h.X(String(model.viewport.x - 2000)),
            h.Y(String(model.viewport.y - 2000)),
            h.Width(String(w + 4000)),
            h.Height(String(ww + 4000)),
            h.Fill('url(#dot-grid)'),
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
                h.Fill('rgba(56,189,248,0.08)'),
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
                    h.Rx('12'),
                    h.Fill(group.color),
                    h.FillOpacity('0.06'),
                    h.Stroke(group.color),
                    h.StrokeOpacity(selected ? '0.9' : '0.45'),
                    h.StrokeWidth(selected ? '2' : '1.25'),
                    h.Cursor('pointer'),
                    h.OnClick(Message.SelectedGroup({ groupId: group.id })),
                  ]),
                  h.rect([
                    h.X(String(rect.x)),
                    h.Y(String(rect.y)),
                    h.Width(String(rect.width)),
                    h.Height(String(GROUP_HEADER)),
                    h.Rx('12'),
                    h.Fill(group.color),
                    h.FillOpacity('0.16'),
                    h.PointerEvents('none'),
                  ]),
                  h.text(
                    [
                      h.X(String(rect.x + GROUP_PAD / 2)),
                      h.Y(String(rect.y + 15)),
                      h.Fill('#dbe4ee'),
                      h.FontSize('11.5'),
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
          ...collapsedRects.map(({ entry, rect }) => {
            const selected =
              Option.getOrNull(model.selectedCollapsedId) === entry.id
            return h.g(
              [h.Class('collapsed-node')],
              [
                h.rect([
                  h.X(String(rect.x)),
                  h.Y(String(rect.y)),
                  h.Width(String(rect.width)),
                  h.Height(String(rect.height)),
                  h.Rx('12'),
                  h.Fill('#141922'),
                  h.FillOpacity('0.72'),
                  h.Stroke(selected ? HIGHLIGHT_COLOR : '#39424f'),
                  h.StrokeWidth(selected ? '2' : '1.25'),
                  h.Cursor('pointer'),
                  h.OnClick(
                    Message.SelectedCollapsed({ collapsedId: entry.id }),
                  ),
                ]),
                h.rect([
                  h.X(String(rect.x)),
                  h.Y(String(rect.y)),
                  h.Width(String(rect.width)),
                  h.Height('24'),
                  h.Rx('12'),
                  h.Fill('#39424f'),
                  h.FillOpacity('0.3'),
                  h.PointerEvents('none'),
                ]),
                h.text(
                  [
                    h.X(String(rect.x + 8)),
                    h.Y(String(rect.y + 16)),
                    h.Fill('#dbe4ee'),
                    h.FontSize('11.5'),
                    h.FontWeight('600'),
                    h.PointerEvents('none'),
                  ],
                  [entry.name],
                ),
                h.text(
                  [
                    h.X(String(rect.x + 8)),
                    h.Y(String(rect.y + rect.height - 8)),
                    h.Fill('#7d8898'),
                    h.FontSize('10.5'),
                    h.PointerEvents('none'),
                  ],
                  [
                    `${entry.nodeIds.length} node${entry.nodeIds.length === 1 ? '' : 's'} collapsed`,
                  ],
                ),
              ],
            )
          }),
          ...model.edges.flatMap(edge => {
            if (isNamedRerouteLink(model, edge)) {
              return []
            }
            const from = model.nodes.find(n => n.id === edge.sourceNodeId)
            const to = model.nodes.find(n => n.id === edge.targetNodeId)
            if (from === undefined || to === undefined) {
              return []
            }
            const fromBox = nodeContainer.get(edge.sourceNodeId)
            const toBox = nodeContainer.get(edge.targetNodeId)
            if (fromBox !== undefined && toBox !== undefined) {
              return []
            }
            const p1 =
              fromBox !== undefined
                ? {
                    x: fromBox.x + fromBox.width,
                    y: fromBox.y + fromBox.height / 2,
                  }
                : portPosition(from, edge.sourcePort, 'out')
            const p2 =
              toBox !== undefined
                ? { x: toBox.x, y: toBox.y + toBox.height / 2 }
                : portPosition(to, edge.targetPort, 'in')
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
                : wireColor(model, edge)
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
                h.OnDoubleClick(
                  Message.InsertedRerouteOnEdge({
                    edgeId: edge.id,
                    worldX: (p1.x + p2.x) / 2,
                    worldY: (p1.y + p2.y) / 2,
                  }),
                ),
                h.OnMouseEnter(Message.HoveredEdge({ edgeId: edge.id })),
                h.OnMouseLeave(Message.UnhoveredEdge({ edgeId: edge.id })),
              ]),
              h.path([
                h.D(d),
                h.Fill('none'),
                h.Stroke(stroke),
                h.StrokeWidth(active ? '3.5' : invalid ? '2.25' : '2'),
                h.StrokeLinecap('round'),
                h.StrokeOpacity(invalid ? '0.9' : active ? '1' : '0.85'),
                ...(invalid ? [h.StrokeDasharray('7 5')] : []),
                ...(active ? [h.Class('graph-edge-glow')] : []),
                h.PointerEvents('none'),
              ]),
            ]
          }),
          ...model.nodes.flatMap(node =>
            hidden.has(node.id)
              ? []
              : [
                  nodeView(
                    model,
                    h,
                    node,
                    nodeStatuses.get(node.id) ?? 'initial',
                    highlightedNodes.has(node.id),
                  ),
                ],
          ),
          model.drag.mode === 'wire'
            ? (() => {
                const drag = model.drag
                const source = model.nodes.find(n => n.id === drag.fromNodeId)
                const from =
                  source === undefined
                    ? null
                    : portPosition(source, drag.fromPort, drag.fromDirection)
                return from === null
                  ? h.empty
                  : h.path([
                      h.D(
                        String(
                          edgePath(from.x, from.y, drag.worldX, drag.worldY),
                        ),
                      ),
                      h.Fill('none'),
                      h.Stroke(HIGHLIGHT_COLOR),
                      h.StrokeWidth('2.5'),
                      h.StrokeDasharray('6 4'),
                      h.PointerEvents('none'),
                      h.Class('wire-preview'),
                    ])
              })()
            : h.empty,
        ],
      ),
      minimapView(model, h),
      contextMenuView(model, h),
      nodeMenuView(model, h),
    ],
  )
}

function minimapView(model: Model, h: HtmlBuilder<Message>): Html {
  if (!model.minimapVisible) {
    return h.button(
      [
        h.OnClick(Message.ToggledMinimap()),
        h.Class(
          'absolute bottom-3 right-3 z-10 bg-[#12151c]/90 hover:bg-[#1a2029] border border-[#232a36] rounded-lg px-2 py-1 text-[12px] text-neutral-400 hover:text-neutral-100 transition-colors',
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
        'minimap absolute bottom-3 right-3 z-10 bg-[#12151c]/90 backdrop-blur border border-[#232a36] rounded-xl shadow-xl shadow-black/40 p-1.5',
      ),
    ],
    [
      h.div(
        [h.Class('flex items-center justify-between px-1 pb-1')],
        [
          h.span(
            [
              h.Class(
                'text-[9.5px] font-semibold uppercase tracking-[0.14em] text-neutral-500',
              ),
            ],
            ['Minimap'],
          ),
          h.button(
            [
              h.OnClick(Message.ToggledMinimap()),
              h.Class(
                'text-neutral-500 hover:text-neutral-100 px-1 leading-none transition-colors',
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
          h.Class('block rounded-lg bg-[#0a0c10] border border-[#1c2230]'),
        ],
        [
          ...model.edges.flatMap(edge => {
            if (isNamedRerouteLink(model, edge)) {
              return []
            }
            const from = model.nodes.find(n => n.id === edge.sourceNodeId)
            const to = model.nodes.find(n => n.id === edge.targetNodeId)
            if (from === undefined || to === undefined) {
              return []
            }
            return [
              h.line([
                h.X1(mx(from.position.x + nodeWidth(from.type))),
                h.Y1(my(from.position.y + nodeHeight(from.type) / 2)),
                h.X2(mx(to.position.x)),
                h.Y2(my(to.position.y + nodeHeight(to.type) / 2)),
                h.Stroke('#333c49'),
                h.StrokeWidth('1'),
              ]),
            ]
          }),
          ...model.nodes.flatMap(node =>
            hiddenNodeIds(model).has(node.id)
              ? []
              : [
                  h.rect([
                    h.X(mx(node.position.x)),
                    h.Y(my(node.position.y)),
                    h.Width(
                      String(Math.max(nodeWidth(node.type) * t.scale, 3)),
                    ),
                    h.Height(
                      String(Math.max(nodeHeight(node.type) * t.scale, 2)),
                    ),
                    h.Rx('1.5'),
                    h.Fill('#222a36'),
                    h.Stroke('#3d8fc7'),
                    h.StrokeWidth('0.5'),
                  ]),
                ],
          ),
          h.rect([
            h.X(mx(model.viewport.x)),
            h.Y(my(model.viewport.y)),
            h.Width(String(Math.max(viewW * t.scale, 4))),
            h.Height(String(Math.max(viewH * t.scale, 4))),
            h.Fill('rgba(56,189,248,0.08)'),
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
  const types = PALETTE_TYPES.filter(type => {
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
        'context-menu fixed z-30 w-60 max-h-80 overflow-auto bg-[#12151c]/95 backdrop-blur border border-[#232a36] rounded-xl shadow-2xl shadow-black/50 flex flex-col py-1',
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
          'bg-transparent border-b border-[#232a36] px-3 py-2 mb-1 text-[12.5px] text-neutral-100 placeholder:text-neutral-600 focus:outline-none',
        ),
        h.AriaLabel('Search nodes to add'),
      ]),
      types.length === 0
        ? h.div(
            [h.Class('px-3 py-1.5 text-[12px] text-neutral-500')],
            ['No matching nodes.'],
          )
        : h.div(
            [h.Class('flex flex-col px-1')],
            types.map(type =>
              h.button(
                [
                  h.OnClick(
                    Message.SelectedContextMenuNode({ nodeType: type }),
                  ),
                  h.Class(
                    'context-menu-item flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-sky-500/10 hover:text-sky-200 transition-colors',
                  ),
                  h.AriaLabel(`Add ${NODE_REGISTRY[type].label}`),
                ],
                [
                  h.span(
                    [h.Class('text-[12.5px] text-neutral-200')],
                    [NODE_REGISTRY[type].label],
                  ),
                  h.span(
                    [
                      h.Class('ml-auto text-[10px] px-1.5 py-0.5 rounded'),
                      h.Style({
                        backgroundColor: `${categoryColor(NODE_REGISTRY[type].category)}1f`,
                        color: categoryColor(NODE_REGISTRY[type].category),
                      }),
                    ],
                    [NODE_REGISTRY[type].category],
                  ),
                ],
              ),
            ),
          ),
    ],
  )
}

function nodeMenuView(model: Model, h: HtmlBuilder<Message>): Html {
  const menu = Option.getOrNull(model.nodeMenu)
  if (menu === null) {
    return h.empty
  }
  const node = model.nodes.find(n => n.id === menu.nodeId)
  if (node === undefined) {
    return h.empty
  }
  const actions: Array<{ label: string; message: Message }> = []
  if (node.type === 'Reroute') {
    actions.push({
      label: 'Convert to Named Reroute',
      message: Message.ConvertedRerouteToNamed({ nodeId: node.id }),
    })
  }
  if (node.type === 'NamedRerouteDeclaration') {
    actions.push({
      label: 'Add Usage',
      message: Message.AddedNamedRerouteUsage({ declarationId: node.id }),
    })
    actions.push({
      label: 'Select Usages',
      message: Message.SelectedRerouteUsages({ declarationId: node.id }),
    })
    actions.push({
      label: 'Convert to Reroute',
      message: Message.ConvertedNamedRerouteToReroute({ nodeId: node.id }),
    })
  }
  if (node.type === 'NamedRerouteUsage') {
    actions.push({
      label: 'Select Declaration',
      message: Message.SelectedRerouteDeclaration({ usageId: node.id }),
    })
    actions.push({
      label: 'Convert to Reroute',
      message: Message.ConvertedNamedRerouteToReroute({ nodeId: node.id }),
    })
  }
  if (model.selectedNodeIds.length >= 2) {
    actions.push(
      { label: 'Align left', message: Message.AlignedNodes({ mode: 'left' }) },
      {
        label: 'Align center',
        message: Message.AlignedNodes({ mode: 'centerX' }),
      },
      {
        label: 'Align right',
        message: Message.AlignedNodes({ mode: 'right' }),
      },
      { label: 'Align top', message: Message.AlignedNodes({ mode: 'top' }) },
      {
        label: 'Align middle',
        message: Message.AlignedNodes({ mode: 'centerY' }),
      },
      {
        label: 'Align bottom',
        message: Message.AlignedNodes({ mode: 'bottom' }),
      },
    )
  }
  if (model.selectedNodeIds.length >= 3) {
    actions.push(
      {
        label: 'Distribute horizontally',
        message: Message.DistributedNodes({ axis: 'horizontal' }),
      },
      {
        label: 'Distribute vertically',
        message: Message.DistributedNodes({ axis: 'vertical' }),
      },
    )
  }
  return h.div(
    [
      h.Class(
        'context-menu fixed z-30 w-56 max-h-80 overflow-auto bg-[#12151c]/95 backdrop-blur border border-[#232a36] rounded-xl shadow-2xl shadow-black/50 flex flex-col py-1',
      ),
      h.Style({ left: `${menu.clientX}px`, top: `${menu.clientY}px` }),
    ],
    [
      h.div(
        [
          h.Class(
            'px-3 py-1.5 mb-1 text-[10px] font-mono uppercase tracking-wide text-neutral-500 border-b border-[#232a36]',
          ),
        ],
        [
          `${node.id} · ${isNodeType(node.type) ? NODE_REGISTRY[node.type].label : node.type}`,
        ],
      ),
      ...actions.map(action =>
        h.button(
          [
            h.OnClick(action.message),
            h.Class(
              'context-menu-item mx-1 px-2 py-1.5 rounded-lg text-left hover:bg-sky-500/10 hover:text-sky-200 text-[12.5px] text-neutral-200 transition-colors',
            ),
          ],
          [action.label],
        ),
      ),
      h.button(
        [
          h.OnClick(Message.DismissedNodeMenu()),
          h.Class(
            'context-menu-item mx-1 mt-1 px-2 py-1.5 rounded-lg text-left hover:bg-neutral-800/70 text-[12.5px] text-neutral-500 hover:text-neutral-300 border-t border-[#232a36] transition-colors',
          ),
        ],
        ['Dismiss'],
      ),
    ],
  )
}

function rerouteNodeView(
  model: Model,
  h: HtmlBuilder<Message>,
  node: EditorNode,
  status: NodeStatus,
  highlighted: boolean,
): ReturnType<HtmlBuilder<Message>['g']> {
  const selected = model.selectedNodeIds.includes(node.id)
  const size = REROUTE_SIZE
  const isDeclaration = node.type === 'NamedRerouteDeclaration'
  const isUsage = node.type === 'NamedRerouteUsage'
  const declarationId = isDeclaration
    ? node.id
    : isUsage
      ? declarationOfUsage(model, node.id)
      : null
  const name = declarationId === null ? '' : rerouteName(model, declarationId)
  const fill = isDeclaration ? '#7c3aed' : isUsage ? '#2563eb' : '#1a2029'
  const stroke = selected
    ? HIGHLIGHT_COLOR
    : status === 'error'
      ? '#f85149'
      : status === 'warning'
        ? '#d29922'
        : isDeclaration || isUsage
          ? '#8b5cf6'
          : '#39424f'
  return h.g(
    [h.Transform(`translate(${node.position.x},${node.position.y})`)],
    [
      selected || highlighted
        ? h.circle([
            h.Cx(String(size / 2)),
            h.Cy(String(size / 2)),
            h.R(String(size / 2 + 3)),
            h.Fill('none'),
            h.Stroke(HIGHLIGHT_COLOR),
            h.StrokeWidth('2'),
            ...(selected ? [] : [h.StrokeDasharray('6 4')]),
          ])
        : h.empty,
      h.circle([
        h.Cx(String(size / 2)),
        h.Cy(String(size / 2)),
        h.R(String(size / 2)),
        h.Fill(fill),
        h.Stroke(stroke),
        h.StrokeWidth('1.5'),
        h.Cursor('grab'),
        h.OnClick(Message.SelectedNode({ nodeId: node.id })),
        h.OnPointerDown(
          (_pointerType, button, sx, sy, _timeStamp, clientX, clientY) => {
            if (button === 0) {
              return Option.some(
                Message.StartedNodeDrag({ nodeId: node.id, x: sx, y: sy }),
              )
            }
            if (button === 2) {
              return Option.some(
                Message.OpenedNodeMenu({ nodeId: node.id, clientX, clientY }),
              )
            }
            return Option.none()
          },
        ),
      ]),
      h.circle([
        h.Cx('0'),
        h.Cy(String(size / 2)),
        h.R('5'),
        h.Fill(typeColor('float')),
        h.Stroke('#0a0c10'),
        h.StrokeWidth('2'),
        h.PointerEvents('none'),
      ]),
      h.circle([
        h.Cx(String(size)),
        h.Cy(String(size / 2)),
        h.R('5'),
        h.Fill(typeColor('float')),
        h.Stroke('#0a0c10'),
        h.StrokeWidth('2'),
        h.PointerEvents('none'),
      ]),
      name !== ''
        ? h.text(
            [
              h.X(String(size / 2)),
              h.Y('-6'),
              h.Fill('#c9d1d9'),
              h.FontSize('11'),
              h.TextAnchor('middle'),
              h.PointerEvents('none'),
            ],
            [name],
          )
        : h.empty,
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
  if (isRerouteType(node.type)) {
    return rerouteNodeView(model, h, node, status, highlighted)
  }
  const selected = model.selectedNodeIds.includes(node.id)
  const height = nodeHeight(node.type)
  const label = isNodeType(node.type)
    ? NODE_REGISTRY[node.type].label
    : node.type
  const category = isNodeType(node.type)
    ? NODE_REGISTRY[node.type].category
    : 'Utility'
  const inputs = isNodeType(node.type) ? NODE_REGISTRY[node.type].inputs : []
  const outputs = isNodeType(node.type) ? NODE_REGISTRY[node.type].outputs : []
  const emphasised = status === 'error' || status === 'warning'
  const headerColor =
    status === 'error'
      ? '#f85149'
      : status === 'warning'
        ? '#d29922'
        : categoryColor(category)
  return h.g(
    [
      h.Transform(`translate(${node.position.x},${node.position.y})`),
      h.Class('node-card'),
    ],
    [
      h.rect([
        h.X('0'),
        h.Y('0'),
        h.Width(String(NODE_W)),
        h.Height(String(height)),
        h.Rx('10'),
        h.Fill('#12151c'),
        h.Stroke(
          status === 'error'
            ? '#f85149'
            : status === 'warning'
              ? '#d29922'
              : '#272e3a',
        ),
        h.StrokeWidth(emphasised ? '1.5' : '1'),
        h.OnClick(Message.SelectedNode({ nodeId: node.id })),
      ]),
      selected
        ? h.rect([
            h.X('-4'),
            h.Y('-4'),
            h.Width(String(NODE_W + 8)),
            h.Height(String(height + 8)),
            h.Rx('13'),
            h.Fill('none'),
            h.Stroke(HIGHLIGHT_COLOR),
            h.StrokeWidth('2'),
          ])
        : highlighted
          ? h.rect([
              h.X('-4'),
              h.Y('-4'),
              h.Width(String(NODE_W + 8)),
              h.Height(String(height + 8)),
              h.Rx('13'),
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
        h.Rx('10'),
        h.Fill(headerColor),
        h.FillOpacity(status === 'initial' ? '0.14' : '0.24'),
        h.Cursor('grab'),
        h.OnPointerDown((_t, button, sx, sy) =>
          button === 0
            ? Option.some(
                Message.StartedNodeDrag({ nodeId: node.id, x: sx, y: sy }),
              )
            : Option.none(),
        ),
      ]),
      h.rect([
        h.X('1'),
        h.Y(String(HEADER_H - 2)),
        h.Width(String(NODE_W - 2)),
        h.Height('2'),
        h.Fill(headerColor),
        h.FillOpacity('0.55'),
        h.PointerEvents('none'),
      ]),
      h.text(
        [
          h.X('11'),
          h.Y('20'),
          h.Fill('#f0f6fc'),
          h.FontSize('12.5'),
          h.FontWeight('600'),
          h.PointerEvents('none'),
        ],
        [label],
      ),
      h.text(
        [
          h.X(String(NODE_W - 11)),
          h.Y('19.5'),
          h.Fill('#77839a'),
          h.FontSize('10'),
          h.FontFamily('ui-monospace, monospace'),
          h.TextAnchor('end'),
          h.PointerEvents('none'),
        ],
        [node.id],
      ),
      ...inputs.flatMap((port, i) => {
        const y = portY(node.type, i)
        const armed = model.pending.active
        return [
          h.circle([
            h.Cx('0'),
            h.Cy(String(y)),
            h.R(armed ? '8.5' : '6.5'),
            h.Fill(typeColor(port.valueType)),
            h.Stroke('#0a0c10'),
            h.StrokeWidth('2'),
            h.Cursor('pointer'),
            h.Class('graph-port graph-port-in'),
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
                if (button !== 0) {
                  return Option.none()
                }
                const start = pointerToWorld(model, target, clientX, clientY)
                return Option.some(
                  Message.StartedWireDrag({
                    nodeId: node.id,
                    port: port.name,
                    direction: 'in',
                    screenX,
                    screenY,
                    worldX: start.x,
                    worldY: start.y,
                    clientX,
                    clientY,
                  }),
                )
              },
            ),
            h.OnPointerUp(() =>
              Option.some(
                Message.DroppedWireOnPort({ nodeId: node.id, port: port.name }),
              ),
            ),
          ]),
          h.text(
            [
              h.X('15'),
              h.Y(String(y + 4)),
              h.Fill('#97a3b4'),
              h.FontSize('11'),
              h.PointerEvents('none'),
            ],
            [port.name],
          ),
        ]
      }),
      ...(node.type === 'Float'
        ? [
            h.text(
              [
                h.X('15'),
                h.Y(String(portY(node.type, 0) + 4)),
                h.Fill('#cdd6e4'),
                h.FontSize('11'),
                h.FontFamily('ui-monospace, monospace'),
                h.PointerEvents('none'),
              ],
              [
                String(
                  typeof node.params.value === 'number' ? node.params.value : 0,
                ),
              ],
            ),
          ]
        : []),
      ...outputs.flatMap((port, i) => {
        const y = portY(node.type, i)
        const isArmed =
          model.pending.active &&
          model.pending.fromNodeId === node.id &&
          model.pending.fromPort === port.name
        return [
          h.text(
            [
              h.X(String(NODE_W - 15)),
              h.Y(String(y + 4)),
              h.Fill('#97a3b4'),
              h.FontSize('11'),
              h.TextAnchor('end'),
              h.PointerEvents('none'),
            ],
            [port.name],
          ),
          h.circle([
            h.Cx(String(NODE_W)),
            h.Cy(String(y)),
            h.R(isArmed ? '9.5' : '6.5'),
            h.Fill(typeColor(port.valueType)),
            h.Stroke(isArmed ? '#ffffff' : '#0a0c10'),
            h.StrokeWidth('2'),
            h.Cursor('pointer'),
            h.Class('graph-port graph-port-out'),
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
                if (button !== 0) {
                  return Option.none()
                }
                const start = pointerToWorld(model, target, clientX, clientY)
                return Option.some(
                  Message.StartedWireDrag({
                    nodeId: node.id,
                    port: port.name,
                    direction: 'out',
                    screenX,
                    screenY,
                    worldX: start.x,
                    worldY: start.y,
                    clientX,
                    clientY,
                  }),
                )
              },
            ),
            h.OnPointerUp(() =>
              Option.some(
                Message.DroppedWireOnPort({ nodeId: node.id, port: port.name }),
              ),
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
  const selectedCollapsed = model.collapsed.find(
    entry => entry.id === Option.getOrNull(model.selectedCollapsedId),
  )
  if (selectedCollapsed !== undefined) {
    return collapsedInspector(h, selectedCollapsed)
  }
  const selected = model.nodes.find(n => n.id === model.selectedNodeIds[0])
  return h.div(
    [h.Class('px-4 py-3.5 border-b border-[#161c26] max-h-64 overflow-auto')],
    [
      h.div(
        [
          h.Class(
            'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500 mb-3',
          ),
        ],
        ['Inspector'],
      ),
      selected === undefined
        ? h.div(
            [h.Class('text-neutral-500')],
            ['Select a node to edit its values.'],
          )
        : isRerouteType(selected.type)
          ? rerouteInspector(h, model, selected)
          : inspectorFor(h, selected),
    ],
  )
}

const INSPECTOR_BUTTON =
  'bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded px-3 py-1'

function rerouteInspector(
  h: HtmlBuilder<Message>,
  model: Model,
  node: EditorNode,
): ReturnType<HtmlBuilder<Message>['div']> {
  if (node.type === 'NamedRerouteDeclaration') {
    return h.div(
      [h.Class('flex flex-col gap-2')],
      [
        h.div(
          [h.Class('text-neutral-400')],
          [`Reroute Declaration (${node.id})`],
        ),
        h.label(
          [h.Class('flex items-center gap-2')],
          [
            h.span([h.Class('w-12 text-neutral-400')], ['Name']),
            h.input([
              h.Type('text'),
              h.Value(rerouteName(model, node.id)),
              h.OnInput(name =>
                Message.RenamedReroute({ declarationId: node.id, name }),
              ),
              h.Class(
                'w-full bg-[#12151c] border border-[#232a36] rounded-md px-2.5 py-1.5 text-[12.5px] text-neutral-100 focus:outline-none focus:border-sky-500/50 transition-colors',
              ),
              h.AriaLabel('Reroute name'),
            ]),
          ],
        ),
        h.button(
          [
            h.OnClick(
              Message.AddedNamedRerouteUsage({ declarationId: node.id }),
            ),
            h.Class(INSPECTOR_BUTTON),
          ],
          ['Add usage'],
        ),
        h.button(
          [
            h.OnClick(
              Message.SelectedRerouteUsages({ declarationId: node.id }),
            ),
            h.Class(INSPECTOR_BUTTON),
          ],
          ['Select usages'],
        ),
        h.button(
          [
            h.OnClick(
              Message.ConvertedNamedRerouteToReroute({ nodeId: node.id }),
            ),
            h.Class(INSPECTOR_BUTTON),
          ],
          ['Convert to reroute'],
        ),
        h.button(
          [
            h.OnClick(Message.RequestedDeleteSelection()),
            h.Class(
              'bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 rounded-md px-3 py-1.5 transition-colors',
            ),
          ],
          ['Delete node'],
        ),
      ],
    )
  }
  if (node.type === 'NamedRerouteUsage') {
    const declarationId = declarationOfUsage(model, node.id)
    const name =
      declarationId === null ? 'Reroute' : rerouteName(model, declarationId)
    return h.div(
      [h.Class('flex flex-col gap-2')],
      [
        h.div([h.Class('text-neutral-400')], [`Reroute Usage (${node.id})`]),
        h.div(
          [h.Class('text-neutral-500 text-xs')],
          [`Declaration: ${declarationId ?? 'none'} · ${name}`],
        ),
        h.button(
          [
            h.OnClick(Message.SelectedRerouteDeclaration({ usageId: node.id })),
            h.Class(INSPECTOR_BUTTON),
          ],
          ['Select declaration'],
        ),
        h.button(
          [
            h.OnClick(
              Message.ConvertedNamedRerouteToReroute({ nodeId: node.id }),
            ),
            h.Class(INSPECTOR_BUTTON),
          ],
          ['Convert to reroute'],
        ),
        h.button(
          [
            h.OnClick(Message.RequestedDeleteSelection()),
            h.Class(
              'bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 rounded-md px-3 py-1.5 transition-colors',
            ),
          ],
          ['Delete node'],
        ),
      ],
    )
  }
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div([h.Class('text-neutral-400')], [`Reroute (${node.id})`]),
      h.button(
        [
          h.OnClick(Message.ConvertedRerouteToNamed({ nodeId: node.id })),
          h.Class(INSPECTOR_BUTTON),
        ],
        ['Convert to Named Reroute'],
      ),
      h.button(
        [
          h.OnClick(Message.RequestedDeleteSelection()),
          h.Class('bg-red-900 hover:bg-red-800 text-white rounded px-3 py-1'),
        ],
        ['Delete node'],
      ),
    ],
  )
}

function collapsedInspector(
  h: HtmlBuilder<Message>,
  entry: CollapsedNode,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [h.Class('px-4 py-3.5 border-b border-[#161c26] max-h-64 overflow-auto')],
    [
      h.div(
        [
          h.Class(
            'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500 mb-3',
          ),
        ],
        ['Collapsed Nodes'],
      ),
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.label(
            [h.Class('flex items-center gap-2')],
            [
              h.span([h.Class('w-12 text-neutral-400')], ['Name']),
              h.input([
                h.Type('text'),
                h.Value(entry.name),
                h.OnInput(name =>
                  Message.RenamedCollapsed({ collapsedId: entry.id, name }),
                ),
                h.Class(
                  'w-full bg-[#12151c] border border-[#232a36] rounded-md px-2.5 py-1.5 text-[12.5px] text-neutral-100 focus:outline-none focus:border-sky-500/50 transition-colors',
                ),
                h.AriaLabel('Collapsed name'),
              ]),
            ],
          ),
          h.div(
            [h.Class('text-neutral-500 text-xs')],
            [
              `${entry.nodeIds.length} hidden node${entry.nodeIds.length === 1 ? '' : 's'}`,
            ],
          ),
          h.button(
            [
              h.OnClick(Message.ExpandedCollapsed({ collapsedId: entry.id })),
              h.Class(INSPECTOR_BUTTON),
            ],
            ['Expand'],
          ),
          h.button(
            [
              h.OnClick(Message.RequestedDeleteSelection()),
              h.Class(
                'bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 rounded-md px-3 py-1.5 transition-colors',
              ),
            ],
            ['Delete container'],
          ),
        ],
      ),
    ],
  )
}

function groupInspector(
  h: HtmlBuilder<Message>,
  group: Group,
): ReturnType<HtmlBuilder<Message>['div']> {
  return h.div(
    [h.Class('px-4 py-3.5 border-b border-[#161c26] max-h-64 overflow-auto')],
    [
      h.div(
        [
          h.Class(
            'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500 mb-3',
          ),
        ],
        ['Group'],
      ),
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
                  'w-full bg-[#12151c] border border-[#232a36] rounded-md px-2.5 py-1.5 text-[12.5px] text-neutral-100 focus:outline-none focus:border-sky-500/50 transition-colors',
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
          h.button(
            [
              h.OnClick(Message.OpenedGroupColorPicker({ groupId: group.id })),
              h.Class(
                'self-start text-[11.5px] text-sky-300 hover:bg-sky-500/10 border border-transparent rounded-md px-2 py-0.5 transition-colors',
              ),
              h.AriaLabel(`Open custom color picker for ${group.name}`),
              h.Title('Pick any color'),
            ],
            ['Custom…'],
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
                'bg-[#1a2029] hover:bg-[#232b37] border border-[#2a3240] rounded-md px-3 py-1.5 text-[12.5px] text-neutral-200 transition-colors',
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
                'w-full bg-[#12151c] border border-[#232a36] rounded-md px-2.5 py-1.5 text-[12.5px] text-neutral-100 focus:outline-none focus:border-sky-500/50 transition-colors',
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
            'bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 rounded-md px-3 py-1.5 mt-1 transition-colors',
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
    [h.Class('px-4 py-3.5 border-b border-[#161c26] flex flex-col min-h-0')],
    [
      h.div(
        [h.Class('flex items-center mb-3')],
        [
          h.span(
            [
              h.Class(
                'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500',
              ),
            ],
            ['Generated HLSL'],
          ),
          h.button(
            [
              h.OnClick(Message.RequestedCopyHlsl()),
              h.Class(
                'ml-auto text-[11.5px] text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800/80 border border-transparent rounded-md px-2 py-0.5 transition-colors',
              ),
              h.AriaLabel('Copy HLSL'),
              h.Title('Copy generated HLSL'),
            ],
            ['Copy'],
          ),
        ],
      ),
      result.ok
        ? h.div(
            [
              h.Class(
                'rounded-xl border border-[#1c2230] overflow-hidden bg-[#0a0c10]',
              ),
            ],
            [
              h.div(
                [
                  h.Class(
                    'flex items-center gap-1.5 px-3 py-2 bg-[#12151c] border-b border-[#1c2230]',
                  ),
                ],
                [
                  h.span([h.Class('w-2 h-2 rounded-full bg-[#ff5f57]')]),
                  h.span([h.Class('w-2 h-2 rounded-full bg-[#febc2e]')]),
                  h.span([h.Class('w-2 h-2 rounded-full bg-[#28c840]')]),
                  h.span(
                    [h.Class('ml-1.5 text-[10px] font-mono text-neutral-500')],
                    ['fragment.hlsl'],
                  ),
                ],
              ),
              h.pre(
                [
                  h.Class(
                    'p-3 overflow-auto text-[11.5px] leading-relaxed font-mono text-emerald-300/90 whitespace-pre-wrap',
                  ),
                ],
                [result.code],
              ),
            ],
          )
        : h.div(
            [
              h.Class(
                'bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-[12.5px] text-red-300',
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
    [h.Class('px-4 py-3.5 flex-1 overflow-auto min-h-0')],
    [
      h.div(
        [
          h.Class(
            'text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500 mb-3',
          ),
        ],
        [`Problems (${errors.length})`],
      ),
      errors.length === 0
        ? h.div([h.Class('text-[12px] text-neutral-600')], ['No problems.'])
        : h.div(
            [h.Class('flex flex-col gap-1.5')],
            errors.map(error =>
              h.div(
                [
                  h.Class(
                    'bg-[#12151c] border border-[#232a36] rounded-md px-2.5 py-2 flex items-start gap-2',
                  ),
                ],
                [
                  h.span(
                    [
                      h.Class(
                        'text-[9.5px] font-mono px-1.5 py-0.5 rounded bg-red-500/10 text-red-300 border border-red-500/25 shrink-0 mt-0.5',
                      ),
                    ],
                    [error.code],
                  ),
                  h.span(
                    [
                      h.Class(
                        'text-[12px] text-neutral-300 whitespace-pre-line flex-1',
                      ),
                    ],
                    [error.message],
                  ),
                  error.nodeId !== undefined
                    ? h.button(
                        [
                          h.OnClick(
                            Message.SelectedNode({ nodeId: error.nodeId }),
                          ),
                          h.Class(
                            'shrink-0 mt-0.5 text-[10.5px] font-mono text-sky-400 hover:text-sky-300 bg-sky-500/10 border border-sky-500/25 rounded px-1.5 py-0.5 transition-colors',
                          ),
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
        'h-9 shrink-0 flex items-center gap-2.5 px-4 border-t border-[#1c2230] bg-[#0e1116] text-[11.5px] text-neutral-400',
      ),
    ],
    [
      h.span([
        h.Class(
          pending === ''
            ? 'w-1.5 h-1.5 rounded-full bg-emerald-400/80'
            : 'w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse',
        ),
      ]),
      h.span([h.Class('truncate')], [pending === '' ? 'Ready.' : pending]),
      h.span(
        [h.Class('ml-auto shrink-0 text-neutral-600')],
        [
          'Del delete · Ctrl+G group · Ctrl+C/V copy · right-click canvas to add',
        ],
      ),
    ],
  )
}
