import type { Graph } from "@hlsl-editor/graph";
import type { HlslType } from "@hlsl-editor/shader-types";

import { err, type CompilerError } from "./errors";
import { emitHLSL } from "./hlsl-gen";
import { toIR, type GraphIR } from "./ir";
import { validate } from "./validate";

export * from "./errors";
export { upstreamPortType, validate } from "./validate";
export { toIR, type GraphIR, type IRNode } from "./ir";
export { emitHLSL } from "./hlsl-gen";

export type GenerateResult =
  | { ok: true; code: string }
  | { ok: false; errors: Array<CompilerError> };

// Dependency-based generation: validate -> IR -> HLSL.
// Invalid graphs produce errors, never misleading code.
export function generate(graph: Graph): GenerateResult {
  const errors = validate(graph);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    const ir = toIR(graph);
    return { ok: true, code: emitHLSL(ir) };
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

// Evaluate every IR node numerically in topo order (mirrors the HLSL
// semantics: scalar splats, Split/Preview passthroughs, transparent reroutes
// and camera, IEEE float math including division by zero). Throws for
// texture/scene nodes whose values only exist on the GPU or in the engine.
function evalIrNodes(ir: GraphIR): Map<string, Array<number>> {
  const values = new Map<string, Array<number>>();
  const count = (type: HlslType): number =>
    type === "float" ? 1 : Number(type.slice("float".length));
  const widen = (value: Array<number>, type: HlslType): Array<number> => {
    const n = count(type);
    if (value.length === n) {
      return value;
    }
    return Array.from({ length: n }, () => value[0] as number);
  };
  for (const node of ir.nodes) {
    const portValue = (input: { fromNodeId: string; fromPort: string }): Array<number> => {
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
    };
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
        const va = widen(portValue(a), node.outType);
        const vb = widen(portValue(b), node.outType);
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
        values.set(node.id, widen(portValue(src), "float4"));
        break;
      }
    }
  }
  return values;
}

// Evaluate the graph numerically (mirrors the IR/HLSL semantics: scalar
// splats, Split component reads, transparent reroutes, IEEE float math
// including division by zero). Pure preview support; no HLSL strings.
export function evaluateGraph(graph: Graph): EvaluateResult {
  const errors = validate(graph);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    const ir = toIR(graph);
    const values = evalIrNodes(ir);
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
export function evaluateNode(graph: Graph, nodeId: string): NodeEvaluateResult {
  const errors = validate(graph);
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  try {
    const ir = toIR(graph);
    const values = evalIrNodes(ir);
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
