// Node status vocabulary and derivation.
//
// A node's status is derived from the graph, never stored: validation
// errors and whether the node feeds the Fragment Output decide it. The
// view renders one NodeStatusIndicator per node from this result, so the
// two can never drift apart.

import { Option } from 'effect'

import type { Model } from './model'

export const NODE_STATUSES = [
  'initial',
  'loading',
  'success',
  'warning',
  'error',
] as const
export type NodeStatus = (typeof NODE_STATUSES)[number]

export const LOADING_VARIANTS = ['border', 'overlay'] as const
export type LoadingVariant = (typeof LOADING_VARIANTS)[number]

export function isLoadingVariant(value: string): value is LoadingVariant {
  return LOADING_VARIANTS.some(variant => variant === value)
}

/** Nodes that reach the Fragment Output by walking edges upstream. */
function contributingNodeIds(model: Model): ReadonlySet<string> {
  const outputId = Option.getOrNull(model.outputNodeId)
  if (outputId === null) {
    return new Set()
  }
  return upstreamIds(model, outputId, new Set())
}

function upstreamIds(
  model: Model,
  nodeId: string,
  seen: Set<string>,
): Set<string> {
  if (seen.has(nodeId)) {
    return seen
  }
  const next = new Set(seen)
  next.add(nodeId)
  return model.edges.reduce<Set<string>>(
    (acc, edge) =>
      edge.targetNodeId === nodeId
        ? upstreamIds(model, edge.sourceNodeId, acc)
        : acc,
    next,
  )
}

function isConnected(model: Model, nodeId: string): boolean {
  return model.edges.some(
    edge => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId,
  )
}

/**
 * Derive every node's status. Precedence: a simulated load overrides
 * everything so both loading variants are observable; then a validation
 * error; then a node with no edges is `initial`; a connected node that
 * does not reach the Fragment Output is `warning`; everything else is
 * `success`.
 */
export function deriveNodeStatuses(
  model: Model,
  errorNodeIds: ReadonlySet<string>,
): ReadonlyMap<string, NodeStatus> {
  const contributing = contributingNodeIds(model)
  return new Map(
    model.nodes.map((node): readonly [string, NodeStatus] => {
      if (model.simulateLoading) {
        return [node.id, 'loading']
      }
      if (errorNodeIds.has(node.id)) {
        return [node.id, 'error']
      }
      if (!isConnected(model, node.id)) {
        return [node.id, 'initial']
      }
      if (!contributing.has(node.id)) {
        return [node.id, 'warning']
      }
      return [node.id, 'success']
    }),
  )
}
