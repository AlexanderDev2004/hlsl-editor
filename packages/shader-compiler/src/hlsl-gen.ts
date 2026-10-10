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

// Texture/sampler naming follows the HLSL "sampler_" + texture-name pairing
// convention so the default sampler binds by name in effect-style setups.
function texName(node: IRNode): string {
  return `Tex${node.variable.slice(1)}`;
}

function samplerName(node: IRNode): string {
  return `sampler_${texName(node)}`;
}

function enumParam(node: IRNode, key: string, fallback: number): number {
  return numParam(node.params[key], fallback);
}

// The sRGB→linear transfer used when a 2D sample's Space is Linear, per the
// sRGB standard (c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4). The HLSL
// ternary applies per component when the condition is a vector.
export const SRGB_TO_LINEAR = [
  "float3 srgbToLinear(float3 c)",
  "{",
  "    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);",
  "}",
  "",
].join("\n");

export function exprFor(
  ir: GraphIR,
  node: IRNode,
  fnNames: ReadonlyMap<string, string> = new Map(),
): string {
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
    case "DotProduct": {
      // Validation guarantees equal component counts, so no splat is
      // applied: dot(a, b) maps 1:1 onto the HLSL intrinsic.
      const a = node.inputs["a"];
      const b = node.inputs["b"];
      if (a === undefined || b === undefined) {
        throw new Error(`Missing inputs for ${node.id}`);
      }
      return `dot(${portRef(ir, a.fromNodeId, a.fromPort)}, ${portRef(ir, b.fromNodeId, b.fromPort)})`;
    }
    case "SampleTexture2D": {
      const uv = node.inputs["UV"];
      if (uv === undefined) {
        throw new Error(`Missing input for ${node.id}`);
      }
      const sample = `${texName(node)}.Sample(${samplerName(node)}, ${portRef(ir, uv.fromNodeId, uv.fromPort)})`;
      let value = sample;
      if (enumParam(node, "Type", 0) === 1) {
        // Normal map: unpack from [0,1] back to tangent space [-1,1].
        value = `normalize(${sample} * 2.0 - 1.0)`;
      }
      if (enumParam(node, "Space", 0) === 1) {
        value = `srgbToLinear(${value})`;
      }
      return value;
    }
    case "SampleCubemap": {
      const dir = node.inputs["Dir"];
      if (dir === undefined) {
        throw new Error(`Missing input for ${node.id}`);
      }
      return `${texName(node)}.Sample(${samplerName(node)}, normalize(${portRef(ir, dir.fromNodeId, dir.fromPort)}))`;
    }
    case "NormalVector": {
      // Object-space transforms the world-space uniform through the
      // inverse world matrix (standard float4x4 matrix, float3x3 slice).
      return enumParam(node, "Space", 1) === 0
        ? `normalize(mul((float3x3) _WorldToObject, _NormalVector))`
        : `normalize(_NormalVector)`;
    }
    case "MainLightDirection":
      return `normalize(_MainLightDirection)`;
    case "Camera":
      // Transparent: never emitted here; portRef resolves uniforms per port.
      throw new Error(`Camera emits no expression (${node.id})`);
    case "Split": {
      // Split itself emits nothing; consumers read components off its var.
      // Its variable holds the full input vector copy for downstream swizzles.
      const src = node.inputs["in"];
      if (src === undefined) {
        throw new Error(`Missing input for ${node.id}`);
      }
      return portRef(ir, src.fromNodeId, src.fromPort);
    }
    case "Preview": {
      // Preview materializes its input into a named intermediate so the
      // value stays inspectable in GPU debuggers (RenderDoc, PIX, NSight).
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
    case "Reroute":
    case "NamedRerouteDeclaration":
    case "NamedRerouteUsage": {
      const src = node.inputs["in"];
      if (src === undefined) {
        throw new Error(`Missing input for ${node.id}`);
      }
      return portRef(ir, src.fromNodeId, src.fromPort);
    }
    case "FunctionCall": {
      // Emit the invocation. Arguments bind by port name (the argument
      // name); a scalar wire into a vector parameter splats, mirroring
      // HLSL's implicit scalar-to-vector behavior.
      const name = fnNames.get(node.ref ?? "");
      if (name === undefined) {
        throw new Error(`Unknown function reference: ${node.ref ?? node.id}`);
      }
      const args: Array<string> = [];
      for (const [portName, inp] of Object.entries(node.inputs)) {
        const to = node.inTypes?.[portName] ?? inp.fromType;
        args.push(withSplat(portRef(ir, inp.fromNodeId, inp.fromPort), inp.fromType, to));
      }
      return `${name}(${args.join(", ")})`;
    }
    case "FunctionInput":
      // Transparent: portRef resolves the argument name directly.
      throw new Error(`FunctionInput emits no expression (${node.id})`);
    case "FunctionOutput": {
      // A function body's return value: splat to the declared return type.
      const src = node.inputs["in"];
      if (src === undefined) {
        throw new Error(`Missing input for ${node.id}`);
      }
      return withSplat(portRef(ir, src.fromNodeId, src.fromPort), src.fromType, node.outType);
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
  if (node.op === "Camera") {
    // Camera is transparent: each output port resolves straight to its
    // uniform. Position stays raw; Direction is a unit vector.
    if (fromPort === "Position") {
      return "_CameraPosition";
    }
    if (fromPort === "Direction") {
      return "normalize(_CameraDirection)";
    }
    throw new Error(`Invalid Camera port: ${fromPort}`);
  }
  // Sample nodes expose RGBA plus per-component swizzle reads.
  if (node.op === "SampleTexture2D" || node.op === "SampleCubemap") {
    const idx = ["RGBA", "R", "G", "B", "A"].indexOf(fromPort);
    if (idx > 0) {
      return swizzleRead(base, (idx - 1) as 0 | 1 | 2 | 3);
    }
  }
  if (node.op === "FunctionInput") {
    // Inside a function body the argument name itself is the expression.
    return fromPort;
  }
  if (
    node.op === "Reroute" ||
    node.op === "NamedRerouteDeclaration" ||
    node.op === "NamedRerouteUsage"
  ) {
    // Reroutes are transparent: resolve straight through to the upstream
    // expression so the emitted code matches a direct wire.
    const src = node.inputs["in"];
    if (src === undefined) {
      throw new Error(`Missing input for ${fromNodeId}`);
    }
    return portRef(ir, src.fromNodeId, src.fromPort);
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

// Scan an IR for the global declarations it needs: texture/sampler pairs,
// engine-bound uniforms, and whether the sRGB helper is required. Shared by
// the main-graph emitter and Material Function emission so declarations can
// be hoisted and deduped at global scope.
export function collectDecls(ir: GraphIR): { decls: Array<string>; needsSrgbHelper: boolean } {
  const decls: Array<string> = [];
  let needsNormalUniform = false;
  let needsObjectTransform = false;
  let needsLightUniform = false;
  let needsCameraUniforms = false;
  let needsSrgbHelper = false;
  for (const node of ir.nodes) {
    if (node.op === "SampleTexture2D") {
      decls.push(`Texture2D ${texName(node)};`, `SamplerState ${samplerName(node)};`);
      if (enumParam(node, "Space", 0) === 1) {
        needsSrgbHelper = true;
      }
    } else if (node.op === "SampleCubemap") {
      decls.push(`TextureCube ${texName(node)};`, `SamplerState ${samplerName(node)};`);
    } else if (node.op === "NormalVector") {
      needsNormalUniform = true;
      if (enumParam(node, "Space", 1) === 0) {
        needsObjectTransform = true;
      }
    } else if (node.op === "MainLightDirection") {
      needsLightUniform = true;
    } else if (node.op === "Camera") {
      needsCameraUniforms = true;
    }
  }
  if (needsCameraUniforms) {
    decls.push("float3 _CameraPosition;", "float3 _CameraDirection;");
  }
  if (needsNormalUniform) {
    decls.push("float3 _NormalVector;");
  }
  if (needsObjectTransform) {
    decls.push("float4x4 _WorldToObject;");
  }
  if (needsLightUniform) {
    decls.push("float3 _MainLightDirection;");
  }
  return { decls, needsSrgbHelper };
}

// Statement lines for every non-transparent IR node (no entry point, no
// indentation, no declarations). fnNames resolves FunctionCall references.
export function emitBody(
  ir: GraphIR,
  fnNames: ReadonlyMap<string, string> = new Map(),
): Array<string> {
  const lines: Array<string> = [];
  for (const node of ir.nodes) {
    if (
      node.op === "FragmentOutput" ||
      node.op === "FunctionOutput" ||
      node.op === "FunctionInput" ||
      node.op === "Camera" ||
      node.op === "Reroute" ||
      node.op === "NamedRerouteDeclaration" ||
      node.op === "NamedRerouteUsage"
    ) {
      // Transparent: no variable, consumers reference the upstream directly.
      continue;
    }
    lines.push(`${node.outType} ${node.variable} = ${exprFor(ir, node, fnNames)};`);
  }
  return lines;
}

// The main() entry point block (with trailing blank line), indented and
// closed. fnNames resolves FunctionCall references.
export function emitEntryPoint(
  ir: GraphIR,
  fnNames: ReadonlyMap<string, string> = new Map(),
): Array<string> {
  const out = ir.nodes.find((n) => n.id === ir.outputNodeId);
  if (out === undefined) {
    throw new Error("IR has no output node");
  }
  const lines = [
    ...emitBody(ir, fnNames),
    `float4 ${ir.outputVar} = ${exprFor(ir, out, fnNames)};`,
    `return ${ir.outputVar};`,
  ];
  // A pixel shader needs an entry point whose return carries the SV_Target
  // semantic (the render target output). `main` is the default entry-point
  // name for fxc and dxc, so the file compiles without extra flags.
  const body = lines.map((line) => `    ${line}`);
  return ["float4 main() : SV_Target", "{", ...body, "}", ""];
}

export function emitHLSL(ir: GraphIR, fnNames: ReadonlyMap<string, string> = new Map()): string {
  const { decls, needsSrgbHelper } = collectDecls(ir);
  // External bindings first, then helper functions, then the entry point.
  const preamble: Array<string> = [];
  if (decls.length > 0) {
    preamble.push(...decls, "");
  }
  if (needsSrgbHelper) {
    preamble.push(SRGB_TO_LINEAR);
  }
  return [...preamble, ...emitEntryPoint(ir, fnNames)].join("\n");
}
