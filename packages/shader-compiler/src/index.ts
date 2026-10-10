import type { Graph } from "@hlsl-editor/graph";
import type { HlslType } from "@hlsl-editor/shader-types";

import { err, type CompilerError } from "./errors";
import { emitFunction, type FunctionDefSource } from "./functions";
import { collectDecls, emitEntryPoint, emitHLSL, SRGB_TO_LINEAR } from "./hlsl-gen";
import { toIR, type GraphIR, type IRNode } from "./ir";
import { validate } from "./validate";

export * from "./errors";
export { upstreamPortType, validate, validateStructure } from "./validate";
export { toIR, type GraphIR, type IRNode } from "./ir";
export { emitHLSL } from "./hlsl-gen";
export {
  emitFunction,
  type FunctionArg,
  type FunctionDefSource,
  type FunctionEmitResult,
} from "./functions";

export type GenerateResult =
  | { ok: true; code: string }
  | { ok: false; errors: Array<CompilerError> };

export interface GenerateOptions {
  /** Material Functions available to FunctionCall nodes. */
  functions?: ReadonlyArray<FunctionDefSource>;
}

// Dependency-based generation: validate -> IR -> HLSL.
// Invalid graphs produce errors, never misleading code.
export function generate(graph: Graph, options?: GenerateOptions): GenerateResult {
  const functions = options?.functions ?? [];
  const errors = validate(graph);
  const byId = new Map(functions.map((f) => [f.id, f]));
  const seenNames = new Set<string>();
  for (const def of functions) {
    if (seenNames.has(def.name)) {
      errors.push(err("InvalidGraph", `Duplicate function name: ${def.name}.`));
    }
    seenNames.add(def.name);
  }
  for (const node of graph.nodes) {
    if (node.type !== "FunctionCall") {
      continue;
    }
    if (byId.get(node.ref ?? "") === undefined) {
      errors.push(
        err("InvalidGraph", `Unknown function reference: ${node.ref ?? node.id}.`, node.id),
      );
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    const ir = toIR(graph);
    const callNodes = ir.nodes.filter((n) => n.op === "FunctionCall");
    if (callNodes.length === 0) {
      return { ok: true, code: emitHLSL(ir) };
    }
    const fnNames = new Map<string, string>();
    for (const call of callNodes) {
      const def = byId.get(call.ref ?? "");
      if (def === undefined) {
        throw new Error(`Unknown function reference: ${call.ref ?? call.id}`);
      }
      fnNames.set(call.ref ?? "", def.name);
    }
    // Assemble: global declarations (hoisted + deduped across the main
    // graph and every used function), then each used function's code once,
    // then the entry point.
    const global = new Set<string>();
    let needsSrgbHelper = false;
    const codes: Array<string> = [];
    const emitted = new Set<string>();
    for (const call of callNodes) {
      const def = byId.get(call.ref ?? "");
      if (def === undefined || emitted.has(def.id)) {
        continue;
      }
      emitted.add(def.id);
      const result = emitFunction(def);
      if (!result.ok) {
        return { ok: false, errors: result.errors };
      }
      for (const decl of result.decls) {
        global.add(decl);
      }
      needsSrgbHelper = needsSrgbHelper || result.needsSrgbHelper;
      codes.push(result.code);
    }
    const { decls, needsSrgbHelper: mainNeedsSrgb } = collectDecls(ir);
    for (const decl of decls) {
      global.add(decl);
    }
    needsSrgbHelper = needsSrgbHelper || mainNeedsSrgb;
    const preamble: Array<string> = [];
    if (global.size > 0) {
      preamble.push(...global, "");
    }
    if (needsSrgbHelper) {
      preamble.push(SRGB_TO_LINEAR);
    }
    return { ok: true, code: [...preamble, ...codes, ...emitEntryPoint(ir, fnNames)].join("\n") };
  } catch (e) {
    return {
      ok: false,
      errors: [err("InvalidGraph", e instanceof Error ? e.message : "Code generation failed.")],
    };
  }
}

export type Color4 = [number, number, number, number];

export type EvaluateResult =
  | { ok: true; color: Color4 }
  | { ok: false; errors: Array<CompilerError> };

export type NodeEvaluateResult =
  | { ok: true; value: Array<number> }
  | { ok: false; errors: Array<CompilerError> };

export interface EvaluateOptions {
  /** Material Functions available to FunctionCall nodes. */
  functions?: ReadonlyArray<FunctionDefSource>;
}

// Optional hooks that let one evalIrNodes run serve the main graph (which
// resolves FunctionCall invocations) or a Material Function body (whose
// FunctionInput values come from the call site's arguments).
interface EvalContext {
  callValue?: (node: IRNode) => Array<number>;
  inputValue?: (node: IRNode) => Array<number>;
}

function countOf(type: HlslType): number {
  return type === "float" ? 1 : Number(type.slice("float".length));
}

function widenValue(value: Array<number>, type: HlslType): Array<number> {
  const n = countOf(type);
  if (value.length === n) {
    return value;
  }
  return Array.from({ length: n }, () => value[0] as number);
}

// The numeric value carried by one IR input edge, applying Split component
// reads off the source node's value.
function portValueOf(
  ir: GraphIR,
  values: Map<string, Array<number>>,
  input: { fromNodeId: string; fromPort: string },
): Array<number> {
  const source = ir.nodes.find((n) => n.id === input.fromNodeId);
  if (source === undefined) {
    throw new Error(`Unknown IR node: ${input.fromNodeId}`);
  }
  const base = values.get(input.fromNodeId);
  if (base === undefined) {
    throw new Error(`Unevaluated node: ${input.fromNodeId}`);
  }
  if (source.op === "Split") {
    const idx = ["x", "y", "z", "w"].indexOf(input.fromPort);
    if (idx < 0) {
      throw new Error(`Invalid Split port: ${input.fromPort}`);
    }
    return [base[idx] ?? 0];
  }
  return base;
}

// Evaluate every IR node numerically in topo order (mirrors the HLSL
// semantics: scalar splats, Split/Preview passthroughs, transparent reroutes
// and camera, IEEE float math including division by zero). Throws for
// texture/scene nodes whose values only exist on the GPU or in the engine.
// `values` may be supplied by a caller whose FunctionCall resolver needs to
// read already-computed values while evaluation is still running.
function evalIrNodes(
  ir: GraphIR,
  ctx?: EvalContext,
  values: Map<string, Array<number>> = new Map(),
): Map<string, Array<number>> {
  const portValue = (input: { fromNodeId: string; fromPort: string }): Array<number> =>
    portValueOf(ir, values, input);
  for (const node of ir.nodes) {
    switch (node.op) {
      case "Float":
        values.set(node.id, [paramNumber(node.params["value"], 0)]);
        break;
      case "Float2":
        values.set(node.id, [paramNumber(node.params["x"], 0), paramNumber(node.params["y"], 0)]);
        break;
      case "Float3":
        values.set(node.id, [
          paramNumber(node.params["x"], 0),
          paramNumber(node.params["y"], 0),
          paramNumber(node.params["z"], 0),
        ]);
        break;
      case "Float4":
        values.set(node.id, [
          paramNumber(node.params["x"], 0),
          paramNumber(node.params["y"], 0),
          paramNumber(node.params["z"], 0),
          paramNumber(node.params["w"], 0),
        ]);
        break;
      case "Add":
      case "Subtract":
      case "Multiply":
      case "Divide": {
        const a = node.inputs["a"];
        const b = node.inputs["b"];
        if (a === undefined || b === undefined) {
          throw new Error(`Missing inputs for ${node.id}`);
        }
        const va = widenValue(portValue(a), node.outType);
        const vb = widenValue(portValue(b), node.outType);
        const op = node.op;
        values.set(
          node.id,
          va.map((x, i) => {
            const y = vb[i] as number;
            if (op === "Add") return x + y;
            if (op === "Subtract") return x - y;
            if (op === "Multiply") return x * y;
            return x / y;
          }),
        );
        break;
      }
      case "DotProduct": {
        // Validation guarantees equal component counts before this runs.
        const a = node.inputs["a"];
        const b = node.inputs["b"];
        if (a === undefined || b === undefined) {
          throw new Error(`Missing inputs for ${node.id}`);
        }
        const va = portValue(a);
        const vb = portValue(b);
        const n = Math.min(va.length, vb.length);
        let sum = 0;
        for (let i = 0; i < n; i++) {
          sum += (va[i] as number) * (vb[i] as number);
        }
        values.set(node.id, [sum]);
        break;
      }
      case "Split": {
        const src = node.inputs["in"];
        if (src === undefined) {
          throw new Error(`Missing input for ${node.id}`);
        }
        values.set(node.id, [...portValue(src)]);
        break;
      }
      case "Preview": {
        const src = node.inputs["in"];
        if (src === undefined) {
          throw new Error(`Missing input for ${node.id}`);
        }
        values.set(node.id, [...portValue(src)]);
        break;
      }
      case "Combine": {
        const parts: Array<number> = [];
        for (const name of ["x", "y", "z", "w"] as const) {
          const inp = node.inputs[name];
          if (inp === undefined) {
            continue;
          }
          const v = portValue(inp);
          parts.push(inp.fromType === "float" ? (v[0] as number) : (v[0] as number));
        }
        values.set(node.id, parts);
        break;
      }
      case "Reroute":
      case "NamedRerouteDeclaration":
      case "NamedRerouteUsage": {
        const src = node.inputs["in"];
        if (src === undefined) {
          throw new Error(`Missing input for ${node.id}`);
        }
        values.set(node.id, [...portValue(src)]);
        break;
      }
      case "FunctionCall": {
        if (ctx?.callValue === undefined) {
          throw new Error(`Function call without definitions (${node.id})`);
        }
        values.set(node.id, ctx.callValue(node));
        break;
      }
      case "FunctionInput": {
        if (ctx?.inputValue === undefined) {
          throw new Error(`FunctionInput outside a function body (${node.id})`);
        }
        values.set(node.id, ctx.inputValue(node));
        break;
      }
      case "FunctionOutput": {
        // The function's return value: keep the declared arity (a float
        // return stays a single number, unlike the float4 fragment output).
        const src = node.inputs["in"];
        if (src === undefined) {
          throw new Error(`Missing input for ${node.id}`);
        }
        values.set(node.id, [...portValue(src)]);
        break;
      }
      case "SampleTexture2D":
      case "SampleCubemap":
        throw new Error(`Sample Texture (${node.id}) reads GPU data the CPU preview cannot know.`);
      case "NormalVector":
      case "MainLightDirection":
      case "Camera":
        throw new Error(
          `Scene input (${node.id}) is bound by the engine at runtime; the CPU preview cannot evaluate it.`,
        );
      case "FragmentOutput": {
        const src = node.inputs["color"];
        if (src === undefined) {
          throw new Error(`Missing color input for ${node.id}`);
        }
        // Mirror the emitter's float -> float4 splat (alpha follows).
        values.set(node.id, widenValue(portValue(src), "float4"));
        break;
      }
    }
  }
  return values;
}

// Evaluate a FunctionCall by running the target function's body IR with the
// call site's argument values bound to its FunctionInput nodes.
function evaluateCall(
  callNode: IRNode,
  byId: Map<string, FunctionDefSource>,
  ir: GraphIR,
  values: Map<string, Array<number>>,
): Array<number> {
  const def = byId.get(callNode.ref ?? "");
  if (def === undefined) {
    throw new Error(`Unknown function reference: ${callNode.ref ?? ""}`);
  }
  const argValues = new Map<string, Array<number>>();
  for (const arg of def.args) {
    const inp = callNode.inputs[arg.name];
    if (inp === undefined) {
      throw new Error(`Missing argument ${arg.name} for ${def.name}()`);
    }
    argValues.set(arg.name, widenValue(portValueOf(ir, values, inp), arg.type));
  }
  const bound = new Map<string, Array<number>>();
  for (const defNode of def.nodes) {
    if (defNode.type !== "FunctionInput") {
      continue;
    }
    const portName = defNode.ports.find((p) => p.direction === "out")?.name ?? "";
    const v = argValues.get(portName);
    if (v === undefined) {
      throw new Error(`Unbound function argument: ${portName}`);
    }
    bound.set(defNode.id, v);
  }
  const defIr = toIR({
    version: 1,
    nodes: def.nodes,
    edges: def.edges,
    outputNodeId: def.outputNodeId,
  });
  const defValues = evalIrNodes(defIr, {
    inputValue: (n) => {
      const v = bound.get(n.id);
      if (v === undefined) {
        throw new Error(`Unbound function argument (${n.id})`);
      }
      return v;
    },
  });
  const out = defValues.get(def.outputNodeId);
  if (out === undefined) {
    throw new Error(`Function ${def.name} produced no value`);
  }
  return out;
}

// Evaluate the graph numerically (mirrors the IR/HLSL semantics: scalar
// splats, Split component reads, transparent reroutes, IEEE float math
// including division by zero). Pure preview support; no HLSL strings.
export function evaluateGraph(graph: Graph, options?: EvaluateOptions): EvaluateResult {
  const errors = validate(graph);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    const ir = toIR(graph);
    const byId = new Map((options?.functions ?? []).map((f) => [f.id, f]));
    const values = new Map<string, Array<number>>();
    evalIrNodes(ir, { callValue: (callNode) => evaluateCall(callNode, byId, ir, values) }, values);
    const out = values.get(ir.outputNodeId);
    if (out === undefined) {
      throw new Error("IR has no output node");
    }
    const color: Color4 = [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0, out[3] ?? 0];
    return { ok: true, color };
  } catch (e) {
    return {
      ok: false,
      errors: [err("InvalidGraph", e instanceof Error ? e.message : "Evaluation failed.")],
    };
  }
}

// Per-node numeric value for on-canvas Preview swatches. Only nodes that
// feed the Fragment Output are part of the IR, so an unreachable Preview
// reports "not connected" rather than a made-up value.
export function evaluateNode(
  graph: Graph,
  nodeId: string,
  options?: EvaluateOptions,
): NodeEvaluateResult {
  const errors = validate(graph);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    const ir = toIR(graph);
    const byId = new Map((options?.functions ?? []).map((f) => [f.id, f]));
    const values = new Map<string, Array<number>>();
    evalIrNodes(ir, { callValue: (callNode) => evaluateCall(callNode, byId, ir, values) }, values);
    const value = values.get(nodeId);
    if (value === undefined) {
      throw new Error(`Not connected to the Fragment Output (${nodeId}).`);
    }
    return { ok: true, value: [...value] };
  } catch (e) {
    return {
      ok: false,
      errors: [err("InvalidGraph", e instanceof Error ? e.message : "Evaluation failed.")],
    };
  }
}

function paramNumber(value: number | Array<number> | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
