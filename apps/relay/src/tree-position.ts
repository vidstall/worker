/**
 * Cascade-tree Phase T-B — this relay's per-room TREE POSITION (PURE, zero I/O).
 *
 * Every relay in a room's `assigned_relays` derives the SAME deterministic
 * bounded-degree spanning tree from the on-chain relay_ids (T-A `deriveTree`),
 * then reads its own slot: parent / children / role. Task 4 derives + stores the
 * position; the actual tree-aware fan is Tasks 5/6/7 (all behind RMS_TREE_ACTIVE).
 *
 * See docs/superpowers/specs cascade-tree Phase T-B design. REQ-RMS-042.
 */
import {
  deriveTree, deriveDegreeCap, treeRoleOf, childrenOf, parentOf,
  toCanonicalRelayId, type TreeRole,
} from '@dvconf/inter-relay-client';

export interface TreePosition {
  parent: string | null;   // canonical relayId
  children: string[];      // canonical relayIds
  role: TreeRole;
  diameter: number;
  withinDiameterBound: boolean;
}

/**
 * PURE. Derive THIS relay's tree position from the on-chain relay_ids.
 * B1: D = min(shapingDegree, capacity-cap). At RoomAssigned P is unknown → capacity is treated
 * as +Infinity so the SHAPING degree governs (forces a real depth->=2 tree). A saturated worker
 * only ever LOWERS D. capacityCap<=0 (or undefined) means "no capacity signal yet" → use the shape.
 */
export function deriveTreePosition(
  relayIds: string[], selfId: string, shapingDegree: number, maxHeight: number, capacityCap?: number,
): TreePosition {
  const canonical = relayIds.map(toCanonicalRelayId);
  const self = toCanonicalRelayId(selfId);
  const cap = capacityCap !== undefined && capacityCap > 0 ? capacityCap : Number.POSITIVE_INFINITY;
  const degreeCap = Math.max(1, Math.min(shapingDegree, cap));
  const layout = deriveTree(canonical, { degreeCap, maxHeight });
  return {
    parent: parentOf(layout, self),
    children: [...childrenOf(layout, self)],
    role: treeRoleOf(layout, self),
    diameter: layout.diameter,
    withinDiameterBound: layout.withinDiameterBound,
  };
}

/** PURE. Fan targets = neighbors minus the receive edge (null origin → all). Works in ANY id space. */
export function fanTargets(neighbors: string[], receiveEdge: string | null): string[] {
  return receiveEdge === null ? neighbors : neighbors.filter((n) => n !== receiveEdge);
}

/** PURE. Decrement the hop budget; undefined (flag-off) passes through. */
export function nextHopTtl(hopTtl: number | undefined): number | undefined {
  return hopTtl === undefined ? undefined : hopTtl - 1;
}
