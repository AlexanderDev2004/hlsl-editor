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
      "DotProduct",
      "Split",
      "Combine",
      "Reroute",
      "NamedRerouteDeclaration",
      "NamedRerouteUsage",
      "FragmentOutput",
      "Preview",
      "SampleTexture2D",
      "SampleCubemap",
      "NormalVector",
      "MainLightDirection",
      "Camera",
    ] as const) {
      expect(NODE_REGISTRY[t]).toBeDefined();
    }
  });

  test("enum params expose dropdown metadata", () => {
    const sample = NODE_REGISTRY["SampleTexture2D"];
    expect(sample.paramDefs?.map((p) => p.key)).toEqual(["Type", "Space"]);
    const type = sample.paramDefs?.[0];
    expect(type?.kind === "enum" && type.options.map((o) => o.label)).toEqual([
      "Default",
      "Normal",
    ]);
    const normal = NODE_REGISTRY["NormalVector"];
    expect(normal.paramDefs?.map((p) => p.key)).toEqual(["Space"]);
  });

  test("dot always reduces to float; samples and scene inputs are fixed-width", () => {
    expect(resolveOutputType("DotProduct", { a: "float3", b: "float3" })).toBe("float");
    expect(resolveOutputType("Preview", { in: "float3" })).toBe("float3");
    expect(resolveOutputType("Preview", {})).toBeNull();
    expect(resolveOutputType("SampleTexture2D", {})).toBe("float4");
    expect(resolveOutputType("SampleCubemap", {})).toBe("float4");
    expect(resolveOutputType("NormalVector", {})).toBe("float3");
    expect(resolveOutputType("MainLightDirection", {})).toBe("float3");
    expect(resolveOutputType("Camera", {})).toBe("float3");
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
