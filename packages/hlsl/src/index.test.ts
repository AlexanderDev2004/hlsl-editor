import { describe, expect, test } from "vitest";

import { floatLit, splatCtor, swizzleRead, vecCtor } from "./index";

describe("hlsl helpers", () => {
  test("float literals always carry a decimal", () => {
    expect(floatLit(2)).toBe("2.0");
    expect(floatLit(0.5)).toBe("0.5");
  });

  test("splat constructor", () => {
    expect(splatCtor("float3", "_0")).toBe("float3(_0, _0, _0)");
  });

  test("vec constructor", () => {
    expect(vecCtor("float2", ["1.0", "2.0"])).toBe("float2(1.0, 2.0)");
  });

  test("swizzle read", () => {
    expect(swizzleRead("_1", 0)).toBe("_1.x");
    expect(swizzleRead("_1", 2)).toBe("_1.z");
  });
});
