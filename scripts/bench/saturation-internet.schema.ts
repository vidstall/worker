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

/**
 * Two-ceiling recompute on measured slopes (mirrors TwoCeilingResult from A5).
 *
 * `binding` here is a DERIVED saturation VERDICT (not the projection floor-binding):
 *   - 'cpu'           => a measured rung approached a full core (relay CPU-bound).
 *   - 'not-saturated' => no rung approached a core (the real-bitrate internet
 *                        run: relay peaked at ~5% of a core; it was never the
 *                        bottleneck). When 'not-saturated', `cWorkerSrtp` is a
 *                        HEADROOM indicator (= 1/measured-slope), NOT a claimed
 *                        operating ceiling — so the DirectTransport-boundary
 *                        caveat requirement does NOT apply. The requirement fires
 *                        ONLY when 'cpu' (or when `binding` is absent, for legacy
 *                        artifacts).
 *
 * There is deliberately NO numeric cap on `cWorkerSrtp` (CH5-R6-001): 540
 * forward-paths is the last delivery-healthy sample of the DirectTransport
 * harness on ONE laptop (i9-12900HK) — a harness-domain FLOOR, not a ceiling.
 * The DirectTransport boundary itself is UNKNOWN (>540; the harness broke at
 * 720). The real-SRTP ceiling is lower than that UNKNOWN boundary, but its
 * relation to 540 (or any measured point) is UNMEASURED — and `cWorkerSrtp`
 * comes from different hardware (Azure VMs), so a numeric `<=540` cap would
 * reject legitimate measurements the evidence does not rule out. Instead a
 * CPU-bound artifact must CARRY the DirectTransport-boundary honesty caveat
 * (fail-closed on the caveat's PRESENCE, not on a number).
 */
export interface TwoCeilingReal {
  /**
   * = round(1/measured per-path CPU slope). When binding==='cpu' (or absent),
   * the artifact must carry the DirectTransport-boundary honesty caveat — no
   * numeric cap (see interface doc: 540 is a one-laptop harness floor).
   */
  cWorkerSrtp: number;
  /** Explicit label for cWorkerSrtp (headroom-vs-ceiling), so it is never misread. */
  cWorkerSrtpNote: string;
  kRcpuAt100: number;
  kRbwAt100: number;
  /** DERIVED saturation verdict from measured relay-CPU headroom. */
  binding: 'cpu' | 'not-saturated';
  floorAt100: number;
  planningAt100: number;
}

/** How the ceiling was projected past the highest measured rung. */
export interface Extrapolation {
  measuredToN: number;
  method: string;
  projectedCeilingViewers: number;
}

/**
 * The CONSUMER-DECODE knee — the measured operating limit of THIS run. The g2g
 * tail bends up because all synthetic consumers were co-located on one box and
 * competed for decode CPU (see honesty[]); it is NOT a per-user deployment limit.
 * All fields are DERIVED from the measured g2g p99 curve.
 */
export interface ConsumerKnee {
  /** Lowest rung N where g2g p99 first bends up super-linearly. */
  onsetN: number;
  /** Top measured rung N (full-saturation point). */
  saturatedN: number;
  /** g2g p99 (ms) at the onset rung. */
  g2gP99AtOnset: number;
  /** g2g p99 (ms) at the saturation rung. */
  g2gP99AtSaturation: number;
}

/** One (uplink -> viewers) reference point of the bandwidth PROJECTION. */
export interface BandwidthReference {
  uplinkMbps: number;
  /** = floor(uplinkMbps / mbpsPerViewer) — DERIVED, never hand-typed. */
  viewers: number;
}

/**
 * Bandwidth ceiling as a clearly-labeled PROJECTION (never a pass/fail gate). No
 * NIC number is baked into any invariant; `measuredPeakEgressMbps` records that
 * the relay NIC was NOT a constraint in this run, so bandwidth-boundedness is
 * purely forward projection.
 */
