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

/** The parent RelayId of `id`, or null (root / unknown). */
export function parentOf(layout: TreeLayout, id: RelayId): RelayId | null {
  return layout.nodes.get(normalizeId(id))?.parent ?? null;
}

/** The child RelayIds of `id` (canonical order); [] for a leaf / unknown. */
export function childrenOf(layout: TreeLayout, id: RelayId): readonly RelayId[] {
  return layout.nodes.get(normalizeId(id))?.children ?? [];
}

/** Tree neighbors of `id` = [parent (if any), ...children]. T-B fans to neighbors minus the receive edge. */
export function neighborsOf(layout: TreeLayout, id: RelayId): RelayId[] {
  const node = layout.nodes.get(normalizeId(id));
  if (!node) return [];
  return [...(node.parent ? [node.parent] : []), ...node.children];
}

/** The forwarding role of a node in the tree. */
export type TreeRole = 'root' | 'internal' | 'leaf';

/**
 * PURE. Classify a node's forwarding role. Unknown id → 'leaf' (fail-safe: never re-forward).
 * A lone/childless root (parent===null AND no children, e.g. a single-node tree) classifies
 * as 'leaf' (no forwarding targets).
 */
export function treeRoleOf(layout: TreeLayout, id: RelayId): TreeRole {
  const node = layout.nodes.get(normalizeId(id));
  if (!node) return 'leaf';
  const hasChildren = node.children.length > 0;
  if (node.parent === null) return hasChildren ? 'root' : 'leaf';
  return hasChildren ? 'internal' : 'leaf';
}

/** PURE. Canonical 0x + 64-lowercase-hex so lexical sort == numeric sort (deriveTree precondition). */
export function toCanonicalRelayId(id: RelayId): RelayId {
  const lower = id.trim().toLowerCase();
  const hex = lower.startsWith('0x') ? lower.slice(2) : lower;
  if (hex.length > 64) throw new Error(`toCanonicalRelayId: oversized hex (${hex.length} chars): ${id}`);
  return '0x' + hex.padStart(64, '0');
}

/** One-way latency parameters (ms). All analyst-supplied / eventually measured — see spec §5. */
export interface LatencyParams {
  lFixedMs: number;   // capture+encode+jitter+decode+render (non-network floor)
  lastMileMs: number; // t_up + t_down combined (both user<->edge-relay legs)
  tHopMs: number;     // ONE inter-relay hop, one-way (network + forward)
}

export interface LatencyEstimate {
  worstMs: number;     // lFixed + lastMile + diameter*tHop
  networkMs: number;   // lastMile + diameter*tHop
  relayPathMs: number; // diameter*tHop (the part the TREE controls)
  hops: number;        // = layout.diameter (echoed for the report)
}

/**
 * PURE. Worst-case one-way latency of a layout. Reuses TreeLayout.diameter (no re-derivation):
 * the worst pair is the tree's two farthest leaves = exactly layout.diameter.
 */
export function estimateLatency(layout: TreeLayout, params: LatencyParams): LatencyEstimate {
  const hops = layout.diameter;
  const relayPathMs = hops * params.tHopMs;
  const networkMs = params.lastMileMs + relayPathMs;
  const worstMs = params.lFixedMs + networkMs;
  return { worstMs, networkMs, relayPathMs, hops };
}
