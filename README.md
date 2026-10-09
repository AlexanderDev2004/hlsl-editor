# HLSL Editor

## 1. Project

HLSL Editor is a web-based **HLSL visual graph editor simulator**. Users build a
small shader graph from typed nodes, the graph is validated, and deterministic
HLSL code is generated from it. It is a clean, extensible foundation — not a
full Unity Shader Graph clone.

## 2. Goal

Visually create a small shader graph, validate types and connections, and
generate HLSL. The pipeline is:

```
Graph -> Type System -> Validation -> Graph IR -> HLSL Generator
```

The graph/compiler engine is framework-independent (plain TypeScript packages)
so a different frontend could reuse it later. Foldkit is the application/UI
layer only.

## 3. Tech Stack

| Tool           | Version (verified)         | Notes                                                            |
| -------------- | -------------------------- | ---------------------------------------------------------------- |
| Foldkit        | 0.166.0                    | Elm-architecture UI on Effect; `npx create-foldkit-app` scaffold |
| TypeScript     | 7.0.2                      | `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`         |
| Effect         | 4.0.0 (app), 4.0.1 (infra) | Commands in Foldkit; Alchemy stack                               |
| Vite           | 8.3.3                      | dev + build, `@foldkit/vite-plugin`, `@tailwindcss/vite`         |
| Tailwind CSS   | 4.3.3                      | developer-tool styling                                           |
| pnpm           | 12.10.1                    | workspace monorepo                                               |
| Vitest         | 5.0.3                      | unit + Foldkit story/scene tests (`happy-dom`)                   |
| Oxlint / Oxfmt | 1.87.0 / 0.66.0            | `pnpm lint`, `pnpm format` (incl. `@foldkit/oxlint-plugin`)      |
| Alchemy        | 2.0.0-beta.81              | `Cloudflare.Website.Foldkit` resource, `infra/alchemy.ts`        |
| Cloudflare     | Workers static assets      | SPA fallback to `index.html`; target domain below                |

## 4. Requirements

- **Node.js**: 22 LTS. Foldkit docs require >= 22.22.2; the Alchemy CLI
  requires >= 22.15 (it refuses to run on older 22.x). This repo was built
  with Node v22.14.0 — upgrade before running `alchemy` commands.
- **pnpm**: 12.10.1 (`corepack` or standalone install).
- **Git**: any recent version.
- **Cloudflare account**: only needed for deployment (`alchemy login` +
  a zone for the custom domain). Not needed for development, tests, or build.

No secrets, tokens, or credentials are stored in this repo.

## 5. Installation

```sh
cd hlsl-editor
pnpm install
```

## 6. Development

Run the web application locally (Vite dev server with Foldkit HMR):

```sh
pnpm dev
# or: pnpm --filter web dev
```

Open the printed `http://localhost:<port>/` URL. A demo graph
(`Float(2) * Float(5)` -> Fragment Output) is seeded on first run.

## 7. Build

Production build of the web app:

```sh
pnpm build
# preview the production bundle:
pnpm preview
```

## 8. Deployment

`infra/alchemy.ts` declares a `Cloudflare.Website.Foldkit` resource with
`rootDir: "apps/web"`. Alchemy runs the app's own Vite build and serves the
output from a Worker; SPA deep links fall back to `index.html` by default.

```sh
pnpm deploy        # alchemy deploy infra/alchemy.ts
pnpm dev:infra     # alchemy dev infra/alchemy.ts (local, with HMR)
```

Expected domain: **https://hlsleditor.alexanderar.com**

To enable it, add `domain: "hlsleditor.alexanderar.com"` to the resource in
`infra/alchemy.ts` (already present as a comment). Prerequisites:

1. `alchemy login` (or `pnpm alchemy login`) with the Cloudflare account.
2. The `alexanderar.com` zone exists in that account (Alchemy provisions
   DNS + certificate from the hostname).
3. Node >= 22.15 for the Alchemy CLI.

The checked-in config deploys without the domain (workers.dev URL) and
typechecks cleanly; no live deploy has been performed yet.

## 9. Project Structure

