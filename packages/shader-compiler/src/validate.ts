import { detectCycle, incomingEdge, type Graph } from "@hlsl-editor/graph";
import { isNodeType, resolveOutputType } from "@hlsl-editor/shader-nodes";
import {
  canConnect,
  componentCount,
  connectionErrorMessage,
  describeType,
  isMvp1Type,
  type HlslType,
} from "@hlsl-editor/shader-types";

import { err, type CompilerError } from "./errors";

// Structural validation shared by the main graph and Material Function
// bodies: cycles, edge endpoints/types, required inputs. Does NOT require
// an entry point (a function body ends at a FunctionOutput instead).
export function validateStructure(graph: Graph): Array<CompilerError> {
  const errors: Array<CompilerError> = [];

  const cycle = detectCycle(graph);
  if (cycle.hasCycle) {
    errors.push(err("CycleDetected", `Cycle detected: ${cycle.path.join(" -> ")}.`));
  }

  for (const edge of graph.edges) {
    const source = graph.nodes.find((n) => n.id === edge.source.nodeId);
    const target = graph.nodes.find((n) => n.id === edge.target.nodeId);
    if (source === undefined || target === undefined) {
      errors.push(
        err("InvalidGraph", `Edge ${edge.id} references a missing node.`, target?.id ?? source?.id),
      );
      continue;
    }
    if (!isNodeType(source.type) || !isNodeType(target.type)) {
      errors.push(err("InvalidGraph", `Edge ${edge.id} references unknown node type.`, target.id));
      continue;
    }
    // Port lookups use the node's own ports so per-instance ports (e.g.
    // FunctionCall arguments) validate exactly like registry ports.
    const sourcePortDef = source.ports.find(
      (p) => p.name === edge.source.port && p.direction === "out",
    );
    const targetPortDef = target.ports.find(
      (p) => p.name === edge.target.port && p.direction === "in",
    );
    if (sourcePortDef === undefined || sourcePortDef.direction !== "out") {
      errors.push(
        err(
          "InvalidConnection",
          `Invalid source port: ${edge.source.nodeId}.${edge.source.port}.`,
          source.id,
        ),
      );
      continue;
    }
    if (targetPortDef === undefined) {
      errors.push(
        err(
          "InvalidConnection",
          `Invalid target port: ${edge.target.nodeId}.${edge.target.port}.`,
          target.id,
        ),
      );
      continue;
    }
    const sourceType = upstreamPortType(graph, edge.source.nodeId, edge.source.port);
    if (sourceType === null) {
      continue;
    }
    const allowed = (targetPortDef.accepts ?? [targetPortDef.valueType]).filter(
      (t): t is HlslType => isMvp1Type(t),
    );
    const ok = allowed.some((t) => canConnect(sourceType, t));
    if (!ok) {
      const expected = targetPortDef.valueType;
      errors.push(
        err(
          "TypeMismatch",
          connectionErrorMessage(expected, sourceType),
          target.id,
          `${target.id}:${targetPortDef.name}`,
        ),
      );
    }
  }

  for (const node of graph.nodes) {
    if (!isNodeType(node.type)) {
      errors.push(err("InvalidGraph", `Unknown node type: ${node.type}.`, node.id));
      continue;
    }
    for (const input of node.ports) {
      if (input.direction !== "in" || !input.required) {
        continue;
      }
      const edge = incomingEdge(graph, node.id, input.name);
      if (edge === undefined) {
        // Combine z/w are optional in practice; registry marks them
        // optional already. Required inputs missing = error.
        errors.push(
          err(
            "MissingRequiredInput",
            `Missing required input: ${node.type}.${input.name}.`,
            node.id,
            `${node.id}:${input.name}`,
          ),
        );
      }
    }
    if (node.type === "Split") {
      const inType = upstreamPortType(graph, node.id, "in");
      if (inType !== null && !isMvp1Type(inType)) {
        errors.push(
          err(
            "TypeMismatch",
            connectionErrorMessage("float2 | float3 | float4", inType),
            node.id,
            `${node.id}:in`,
          ),
        );
      }
    }
    // dot(x, y) requires both operands to have the same number of
    // components (HLSL docs: the operands must be the same size). Types
    // resolve through the operand edges' SOURCE ports.
    if (node.type === "DotProduct") {
      const edgeA = incomingEdge(graph, node.id, "a");
      const edgeB = incomingEdge(graph, node.id, "b");
      const a =
        edgeA !== undefined
          ? upstreamPortType(graph, edgeA.source.nodeId, edgeA.source.port)
          : null;
      const b =
        edgeB !== undefined
          ? upstreamPortType(graph, edgeB.source.nodeId, edgeB.source.port)
          : null;
      if (a !== null && b !== null && componentCount(a) !== componentCount(b)) {
        errors.push(
          err(
            "TypeMismatch",
            `Dot Product requires inputs of equal length (got ${describeType(a)} and ${describeType(b)}).`,
            node.id,
          ),
        );
      }
    }
  }

  return errors;
}

