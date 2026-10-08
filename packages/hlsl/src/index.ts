// HLSL string helpers. Reserved for MVP2 texture/matrix boilerplate;
// MVP1 uses float literals, splat constructors, and swizzle reads.

import type { HlslType } from "@hlsl-editor/shader-types";

export function floatLit(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Non-finite float literal: ${value}`);
  }
  const text = value.toString();
  return text.includes(".") || text.includes("e") || text.includes("E") ? text : `${text}.0`;
}

export function splatCtor(type: HlslType, scalarExpr: string): string {
  const count = type === "float" ? 1 : Number(type.slice("float".length));
  if (type === "float") {
    return scalarExpr;
  }
  return `${type}(${Array.from({ length: count }, () => scalarExpr).join(", ")})`;
}

export function vecCtor(type: HlslType, components: Array<string>): string {
  if (type === "float") {
    if (components.length !== 1) {
      throw new Error(`float needs 1 component, got ${components.length}`);
    }
    return components[0] as string;
  }
  return `${type}(${components.join(", ")})`;
}

const SWIZZLE = ["x", "y", "z", "w"] as const;

export function swizzleRead(varName: string, index: 0 | 1 | 2 | 3): string {
  return `${varName}.${SWIZZLE[index]}`;
}
