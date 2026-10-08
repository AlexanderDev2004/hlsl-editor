// Named-reroute linking.
//
// A declaration and its usages are joined by a hidden edge (declaration.out ->
// usage.in). Keeping the link as a real edge means topo order, reachability,
// cycle detection and codegen need no special cases; the view simply does not
// draw that wire. Names are editor metadata keyed by the declaration id, so
// the pure domain graph stays name-free.

import type { EditorEdge, Model } from './model'

export function isNamedRerouteLink(model: Model, edge: EditorEdge): boolean {
  const from = model.nodes.find(node => node.id === edge.sourceNodeId)
  const to = model.nodes.find(node => node.id === edge.targetNodeId)
  return (
    from?.type === 'NamedRerouteDeclaration' && to?.type === 'NamedRerouteUsage'
  )
}

export function rerouteName(model: Model, declarationId: string): string {
  return model.rerouteNames[declarationId] ?? 'Reroute'
}

export function declarationOfUsage(
  model: Model,
  usageId: string,
): string | null {
  const link = model.edges.find(
    edge => edge.targetNodeId === usageId && isNamedRerouteLink(model, edge),
  )
  return link === undefined ? null : link.sourceNodeId
}

export function usagesOfDeclaration(
  model: Model,
  declarationId: string,
): Array<string> {
  return model.edges
    .filter(
      edge =>
        edge.sourceNodeId === declarationId && isNamedRerouteLink(model, edge),
    )
    .map(edge => edge.targetNodeId)
}
