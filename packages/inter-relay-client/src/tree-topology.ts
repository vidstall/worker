/**
 * Cascade-tree Phase T-A — deterministic tree derivation (PURE, zero I/O).
 * See docs/superpowers/specs/2026-07-02-cascade-tree-phase-A-derivation-design.md
 */

/**
 * A relay identity in the tree. On-chain Sui object ID, normalized to 0x-prefixed lowercase hex.
 * MUST be the canonical zero-padded form (0x + 64 hex chars) so that lexical sort == numeric sort —
 * derivation determinism depends on this. Callers are responsible for passing canonical IDs.
 */
export type RelayId = string;

/**
 * PURE. Max children a relay may forward to, from its worker path budget.
 * D = floor((cWorker - uLocal) / producersPerPeer), clamped to >= 0.
 */
export function deriveDegreeCap(
  cWorker: number,
  uLocal: number,
  producersPerPeer: number,
): number {
  if (producersPerPeer <= 0) return 0;
  const budget = cWorker - uLocal;
  if (budget <= 0) return 0;
  return Math.floor(budget / producersPerPeer);
}

export interface TreeNode {
  readonly relayId: RelayId;
  readonly parent: RelayId | null; // null iff this node is the root
  readonly children: readonly RelayId[]; // canonical order (sorted by RelayId); length <= degreeCap
  readonly depth: number;          // root = 0
}

export interface TreeLayout {
  root: RelayId | null;         // null iff the input set is empty
  nodes: ReadonlyMap<RelayId, TreeNode>;
  height: number;               // max depth; 0 for a single node; -1 for empty
  diameter: number;             // longest relay->relay hop path; 0 for <=1 node
  withinDiameterBound: boolean; // height <= maxHeight (REQ-RMS-041)
  degreeCap: number;            // the D echoed back for callers/logging
}

export interface DeriveTreeOptions {
  degreeCap: number; // D from deriveDegreeCap (>= 0); build clamps to >= 1 (see below)
  maxHeight: number; // H — REQUIRED; the pure module has no default (caller owns the env read)
}

function normalizeId(id: RelayId): RelayId {
  return id.trim().toLowerCase();
}

function computeDiameter(nodes: ReadonlyMap<RelayId, TreeNode>, root: RelayId): number {
  let best = 0;
  const downHeight = (id: RelayId): number => {
    const node = nodes.get(id)!;
    const childEdgeHeights = node.children.map((c) => downHeight(c) + 1);
    childEdgeHeights.sort((a, b) => b - a);
    const top1 = childEdgeHeights[0] ?? 0;
    const top2 = childEdgeHeights[1] ?? 0;
    const through = top1 + top2;
    if (through > best) best = through;
    return top1;
  };
  downHeight(root);
  return best;
}

interface MutableTreeNode {
  relayId: RelayId;
  parent: RelayId | null;
  children: RelayId[];
  depth: number;
}

/** PURE. Deterministic complete-D-ary spanning tree over the relay set, keyed by RelayId. */
export function deriveTree(
  relayIds: readonly RelayId[],
  opts: DeriveTreeOptions,
): TreeLayout {
  const { degreeCap, maxHeight } = opts;
  const ids = Array.from(new Set(relayIds.map(normalizeId))).sort();
  const K = ids.length;
  if (K === 0) {
    return {
      root: null, nodes: new Map(), height: -1, diameter: 0,
      withinDiameterBound: true, degreeCap,
    };
  }
  const D = Math.max(1, degreeCap); // a build needs D >= 1; D==0 -> chain (infeasibility via bound)
  const nodes = new Map<RelayId, MutableTreeNode>();
  for (let i = 0; i < K; i++) {
    const relayId = ids[i]!;
    const parent = i === 0 ? null : ids[Math.floor((i - 1) / D)]!;
    const depth = parent === null ? 0 : nodes.get(parent)!.depth + 1;
    nodes.set(relayId, { relayId, parent, children: [], depth });
    if (parent !== null) nodes.get(parent)!.children.push(relayId);
  }
  let height = 0;
  for (const node of nodes.values()) if (node.depth > height) height = node.depth;
  const diameter = computeDiameter(nodes, ids[0]!);
  return {
    root: ids[0]!,
    nodes,
    height,
    diameter,
    withinDiameterBound: height <= maxHeight,
    degreeCap,
  };
}
