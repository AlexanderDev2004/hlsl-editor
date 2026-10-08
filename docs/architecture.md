# Architecture — HLSL Graph Editor (MVP 1)

## Pipeline

```
Graph Editor (Foldkit SVG, apps/web)
  ↓  Messages (add/move/connect/...)
Graph Model (packages/graph — nodes/edges/ports, positions)
  ↓
Type System (packages/shader-types — float..float4, canConnect)
  ↓
Validation (packages/shader-compiler/validate — structured errors)
  ↓
Graph IR (packages/shader-compiler/ir — no UI state)
  ↓
HLSL Generator (packages/shader-compiler/hlsl — deterministic, CSE)
  ↓
HLSL Code (pre panel + copy)
```

## Package boundaries

- `packages/shader-types`: `HlslType`, `canConnect`, `describeType`, `FUTURE_TYPES` (bool/int/uint/half/matrix/texture/sampler → always reject in MVP1 with clear message). No dependencies.
- `packages/graph`: `Graph/Node/Port/Edge` types, `createGraph/addNode/removeNode/addEdge/removeEdge/setNodeParam/setNodePosition`, `topoSort`, `detectCycle`, `serialize(v1)/deserialize+migrate`. Depends on `shader-types` for port types only.
- `packages/shader-nodes`: `NodeDefinition` registry + MVP1 defs: `Float,Float2,Float3,Float4,Add,Subtract,Multiply,Divide,Split,Combine,FragmentOutput`. Each def: `inputs/outputs/defaults`. Depends on `graph` + `shader-types`.
- `packages/shader-compiler`: `validate(graph,registry)→CompilerError[]`, `toIR→IR`, `generateHLSL→{code}|{errors}`. Depends on `graph/shader-nodes/shader-types`. Pure functions; no Effect, no Foldkit.
- `packages/hlsl`: string helpers (`floatLit`, `vecCtor`, `swizzle`). Reserved for MVP2 texture/matrix helpers.
- `packages/wgsl`: stub type map only (`float→f32` etc.), no codegen — MVP3 seam.
- `apps/web` (Foldkit): `Model/Message/update/view`, SVG canvas, HLSL panel, Problems panel, undo/redo (graph snapshots), localStorage + JSON import/export Commands. Imports pure packages; never the reverse.

## Domain model (MVP1)

- Graph: `{ version:1, nodes: Node[], edges: Edge[], outputNodeId: string|null }`.
- Node: `{ id, type, position:{x,y}, params: Record<string,number|number[]> }` (ports derived from registry + params; stored ports optional for serialization compat).
- Port (derived): `{ id:`${nodeId}:${name}`, name, direction:'in'|'out', valueType:HlslType, required:boolean, defaultValue? }`.
- Edge: `{ id, source:{nodeId,port}, target:{nodeId,port} }`. Invariants: one edge per input port; both endpoints exist; output→input direction; no self-loop; `canConnect` passes; acyclic.

## Type conversion (MVP1)

- Pass: exact match; `float→float2/3/4` (emit `floatN(s,s,...)` splat at use site).
- Reject: `floatN→float`, `floatN→floatM` (N≠M), any future type. Error: `Type mismatch: Expected {expected}, Received {actual}` + `InvalidConnection/TypeMismatch` code with `nodeId/portId`.

## IR (UI-free)

```ts
interface IRNode {
  id: string;
  op: NodeType;
  outType: HlslType;
  inputs: (IRRef | Literal)[];
}
interface IR {
  nodes: IRNode[];
  output: { nodeId: string; source: IRRef };
  varOf: Record<string, string>;
}
```

Built by topo walk from `FragmentOutput`; nodes unreachable from output excluded (but reported as unused, not errors). Sorted by node id at each level for determinism.

## HLSL generation

- Emit `float _0 = 2.0;`-style lets in topo order, then `float4 _out = ...; return _out;`-equivalent expression. Same graph → byte-identical output. Invalid graph → return errors, emit nothing.
- Example: `Float(2) ─┐ ├─Multiply→FragmentOutput` / `Float(5) ─┘` gives `float _0 = 2.0; float _1 = 5.0; float _2 = _0 * _1; …`.

## Errors

`{ code: 'InvalidConnection'|'TypeMismatch'|'MissingRequiredInput'|'MissingOutput'|'InvalidGraph'|'CycleDetected', message, nodeId?, portId? }`. UI highlights node/port by id.

## Undo/redo & persistence

- History: stack of serialized graphs (cap 100), push on commit ops (add/delete/move-end/value/connect/disconnect); move drag pushes once on pointer-up.
- Persistence: `localStorage key hlsl-editor:graph:v1`; Export downloads `graph.json`; Import validates version + migrates.

## Future seams

- MVP2: add `Texture2D/UV/Sample` types + nodes; `hlsl/` gains sampler boilerplate; IR gains `resources[]`.
- MVP3: `wgsl/` codegen + WebGPU preview canvas behind feature flag; engine untouched.
- MVP4: functions/structs/matrices — registry + type enum extensions only.
