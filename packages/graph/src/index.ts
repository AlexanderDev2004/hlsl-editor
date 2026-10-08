// Framework-independent graph domain model.
// Immutable (pure) helpers: every mutation returns a new Graph.
// Type compatibility is NOT checked here — that lives in shader-compiler
// so the graph stays usable for future type systems.

export const GRAPH_SCHEMA_VERSION = 1;

export interface Vec2 {
  x: number;
  y: number;
}

export type PortDirection = "in" | "out";

export interface Port {
  id: string;
  name: string;
  direction: PortDirection;
  valueType: string;
  required: boolean;
  defaultValue?: number | Array<number>;
}

export interface GraphNode {
  id: string;
  type: string;
  position: Vec2;
  ports: Array<Port>;
  params: Record<string, number | Array<number>>;
}

export interface EdgeEndpoint {
  nodeId: string;
  port: string;
}

export interface GraphEdge {
  id: string;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
}

export interface Graph {
  version: number;
  nodes: Array<GraphNode>;
  edges: Array<GraphEdge>;
  outputNodeId: string | null;
}

export interface SerializedGraph {
  version: number;
  nodes: Array<GraphNode>;
  edges: Array<GraphEdge>;
  outputNodeId: string | null;
}

export function portId(nodeId: string, portName: string): string {
  return `${nodeId}:${portName}`;
}

export function createGraph(): Graph {
  return { version: GRAPH_SCHEMA_VERSION, nodes: [], edges: [], outputNodeId: null };
}

export function findNode(graph: Graph, nodeId: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === nodeId);
}

export function findPort(node: GraphNode, portName: string): Port | undefined {
  return node.ports.find((p) => p.name === portName);
}

export function incomingEdge(
  graph: Graph,
  nodeId: string,
  portName: string,
): GraphEdge | undefined {
  return graph.edges.find((e) => e.target.nodeId === nodeId && e.target.port === portName);
}

export function outgoingEdges(graph: Graph, nodeId: string, portName: string): Array<GraphEdge> {
  return graph.edges.filter((e) => e.source.nodeId === nodeId && e.source.port === portName);
}

export function addNode(graph: Graph, node: GraphNode): Graph {
  if (findNode(graph, node.id) !== undefined) {
    throw new Error(`Duplicate node id: ${node.id}`);
  }
  const next: Graph = {
    ...graph,
    nodes: [...graph.nodes, node],
    outputNodeId: node.type === "FragmentOutput" ? node.id : graph.outputNodeId,
  };
  return next;
}

export function removeNode(graph: Graph, nodeId: string): Graph {
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => n.id !== nodeId),
    edges: graph.edges.filter((e) => e.source.nodeId !== nodeId && e.target.nodeId !== nodeId),
    outputNodeId: graph.outputNodeId === nodeId ? null : graph.outputNodeId,
  };
}

export function setNodePosition(graph: Graph, nodeId: string, position: Vec2): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, position: { ...position } } : n)),
  };
}

export function setNodeParam(
  graph: Graph,
  nodeId: string,
  key: string,
  value: number | Array<number>,
): Graph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) =>
      n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n,
    ),
  };
}

export type AddEdgeError =
  | { kind: "UnknownNode"; nodeId: string }
  | { kind: "UnknownPort"; nodeId: string; port: string }
  | { kind: "BadDirection" }
  | { kind: "InputAlreadyConnected"; nodeId: string; port: string }
  | { kind: "SelfLoop" };

