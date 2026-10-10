import { addEdge, addNode, createGraph, type GraphNode } from "@hlsl-editor/graph";
import { createNodeOfType } from "@hlsl-editor/shader-nodes";
import type { HlslType } from "@hlsl-editor/shader-types";
import { describe, expect, test } from "vitest";

import { emitFunction, evaluateGraph, generate, type FunctionDefSource } from "./index";

function floatNode(id: string, value: number, x = 0): GraphNode {
  return createNodeOfType("Float", id, { x, y: 0 }, { value });
}

function float3Node(id: string, x = 0): GraphNode {
  return createNodeOfType("Float3", id, { x, y: 0 }, { x: 1, y: 2, z: 3 });
}

function functionInputNode(id: string, argName: string, argType: HlslType): GraphNode {
  return {
    id,
    type: "FunctionInput",
    position: { x: 0, y: 0 },
    params: {},
    ports: [
      {
        id: `${id}:${argName}`,
        name: argName,
        direction: "out",
        valueType: argType,
        required: false,
      },
    ],
  };
}

function functionOutputNode(id: string): GraphNode {
  return createNodeOfType("FunctionOutput", id, { x: 300, y: 0 }, {});
}

function functionCallNode(
  id: string,
  ref: string,
  args: Array<{ name: string; type: HlslType }>,
  returnType: HlslType,
): GraphNode {
  return {
    id,
    type: "FunctionCall",
    position: { x: 200, y: 0 },
    params: {},
    ref,
    ports: [
      ...args.map((a) => ({
        id: `${id}:${a.name}`,
        name: a.name,
        direction: "in" as const,
        valueType: a.type,
        required: true,
      })),
      {
        id: `${id}:out`,
        name: "out",
        direction: "out",
        valueType: returnType,
        required: false,
      },
    ],
  };
}

function edge(
  id: string,
  from: { nodeId: string; port: string },
  to: { nodeId: string; port: string },
) {
  return { id, source: from, target: to };
}

function outputNode(id: string): GraphNode {
  return createNodeOfType("FragmentOutput", id, { x: 500, y: 0 }, {});
}

describe("emitFunction", () => {
  test("zero-argument function emits a body and return", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "Fn1",
      args: [],
      nodes: [floatNode("c", 2), functionOutputNode("fo")],
      edges: [edge("e1", { nodeId: "c", port: "out" }, { nodeId: "fo", port: "in" })],
      outputNodeId: "fo",
    };
    const result = emitFunction(def);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("float Fn1()");
      expect(result.code).toContain("float _0 = 2.0;");
      expect(result.code).toContain("return _0;");
    }
  });

  test("two-argument dot function declares typed parameters", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "Dot2",
      args: [
        { name: "a", type: "float3" },
        { name: "b", type: "float3" },
      ],
      nodes: [
        functionInputNode("ia", "a", "float3"),
        functionInputNode("ib", "b", "float3"),
        createNodeOfType("DotProduct", "d", { x: 150, y: 0 }, {}),
        functionOutputNode("fo"),
      ],
      edges: [
        edge("e1", { nodeId: "ia", port: "a" }, { nodeId: "d", port: "a" }),
        edge("e2", { nodeId: "ib", port: "b" }, { nodeId: "d", port: "b" }),
        edge("e3", { nodeId: "d", port: "out" }, { nodeId: "fo", port: "in" }),
      ],
      outputNodeId: "fo",
    };
    const result = emitFunction(def);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("float Dot2(float3 a, float3 b)");
      expect(result.code).toContain("dot(a, b)");
      expect(result.code).toContain("return _0;");
    }
  });

  test("a cycle inside the body is rejected", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "Fn1",
      args: [],
      nodes: [createNodeOfType("Add", "a", { x: 100, y: 0 }, {}), functionOutputNode("fo")],
      edges: [
        edge("e1", { nodeId: "fo", port: "in" }, { nodeId: "a", port: "a" }),
        edge("e2", { nodeId: "a", port: "out" }, { nodeId: "fo", port: "in" }),
      ],
      outputNodeId: "fo",
    };
    const result = emitFunction(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.code === "CycleDetected")).toBe(true);
    }
  });

  test("an invalid function name is rejected", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "1bad name",
      args: [],
      nodes: [floatNode("c", 1), functionOutputNode("fo")],
      edges: [edge("e1", { nodeId: "c", port: "out" }, { nodeId: "fo", port: "in" })],
      outputNodeId: "fo",
    };
    expect(emitFunction(def).ok).toBe(false);
  });
});