```
hlsl-editor/
  apps/web/               # Foldkit SPA: Model/Message/update/view, SVG canvas
    src/editor/           # model.ts message.ts commands.ts update.ts view.ts subscriptions.ts
    src/main.ts           # pure app surface (tests import this, never entry.ts)
    src/entry.ts          # Runtime.makeApplication + run (side effects only here)
  packages/
    shader-types/         # float..float4, canConnect, future-type rejections
    graph/                # Graph/Node/Port/Edge, topo sort, cycle detection, v1 serialization
    shader-nodes/         # registry + MVP1 node definitions
    shader-compiler/      # validate -> IR -> deterministic HLSL (pure, UI-free)
    hlsl/                 # HLSL string helpers (literals, constructors, swizzles)
    wgsl/                 # MVP3 seam: type map only, no codegen
  infra/alchemy.ts        # Cloudflare deployment (statically validated)
  docs/research.md        # Phase-0 research + sources
  docs/architecture.md    # package boundaries, IR, error model
```

`packages/*` never import Foldkit. `apps/web` never leaks viewport/selection
into the compiler — the IR carries no UI state.

## 10. Architecture

```
Graph Editor (Foldkit SVG canvas)
  -> Graph Model (nodes, edges, ports, params)
  -> Type System (exact match; float -> float2/3/4 splat; all else rejected)
  -> Validation (InvalidConnection, TypeMismatch, MissingRequiredInput,
                 MissingOutput, InvalidGraph, CycleDetected)
  -> Graph IR (dependency-ordered, UI-free)
  -> HLSL Generator (topo walk from Fragment Output, CSE via _n lets,
                      byte-identical output for the same graph)
```

The generated file is a complete pixel shader: the body is wrapped in a
`float4 main() : SV_Target` entry point per the HLSL docs (SV_Target marks
the render-target output; `main` is the default entry point for fxc/dxc, so
the file compiles with no extra flags).

Connections are made by clicking an output port then an input port.
`float -> floatN` inserts a splat constructor; `floatN -> float` is rejected
(use Split). Invalid graphs produce structured errors and no HLSL.

Reroute nodes (plain and named) are organizing constructs that are transparent
to the compiler: the emitter assigns them no variable and resolves consumers
straight to the upstream expression, so the generated HLSL is byte-identical to
the same graph without them. Named-reroute declaration/usage pairs keep their
link as a hidden edge, which lets topo sort, reachability and cycle detection
work unchanged.

## 11. MVP 1

- Nodes: Float, Float2, Float3, Float4, Add, Subtract, Multiply, Divide,
  Split, Combine, Reroute, Fragment Output.
- Canvas: create, move (drag), delete, connect, select, zoom (slider/reset),
  pan (middle-drag). Left-drag on empty canvas draws a marquee that selects
  every node it overlaps. Ports are color-coded by type; invalid edges and
  nodes are highlighted red.
- Add nodes from the toolbar palette, or right-click empty canvas for a
  Unreal-Blueprint-style menu: a search box plus the node list, inserting the
  chosen node at the click point.
- Reroute nodes (Unreal-style organization): double-click a wire to insert a
  small pass-through reroute at that point, then drag it to reshape the wire.
  Reroutes are transparent to validation and codegen — the generated HLSL is
  byte-identical to a direct wire. Right-click a reroute (or use its
  Inspector) to convert it to a Named Reroute, add usages, rename it, and
  select its usages/declaration. A named reroute keeps its link as a hidden
  edge, so it is likewise fully transparent in the HLSL.
- Align & Distribute: with two or more nodes selected, the node context menu
  aligns them left/center/right and top/middle/bottom; with three or more it
  distributes them horizontally or vertically.
- Collapse Nodes: select nodes and press Collapse to hide them behind one
  named container; boundary wires are re-anchored to the container while the
  members stay in the graph, so validation and codegen are unchanged. Rename
  it in the Inspector or Expand to restore the members.
- Copy/paste: `Ctrl/Cmd+C` copies the selected nodes and the wires between
  them, `Ctrl/Cmd+V` pastes duplicates (fresh ids, cascading offset) and
  selects them.
- Grouping: select nodes and press `Ctrl/Cmd+G` (or the Group button) to wrap
  them in a named, colored comment box. Rename and recolor it in the
  Inspector (8 preset swatches, or `Custom…` for a honeycomb picker with
  hex/RGB fields), drag its header to move every member, or press
  `Ctrl/Cmd+Shift+G` (or Ungroup) to remove the frame. A node belongs to at
  most one group; deleting its last member removes the group.
