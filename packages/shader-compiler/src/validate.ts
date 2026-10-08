import { detectCycle, incomingEdge, type Graph } from "@hlsl-editor/graph";
import { NODE_REGISTRY, isNodeType, resolveOutputType } from "@hlsl-editor/shader-nodes";
import {
  canConnect,
  connectionErrorMessage,
  isMvp1Type,
  type HlslType,
} from "@hlsl-editor/shader-types";

import { err, type CompilerError } from "./errors";

// Validate structure + types. Returns errors (empty = valid).
export function validate(graph: Graph): Array<CompilerError> {
  const errors: Array<CompilerError> = [];

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
    const sourceDef = NODE_REGISTRY[source.type];
    const targetDef = NODE_REGISTRY[target.type];
    const sourcePortDef =
      sourceDef.outputs.find((p) => p.name === edge.source.port) ??
      sourceDef.inputs.find((p) => p.name === edge.source.port);
    const targetPortDef = targetDef.inputs.find((p) => p.name === edge.target.port);
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
    const allowed = targetPortDef.accepts ?? [targetPortDef.valueType];
    const ok = allowed.some((t) => canConnect(sourceType, t));
    if (!ok) {
      const expected = allowed.length === 1 ? (allowed[0] as string) : allowed.join(" | ");
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
    const def = NODE_REGISTRY[node.type];
    for (const input of def.inputs) {
      if (!input.required) {
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
  const def = NODE_REGISTRY[node.type];
  const outDef = def.outputs.find((p) => p.name === portName);
  if (outDef === undefined) {
    return null;
  }
  if (
    node.type === "Float" ||
    node.type === "Float2" ||
    node.type === "Float3" ||
    node.type === "Float4"
  ) {
    return outDef.valueType;
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
