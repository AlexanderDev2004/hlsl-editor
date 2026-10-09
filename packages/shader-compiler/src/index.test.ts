import { addEdge, addNode, createGraph } from "@hlsl-editor/graph";
import { createNodeOfType } from "@hlsl-editor/shader-nodes";
import { describe, expect, test } from "vitest";

import { evaluateGraph, evaluateNode, generate, toIR, validate } from "./index";

function floatNode(id: string, value: number, x = 0) {
  return createNodeOfType("Float", id, { x, y: 0 }, { value });
}

function outputNode(id: string) {
  return createNodeOfType("FragmentOutput", id, { x: 400, y: 0 }, {});
}

describe("validation", () => {
  test("valid graph passes", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, outputNode("out"));
    // Float -> float4 splat is allowed into FragmentOutput
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    expect(validate(g)).toEqual([]);
  });

  test("invalid type connection is reported", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float3", "v", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "v", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const errors = validate(g);
    expect(errors.some((e) => e.code === "TypeMismatch")).toBe(true);
    expect(errors[0]?.message).toContain("Type mismatch");
  });

  test("missing input is reported", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Add", "add", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    const errors = validate(g);
    expect(errors.some((e) => e.code === "MissingRequiredInput")).toBe(true);
  });

  test("missing output is reported", () => {
    const g = addNode(createGraph(), floatNode("a", 1));
    expect(validate(g).some((e) => e.code === "MissingOutput")).toBe(true);
  });

  test("cycle is detected", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Add", "a", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Add", "b", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = {
      ...g,
      edges: [
        { id: "e1", source: { nodeId: "b", port: "out" }, target: { nodeId: "a", port: "a" } },
        { id: "e2", source: { nodeId: "a", port: "out" }, target: { nodeId: "b", port: "a" } },
      ],
    };
    expect(validate(g).some((e) => e.code === "CycleDetected")).toBe(true);
  });
});

