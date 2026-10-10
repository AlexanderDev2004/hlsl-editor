// Material Function emission: turn a FunctionDefSource (a reusable node
// subgraph with an explicit signature) into a standalone HLSL function.
// Declarations used inside the body are reported separately so the caller
// can hoist and dedupe them at global scope.

import type { Graph, GraphEdge, GraphNode } from "@hlsl-editor/graph";
import type { HlslType } from "@hlsl-editor/shader-types";

import { err, type CompilerError } from "./errors";
import { collectDecls, emitBody, exprFor } from "./hlsl-gen";
import { toIR } from "./ir";
import { validateStructure } from "./validate";

export interface FunctionArg {
  name: string;
  type: HlslType;
}

// The compiled form of a Material Function: signature plus the body graph
// (FunctionInput/FunctionOutput nodes included) that computes the return.
export interface FunctionDefSource {
  id: string;
  name: string;
  args: Array<FunctionArg>;
  nodes: Array<GraphNode>;
  edges: Array<GraphEdge>;
  outputNodeId: string;
}

export type FunctionEmitResult =
  | { ok: true; code: string; decls: Array<string>; needsSrgbHelper: boolean }
  | { ok: false; errors: Array<CompilerError> };

const IDENTIFIER = /^[A-Za-z_]\w*$/;

// Emit `T Name(T1 a, ...) { ...; return ...; }`. The body graph must end at
// a FunctionOutput node; its input value becomes the return expression.
export function emitFunction(def: FunctionDefSource): FunctionEmitResult {
  if (!IDENTIFIER.test(def.name)) {
    return {
      ok: false,
      errors: [err("InvalidGraph", `Invalid function name: ${def.name}.`)],
    };
  }
  for (const arg of def.args) {
    if (!IDENTIFIER.test(arg.name)) {
      return {
        ok: false,
        errors: [err("InvalidGraph", `Invalid function argument name: ${arg.name}.`)],
      };
    }
  }
  try {
    const graph: Graph = {
      version: 1,
      nodes: def.nodes,
      edges: def.edges,
      outputNodeId: def.outputNodeId,
    };
    const errors = validateStructure(graph);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
    const ir = toIR(graph);
    const out = ir.nodes.find((n) => n.id === def.outputNodeId);
    if (out === undefined) {
      return {
        ok: false,
        errors: [err("InvalidGraph", `Function ${def.name} has no output node.`)],
      };
    }
    const params = def.args.map((a) => `${a.type} ${a.name}`).join(", ");
    const body = [...emitBody(ir), `return ${exprFor(ir, out)};`];
    const code = [
      `${out.outType} ${def.name}(${params})`,
      "{",
      ...body.map((line) => `    ${line}`),
      "}",
      "",
    ].join("\n");
    const { decls, needsSrgbHelper } = collectDecls(ir);
    return { ok: true, code, decls, needsSrgbHelper };
  } catch (e) {
    return {
      ok: false,
      errors: [err("InvalidGraph", e instanceof Error ? e.message : "Function emission failed.")],
    };
  }
}
