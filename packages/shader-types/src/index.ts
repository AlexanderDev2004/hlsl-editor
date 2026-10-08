// HLSL scalar/vector type system — MVP 1 supports float..float4.
// Future types are listed explicitly so misuse fails with a clear message.

export const MVP1_TYPES = ["float", "float2", "float3", "float4"] as const;
export type HlslType = (typeof MVP1_TYPES)[number];

// Reserved for future MVPs (bool/int/uint/half, matrices, resources).
// Kept as data so validation can reject them explicitly instead of
// treating them as unknown strings.
export const FUTURE_TYPES = [
  "bool",
  "int",
  "uint",
  "half",
  "float2x2",
  "float3x3",
  "float4x4",
  "Texture2D",
  "Texture3D",
  "TextureCube",
  "SamplerState",
] as const;
export type FutureType = (typeof FUTURE_TYPES)[number];

const COMPONENT_COUNTS: Record<HlslType, 1 | 2 | 3 | 4> = {
  float: 1,
  float2: 2,
  float3: 3,
  float4: 4,
};

export function isMvp1Type(value: string): value is HlslType {
  return (MVP1_TYPES as ReadonlyArray<string>).includes(value);
}

export function isFutureType(value: string): value is FutureType {
  return (FUTURE_TYPES as ReadonlyArray<string>).includes(value);
}

export function componentCount(type: HlslType): 1 | 2 | 3 | 4 {
  return COMPONENT_COUNTS[type];
}

/**
 * MVP 1 connection rule:
 * - exact match: always allowed
 * - float -> float2/3/4: allowed (scalar splat constructor)
 * - everything else rejected, including floatN -> float and any
 *   future/resource type (forward-compatible rejection).
 */
export function canConnect(from: string, to: string): boolean {
  if (from === to && isMvp1Type(from)) {
    return true;
  }
  if (from === "float" && (to === "float2" || to === "float3" || to === "float4")) {
    return true;
  }
  return false;
}

export function connectionErrorMessage(expected: string, received: string): string {
  return `Type mismatch:\nExpected ${expected}\nReceived ${received}`;
}

export function describeType(type: string): string {
  if (isMvp1Type(type)) {
    return `${type} (${componentCount(type)} component${componentCount(type) === 1 ? "" : "s"})`;
  }
  if (isFutureType(type)) {
    return `${type} (not supported in MVP 1)`;
  }
  return `${type} (unknown type)`;
}