describe("hlsl generation", () => {
  test("simple Float graph splats to output", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float _0 = 2.0;");
      expect(res.code).toContain("float4 _1 = float4(_0, _0, _0, _0);");
    }
  });

  test("spec example: Float(2) * Float(5) -> output", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, floatNode("b", 5));
    g = addNode(g, createNodeOfType("Multiply", "mul", { x: 100, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "mul", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "b", port: "out" },
      target: { nodeId: "mul", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "mul", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("_0 * _1");
      expect(res.code).toMatch(/float _2 = _0 \* _1;/);
    }
  });

  test("Add works and nested ops compose", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 1));
    g = addNode(g, floatNode("b", 2));
    g = addNode(g, floatNode("c", 3));
    g = addNode(g, createNodeOfType("Add", "add", { x: 100, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Multiply", "mul", { x: 200, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "add", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "b", port: "out" },
      target: { nodeId: "add", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "add", port: "out" },
      target: { nodeId: "mul", port: "a" },
    });
    g = addEdge(g, {
      id: "e4",
      source: { nodeId: "c", port: "out" },
      target: { nodeId: "mul", port: "b" },
    });
    g = addEdge(g, {
      id: "e5",
      source: { nodeId: "mul", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("+");
      expect(res.code).toContain("*");
    }
  });

  test("generation is deterministic", () => {
    const build = () => {
      let g = createGraph();
      g = addNode(g, floatNode("b", 5));
      g = addNode(g, floatNode("a", 2));
      g = addNode(g, createNodeOfType("Multiply", "mul", { x: 100, y: 0 }, {}));
      g = addNode(g, outputNode("out"));
      g = addEdge(g, {
        id: "e1",
        source: { nodeId: "a", port: "out" },
        target: { nodeId: "mul", port: "a" },
      });
      g = addEdge(g, {
        id: "e2",
        source: { nodeId: "b", port: "out" },
        target: { nodeId: "mul", port: "b" },
      });
      g = addEdge(g, {
        id: "e3",
        source: { nodeId: "mul", port: "out" },
        target: { nodeId: "out", port: "color" },
      });
      return g;
    };
    const r1 = generate(build());
    const r2 = generate(build());
    expect(r1).toEqual(r2);
  });

  test("disconnected unused nodes are excluded", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, floatNode("stray", 99));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).not.toContain("99");
    }
  });

  test("invalid graph generates no code", () => {
    const g = addNode(createGraph(), floatNode("a", 1));
    const res = generate(g);
    expect(res.ok).toBe(false);
  });

  test("IR contains no UI state", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const ir = toIR(g);
    expect(JSON.stringify(ir)).not.toContain("position");
    expect(JSON.stringify(ir)).not.toContain("viewport");
  });

  test("Split + Combine round-trip", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float3", "v", { x: 0, y: 0 }, { x: 1, y: 2, z: 3 }));
    g = addNode(g, createNodeOfType("Split", "sp", { x: 100, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Combine", "cb", { x: 200, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Float", "w", { x: 0, y: 100 }, { value: 4 }));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "v", port: "out" },
      target: { nodeId: "sp", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "sp", port: "x" },
      target: { nodeId: "cb", port: "x" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "sp", port: "y" },
      target: { nodeId: "cb", port: "y" },
    });
    g = addEdge(g, {
      id: "e4",
      source: { nodeId: "sp", port: "z" },
      target: { nodeId: "cb", port: "z" },
    });
    g = addEdge(g, {
      id: "e5",
      source: { nodeId: "w", port: "out" },
      target: { nodeId: "cb", port: "w" },
    });
    g = addEdge(g, {
      id: "e6",
      source: { nodeId: "cb", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain(".x");
      expect(res.code).toContain("float4");
    }
  });

  test("a Reroute is transparent to codegen", () => {
    const build = (withReroute: boolean) => {
      let g = createGraph();
      g = addNode(g, floatNode("a", 2));
      if (withReroute) {
        g = addNode(g, createNodeOfType("Reroute", "r", { x: 200, y: 0 }, {}));
      }
      g = addNode(g, outputNode("out"));
      g = addEdge(g, {
        id: "e1",
        source: { nodeId: "a", port: "out" },
        target: withReroute ? { nodeId: "r", port: "in" } : { nodeId: "out", port: "color" },
      });
      if (withReroute) {
        g = addEdge(g, {
          id: "e2",
          source: { nodeId: "r", port: "out" },
          target: { nodeId: "out", port: "color" },
        });
      }
      return g;
    };
    const plain = generate(build(false));
    const routed = generate(build(true));
    expect(routed.ok).toBe(true);
    if (plain.ok && routed.ok) {
      expect(routed.code).toBe(plain.code);
    }
  });

  test("a Named Reroute declaration/usage pair is transparent", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 3));
    g = addNode(g, createNodeOfType("NamedRerouteDeclaration", "d", { x: 100, y: 0 }, {}));
    g = addNode(g, createNodeOfType("NamedRerouteUsage", "u", { x: 300, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "d", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "d", port: "out" },
      target: { nodeId: "u", port: "in" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "u", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    expect(validate(g)).toEqual([]);
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float _0 = 3.0;");
      expect(res.code).toContain("float4 _1 = float4(_0, _0, _0, _0);");
      expect(res.code).not.toContain("_2");
    }
  });

  test("emitted shader is a complete pixel shader entry point", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Pixel shader entry point per HLSL docs: SV_Target marks the render
      // target output; `main` is the default entry point for fxc/dxc.
      expect(res.code).toMatch(/^float4 main\(\) : SV_Target\n\{\n/);
      expect(res.code).toContain("    return _1;\n}");
      expect(res.code.endsWith("}\n")).toBe(true);
    }
  });
});

describe("evaluation", () => {
  test("Float(2) * Float(5) evaluates to splat 10", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 2));
    g = addNode(g, floatNode("b", 5));
    g = addNode(g, createNodeOfType("Multiply", "mul", { x: 100, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "mul", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "b", port: "out" },
      target: { nodeId: "mul", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "mul", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = evaluateGraph(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.color).toEqual([10, 10, 10, 10]);
    }
  });

  test("Float output splats alpha like the emitter", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 0.5));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = evaluateGraph(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.color).toEqual([0.5, 0.5, 0.5, 0.5]);
    }
  });

  test("division by zero yields IEEE infinity", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 1));
    g = addNode(g, floatNode("b", 0));
    g = addNode(g, createNodeOfType("Divide", "div", { x: 100, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "div", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "b", port: "out" },
      target: { nodeId: "div", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "div", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const res = evaluateGraph(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.color[0]).toBe(Number.POSITIVE_INFINITY);
    }
  });

  test("invalid graph produces no value", () => {
    const g = addNode(createGraph(), floatNode("a", 1));
    const res = evaluateGraph(g);
    expect(res.ok).toBe(false);
  });
});

