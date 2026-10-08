// MVP 1 node registry. Static port shapes; dynamic output types for
// polymorphic math (Add/Sub/Mul/Div) and Combine are resolved by
// `resolveOutputType` from actual upstream types.

import type { GraphNode, Port, Vec2 } from "@hlsl-editor/graph";
import { componentCount, type HlslType } from "@hlsl-editor/shader-types";

export const NODE_TYPES = [
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
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface PortDef {
  name: string;
  direction: "in" | "out";
  valueType: HlslType;
  required: boolean;
  accepts?: ReadonlyArray<HlslType>;
}

export interface NodeDefinition {
  type: NodeType;
  label: string;
  category: "Input" | "Math" | "Vector" | "Utility" | "Output";
  inputs: Array<PortDef>;
  outputs: Array<PortDef>;
  defaultParams: Record<string, number | Array<number>>;
}

function port(nodeId: string, def: PortDef): Port {
  return {
    id: `${nodeId}:${def.name}`,
    name: def.name,
    direction: def.direction,
    valueType: def.valueType,
    required: def.required,
  };
}

const MATH_INPUTS: Array<PortDef> = [
  {
    name: "a",
    direction: "in",
    valueType: "float",
    required: true,
    accepts: ["float", "float2", "float3", "float4"],
  },
  {
    name: "b",
    direction: "in",
    valueType: "float",
    required: true,
    accepts: ["float", "float2", "float3", "float4"],
  },
];

// Reroute-family nodes pass their input value through unchanged. The port
// type is nominal (float); the real type is resolved from the upstream.
const ANY_INPUT: Array<PortDef> = [
  {
    name: "in",
    direction: "in",
    valueType: "float",
    required: true,
    accepts: ["float", "float2", "float3", "float4"],
  },
];
const PASSTHROUGH_OUTPUT: Array<PortDef> = [
  { name: "out", direction: "out", valueType: "float", required: false },
];

export const NODE_REGISTRY: Record<NodeType, NodeDefinition> = {
  Float: {
    type: "Float",
    label: "Float",
    category: "Input",
    inputs: [],
    outputs: [{ name: "out", direction: "out", valueType: "float", required: false }],
    defaultParams: { value: 0 },
  },
  Float2: {
    type: "Float2",
    label: "Float2",
    category: "Input",
    inputs: [],
    outputs: [{ name: "out", direction: "out", valueType: "float2", required: false }],
    defaultParams: { x: 0, y: 0 },
  },
  Float3: {
    type: "Float3",
    label: "Float3",
    category: "Input",
    inputs: [],
    outputs: [{ name: "out", direction: "out", valueType: "float3", required: false }],
    defaultParams: { x: 0, y: 0, z: 0 },
  },
  Float4: {
    type: "Float4",
    label: "Float4",
    category: "Input",
    inputs: [],
    outputs: [{ name: "out", direction: "out", valueType: "float4", required: false }],
    defaultParams: { x: 0, y: 0, z: 0, w: 0 },
  },
  Add: {
    type: "Add",
    label: "Add",
    category: "Math",
    inputs: MATH_INPUTS,
    outputs: [{ name: "out", direction: "out", valueType: "float", required: false }],
    defaultParams: {},
  },
  Subtract: {
    type: "Subtract",
    label: "Subtract",
    category: "Math",
    inputs: MATH_INPUTS,
    outputs: [{ name: "out", direction: "out", valueType: "float", required: false }],
    defaultParams: {},
  },
  Multiply: {
    type: "Multiply",
    label: "Multiply",
    category: "Math",
    inputs: MATH_INPUTS,
    outputs: [{ name: "out", direction: "out", valueType: "float", required: false }],
    defaultParams: {},
  },
  Divide: {
    type: "Divide",
    label: "Divide",
    category: "Math",
    inputs: MATH_INPUTS,
    outputs: [{ name: "out", direction: "out", valueType: "float", required: false }],
    defaultParams: {},
  },
  Split: {
    type: "Split",
    label: "Split",
    category: "Vector",
    inputs: [
      {
        name: "in",
        direction: "in",
        valueType: "float2",
        required: true,
        accepts: ["float2", "float3", "float4"],
      },
    ],
    outputs: [
      { name: "x", direction: "out", valueType: "float", required: false },
      { name: "y", direction: "out", valueType: "float", required: false },
      { name: "z", direction: "out", valueType: "float", required: false },
      { name: "w", direction: "out", valueType: "float", required: false },
    ],
    defaultParams: {},
  },
  Combine: {
    type: "Combine",
    label: "Combine",
    category: "Vector",
    inputs: [
      { name: "x", direction: "in", valueType: "float", required: true },
      { name: "y", direction: "in", valueType: "float", required: true },
      { name: "z", direction: "in", valueType: "float", required: false },
      { name: "w", direction: "in", valueType: "float", required: false },
    ],
    outputs: [{ name: "out", direction: "out", valueType: "float2", required: false }],
    defaultParams: {},
  },
  FragmentOutput: {
    type: "FragmentOutput",
    label: "Fragment Output",
    category: "Output",
    inputs: [
      {
        name: "color",
        direction: "in",
        valueType: "float4",
        required: true,
        accepts: ["float", "float4"],
      },
    ],
    outputs: [],
    defaultParams: {},
  },
  Reroute: {
    type: "Reroute",
    label: "Reroute",
    category: "Utility",
    inputs: ANY_INPUT,
    outputs: PASSTHROUGH_OUTPUT,
    defaultParams: {},
  },
  NamedRerouteDeclaration: {
    type: "NamedRerouteDeclaration",
    label: "Reroute Declaration",
    category: "Utility",
    inputs: ANY_INPUT,
    outputs: PASSTHROUGH_OUTPUT,
    defaultParams: {},
  },
  NamedRerouteUsage: {
    type: "NamedRerouteUsage",
    label: "Reroute Usage",
    category: "Utility",
    inputs: ANY_INPUT,
    outputs: PASSTHROUGH_OUTPUT,
    defaultParams: {},
  },
};

export const REROUTE_TYPES: ReadonlyArray<NodeType> = [
  "Reroute",
  "NamedRerouteDeclaration",
  "NamedRerouteUsage",
];

export function isRerouteType(type: string): boolean {
  return REROUTE_TYPES.some((t) => t === type);
}

export function isNodeType(value: string): value is NodeType {
  return (NODE_TYPES as ReadonlyArray<string>).includes(value);
}

export function createNodeOfType(
  type: NodeType,
  id: string,
  position: Vec2,
  params: Record<string, number | Array<number>>,
): GraphNode {
  const def = NODE_REGISTRY[type];
  return {
    id,
    type,
    position: { ...position },
    ports: [...def.inputs, ...def.outputs].map((d) => port(id, d)),
    params: { ...def.defaultParams, ...params },
  };
}

/** Resolve a node's output type given actual upstream input types. */
export function resolveOutputType(
  type: NodeType,
  inputTypes: Record<string, HlslType>,
): HlslType | null {
  switch (type) {
    case "Float":
      return "float";
    case "Float2":
      return "float2";
    case "Float3":
      return "float3";
    case "Float4":
      return "float4";
    case "Add":
    case "Subtract":
    case "Multiply":
    case "Divide": {
      const a = inputTypes["a"];
      const b = inputTypes["b"];
      if (a === undefined || b === undefined) {
        return null;
      }
      return componentCount(a) >= componentCount(b) ? a : b;
    }
    case "Split":
      return "float";
    case "Combine": {
      if (inputTypes["w"] !== undefined) {
        return "float4";
      }
      if (inputTypes["z"] !== undefined) {
        return "float3";
      }
      return "float2";
    }
    case "Reroute":
    case "NamedRerouteDeclaration":
    case "NamedRerouteUsage":
      return inputTypes["in"] ?? null;
    case "FragmentOutput":
      return null;
  }
}
