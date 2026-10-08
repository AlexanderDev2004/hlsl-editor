import { describe, expect, test } from "vitest";

import { createNodeOfType, NODE_REGISTRY, resolveOutputType } from "./index";

describe("shader-nodes", () => {
  test("registry covers MVP1 set", () => {
    for (const t of [
      "Float",
      "Float2",
      "Float3",
      "Float4",
      "Add",
      "Subtract",
      "Multiply",
      "Divide",
      "Split",
      "Combine",
      "Reroute",
      "NamedRerouteDeclaration",
      "NamedRerouteUsage",
      "FragmentOutput",
    ] as const) {
      expect(NODE_REGISTRY[t]).toBeDefined();
    }
  });

  test("reroute output passes the input type through", () => {
    expect(resolveOutputType("Reroute", { in: "float3" })).toBe("float3");
    expect(resolveOutputType("Reroute", {})).toBeNull();
    expect(resolveOutputType("NamedRerouteDeclaration", { in: "float2" })).toBe("float2");
    expect(resolveOutputType("NamedRerouteUsage", { in: "float4" })).toBe("float4");
  });

  test("math output is the wider input", () => {
    expect(resolveOutputType("Add", { a: "float", b: "float3" })).toBe("float3");
    expect(resolveOutputType("Multiply", { a: "float2", b: "float2" })).toBe("float2");
  });

  test("combine grows with connected inputs", () => {
    expect(resolveOutputType("Combine", { x: "float", y: "float" })).toBe("float2");
    expect(resolveOutputType("Combine", { x: "float", y: "float", z: "float" })).toBe("float3");
    expect(resolveOutputType("Combine", { x: "float", y: "float", z: "float", w: "float" })).toBe(
      "float4",
    );
  });

  test("created nodes carry ports and defaults", () => {
    const n = createNodeOfType("Float", "n1", { x: 10, y: 20 }, {});
    expect(n.ports.some((p) => p.name === "out" && p.direction === "out")).toBe(true);
    expect(n.params["value"]).toBe(0);
  });
});