describe("dot product", () => {
  test("dot(a, b) emits the HLSL intrinsic", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float3", "v1", { x: 0, y: 0 }, { x: 1, y: 2, z: 3 }));
    g = addNode(g, createNodeOfType("Float3", "v2", { x: 0, y: 0 }, { x: 4, y: 5, z: 6 }));
    g = addNode(g, createNodeOfType("DotProduct", "dot", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "v1", port: "out" },
      target: { nodeId: "dot", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "v2", port: "out" },
      target: { nodeId: "dot", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "dot", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    expect(validate(g)).toEqual([]);
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float _2 = dot(_0, _1);");
    }
    const ev = evaluateGraph(g);
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.color[0]).toBe(1 * 4 + 2 * 5 + 3 * 6);
    }
  });

  test("mismatched vector lengths are rejected", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float2", "v1", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Float3", "v2", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("DotProduct", "dot", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "v1", port: "out" },
      target: { nodeId: "dot", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "v2", port: "out" },
      target: { nodeId: "dot", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "dot", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const errors = validate(g);
    const mismatch = errors.find(
      (e) => e.code === "TypeMismatch" && e.message.includes("equal length"),
    );
    expect(mismatch).toBeDefined();
    // Never misleading code: a graph with a broken dot generates nothing.
    expect(generate(g).ok).toBe(false);
  });

  test("scalar dot equals plain multiplication", () => {
    let g = createGraph();
    g = addNode(g, floatNode("a", 3));
    g = addNode(g, floatNode("b", 4));
    g = addNode(g, createNodeOfType("DotProduct", "dot", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "dot", port: "a" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "b", port: "out" },
      target: { nodeId: "dot", port: "b" },
    });
    g = addEdge(g, {
      id: "e3",
      source: { nodeId: "dot", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    const ev = evaluateGraph(g);
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.color[0]).toBe(12);
    }
  });
});

