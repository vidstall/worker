/**
 * REQ-RMS-002/003/013/018 — off-chain capacity-aware ADMISSION layer (relay-mesh-scaling M1).
 *
 * PURE functions, NO on-chain round-trip and NO mutation of the PVR consensus score
 * (scoring.ts computeNodeScore stays byte-identical to pairing_score.move). This layer is
 * applied AFTER canonicalSort, narrowing the consensus-sorted candidate set by measured
 * capacity. Verified load `l_i` (attestedLoadPaths) is canary-attested (REQ-RMS-005), NEVER
 * relay self-report.
 *
 * LOGGING: pure math, no I/O, no logger needed here.
 */

/** Creator-supplied room-class hint -> preset (V_active, P_active) for L_r seeding (REQ-RMS-016). */
export type RoomClass = 'small' | 'large' | 'webinar';

/** Per-class presets: V_active = est. gallery viewers, P_active = est. concurrent video publishers. */
const CLASS_PRESETS: Record<RoomClass, { vActive: number; pActive: number }> = {
  small:   { vActive: 6,  pActive: 2 },
  large:   { vActive: 30, pActive: 20 },
  webinar: { vActive: 50, pActive: 1 },
};

/** The gallery page size (LOCKED M1 default) — caps the per-viewer video fan (P_active). */
export const PAGE_SIZE = 9;

/**
 * REQ-RMS-003 — estimate a room's load in forward-paths.
 *   SFU: L_r = V_active * min(9, P_active) + audio_term
 *   MCU: video collapses to 1 composited stream; audio_term unchanged.
 * audio_term = expectedParticipants (a CONSERVATIVE O(N) floor; true audio fan-out is ~O(N^2)
 * pending REQ-RMS-001/REQ-RMS-012 — documented under-count absorbed by runtime spill, OUT in M1).
 */
export function estimateRoomLoad(
  roomClass: RoomClass,
  expectedParticipants: number,
  relayMode: 'sfu' | 'mcu',
): number {
  const { vActive, pActive } = CLASS_PRESETS[roomClass];
  const audioTerm = Math.max(0, expectedParticipants);
  if (relayMode === 'mcu') return 1 + audioTerm;
  return vActive * Math.min(PAGE_SIZE, pActive) + audioTerm;
}

/** A relay's measured capacity inputs for admission (l_i canary-attested, never self-report). */
export interface RelayCapacity {
  minerId: string;
  /** Verified current load in forward-paths (canary/heartbeat-attested, REQ-RMS-005/019). */
  attestedLoadPaths: number;
  /** Per-worker ceiling (calibrated, REQ-RMS-001). */
  cWorker: number;
  /** Validator-probed RTT for the geo tie-break (NodeCandidate.rtt; never self-reported). */
  rtt: bigint;
  /** Epochs since last on-chain heartbeat (for pool-health; fresh < PVR_HEARTBEAT_STALE). */
  heartbeatFreshEpochs?: number;
  /** Canary success-rate over last N audits acceptable (for pool-health, REQ-RMS-018). */
  canaryHealthy?: boolean;
}

/** Staleness threshold — mirrors scoring.ts PVR_HEARTBEAT_STALE (kept in epochs). */
export const HEARTBEAT_STALE_EPOCHS = 7;

/**
 * REQ-RMS-002 — i* = argmin (l_i + L_r)/C_worker  s.t.  l_i + L_r <= C_worker; RTT tie-break.
 * Returns null (defer) when NO relay can absorb L_r under its ceiling.
 */
export function selectPlacementRelay(relays: RelayCapacity[], roomLoad: number): RelayCapacity | null {
  let best: RelayCapacity | null = null;
  let bestRatio = Number.POSITIVE_INFINITY;
  for (const r of relays) {
    const projected = r.attestedLoadPaths + roomLoad;
    if (projected > r.cWorker) continue;        // capacity ceiling
    const ratio = projected / r.cWorker;
    if (
      ratio < bestRatio ||
      (ratio === bestRatio && best !== null && r.rtt < best.rtt) // RTT (geo) tie-break
    ) {
      best = r;
      bestRatio = ratio;
    }
  }
  return best;
}

