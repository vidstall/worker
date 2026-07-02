/**
 * Cascade-tree Phase T-A — deterministic tree derivation (PURE, zero I/O).
 * See docs/superpowers/specs/2026-07-02-cascade-tree-phase-A-derivation-design.md
 */

/** A relay identity in the tree. On-chain Sui object ID as a normalized 0x-hex string. */
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
