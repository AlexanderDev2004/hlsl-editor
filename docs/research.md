# HLSL Graph Editor — Research

Date: 2026-10-08. Sources are newest official docs; secondary sources used only for practical context.

## 1. HLSL findings (Microsoft Learn, Win32 HLSL reference)

### What HLSL is

High-Level Shading Language for Direct3D programmable pipeline. Authored as typed functions with semantics (`SV_POSITION`, `SV_Target`) connecting vertex/pixel stages; compiled via `dxc`/`fxc` to DXIL/DXBC for specific shader models/targets. MVP1 needs only expression-level generation (no stage boilerplate beyond a fragment epilogue), but architecture must allow full `VS/PS` emission later.

### Scalar types (`dx-graphics-hlsl-scalar`)

- `bool`, `int` (32s), `uint`/`dword` (32u), `half` (16f compat, maps to float on D3D10 targets), `float` (32f), `double` (64f, cannot be VS/PS stream I/O directly — pack via `asuint`/`asdouble`).
- Minimum-precision: `min16float/min10float/min16int/min12int/min16uint` (driver may up-precision; do not rely on wrap/clamp).
- SM 6.0: `int64_t/uint64_t`; SM 6.2 + `-enable-16bit-types`: `float16_t/int16_t/uint16_t` (needs Turing+).
- D3D9 vs 10: `snorm float`/`unorm float` modifiers.
- **MVP1 decision:** support only `float`. Architecture reserves `bool/int/uint/half` slots so future types are additive.

### Vector types (`dx-graphics-hlsl-vector`, `-per-component-math`)

- 1–4 components, homogeneous scalar type: `float2/3/4` or `vector<float,N>` (defaults: `vector` = `float4`, `vector<float16_t>` = 4-comp).
- Constructors: `float3(0.5,0.5,0.5)`, `float3(x,y,z)`, `float4(a,b,c,d)`, brace init `float3 f = {0.2f,0.3f,0.4f}`.
- Swizzle: position set `xyzw` vs color set `rgba`; **cannot mix** (`pos.xg` invalid). Read any order/repeat (`pos.zx`, `pos.xx` valid). Write masking allowed but no duplicate LHS (`f_4D.xx = ...` invalid).
- Per-component arithmetic: `float4 v = a*b` means `v.x=a.x*b.x` etc., not dot product. `mul()` overloads handle vector×matrix cases.
- **MVP1 rules derived:** `float→floatN` via splat constructor is safe; `floatN→float` without explicit component selection is lossy → reject (require Split). Same-dimension `+-*/` is per-component.

### Matrix types (`dx-graphics-hlsl-matrix`)

- `TypeRowsCols` (1–4 each, e.g. `float3x3`) or `matrix<float,R,C>`. Row-major vs column-major packing affects constant registers only, not in-body constructors (always row-major order).
- Access: `_m00…_m33` (0-based), `_11…_44` (1-based), `[r][c]` array notation; `m[0]` returns a row vector. Swizzle across components allowed within one namespace.
- **MVP1 decision:** no matrices; reserve `floatNxM` in type enum for later. Codegen seam (`hlsl/` package) must not assume vector-only forever.

### Textures / resources / samplers (for MVP2 seam)

- `Texture2D/Texture3D/TextureCube`, `SamplerState`, buffers, state objects; declared as globals + sampled in PS. Not implemented in MVP1 — type system has `FutureType` rejection path so `Texture2D→float4` fails with clear message today and becomes valid when sampling nodes land.

### Conversions / arithmetic / functions / stages

- HLSL allows implicit scalar→vector splat in constructors; narrowing vector→scalar requires explicit swizzle/cast — our `canConnect` mirrors this.
- Function syntax: `Ret name(Params : Semantics) : Semantic { body }`. Stages: VS (per-vertex, `SV_POSITION` out) → rasterizer → PS/FS (per-pixel, `SV_Target` out). MVP1 emits only the PS expression body + `return` color; full stage wrappers are MVP3 (WebGPU/WGSL preview) work.

Sources:

- https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-data-types
- https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-scalar
- https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-vector
- https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-matrix
- https://learn.microsoft.com/en-us/windows/win32/direct3dhlsl/dx-graphics-hlsl-per-component-math

## 2. Shader-graph findings (Unity Shader Graph docs v11–14, Unreal/Blender secondary)

- **Node**: operation/input/output + unconnected Controls. **Port**: typed input/output endpoint. **Edge**: directed output→input connection carrying a DataType. **Graph**: nodes + edges + master/output node.
- Unity rules copied: **one edge per input port, many per output port**; unconnected inputs fall back to Default Input (constant field). Port colors encode type.
- Concepts extracted (not copied): typed ports, explicit conversion nodes (Split/Combine/Swizzle), validation pass before codegen, dependency traversal from master node (topological order, not screen position), generated HLSL per-stage, `Copy Shader` inspection equivalent to our HLSL panel.
- Unreal/Blender confirm same pipeline: type-check → DAG walk → IR → emit. Cycles must be rejected (shaders are DAGs).
- Sources:
  - https://docs.unity3d.com/Packages/com.unity.shadergraph@13.0/manual/Port.html
  - https://docs.unity3d.com/Packages/com.unity.shadergraph@13.0/manual/Node.html
  - https://docs.unity3d.com/Packages/com.unity.shadergraph@14.0/manual/Edge.html

