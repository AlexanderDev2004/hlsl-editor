import type { Graph } from "@hlsl-editor/graph";

import { err, type CompilerError } from "./errors";
import { emitHLSL } from "./hlsl-gen";
import { toIR } from "./ir";
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