describe("texture sampling", () => {
  function sampleGraph(params: Record<string, number | Array<number>>) {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float2", "uv", { x: 0, y: 0 }, { x: 0.5, y: 0.5 }));
    g = addNode(g, createNodeOfType("SampleTexture2D", "s", { x: 0, y: 0 }, params));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "uv", port: "out" },
      target: { nodeId: "s", port: "UV" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "s", port: "RGBA" },
      target: { nodeId: "out", port: "color" },
    });
    return g;
  }

  test("default sample emits Texture2D + sampler declarations", () => {
    const res = generate(sampleGraph({ Type: 0, Space: 0 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("Texture2D Tex1;");
      expect(res.code).toContain("SamplerState sampler_Tex1;");
      expect(res.code).toContain("Tex1.Sample(sampler_Tex1, _0);");
      expect(res.code.startsWith("Texture2D Tex1;")).toBe(true);
      expect(res.code).not.toContain("srgbToLinear");
    }
  });

  test("Type=Normal unpacks to tangent space", () => {
    const res = generate(sampleGraph({ Type: 1, Space: 0 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain(
        "float4 _1 = normalize(Tex1.Sample(sampler_Tex1, _0) * 2.0 - 1.0);",
      );
    }
  });

  test("Space=Linear emits the sRGB transfer helper once", () => {
    const res = generate(sampleGraph({ Type: 0, Space: 1 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float3 srgbToLinear(float3 c)");
      expect(res.code.match(/srgbToLinear\(/g)?.length).toBe(2);
      expect(res.code).toContain("srgbToLinear(Tex1.Sample(sampler_Tex1, _0));");
    }
  });

  test("R/G/B/A outputs swizzle the sampled float4", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float2", "uv", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("SampleTexture2D", "s", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "uv", port: "out" },
      target: { nodeId: "s", port: "UV" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "s", port: "B" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Component reads are scalar, so the float4 output splats them.
      expect(res.code).toContain("float4 _2 = float4(_1.z, _1.z, _1.z, _1.z);");
    }
  });

  test("cubemap samples a normalized direction", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Float3", "dir", { x: 0, y: 0 }, { x: 0, y: 1, z: 0 }));
    g = addNode(g, createNodeOfType("SampleCubemap", "cube", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "dir", port: "out" },
      target: { nodeId: "cube", port: "Dir" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "cube", port: "RGBA" },
      target: { nodeId: "out", port: "color" },
    });
    expect(validate(g)).toEqual([]);
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("TextureCube Tex1;");
      expect(res.code).toContain("Tex1.Sample(sampler_Tex1, normalize(_0));");
    }
  });

  test("evaluation refuses GPU-only values instead of inventing them", () => {
    const ev = evaluateGraph(sampleGraph({ Type: 0, Space: 0 }));
    expect(ev.ok).toBe(false);
    if (!ev.ok) {
      expect(ev.errors[0]?.message).toContain("GPU data");
    }
  });
});

describe("scene inputs", () => {
  // float3 scene outputs reach the float4 Fragment Output through a Split,
  // the same way a user wires them in the editor.
  function sceneGraph(
    type: "NormalVector" | "MainLightDirection",
    params: Record<string, number | Array<number>> = {},
  ) {
    let g = createGraph();
    g = addNode(g, createNodeOfType(type, "src", { x: 0, y: 0 }, params));
    g = addNode(g, createNodeOfType("Split", "split", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "src", port: "out" },
      target: { nodeId: "split", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "split", port: "x" },
      target: { nodeId: "out", port: "color" },
    });
    return g;
  }

  test("normal vector defaults to world space", () => {
    const res = generate(sceneGraph("NormalVector"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float3 _NormalVector;");
      expect(res.code).toContain("float3 _0 = normalize(_NormalVector);");
      expect(res.code).toContain("float3 _1 = _0;");
      expect(res.code).toContain("float4 _2 = float4(_1.x, _1.x, _1.x, _1.x);");
      expect(res.code).not.toContain("_WorldToObject");
    }
  });

  test("object-space normals transform through _WorldToObject", () => {
    const res = generate(sceneGraph("NormalVector", { Space: 0 }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float4x4 _WorldToObject;");
      expect(res.code).toContain("normalize(mul((float3x3) _WorldToObject, _NormalVector))");
    }
  });

  test("main light direction is a normalized uniform", () => {
    const res = generate(sceneGraph("MainLightDirection"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float3 _MainLightDirection;");
      expect(res.code).toContain("float3 _0 = normalize(_MainLightDirection);");
    }
  });

  test("camera ports resolve per uniform and emit no variable", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Camera", "cam", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Split", "split", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "cam", port: "Position" },
      target: { nodeId: "split", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "split", port: "x" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float3 _CameraPosition;");
      expect(res.code).toContain("float3 _CameraDirection;");
      // The Split variable aliases the raw position uniform.
      expect(res.code).toContain("float3 _0 = _CameraPosition;");
      expect(res.code).toContain("float4 _1 = float4(_0.x, _0.x, _0.x, _0.x);");
    }
  });

  test("camera direction is normalized at the reference site", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("Camera", "cam", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Split", "split", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "cam", port: "Direction" },
      target: { nodeId: "split", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "split", port: "x" },
      target: { nodeId: "out", port: "color" },
    });
    const res = generate(g);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain("float3 _0 = normalize(_CameraDirection);");
    }
  });

  test("evaluation refuses engine-bound scene data", () => {
    let g = createGraph();
    g = addNode(g, createNodeOfType("MainLightDirection", "l", { x: 0, y: 0 }, {}));
    g = addNode(g, createNodeOfType("Split", "split", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "l", port: "out" },
      target: { nodeId: "split", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "split", port: "x" },
      target: { nodeId: "out", port: "color" },
    });
    const ev = evaluateGraph(g);
    expect(ev.ok).toBe(false);
    if (!ev.ok) {
      expect(ev.errors[0]?.message).toContain("bound by the engine");
    }
  });
});

describe("preview node", () => {
  function previewGraph() {
    let g = createGraph();
    g = addNode(g, floatNode("a", 0.25));
    g = addNode(g, createNodeOfType("Preview", "p", { x: 0, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "p", port: "in" },
    });
    g = addEdge(g, {
      id: "e2",
      source: { nodeId: "p", port: "out" },
      target: { nodeId: "out", port: "color" },
    });
    return g;
  }

  test("preview materializes a typed copy of its input", () => {
    const res = generate(previewGraph());
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The Preview variable aliases the float input; the output splats it.
      expect(res.code).toContain("float _1 = _0;");
      expect(res.code).toContain("float4 _2 = float4(_1, _1, _1, _1);");
    }
  });

  test("evaluateNode returns the value at the preview", () => {
    const g = previewGraph();
    const at = evaluateNode(g, "p");
    expect(at.ok).toBe(true);
    if (at.ok) {
      expect(at.value).toEqual([0.25]);
    }
    // A Preview that feeds nothing reports that instead of a made-up value.
    let solo = createGraph();
    solo = addNode(solo, createNodeOfType("Preview", "p", { x: 0, y: 0 }, {}));
    solo = addNode(solo, outputNode("out"));
    const unreachable = evaluateNode(solo, "p");
    expect(unreachable.ok).toBe(false);
  });
});