## 3. Foldkit findings (foldkit.dev, v0.167.0 pre-1.0, 2026-10-08)

- Elm architecture: single immutable `Model` (`Schema.Struct`), `Message` facts (`defineMessageUnion`), pure `update(model,msg)→{model,commands?}` (`Message.match`, exhaustive), pure `view(model,h:HtmlBuilder)→Document`, one-shot side effects as `Command.define` (+ `Effect`), runtime `Runtime.makeApplication`/`Runtime.run`. Other sources: Browser events, `Mount` (element-scoped imperative), `Subscription` (Model-gated streams, e.g. drag), `ManagedResource` (handles), `Resource` (app singletons).
- Scaffold: `npx create-foldkit-app@latest` (SPA | SSG | SSR). SPA starter gives `src/main.ts` (pure defs), `src/entry.ts` (bootstrap — keep separate so tests import without side effects), `src/styles.css` (Tailwind), `index.html`, `vite.config.ts` (`foldkit()` + `optimizeDeps.entries:["src/entry.ts"]`), `tsconfig.json`, `.oxlintrc.json`/`.oxfmtrc.json`, `AGENTS.md`/`FOLDKIT.md`. Prereq Node `>=22.22.2`. Pins `effect@4.0.0` + `@effect/platform-browser@4.0.0` (stable paths).
- Testing: `foldkit/story` (update state machine) + `foldkit/scene` (view interaction, accessible locators), Vitest runner. DevTools + MCP for message history/rewind.
- Canvas implication: implement drag/pan/zoom with Messages + Subscription (e.g. `user-select:none` while dragging); avoid third-party canvas libs (would need `Mount` wrappers).
- Sources: https://foldkit.dev/, https://foldkit.dev/get-started, https://foldkit.dev/core/architecture

## 4. Alchemy findings (alchemy.run)

- `Cloudflare.Website.Foldkit("Name", { rootDir: "apps/web" })` deploys client-only Vite apps: runs app's own Vite build programmatically, preserves `foldkit()` plugin, uploads assets, serves via Worker. No `main`/build cmd/output dir/`wrangler.jsonc`. Pinned Effect is app-local — Alchemy imposes none.
- SPA default `assets.notFoundHandling: "single-page-application"` (deep links → `index.html`); override `"404-page"` only if shipping real 404. `env: { VITE_X }` baked at build; Worker's own `env` bindings not visible to browser — expose via Worker routes if ever needed (not MVP1).
- `alchemy dev` reuses Vite dev server (HMR/state preservation intact). Custom domain via `domain: "hlsleditor.alexanderar.com"` (zone must pre-exist; cert/DNS provisioned); `workersDev` toggle. Target domain deferred — MVP1 validates config only.
- Incompatible: `@cloudflare/vite-plugin` must be removed (Alchemy ships its own integration).
- Sources: https://alchemy.run/cloudflare/frontend/foldkit/, https://alchemy.run/cloudflare/frontend/vite, https://alchemy.run/cloudflare/networking/custom-domains

## 5. Tech-stack findings

- TypeScript + pnpm workspaces (workspace root `pnpm-workspace.yaml`). Environment here: Node v22.14.0 (below Foldkit's stated 22.22.2 — upgrade before scaffold or accept warning), pnpm 12.10.1.
- Vite ≥6.4, Node ≥22.12 for Vitest (`vitest.dev/guide`). Tailwind via `@tailwindcss/vite` plugin + `@import "tailwindcss"` in CSS.
- Lint/format: Oxlint + Oxfmt (what Foldkit scaffolds: `pnpm lint`, `pnpm format`); `oxlint` recommended dedicated linter, `eslint-plugin-oxlint` only for migration.
- Effect: use where async/runtime effects benefit (Commands, persistence, file I/O); keep graph/compiler pure functions (no Effect needed) per spec rule 9.

## 6. Architectural decisions

1. `packages/*` pure TypeScript, zero Foldkit imports; `apps/web` is the only Foldkit layer. HLSL gen independent of UI.
2. Pipeline `Graph → validate → IR → HLSL`; IR strips `position/selection/viewport`.
3. `canConnect`: exact match pass; `float→floatN` splat pass; everything else (incl. `floatN→float`, future resources) fail with `Type mismatch: Expected X, Received Y`.
4. Codegen: DFS from `FragmentOutput`, topo-sort with id-tiebreak (deterministic), CSE via `_n` lets; invalid graph emits no code.
5. Serialization `{version:1,nodes,edges}` + migrator hook; undo stores graph-only snapshots.
6. Custom SVG canvas (no xyflow) for full Message-driven control.

## 7. Risks / uncertainties

- Foldkit pre-1.0 churn (v0.167.0) — pin version from scaffold, re-verify APIs on upgrade.
- Node 22.14.0 < documented 22.22.2 — may need upgrade for `create-foldkit-app`.
- `create-foldkit-app` non-interactive flags unverified until run — fallback is manual Vite+Foldkit wiring per docs.
- HLSL `double` I/O packing and matrix packing nuances deferred (not MVP1 surface).