// Structural edge validation only (existence, direction, single-input rule).
// Type checking happens in shader-compiler validation.
export function addEdge(graph: Graph, edge: GraphEdge): Graph {
  const sourceNode = findNode(graph, edge.source.nodeId);
  if (sourceNode === undefined) {
    throw new Error(`Unknown source node: ${edge.source.nodeId}`);
  }
  const targetNode = findNode(graph, edge.target.nodeId);
  if (targetNode === undefined) {
    throw new Error(`Unknown target node: ${edge.target.nodeId}`);
  }
  const sourcePort = findPort(sourceNode, edge.source.port);
  const targetPort = findPort(targetNode, edge.target.port);
  if (sourcePort === undefined || sourcePort.direction !== "out") {
    throw new Error(`Invalid source port: ${edge.source.nodeId}.${edge.source.port}`);
  }
  if (targetPort === undefined || targetPort.direction !== "in") {
    throw new Error(`Invalid target port: ${edge.target.nodeId}.${edge.target.port}`);
  }
  if (edge.source.nodeId === edge.target.nodeId) {
    throw new Error("Self-loop edges are not allowed");
  }
  if (graph.edges.some((e) => e.id === edge.id)) {
    throw new Error(`Duplicate edge id: ${edge.id}`);
  }
  if (incomingEdge(graph, edge.target.nodeId, edge.target.port) !== undefined) {
    throw new Error(`Input already connected: ${edge.target.nodeId}.${edge.target.port}`);
  }
  return { ...graph, edges: [...graph.edges, edge] };
}

export function removeEdge(graph: Graph, edgeId: string): Graph {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

// Depth-first cycle detection over node dependencies (target depends on source).
export function detectCycle(graph: Graph): { hasCycle: boolean; path: Array<string> } {
  const adjacency = new Map<string, Array<string>>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.target.nodeId);
    if (list !== undefined) {
      list.push(edge.source.nodeId);
    }
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: Array<string> = [];
  let found: Array<string> | null = null;

  const visit = (id: string): void => {
    if (found !== null) {
      return;
    }
    visited.add(id);
    stack.add(id);
    path.push(id);
    for (const dep of adjacency.get(id) ?? []) {
      if (found !== null) {
        return;
      }
      if (!visited.has(dep)) {
        visit(dep);
      } else if (stack.has(dep)) {
        found = [...path.slice(path.indexOf(dep)), dep];
        return;
      }
    }
    stack.delete(id);
    path.pop();
  };

  const sorted = [...graph.nodes].map((n) => n.id).sort();
  for (const id of sorted) {
    if (!visited.has(id)) {
      visit(id);
    }
  }
  return found === null ? { hasCycle: false, path: [] } : { hasCycle: true, path: found };
}

// Deterministic topological order of dependencies of `startId`
// (dependencies before dependents; ties broken by node id).
export function topoSortFrom(graph: Graph, startId: string): Array<string> {
  const deps = new Map<string, Array<string>>();
  for (const node of graph.nodes) {
    deps.set(node.id, []);
  }
  for (const edge of graph.edges) {
    deps.get(edge.target.nodeId)?.push(edge.source.nodeId);
  }
  for (const list of deps.values()) {
    list.sort();
  }
  const visited = new Set<string>();
  const order: Array<string> = [];
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    for (const dep of deps.get(id) ?? []) {
      visit(dep);
    }
    order.push(id);
  };
  visit(startId);
  return order;
}

export function serialize(graph: Graph): SerializedGraph {
  return {
    version: GRAPH_SCHEMA_VERSION,
    nodes: graph.nodes,
    edges: graph.edges,
    outputNodeId: graph.outputNodeId,
  };
}

export function deserialize(data: SerializedGraph): Graph {
  if (data.version > GRAPH_SCHEMA_VERSION) {
    throw new Error(`Unsupported graph version: ${data.version}`);
  }
  // v1 is current; future versions migrate here.
  const migrated: SerializedGraph = migrate(data);
  return {
    version: GRAPH_SCHEMA_VERSION,
    nodes: migrated.nodes,
    edges: migrated.edges,
    outputNodeId: migrated.outputNodeId,
  };
}

function migrate(data: SerializedGraph): SerializedGraph {
  if (data.version === 1 || data.version === undefined) {
    return {
      version: 1,
      nodes: data.nodes ?? [],
      edges: data.edges ?? [],
      outputNodeId: data.outputNodeId ?? null,
    };
  }
  return { version: 1, nodes: data.nodes, edges: data.edges, outputNodeId: data.outputNodeId };
}
