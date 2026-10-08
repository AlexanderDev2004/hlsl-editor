// Deterministic HLSL emitter. Same IR -> byte-identical code.
// No code is emitted for invalid graphs (callers check validate first).

import { floatLit, splatCtor, swizzleRead, vecCtor } from "@hlsl-editor/hlsl";
import type { HlslType } from "@hlsl-editor/shader-types";

import type { GraphIR, IRNode } from "./ir";

const MATH_OP: Record<string, string> = {
  Add: "+",
  Subtract: "-",
  Multiply: "*",
  Divide: "/",
};

function numParam(value: number | Array<number> | undefined, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function exprFor(ir: GraphIR, node: IRNode): string {
  switch (node.op) {
    case "Float":
      return floatLit(numParam(node.params["value"], 0));
    case "Float2": {
      const x = floatLit(numParam(node.params["x"], 0));
      const y = floatLit(numParam(node.params["y"], 0));
      return vecCtor("float2", [x, y]);
    }
    case "Float3": {
      const x = floatLit(numParam(node.params["x"], 0));
      const y = floatLit(numParam(node.params["y"], 0));
      const z = floatLit(numParam(node.params["z"], 0));
      return vecCtor("float3", [x, y, z]);
    }
    case "Float4": {
      const x = floatLit(numParam(node.params["x"], 0));
      const y = floatLit(numParam(node.params["y"], 0));
      const z = floatLit(numParam(node.params["z"], 0));
      const w = floatLit(numParam(node.params["w"], 0));
      return vecCtor("float4", [x, y, z, w]);
    }
    case "Add":
    case "Subtract":
    case "Multiply":
    case "Divide": {
      const a = node.inputs["a"];
      const b = node.inputs["b"];
      if (a === undefined || b === undefined) {
        throw new Error(`Missing inputs for ${node.id}`);
      }
      const aExpr = withSplat(portRef(ir, a.fromNodeId, a.fromPort), a.fromType, node.outType);
      const bExpr = withSplat(portRef(ir, b.fromNodeId, b.fromPort), b.fromType, node.outType);
      return `${aExpr} ${MATH_OP[node.op] as string} ${bExpr}`;
    }
    case "Split": {
      // Split itself emits nothing; consumers read components off its var.
      // Its variable holds the full input vector copy for downstream swizzles.
      const src = node.inputs["in"];
      if (src === undefined) {
        throw new Error(`Missing input for ${node.id}`);
      }
      return portRef(ir, src.fromNodeId, src.fromPort);
    }
    case "Combine": {
      const parts: Array<string> = [];
      for (const name of ["x", "y", "z", "w"] as const) {
        const inp = node.inputs[name];
        if (inp === undefined) {
          continue;
        }
        const v = portRef(ir, inp.fromNodeId, inp.fromPort);
        // Combine inputs are scalar floats; if a vector arrives (via splat
        // edge it is already float) — but guard: extract .x when needed.
        parts.push(inp.fromType === "float" ? v : swizzleRead(v, 0));
      }
      return vecCtor(node.outType, parts);
    }
    case "FragmentOutput": {
      const src = node.inputs["color"];
      if (src === undefined) {
        throw new Error(`Missing color input for ${node.id}`);
      }
      return withSplat(portRef(ir, src.fromNodeId, src.fromPort), src.fromType, "float4");
    }
  }
}

// Reference another node's variable from a downstream port, applying the
// Split swizzle when reading through a Split output port.
export function portRef(ir: GraphIR, fromNodeId: string, fromPort: string): string {
  const vars = new Map(ir.nodes.map((n) => [n.id, n.variable] as const));
  const node = ir.nodes.find((n) => n.id === fromNodeId);
  if (node === undefined) {
    throw new Error(`Unknown IR node: ${fromNodeId}`);
  }
  const base = vars.get(fromNodeId) as string;
  if (node.op === "Split") {
    const idx = ["x", "y", "z", "w"].indexOf(fromPort);
    if (idx < 0) {
      throw new Error(`Invalid Split port: ${fromPort}`);
    }
    // The Split variable already aliases the input vector.
    return swizzleRead(base, idx as 0 | 1 | 2 | 3);
  }
  return base;
}

function withSplat(varExpr: string, from: HlslType, to: HlslType): string {
  if (from === to) {
    return varExpr;
  }
  if (from === "float") {
    return splatCtor(to, varExpr);
  }
  throw new Error(`Cannot convert ${from} to ${to}`);
}

export function emitHLSL(ir: GraphIR): string {
  const lines: Array<string> = [];
  for (const node of ir.nodes) {
    if (node.op === "FragmentOutput") {
      continue;
    }
    lines.push(`${node.outType} ${node.variable} = ${exprFor(ir, node)};`);
  }
  const out = ir.nodes.find((n) => n.id === ir.outputNodeId);
  if (out === undefined) {
    throw new Error("IR has no output node");
  }
  lines.push(`float4 ${ir.outputVar} = ${exprFor(ir, out)};`);
  return lines.join("\n") + "\n";
}