- Node status indicator: every node shows a derived status
  (`initial`/`success`/`warning`/`error`), with `loading` simulated from the
  toolbar in `border` or `overlay` variant.
- Minimap: a thumbnail of the graph and the current viewport, closable with
  its `×` button and reopened with the arrow button.
- Edges: hover a wire to highlight it and the two nodes it connects; click a
  wire to select it and press `Delete` to remove it. Removing a wire keeps its
  nodes, so the same ports can be connected again.
- Editing: numeric values in the Inspector; invalid connections rejected
  with human-readable errors (`Type mismatch: Expected ..., Received ...`).
- Panels: Generated HLSL (copy button, clear error state), Problems list
  (click an id to select the node), status bar.
- Keyboard: `Delete`/`Backspace` delete, `Ctrl/Cmd+C`/`Ctrl/Cmd+V` copy/paste,
  `Ctrl/Cmd+G` group, `Ctrl/Cmd+Shift+G` ungroup, `Ctrl/Cmd+Z` undo,
  `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` redo, `Esc` cancels a pending wire and
  closes the add-node menu. Bindings are suppressed while typing in inputs.
- Settings: the Settings button opens a panel listing every command. Click
  Record and press the keys to rebind; a conflicting binding is rejected, Esc
  cancels recording, and each row has a Reset. A Windows/macOS toggle controls
  how shortcuts are displayed (`Ctrl+G` vs `⌘G`). Custom bindings persist in
  browser storage and load on start.
- Undo/redo for add, delete, move, group/ungroup, value change, connect
  (history is graph-only, capped at 100).
- Save to browser storage, load on start, New, Export JSON, Import JSON
  (`{version: 1, nodes, edges, outputNodeId, rerouteNames, collapsed}`).
  Imported params are sanitized against the node registry: unknown keys and
  non-finite numbers fall back to defaults, so a hand-edited file can never
  produce non-numeric HLSL.
- Play: runs the graph numerically and previews the Fragment Output color in
  a modal — clamped swatch over a checkerboard, raw RGBA readout, hex. Any
  graph edit closes the preview; Esc or the backdrop closes it too.
- Log panel: a session console under the canvas. Every connection attempt
  (success or rejected with its reason), node add/delete, param edit,
  save/load/import, copy, and Play run is logged with a level — error,
  warning, success, info, system — newest first, capped at 200 entries.
  The header shows error/warning counts; Clear empties it and the toolbar
  Log button (or the panel's ✕) toggles it. Logs are session-only: they are
  not saved, exported, or undoable.
- 144 tests: type system, graph, validation, HLSL generation (incl.
  determinism, entry-point emission, and unused-node exclusion), numeric
  evaluation, Foldkit story/scene tests.

## 12. MVP Roadmap

### MVP 1 — Graph -> HLSL (this repo state)

Foundation above. No backend, no auth, no database.

### MVP 2 — Texture + UV + more shader nodes

Add `Texture2D`, UV, Sample nodes; extend `shader-types` with resource types;
sampler boilerplate in `packages/hlsl`; `resources[]` in the IR.

### MVP 3 — WebGPU/WGSL live preview

WGSL codegen in `packages/wgsl` (type map already stubbed) + WebGPU canvas
preview behind a feature flag. Engine packages stay untouched.

### MVP 4 — Advanced shader editor capabilities

Functions, structs, matrices, multi-pass graphs, richer validation.
Registry + type-enum extensions only; no MVP 1 rewrites expected.

## Known limitations

- Node 22.14.0 works for dev/test/build, but Foldkit documents >= 22.22.2
  and the Alchemy CLI requires >= 22.15 — upgrade Node before deploying.
- Dragging a node and releasing outside the canvas can leave a drag active;
  click the canvas to reset it (no pointer-capture yet).
- Pan/zoom are screen-pixel approximations; pinch/wheel gestures are not
  bound (zoom via slider/Reset button).
- `pnpm -r test` prints PowerShell `RemoteException` noise on Windows when
  tools write to stderr; test results themselves are authoritative (114/114).
- Collapse is visual: the member nodes stay in the graph, so a collapsed
  container re-anchors boundary wires rather than exposing its own subgraph
  input/output ports (no collapse-to-function).