/**
 * REQ-RMS-018 — pool-health gate. A relay is healthy iff heartbeat is fresh
 * (< HEARTBEAT_STALE_EPOCHS) AND canary success-rate is acceptable. Admit only if
 * the count of healthy relays >= K_r.
 */
export function poolHealthGate(pool: RelayCapacity[], kR: number): boolean {
  const healthy = pool.filter(
    (r) => (r.heartbeatFreshEpochs ?? Number.MAX_SAFE_INTEGER) < HEARTBEAT_STALE_EPOCHS && r.canaryHealthy === true,
  ).length;
  return healthy >= kR;
}

/** Minimum relays per room — mirrors on-chain constants::default_min_relays_per_room() = 2. */
export const MIN_RELAY = 2;

/**
 * REQ-RMS-013 — M = ceil(sum L_r / C_relay) * (1 + redundancy) + byzantine_margin, clamped >= MIN_RELAY.
 * Demo: R~20-30 rooms * ~270 paths / C_relay derives M; a small load floors at MIN_RELAY+margin
 * so M=5 is a justified demo floor, not arbitrary.
 */
export function poolSize(
  totalLoadPaths: number,
  cRelay: number,
  redundancy: number,
  byzantineMargin: number,
): number {
  const base = Math.ceil(totalLoadPaths / Math.max(1, cRelay));
  const withRedundancy = Math.ceil(base * (1 + redundancy));
  return Math.max(MIN_RELAY, withRedundancy + byzantineMargin);
}

// ── REQ-RMS-015 — Byzantine exclusion (M3). Pure off-chain filter applied to the
// candidate SET before PVR ranking; the consensus score (computeNodeScore ==
// pairing_score.move) is NEVER touched. The flag predicate is sourced from the
// canary verify-loop accumulator via isRelayFlaggedByCanary (validator-daemon). ──

/** The minimal placement-candidate shape the exclusion filter needs. */
export interface PlacementCandidate {
  /** The relay's stable on-chain miner_id (the canary accumulator key). */
  minerId: string;
}

/**
 * Return a NEW candidate array with every relay the `isFlagged` predicate marks as
 * a sustained canary diverger removed. Order-preserving, input not mutated. The
 * caller supplies `isFlagged` bound to `isRelayFlaggedByCanary(acc, id, budget,
 * MIN_ROUNDS_FOR_CUMULATIVE)`.
 */
export function excludeFlaggedRelays<C extends PlacementCandidate>(
  candidates: C[],
  isFlagged: (minerId: string) => boolean,
): C[] {
  return candidates.filter((c) => !isFlagged(c.minerId));
}

/**
 * REQ-RMS-015 — a STANDALONE top-kr selector helper (the M1 EscrowCreated arm does
 * NOT use it: M1 ships selectPlacementRelay i*=argmin + ballot.slice(0, MIN_RELAY)
 * @ event-handler.ts:473/:500 — there is NO `min(2,len)` builder in live source, per
 * BLOCKER-2). Kept as a pure exported helper exercised ONLY by the 5a.2 unit test so
 * the exclude->select pipeline is independently checkable. `kr` defaults to 2 (= MIN_RELAY
 * at the demo floor). Pure, order-preserving, input not mutated. Does NOT touch
 * `computeNodeScore` / the PVR consensus ordering — `rankedRelays` is already the
 * canonically-sorted set; this only takes the top-`kr` ids from it.
 */
export function selectTopRelays<C extends PlacementCandidate>(
  rankedRelays: C[],
  kr = 2,
): string[] {
  const take = Math.max(1, Math.min(kr, rankedRelays.length));
  return rankedRelays.slice(0, take).map((r) => r.minerId);
}