// Full main-graph validation: structure plus the Fragment Output entry
// point requirement.
export function validate(graph: Graph): Array<CompilerError> {
  const errors = validateStructure(graph);

  const outputNodes = graph.nodes.filter((n) => n.type === "FragmentOutput");
  if (outputNodes.length === 0 || graph.outputNodeId === null) {
    errors.push(
      err("MissingOutput", "Graph has no Fragment Output node. Add one to generate HLSL."),
    );
  } else if (outputNodes.length > 1) {
    errors.push(
      err(
        "InvalidGraph",
        `Graph has ${outputNodes.length} Fragment Output nodes; exactly one is required.`,
      ),
    );
  }
  const outputNode = graph.nodes.find((n) => n.id === graph.outputNodeId);
  if (graph.outputNodeId !== null && outputNode === undefined) {
    errors.push(err("InvalidGraph", `Output node not found: ${graph.outputNodeId}.`));
  }

  return errors;
}

// Best-effort upstream output type for cycle-free error messages.
// Returns null when it cannot be determined (errors reported elsewhere).
// Cycle-guarded: returns null instead of recursing forever on cyclic graphs
// (the cycle itself is reported separately as CycleDetected).
export function upstreamPortType(
  graph: Graph,
  nodeId: string,
  portName: string,
  seen: Set<string> = new Set(),
): HlslType | null {
  if (seen.has(nodeId)) {
    return null;
  }
  seen.add(nodeId);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined || !isNodeType(node.type)) {
    return null;
  }
  const outDef = node.ports.find((p) => p.direction === "out" && p.name === portName);
  if (outDef === undefined) {
    return null;
  }
  if (
    node.type === "Float" ||
    node.type === "Float2" ||
    node.type === "Float3" ||
    node.type === "Float4"
  ) {
    return isMvp1Type(outDef.valueType) ? outDef.valueType : null;
  }
  if (
    node.type === "Add" ||
    node.type === "Subtract" ||
    node.type === "Multiply" ||
    node.type === "Divide"
  ) {
    const a = inputActualType(graph, nodeId, "a", seen);
    const b = inputActualType(graph, nodeId, "b", seen);
    if (a === null || b === null) {
      return null;
    }
    return resolveOutputType(node.type, { a, b });
  }
  if (node.type === "Split") {
    return "float";
  }
  if (node.type === "Preview") {
    return inputActualType(graph, nodeId, "in", seen);
  }
  if (node.type === "DotProduct") {
    const a = inputActualType(graph, nodeId, "a", seen);
    const b = inputActualType(graph, nodeId, "b", seen);
    if (a === null || b === null) {
      return null;
    }
    return resolveOutputType(node.type, { a, b });
  }
  if (
    node.type === "SampleTexture2D" ||
    node.type === "SampleCubemap" ||
    node.type === "NormalVector" ||
    node.type === "MainLightDirection" ||
    node.type === "Camera"
  ) {
    // R/G/B/A are scalar component reads off the float4 sample variable;
    // only the RGBA port carries the full vector.
    if (node.type === "SampleTexture2D" || node.type === "SampleCubemap") {
      return portName === "RGBA" ? "float4" : "float";
    }
    return resolveOutputType(node.type, {});
  }
  if (
    node.type === "Reroute" ||
    node.type === "NamedRerouteDeclaration" ||
    node.type === "NamedRerouteUsage"
  ) {
    return inputActualType(graph, nodeId, "in", seen);
  }
  if (node.type === "Combine") {
    const inputs: Record<string, HlslType> = {};
    for (const name of ["x", "y", "z", "w"]) {
      const t = inputActualType(graph, nodeId, name, seen);
      if (t !== null) {
        inputs[name] = t;
      }
    }
    return resolveOutputType("Combine", inputs);
  }
  if (node.type === "FunctionCall" || node.type === "FunctionInput") {
    // Per-instance ports carry the concrete argument/return type directly.
    return isMvp1Type(outDef.valueType) ? outDef.valueType : null;
  }
  return null;
}

function inputActualType(
  graph: Graph,
  nodeId: string,
  portName: string,
  seen: Set<string>,
): HlslType | null {
  const edge = incomingEdge(graph, nodeId, portName);
  if (edge === undefined) {
    return null;
  }
  return upstreamPortType(graph, edge.source.nodeId, edge.source.port, seen);
}
