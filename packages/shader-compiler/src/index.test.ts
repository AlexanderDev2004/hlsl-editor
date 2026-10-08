import { addEdge, addNode, createGraph } from "@hlsl-editor/graph";
import { createNodeOfType } from "@hlsl-editor/shader-nodes";
import { describe, expect, test } from "vitest";

import { generate, toIR, validate } from "./index";

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
});