export interface BandwidthProjection {
  /** Real measured per-viewer egress (Mbps). */
  mbpsPerViewer: number;
  /** viewers = uplinkMbps / mbpsPerViewer, at >=2 named uplinks. */
  references: BandwidthReference[];
  /** Peak total egress actually measured this run (relay NIC was never the cap). */
  measuredPeakEgressMbps: number;
}

/**
 * Media-security condition the run was measured under. Operator-supplied (the
 * raw JSONL does NOT record it) — REQUIRED and validated fail-closed so no
 * artifact is ever ambiguous about its E2EE condition (this run vs the E2EE
 * re-run must each self-declare).
 */
export type MediaSecurity = 'plaintext' | 'e2ee';

/** The full curated artifact — the auditable unit of record. */
export interface CuratedSaturationInternet {
  artifact: string;
  runId: string;
  benchCommit: string;
  /** REQUIRED — plaintext vs e2ee condition (operator-supplied, fail-closed). */
  mediaSecurity: MediaSecurity;
  requirement: string;
  regionPair: string[];
  relays: RelayNode[];
  pageSize: number;
  pathsPerViewer: number;
  profile: string;
  rungs: RungRow[];
  dropRelay: DropRelayEvent;
  twoCeiling: TwoCeilingReal;
  /** The measured operating limit of this run (co-location decode knee). */
  consumerKnee: ConsumerKnee;
  /** Bandwidth ceiling as a labeled projection (never a gate). */
  bandwidthProjection: BandwidthProjection;
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

/** Max allowed relative deviation of a rung's mbpsPerViewer from the median. */
const EGRESS_LINEARITY_TOL = 0.05; // 5% — measured spread this run is ~0.3%.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPercentileTriple(v: unknown): v is PercentileTriple {
  if (v === null || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return isFiniteNumber(t.p50) && isFiniteNumber(t.p95) && isFiniteNumber(t.p99);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * FAIL-CLOSED validator. Returns a list of greppable violation strings; `[]`
 * means the artifact is fully valid. See module doc for the guarded invariants.
 */
export function validateCurated(o: CuratedSaturationInternet): string[] {
  const violations: string[] = [];

  // mediaSecurity must be explicitly declared (no artifact may be ambiguous
  // about its plaintext-vs-e2ee condition).
  if (o.mediaSecurity !== 'plaintext' && o.mediaSecurity !== 'e2ee') {
    violations.push(
      "mediaSecurity must be declared ('plaintext' or 'e2ee')",
    );
  }

  // honesty[] must be present and non-empty.
  if (!Array.isArray(o.honesty) || o.honesty.length === 0) {
    violations.push('honesty[] must be non-empty');
  }

  // Per-rung field completeness + MEASURED value guards.
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
    // Delivery must be perfect on EVERY rung (a measured hard gate).
    if (isFiniteNumber(rung.deliveryHealth) && rung.deliveryHealth !== 1) {
      violations.push(
        `rung ${i}: deliveryHealth ${rung.deliveryHealth} != 1 (delivery must be 100%)`,
      );
    }
    // Identity must be 0-mismatch on EVERY rung — INCLUDING clean:false rungs.
    // clean:false scopes only steady-state LATENCY claims, never delivery/identity.
    if (rung.streamIdentityOk === false) {
      violations.push(
        `rung ${i}: streamIdentityOk false (identity must be 0-mismatch on all rungs)`,
      );
    }
  }

  // Egress LINEARITY: every rung's mbpsPerViewer within tolerance of the median.
  const mbps = rungs
    .map((r) => r.mbpsPerViewer)
    .filter((v): v is number => isFiniteNumber(v) && v > 0);
  if (mbps.length > 0) {
    const med = medianOf(mbps);
    for (let i = 0; i < rungs.length; i++) {
      const v = rungs[i]!.mbpsPerViewer;
      if (isFiniteNumber(v) && med > 0) {
        const dev = Math.abs(v - med) / med;
        if (dev > EGRESS_LINEARITY_TOL) {
          violations.push(
            `rung ${i}: egress non-linear (mbpsPerViewer deviates ` +
              `${(dev * 100).toFixed(1)}% > ${(EGRESS_LINEARITY_TOL * 100).toFixed(
                0,
              )}% from median)`,
          );
        }
      }
    }
  }

  // Two-ceiling: the DirectTransport-boundary CAVEAT requirement applies ONLY
  // when the relay was CPU-bound. When binding is absent (legacy artifacts) we
  // DEFAULT to applying the requirement, so a legacy CPU-bound overclaim can
  // never slip through fail-open.
  //
  // WHY a caveat-presence check and NOT a numeric `<=540` cap (CH5-R6-001):
  // 540 forward-paths is a delivery-healthy DirectTransport-harness FLOOR on
  // one laptop (i9-12900HK), not a ceiling — the DirectTransport boundary is
  // UNKNOWN (>540; the harness broke at 720), the real-SRTP ceiling's relation
  // to 540 is UNMEASURED, and cWorkerSrtp is measured on different hardware
  // (Azure VMs). A numeric cap would reject legitimate measurements in
  // (540, DT-boundary] that the evidence does not rule out. Fail-closed is
  // preserved by requiring the artifact to NAME the boundary relation in
  // honesty[] whenever it claims a CPU-bound cWorkerSrtp.
  const honesty = Array.isArray(o.honesty) ? o.honesty : [];
  const binding = o.twoCeiling?.binding;
  const guardApplies = binding === 'cpu' || binding === undefined;
  const hasDtBoundaryCaveat = honesty.some(
    (h) => /DirectTransport/i.test(h) && /boundary|unmeasured|unknown/i.test(h),
  );
  if (
    guardApplies &&
    isFiniteNumber(o.twoCeiling?.cWorkerSrtp) &&
    !hasDtBoundaryCaveat
  ) {
    violations.push(
      'cpu-bound artifact missing the DirectTransport-boundary caveat ' +
        '(real-SRTP ceiling vs the UNKNOWN DirectTransport boundary is unmeasured)',
    );
  }

  // Consumer-decode knee must be present AND located (the measured operating
  // limit); the tail must bend UP (saturation p99 >= onset p99).
  const knee = o.consumerKnee;
  if (
    knee === undefined ||
    !isFiniteNumber(knee.onsetN) ||
    !isFiniteNumber(knee.saturatedN) ||
    !isFiniteNumber(knee.g2gP99AtOnset) ||
    !isFiniteNumber(knee.g2gP99AtSaturation)
  ) {
    violations.push('consumerKnee missing/incomplete (measured operating limit)');
  } else if (knee.g2gP99AtSaturation < knee.g2gP99AtOnset) {
    violations.push(
      'consumerKnee not located: g2g p99 does not bend up (saturation < onset)',
    );
  }

  // Mesh must survive the drop with >= 2 relays (positive survival floor).
  if (
    isFiniteNumber(o.dropRelay?.relaysAfter) &&
    o.dropRelay.relaysAfter < 2
  ) {
    violations.push('dropRelay.relaysAfter < 2 (mesh must survive with >=2 relays)');
  }

  // honesty[] must DOCUMENT both load-bearing caveats:
  //   (1) the relay was sub-saturated / has headroom (relay NOT the bottleneck);
  //   (2) the consumer knee is a CO-LOCATION artifact (not a per-user limit).
  const hasHeadroomCaveat = honesty.some((h) =>
    /headroom|sub-saturat|not saturat|never approached|not the bottleneck/i.test(h),
  );
  const hasColocationCaveat = honesty.some((h) =>
    /co-locat|colocat|synthetic consumer|per-user|own device/i.test(h),
  );
  if (honesty.length > 0 && !hasHeadroomCaveat) {
    violations.push(
      'honesty[] must document relay sub-saturation/headroom (relay not the bottleneck)',
    );
  }
  if (honesty.length > 0 && !hasColocationCaveat) {
    violations.push(
      'honesty[] must document the consumer-knee co-location artifact (not a per-user limit)',
    );
  }

  return violations;
}
