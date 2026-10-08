import { describe, expect, test } from "vitest";

import {
  canConnect,
  componentCount,
  connectionErrorMessage,
  describeType,
  isFutureType,
  isMvp1Type,
} from "./index";

describe("shader-types", () => {
  test("exact type matches connect", () => {
    expect(canConnect("float", "float")).toBe(true);
    expect(canConnect("float2", "float2")).toBe(true);
    expect(canConnect("float3", "float3")).toBe(true);
    expect(canConnect("float4", "float4")).toBe(true);
  });

  test("float splats to float2/3/4", () => {
    expect(canConnect("float", "float2")).toBe(true);
    expect(canConnect("float", "float3")).toBe(true);
    expect(canConnect("float", "float4")).toBe(true);
  });

  test("vector to scalar is rejected", () => {
    expect(canConnect("float3", "float")).toBe(false);
    expect(canConnect("float2", "float")).toBe(false);
    expect(canConnect("float4", "float")).toBe(false);
  });

  test("mismatched vectors are rejected", () => {
    expect(canConnect("float2", "float3")).toBe(false);
    expect(canConnect("float4", "float3")).toBe(false);
    expect(canConnect("float3", "float4")).toBe(false);
  });

  test("future resource types are rejected for forward-compat", () => {
    expect(canConnect("Texture2D", "float4")).toBe(false);
    expect(canConnect("float4", "Texture2D")).toBe(false);
    expect(canConnect("SamplerState", "float")).toBe(false);
    expect(isFutureType("Texture2D")).toBe(true);
    expect(isMvp1Type("Texture2D")).toBe(false);
  });

  test("unknown types are rejected", () => {
    expect(canConnect("double", "float")).toBe(false);
    expect(canConnect("float", "double")).toBe(false);
  });

  test("component counts", () => {
    expect(componentCount("float")).toBe(1);
    expect(componentCount("float4")).toBe(4);
  });

  test("error message is human readable", () => {
    expect(connectionErrorMessage("float", "float3")).toBe(
      "Type mismatch:\nExpected float\nReceived float3",
    );
  });

  test("describeType distinguishes MVP1 / future / unknown", () => {
    expect(describeType("float3")).toContain("float3");
    expect(describeType("Texture2D")).toContain("not supported in MVP 1");
    expect(describeType("double")).toContain("unknown");
  });
});
