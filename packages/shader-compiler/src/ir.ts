// Graph IR: UI-free intermediate representation between the graph and
// the HLSL emitter. Contains no position/selection/viewport state.

import type { Graph } from "@hlsl-editor/graph";
import { incomingEdge } from "@hlsl-editor/graph";
import { isNodeType, isRerouteType, type NodeType } from "@hlsl-editor/shader-nodes";
import type { HlslType } from "@hlsl-editor/shader-types";

import { upstreamPortType } from "./validate";

export type IROp = NodeType;

export interface IRNode {
  id: string;
  op: IROp;
  outType: HlslType;
  // Ordered input expressions resolved during HLSL emission.
  inputs: Record<string, { fromNodeId: string; fromPort: string; fromType: HlslType }>;
  params: Record<string, number | Array<number>>;
  // Assigned variable name (_0, _1, ...) in deterministic topo order.
  variable: string;
}

export interface GraphIR {
  nodes: Array<IRNode>;
  outputNodeId: string;
  outputVar: string;
}

// Build IR from an already-validated graph. Throws on invalid input.
export function toIR(graph: Graph): GraphIR {
  if (graph.outputNodeId === null) {
    throw new Error("Cannot build IR without an output node");
  }
  const outputNode = graph.nodes.find((n) => n.id === graph.outputNodeId);
  if (outputNode === undefined || outputNode.type !== "FragmentOutput") {
    throw new Error("Output node must be a FragmentOutput");
  }

  // Reachable set via reverse walk from output (dependencies only).
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) {
      return;
    }
    reachable.add(id);
    for (const edge of graph.edges.filter((e) => e.target.nodeId === id)) {
      visit(edge.source.nodeId);
    }
  };
  visit(outputNode.id);

  // Deterministic topo order: DFS with id-sorted adjacency.
  const deps = new Map<string, Array<string>>();
  for (const id of reachable) {
    deps.set(id, []);
  }
  const sortedEdges = [...graph.edges].sort((a, b) =>
    a.source.nodeId < b.source.nodeId ? -1 : a.source.nodeId > b.source.nodeId ? 1 : 0,
  );
  for (const edge of sortedEdges) {
    if (reachable.has(edge.target.nodeId) && reachable.has(edge.source.nodeId)) {
      deps.get(edge.target.nodeId)?.push(edge.source.nodeId);
    }
  }
  for (const list of deps.values()) {
    list.sort();
  }
  const order: Array<string> = [];
  const seen = new Set<string>();
  const dfs = (id: string): void => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    for (const dep of deps.get(id) ?? []) {
      dfs(dep);
    }
    order.push(id);
  };
  dfs(outputNode.id);

  const varOf = new Map<string, string>();
  let counter = 0;
  for (const id of order) {
    const node = graph.nodes.find((n) => n.id === id);
    if (node === undefined || !isNodeType(node.type)) {
      continue;
    }
    // Transparent nodes (reroutes, the output) emit no variable, so the
    // numbering downstream matches a graph without them.
    if (node.type === "FragmentOutput" || isRerouteType(node.type)) {
      continue;
    }
    varOf.set(id, `_${counter}`);
    counter += 1;
  }
  const outputVar = `_${counter}`;

  const nodes: Array<IRNode> = [];
  for (const id of order) {
    const node = graph.nodes.find((n) => n.id === id);
    if (node === undefined || !isNodeType(node.type)) {
      throw new Error(`Invalid node in IR walk: ${id}`);
    }
    const def_inputs: Array<string> = inputPortNames(node.type);
    const inputs: IRNode["inputs"] = {};
    for (const name of def_inputs) {
      const edge = incomingEdge(graph, id, name);
      if (edge !== undefined) {
        const fromType = upstreamPortType(graph, edge.source.nodeId, edge.source.port);
        if (fromType === null) {
          throw new Error(`Cannot resolve type for ${edge.source.nodeId}.${edge.source.port}`);
        }
        inputs[name] = { fromNodeId: edge.source.nodeId, fromPort: edge.source.port, fromType };
      }
    }
    const outType =
      node.type === "FragmentOutput" ? ("float4" as HlslType) : resolveNodeOutType(graph, id);
    nodes.push({
      id,
      op: node.type,
      outType,
      inputs,
      params: node.params,
      variable: varOf.get(id) ?? "",
    });
  }

  return { nodes, outputNodeId: outputNode.id, outputVar };
}

function inputPortNames(type: NodeType): Array<string> {
  switch (type) {
    case "Float":
    case "Float2":
    case "Float3":
    case "Float4":
      return [];
    case "Add":
    case "Subtract":
    case "Multiply":
    case "Divide":
      return ["a", "b"];
    case "Split":
      return ["in"];
    case "Combine":
      return ["x", "y", "z", "w"];
    case "Reroute":
    case "NamedRerouteDeclaration":
    case "NamedRerouteUsage":
      return ["in"];
    case "FragmentOutput":
      return ["color"];
  }
}

function resolveNodeOutType(graph: Graph, nodeId: string): HlslType {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined || !isNodeType(node.type)) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  // Input nodes carry their own type.
  if (node.type === "Float") {
    return "float";
  }
  if (node.type === "Float2") {
    return "float2";
  }
  if (node.type === "Float3") {
    return "float3";
  }
  if (node.type === "Float4") {
    return "float4";
  }
  // Split aliases the input vector; its variable keeps the vector type
  // so downstream port reads emit swizzles off it.
  if (node.type === "Split") {
    const edge = incomingEdge(graph, nodeId, "in");
    if (edge === undefined) {
      throw new Error(`Cannot resolve output type for ${nodeId}`);
    }
    const t = upstreamPortType(graph, edge.source.nodeId, edge.source.port);
    if (t === null) {
      throw new Error(`Cannot resolve output type for ${nodeId}`);
    }
    return t;
  }
  const t = upstreamPortType(graph, nodeId, "out");
  if (t === null) {
    throw new Error(`Cannot resolve output type for ${nodeId}`);
  }
  return t;
}