describe("generate with Material Functions", () => {
  // fn: Dot2(a: float3, b: float3) -> float, wired from two constant float3s.
  function dotDef(): FunctionDefSource {
    return {
      id: "f1",
      name: "Dot2",
      args: [
        { name: "a", type: "float3" },
        { name: "b", type: "float3" },
      ],
      nodes: [
        functionInputNode("ia", "a", "float3"),
        functionInputNode("ib", "b", "float3"),
        createNodeOfType("DotProduct", "d", { x: 150, y: 0 }, {}),
        functionOutputNode("fo"),
      ],
      edges: [
        edge("e1", { nodeId: "ia", port: "a" }, { nodeId: "d", port: "a" }),
        edge("e2", { nodeId: "ib", port: "b" }, { nodeId: "d", port: "b" }),
        edge("e3", { nodeId: "d", port: "out" }, { nodeId: "fo", port: "in" }),
      ],
      outputNodeId: "fo",
    };
  }

  function mainGraph(): ReturnType<typeof createGraph> {
    let g = createGraph();
    g = addNode(g, float3Node("v1", 0));
    g = addNode(g, float3Node("v2", 80));
    g = addNode(
      g,
      functionCallNode(
        "call",
        "f1",
        [
          { name: "a", type: "float3" },
          { name: "b", type: "float3" },
        ],
        "float",
      ),
    );
    g = addNode(g, outputNode("out"));
    g = addEdge(g, edge("e1", { nodeId: "v1", port: "out" }, { nodeId: "call", port: "a" }));
    g = addEdge(g, edge("e2", { nodeId: "v2", port: "out" }, { nodeId: "call", port: "b" }));
    g = addEdge(g, edge("e3", { nodeId: "call", port: "out" }, { nodeId: "out", port: "color" }));
    return g;
  }

  test("emits the function once and calls it at the use site", () => {
    const result = generate(mainGraph(), { functions: [dotDef()] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("float Dot2(float3 a, float3 b)");
      expect(result.code.match(/float Dot2/g)?.length).toBe(1);
      expect(result.code).toContain("= Dot2(");
      expect(result.code).toContain("float4 main() : SV_Target");
    }
  });

  test("an unknown function reference is a compile error", () => {
    const result = generate(mainGraph(), { functions: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes("Unknown function reference"))).toBe(
        true,
      );
    }
  });

  test("a scalar wire into a vector parameter splats", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "Scale",
      args: [{ name: "a", type: "float3" }],
      nodes: [functionInputNode("ia", "a", "float3"), functionOutputNode("fo")],
      edges: [edge("e1", { nodeId: "ia", port: "a" }, { nodeId: "fo", port: "in" })],
      outputNodeId: "fo",
    };
    let g = createGraph();
    g = addNode(g, floatNode("s", 2));
    g = addNode(g, functionCallNode("call", "f1", [{ name: "a", type: "float3" }], "float3"));
    g = addNode(g, createNodeOfType("Split", "sp", { x: 350, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, edge("e1", { nodeId: "s", port: "out" }, { nodeId: "call", port: "a" }));
    g = addEdge(g, edge("e2", { nodeId: "call", port: "out" }, { nodeId: "sp", port: "in" }));
    g = addEdge(g, edge("e3", { nodeId: "sp", port: "x" }, { nodeId: "out", port: "color" }));
    const result = generate(g, { functions: [def] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("float3 Scale(float3 a)");
      expect(result.code).toContain("Scale(float3(_0, _0, _0))");
    }
  });

  test("texture declarations used inside a function hoist to global scope", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "Sample",
      args: [],
      nodes: [
        createNodeOfType("Float2", "uv", { x: 0, y: 80 }, {}),
        createNodeOfType("SampleTexture2D", "t", { x: 0, y: 0 }, {}),
        functionOutputNode("fo"),
      ],
      edges: [
        edge("e1", { nodeId: "uv", port: "out" }, { nodeId: "t", port: "UV" }),
        edge("e2", { nodeId: "t", port: "RGBA" }, { nodeId: "fo", port: "in" }),
      ],
      outputNodeId: "fo",
    };
    let g = createGraph();
    g = addNode(g, functionCallNode("call", "f1", [], "float4"));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, edge("e1", { nodeId: "call", port: "out" }, { nodeId: "out", port: "color" }));
    const result = generate(g, { functions: [def] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fnIndex = result.code.indexOf("float4 Sample()");
      const declIndex = result.code.indexOf("Texture2D Tex");
      expect(fnIndex).toBeGreaterThan(-1);
      expect(declIndex).toBeGreaterThan(-1);
      expect(declIndex).toBeLessThan(fnIndex);
    }
  });

  test("two calls to the same function emit the body once", () => {
    let g = createGraph();
    g = addNode(g, float3Node("v1", 0));
    g = addNode(g, float3Node("v2", 80));
    g = addNode(
      g,
      functionCallNode(
        "call1",
        "f1",
        [
          { name: "a", type: "float3" },
          { name: "b", type: "float3" },
        ],
        "float",
      ),
    );
    g = addNode(
      g,
      functionCallNode(
        "call2",
        "f1",
        [
          { name: "a", type: "float3" },
          { name: "b", type: "float3" },
        ],
        "float",
      ),
    );
    g = addNode(g, createNodeOfType("Add", "sum", { x: 350, y: 0 }, {}));
    g = addNode(g, outputNode("out"));
    g = addEdge(g, edge("e1", { nodeId: "v1", port: "out" }, { nodeId: "call1", port: "a" }));
    g = addEdge(g, edge("e2", { nodeId: "v2", port: "out" }, { nodeId: "call1", port: "b" }));
    g = addEdge(g, edge("e3", { nodeId: "v1", port: "out" }, { nodeId: "call2", port: "a" }));
    g = addEdge(g, edge("e4", { nodeId: "v2", port: "out" }, { nodeId: "call2", port: "b" }));
    g = addEdge(g, edge("e5", { nodeId: "call1", port: "out" }, { nodeId: "sum", port: "a" }));
    g = addEdge(g, edge("e6", { nodeId: "call2", port: "out" }, { nodeId: "sum", port: "b" }));
    g = addEdge(g, edge("e7", { nodeId: "sum", port: "out" }, { nodeId: "out", port: "color" }));
    const result = generate(g, { functions: [dotDef()] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code.match(/float Dot2\(/g)?.length).toBe(1);
      expect(result.code.match(/= Dot2\(/g)?.length).toBe(2);
    }
  });
});

describe("evaluate with Material Functions", () => {
  test("numeric evaluation runs through the function body", () => {
    const def: FunctionDefSource = {
      id: "f1",
      name: "Add2",
      args: [
        { name: "a", type: "float" },
        { name: "b", type: "float" },
      ],
      nodes: [
        functionInputNode("ia", "a", "float"),
        functionInputNode("ib", "b", "float"),
        createNodeOfType("Add", "sum", { x: 150, y: 0 }, {}),
        functionOutputNode("fo"),
      ],
      edges: [
        edge("e1", { nodeId: "ia", port: "a" }, { nodeId: "sum", port: "a" }),
        edge("e2", { nodeId: "ib", port: "b" }, { nodeId: "sum", port: "b" }),
        edge("e3", { nodeId: "sum", port: "out" }, { nodeId: "fo", port: "in" }),
      ],
      outputNodeId: "fo",
    };
    let g = createGraph();
    g = addNode(g, floatNode("s1", 2));
    g = addNode(g, floatNode("s2", 5, 40));
    g = addNode(
      g,
      functionCallNode(
        "call",
        "f1",
        [
          { name: "a", type: "float" },
          { name: "b", type: "float" },
        ],
        "float",
      ),
    );
    g = addNode(g, outputNode("out"));
    g = addEdge(g, edge("e1", { nodeId: "s1", port: "out" }, { nodeId: "call", port: "a" }));
    g = addEdge(g, edge("e2", { nodeId: "s2", port: "out" }, { nodeId: "call", port: "b" }));
    g = addEdge(g, edge("e3", { nodeId: "call", port: "out" }, { nodeId: "out", port: "color" }));
    const result = evaluateGraph(g, { functions: [def] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.color).toEqual([7, 7, 7, 7]);
    }
  });
});
