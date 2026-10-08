// WGSL seam for MVP 3 (WebGPU live preview). Types only — no codegen yet.

export const HLSL_TO_WGSL = {
  float: "f32",
  float2: "vec2<f32>",
  float3: "vec3<f32>",
  float4: "vec4<f32>",
} as const;

export type HlslFloatType = keyof typeof HLSL_TO_WGSL;

export function hlslToWgsl(type: HlslFloatType): string {
  return HLSL_TO_WGSL[type];
}
