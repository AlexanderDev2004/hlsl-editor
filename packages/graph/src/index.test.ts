import { describe, expect, test } from "vitest";

import {
  addEdge,
  addNode,
  createGraph,
  deserialize,
  detectCycle,
  incomingEdge,
  removeEdge,
  removeNode,
  serialize,
  setNodePosition,
  topoSortFrom,
  type GraphNode,
} from "./index";

function node(id: string, type = "Float"): GraphNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    ports:
      type === "FragmentOutput"
        ? [
            {
              id: `${id}:color`,
              name: "color",
              direction: "in",
              valueType: "float4",
              required: true,
            },
          ]
        : [
            { id: `${id}:out`, name: "out", direction: "out", valueType: "float", required: false },
            { id: `${id}:in`, name: "in", direction: "in", valueType: "float", required: false },
          ],
    params: {},
  };
}

describe("graph", () => {
  test("node creation and lookup", () => {
    const g = addNode(createGraph(), node("a"));
    expect(g.nodes).toHaveLength(1);
    expect(() => addNode(g, node("a"))).toThrow(/Duplicate node/);
  });

  test("edge creation enforces single edge per input", () => {
    let g = createGraph();
    g = addNode(g, node("a"));
    g = addNode(g, node("b"));
    g = addNode(g, node("c"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "b", port: "in" },
    });
    expect(incomingEdge(g, "b", "in")?.id).toBe("e1");
    expect(() =>
      addEdge(g, {
        id: "e2",
        source: { nodeId: "c", port: "out" },
        target: { nodeId: "b", port: "in" },
      }),
    ).toThrow(/already connected/);
  });

  test("edge removal", () => {
    let g = createGraph();
    g = addNode(g, node("a"));
    g = addNode(g, node("b"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "b", port: "in" },
    });
    g = removeEdge(g, "e1");
    expect(g.edges).toHaveLength(0);
  });

  test("remove node drops connected edges", () => {
    let g = createGraph();
    g = addNode(g, node("a"));
    g = addNode(g, node("b"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "b", port: "in" },
    });
    g = removeNode(g, "a");
    expect(g.edges).toHaveLength(0);
  });

  test("cycle detection", () => {
    let g = createGraph();
    g = addNode(g, node("a", "Add"));
    g = addNode(g, node("b", "Add"));
    // a.in <- b.out, b.in <- a.out
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "b", port: "out" },
      target: { nodeId: "a", port: "in" },
    });
    // need second input port; reuse validation bypass by direct push
    const cyclic = {
      ...g,
      edges: [
        ...g.edges,
        { id: "e2", source: { nodeId: "a", port: "out" }, target: { nodeId: "b", port: "in" } },
      ],
    };
    expect(detectCycle(cyclic).hasCycle).toBe(true);
    expect(detectCycle(g).hasCycle).toBe(false);
  });

  test("topo sort is deterministic and dependency-first", () => {
    let g = createGraph();
    g = addNode(g, node("out", "FragmentOutput"));
    g = addNode(g, node("mul", "Add"));
    g = addNode(g, node("a"));
    g = addNode(g, node("b"));
    g = addEdge(g, {
      id: "e1",
      source: { nodeId: "a", port: "out" },
      target: { nodeId: "mul", port: "in" },
    });
    const order = topoSortFrom(g, "mul");
    expect(order[order.length - 1]).toBe("mul");
    expect(order).toContain("a");
  });

  test("setNodePosition is immutable", () => {
    const g = addNode(createGraph(), node("a"));
    const moved = setNodePosition(g, "a", { x: 5, y: 6 });
    expect(g.nodes[0]?.position).toEqual({ x: 0, y: 0 });
    expect(moved.nodes[0]?.position).toEqual({ x: 5, y: 6 });
  });

  test("serialize round-trips with version", () => {
    let g = createGraph();
    g = addNode(g, node("a"));
    const data = serialize(g);
    expect(data.version).toBe(1);
    expect(
      deserialize(JSON.parse(JSON.stringify(data)) as ReturnType<typeof serialize>).nodes,
    ).toHaveLength(1);
  });

  test("disconnected nodes are simply absent from topo walk", () => {
    let g = createGraph();
    g = addNode(g, node("a"));
    g = addNode(g, node("lonely"));
    expect(topoSortFrom(g, "a")).toEqual(["a"]);
  });
});
