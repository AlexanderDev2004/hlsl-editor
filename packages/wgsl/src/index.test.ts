import { describe, expect, test } from "vitest";

import { hlslToWgsl } from "./index";

describe("wgsl seam", () => {
  test("float types map (MVP3 placeholder)", () => {
    expect(hlslToWgsl("float")).toBe("f32");
    expect(hlslToWgsl("float4")).toBe("vec4<f32>");
  });
});
