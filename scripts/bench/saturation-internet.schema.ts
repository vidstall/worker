/**
 * Curated evidence schema + fail-closed validator — relay-saturation INTERNET
 * run (Task A4). ⭐ DATA-RECORDING contract.
 *
 * Every curated artifact this pipeline emits MUST conform to
 * {@link CuratedSaturationInternet}. `validateCurated` is FAIL-CLOSED: it returns
 * a non-empty list of greppable violation strings on ANY of the guarded
 * conditions, so a malformed or overclaiming artifact can never silently pass a
 * gate. An empty list means "fully valid".
 *
 * The three "closed-caveat" fields are load-bearing — they are what upgrade this
 * run from the datasheet-estimate to a real-media measurement:
 *   - `cpuCoresSrtp`  closes C1 (real SRTP CPU, not DirectTransport-optimistic)
 *   - `egressMbpsReal` closes C2 (real capped-NIC bytesSent, not datasheet 2.7)
 *   - `pipeBytesDelta` closes C3 (observed inter-relay pipe bytes, not inferred)
 *
 * Plan: `docs/superpowers/plans/2026-07-09-relay-saturation-internet-multirelay-drop.md`
 */

/** One relay in the mesh (1-primary / 1-warm-standby + optional overlap). */
export interface RelayNode {
  relayId: string;
  region: string;
  publishedNicMbps: number;
  role: 'primary' | 'standby' | 'overlap';
}

/** Percentile triple for a latency metric under load. */
export interface PercentileTriple {
  p50: number;
  p95: number;
  p99: number;
}

/** One saturation rung (a fixed concurrent-viewer count). */
export interface RungRow {
  /** Concurrent viewers this rung. */
  n: number;
  /** n * pathsPerViewer. */
  forwardPaths: number;
  /** Worker.getResourceUsage w/ REAL SRTP (closes caveat C1). */
  cpuCoresSrtp: number;
  /** Standby capped-NIC bytesSent delta expressed as Mbps (closes C2). */
  egressMbpsReal: number;
  /** egressMbpsReal / n -> replaces the 2.7 datasheet figure. */
  mbpsPerViewer: number;
  /** Inter-relay hop latency, under load. */
  tHopMs: PercentileTriple;
  /** Producer->consumer glass-to-glass latency, under load. */
  g2gMs: PercentileTriple;
  /** Standby /api/probe pipe_bytes_observed delta (closes C3). */
  pipeBytesDelta: number;
  /** Delivery health 0..1. */
  deliveryHealth: number;
  /** Consumer correctness (from A2 StreamIdentityChecker). */
  streamIdentityOk: boolean;
  /** false + anomaly note if the box/NIC thrashed. */
  clean: boolean;
  anomaly?: string;
}

/** Live drop-relay (primary-death -> promote) event. */
export interface DropRelayEvent {
  atRungN: number;
  mttrMs: number;
  relaysBefore: number;
  relaysAfter: number;
  relayPromotedEpoch: number;
  mediaResumed: boolean;
}

/** Two-ceiling recompute on measured slopes (mirrors TwoCeilingResult from A5). */
export interface TwoCeilingReal {
  /** MUST be <= 540 (real SRTP can only lower the DirectTransport-optimistic 540). */
  cWorkerSrtp: number;
  kRcpuAt100: number;
  kRbwAt100: number;
  binding: 'cpu' | 'bandwidth';
  floorAt100: number;
  planningAt100: number;
}

/** How the ceiling was projected past the highest measured rung. */
export interface Extrapolation {
  measuredToN: number;
  method: string;
  projectedCeilingViewers: number;
}

/** The full curated artifact — the auditable unit of record. */
export interface CuratedSaturationInternet {
  artifact: string;
  runId: string;
  benchCommit: string;
  requirement: string;
  regionPair: string[];
  relays: RelayNode[];
  pageSize: number;
  pathsPerViewer: number;
  profile: string;
  rungs: RungRow[];
  dropRelay: DropRelayEvent;
  twoCeiling: TwoCeilingReal;
  extrapolation: Extrapolation;
  /** REQUIRED, non-empty — the explicit honesty/scope caveats for this run. */
  honesty: string[];
}

/** Required numeric fields on every rung (fail-closed if any is missing). */
const RUNG_NUMERIC_FIELDS: readonly (keyof RungRow)[] = [
  'n',
  'forwardPaths',
  'cpuCoresSrtp',
  'egressMbpsReal',
  'mbpsPerViewer',
  'pipeBytesDelta',
  'deliveryHealth',
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPercentileTriple(v: unknown): v is PercentileTriple {
  if (v === null || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return isFiniteNumber(t.p50) && isFiniteNumber(t.p95) && isFiniteNumber(t.p99);
}

/**
 * FAIL-CLOSED validator. Returns a list of greppable violation strings; `[]`
 * means the artifact is fully valid. See module doc for the guarded invariants.
 */
export function validateCurated(o: CuratedSaturationInternet): string[] {
  const violations: string[] = [];

  // honesty[] must be present and non-empty.
  if (!Array.isArray(o.honesty) || o.honesty.length === 0) {
    violations.push('honesty[] must be non-empty');
  }

  // Per-rung field completeness + value guards.
  const rungs = Array.isArray(o.rungs) ? o.rungs : [];
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i]!;
    for (const field of RUNG_NUMERIC_FIELDS) {
      if (!isFiniteNumber(rung[field])) {
        violations.push(`rung ${i}: missing field ${field}`);
      }
    }
    if (!isPercentileTriple(rung.tHopMs)) {
      violations.push(`rung ${i}: missing field tHopMs`);
    }
    if (!isPercentileTriple(rung.g2gMs)) {
      violations.push(`rung ${i}: missing field g2gMs`);
    }
    if (isFiniteNumber(rung.mbpsPerViewer) && rung.mbpsPerViewer <= 0) {
      violations.push(`rung ${i}: mbpsPerViewer must be > 0`);
    }
    if (rung.clean === true && rung.streamIdentityOk === false) {
      violations.push(`rung ${i}: streamIdentityOk false on a clean rung`);
    }
  }

  // Two-ceiling: real SRTP cannot exceed the DirectTransport optimistic ceiling.
  if (isFiniteNumber(o.twoCeiling?.cWorkerSrtp) && o.twoCeiling.cWorkerSrtp > 540) {
    violations.push(
      'cWorkerSrtp > 540 (SRTP cannot exceed DirectTransport ceiling)',
    );
  }

  // Mesh must survive the drop with >= 2 relays.
  if (
    isFiniteNumber(o.dropRelay?.relaysAfter) &&
    o.dropRelay.relaysAfter < 2
  ) {
    violations.push('dropRelay.relaysAfter < 2 (mesh must survive with >=2 relays)');
  }

  return violations;
}
