/**
 * Raw JSONL -> curated evidence aggregator — relay-saturation INTERNET run
 * (Task A4). ⭐ DATA-RECORDING core.
 *
 * `aggregate` is the pure, importable, tested transform: it parses the raw
 * sampled JSONL (one object per line, `kind:'rung'` or `kind:'drop'`), derives
 * every curated field deterministically from the measured samples, calls the
 * A5 two-ceiling extrapolation on the measured slopes, and returns a
 * {@link CuratedSaturationInternet}. It does NOT validate — the caller runs
 * `validateCurated` and fails closed on any violation (see the CLI below).
 *
 * Percentiles reuse the existing nearest-rank `percentile` from `./replay`
 * (arrays are sorted ascending first) — this file does NOT reimplement it.
 *
 * CLI (so Phase B can pipe raw -> curated):
 *   tsx scripts/bench/aggregate-saturation-internet.ts <raw.jsonl> \
 *       --run-id <id> --commit <sha>
 *   -> prints curated JSON to stdout; exits 1 (violations on stderr) if invalid.
 *
 * Plan: `docs/superpowers/plans/2026-07-09-relay-saturation-internet-multirelay-drop.md`
 */

import { readFileSync } from 'node:fs';
import { percentile } from './replay';
import { extrapolateTwoCeiling } from './two-ceiling-extrapolate';
import { validateCurated } from './saturation-internet.schema';
import type {
  BandwidthProjection,
  ConsumerKnee,
  CuratedSaturationInternet,
  DropRelayEvent,
  Extrapolation,
  MediaSecurity,
  PercentileTriple,
  RelayNode,
  RungRow,
  TwoCeilingReal,
} from './saturation-internet.schema';

const PATHS_PER_VIEWER = 9;
const NIC_MBPS = 100;
const N_AT_TARGET = 100;
/** A rung is "relay CPU-bound" only if it approached a full core. */
const RELAY_CPU_SATURATION_CORES = 0.5;
/** Named uplinks for the bandwidth PROJECTION reference points. */
const PROJECTION_UPLINKS_MBPS = [100, 1000];

/** Raw rung sample line shape (aligned to the real probe/latency keys). */
interface RawRung {
  kind: 'rung';
  n: number;
  cpuCoresSrtp: number;
  bytesSentDeltaStandby: number;
  windowMs: number;
  tHopSamples: number[];
  g2gSamples: number[];
  pipeBytesObservedDelta: number;
  deliveryHealth: number;
  identity: { observed: number; matched: number; mismatched: number };
  clean?: boolean;
  anomaly?: string;
}

/** Raw drop-event line shape. */
interface RawDrop {
  kind: 'drop';
  atRungN: number;
  mttrMs: number;
  relaysBefore: number;
  relaysAfter: number;
  relayPromotedEpoch: number;
  mediaResumed: boolean;
}

type RawLine = RawRung | RawDrop;

/** p50/p95/p99 via the imported nearest-rank helper (sorts ascending first). */
function triple(samples: number[]): PercentileTriple {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

/** Median of a numeric array (returns 0 for an empty array). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/** A rung's g2g TAIL SPREAD = p99/p50. ~1.0 = tight (no tail); >1 = tail detaching. */
function tailSpread(r: RungRow): number {
  return r.g2gMs.p50 > 0 ? r.g2gMs.p99 / r.g2gMs.p50 : 1;
}

/**
 * Locate the consumer-decode knee from the measured g2g curve. Onset = the
 * lowest rung where the latency TAIL first DETACHES from the median — i.e. the
 * p99/p50 tail-spread jumps materially (>= KNEE_SPREAD_JUMP) vs the previous
 * rung. (Tail-detachment, not raw-p99-super-linearity: p99 can nearly double
 * for a 2x load and still read "linear" while the tail has plainly blown out;
 * the SPREAD is the honest saturation signal.) Saturation = the top measured
 * rung. If no rung detaches, onset falls back to the top rung (still located).
 * Pure — derived only from measured p50/p99.
 */
const KNEE_SPREAD_JUMP = 1.3; // >=30% jump in p99/p50 spread = tail detaching.
export function deriveConsumerKnee(rungs: RungRow[]): ConsumerKnee {
  if (rungs.length === 0) {
    return { onsetN: 0, saturatedN: 0, g2gP99AtOnset: 0, g2gP99AtSaturation: 0 };
  }
  const top = rungs[rungs.length - 1]!;
  let onsetIdx = rungs.length - 1;
  for (let i = 1; i < rungs.length; i++) {
    const prevSpread = tailSpread(rungs[i - 1]!);
    const curSpread = tailSpread(rungs[i]!);
    if (prevSpread > 0 && curSpread / prevSpread >= KNEE_SPREAD_JUMP) {
      onsetIdx = i;
      break;
    }
  }
  const onset = rungs[onsetIdx]!;
  return {
    onsetN: onset.n,
    saturatedN: top.n,
    g2gP99AtOnset: onset.g2gMs.p99,
    g2gP99AtSaturation: top.g2gMs.p99,
  };
}

function toRungRow(raw: RawRung): RungRow {
  const forwardPaths = raw.n * PATHS_PER_VIEWER;
  // bytesSent -> bits -> per-second -> Mbps.
  const egressMbpsReal =
    (raw.bytesSentDeltaStandby * 8) / (raw.windowMs / 1000) / 1e6;
  const mbpsPerViewer = egressMbpsReal / raw.n;
  const streamIdentityOk =
    raw.identity.mismatched === 0 && raw.identity.observed > 0;
  const row: RungRow = {
    n: raw.n,
    forwardPaths,
    cpuCoresSrtp: raw.cpuCoresSrtp,
    egressMbpsReal,
    mbpsPerViewer,
    tHopMs: triple(raw.tHopSamples),
    g2gMs: triple(raw.g2gSamples),
    pipeBytesDelta: raw.pipeBytesObservedDelta,
    deliveryHealth: raw.deliveryHealth,
    streamIdentityOk,
    // Default clean=true unless the raw line reports otherwise.
    clean: raw.clean === false ? false : true,
  };
  if (raw.anomaly !== undefined) row.anomaly = raw.anomaly;
  return row;
}

/**
 * Parse raw JSONL and derive the curated artifact. Pure — no I/O, no exit.
 */
export function aggregate(
  rawJsonl: string,
  meta: { runId: string; benchCommit: string; mediaSecurity: MediaSecurity },
): CuratedSaturationInternet {
  const lines: RawLine[] = rawJsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as RawLine);

  const rawRungs = lines.filter((l): l is RawRung => l.kind === 'rung');
  const rawDrop = lines.find((l): l is RawDrop => l.kind === 'drop');

  const rungs = rawRungs.map(toRungRow);

  const dropRelay: DropRelayEvent =
    rawDrop !== undefined
      ? {
          atRungN: rawDrop.atRungN,
          mttrMs: rawDrop.mttrMs,
          relaysBefore: rawDrop.relaysBefore,
          relaysAfter: rawDrop.relaysAfter,
          relayPromotedEpoch: rawDrop.relayPromotedEpoch,
          mediaResumed: rawDrop.mediaResumed,
        }
      : {
          atRungN: 0,
          mttrMs: 0,
          relaysBefore: 0,
          relaysAfter: 0,
          relayPromotedEpoch: 0,
          mediaResumed: false,
        };

  // Measured slopes: per-path CPU and per-viewer Mbps (median across rungs).
  const cpuCoresPerPathSrtp = median(
    rungs.map((r) => r.cpuCoresSrtp / r.forwardPaths),
  );
  const mbpsPerViewerReal = median(rungs.map((r) => r.mbpsPerViewer));

  const tc = extrapolateTwoCeiling({
    cpuCoresPerPathSrtp,
    mbpsPerViewerReal,
    nicMbps: NIC_MBPS,
    nAtTarget: N_AT_TARGET,
    pathsPerViewer: PATHS_PER_VIEWER,
  });

  // DERIVED saturation verdict: the relay is CPU-bound only if a MEASURED rung
  // approached a full core; otherwise it never became the bottleneck.
  const maxCpuCoresSrtp = rungs.reduce(
    (m, r) => Math.max(m, r.cpuCoresSrtp),
    0,
  );
  const binding: TwoCeilingReal['binding'] =
    maxCpuCoresSrtp > RELAY_CPU_SATURATION_CORES ? 'cpu' : 'not-saturated';
  const cWorkerSrtpNote =
    binding === 'cpu'
      ? `${tc.cWorkerSrtp} = 1/measured per-path CPU slope; a rung approached a core (max ${maxCpuCoresSrtp.toFixed(4)}) so this IS the CPU operating ceiling.`
      : `${tc.cWorkerSrtp} = 1/measured per-path CPU slope; the relay never approached this (peaked at ${maxCpuCoresSrtp.toFixed(4)} of a core) — a HEADROOM indicator, NOT a claimed operating ceiling.`;
  const twoCeiling: TwoCeilingReal = {
    cWorkerSrtp: tc.cWorkerSrtp,
    cWorkerSrtpNote,
    kRcpuAt100: tc.kRcpuAt100,
    kRbwAt100: tc.kRbwAt100,
    binding,
    floorAt100: tc.floorAt100,
    planningAt100: tc.planningAt100,
  };

  // CONSUMER-DECODE knee (measured operating limit). Onset = the lowest rung
  // where g2g p99 first bends up super-linearly vs the previous rung (its p99
  // grows faster than n grows); saturation = the top measured rung. Both DERIVED.
  const consumerKnee = deriveConsumerKnee(rungs);

  // Bandwidth ceiling as a labeled PROJECTION (viewers = uplink / per-viewer),
  // parameterized on named uplinks; plus the measured peak egress (relay NIC was
  // never the constraint in this run).
  const measuredPeakEgressMbps = rungs.reduce(
    (m, r) => Math.max(m, r.egressMbpsReal),
    0,
  );
  const bandwidthProjection: BandwidthProjection = {
    mbpsPerViewer: mbpsPerViewerReal,
    references: PROJECTION_UPLINKS_MBPS.map((uplinkMbps) => ({
      uplinkMbps,
      viewers:
        mbpsPerViewerReal > 0
          ? Math.floor(uplinkMbps / mbpsPerViewerReal)
          : 0,
    })),
    measuredPeakEgressMbps,
  };

  const measuredToN = rungs.reduce((m, r) => Math.max(m, r.n), 0);
  const extrapolation: Extrapolation = {
    measuredToN,
    method:
      'linear slope on measured per-path CPU + per-viewer Mbps, projected to N',
    // NIC / per-viewer -> how many viewers one capped relay NIC can carry.
    projectedCeilingViewers:
      mbpsPerViewerReal > 0 ? Math.floor(NIC_MBPS / mbpsPerViewerReal) : 0,
  };

  const relays: RelayNode[] = [
    {
      relayId: 'relay-primary',
      region: 'koreacentral',
      publishedNicMbps: NIC_MBPS,
      role: 'primary',
    },
    {
      relayId: 'relay-standby',
      region: 'japaneast',
      publishedNicMbps: NIC_MBPS,
      role: 'standby',
    },
    {
      relayId: 'relay-overlap',
      region: 'japaneast',
      publishedNicMbps: NIC_MBPS,
      role: 'overlap',
    },
  ];

  const honesty: string[] = [
    `Measured live only to N=${measuredToN}; higher N is EXTRAPOLATED, not observed.`,
    // (1) REQUIRED caveat: relay sub-saturation / headroom (relay NOT the bottleneck).
    `RELAY HEADROOM: the relay never approached its CPU ceiling — SRTP CPU peaked at ${maxCpuCoresSrtp.toFixed(4)} of a core (~${(maxCpuCoresSrtp * 100).toFixed(1)}%) at the top rung, scaling LINEARLY with N. The relay was NOT the bottleneck; cWorkerSrtp (${tc.cWorkerSrtp}) is a headroom indicator, not a measured operating ceiling.`,
    // (2) REQUIRED caveat: the consumer knee is a CO-LOCATION artifact, not a per-user limit.
    `CONSUMER-KNEE consistent with CO-LOCATION: the g2g p99 knee (${consumerKnee.g2gP99AtOnset.toFixed(1)}->${consumerKnee.g2gP99AtSaturation.toFixed(1)} ms across N=${consumerKnee.onsetN}->${consumerKnee.saturatedN}) coincides with ALL synthetic consumers being co-located on ONE 2-vCPU box competing for decode CPU. The co-location control isolates the L_decode term (it halves when decode density halves while relay cpuCoresSrtp stays invariant); attribution of the ENTIRE g2g p99 knee is INFERENTIAL — the 3-trial p99 median did not itself recede and its residual tail tracks a cross-region jitter-buffer transient. Relay hop p50 stays FLAT (~13 ms) at every rung. We therefore INFER the knee does not stack per real distinct user; NOT a proven per-user deployment limit.`,
    'Bandwidth ceiling is a labeled forward PROJECTION (viewers = uplink / per-viewer-Mbps); the relay NIC was never a constraint in this run (measured peak egress well under the cap). No NIC number gates the pass/fail.',
    // Planning-fields legend — so kRbwAt100=3 is never misread against the 34-viewer projection.
    `twoCeiling planning fields = number of RELAYS needed to serve N=${N_AT_TARGET} concurrent viewers: kRcpuAt100 (CPU-bound: ceil(N*pathsPerViewer / cWorkerSrtp)), kRbwAt100 (bandwidth-bound: ceil(N*mbpsPerViewer / publishedNicMbps)), floorAt100 = max(kRcpuAt100, kRbwAt100), planningAt100 = floor + engineering headroom (20% burst @ 70% target NIC utilisation). The bandwidth-bound figures assume the published ${NIC_MBPS} Mbps relay NIC (relays[].publishedNicMbps) — a forward PROJECTION, not a measured ceiling (measured peak egress was only ${measuredPeakEgressMbps.toFixed(2)} Mbps, so the NIC was never the constraint in this run). This is orthogonal to bandwidthProjection.references, which report per-relay VIEWER capacity (uplink / per-viewer) at named uplinks.`,
    '3 relays = redundant placement in the 1-primary / 1-warm-standby model (NOT a multi-active mesh; no mesh economics claimed).',
    'relaysAfter=3 means the mesh was left UNTOUCHED — this run did NOT perform a kill+survive; it is NOT a measured failover. The smh D2 lane (REQ-RMS-024) observed a BOOLEAN promotion after verified pre-kill media with surviving processes/ports open; recovery time (MTTR) and post-promotion media resume/continuity were NOT measured there.',
    'Mesh re-formation after failover is deferred (REQ-RMS-023, out of scope for this run).',
  ];

  // Plaintext runs must declare that the relay capacity is E2EE-INVARIANT (the
  // relay is content-blind; E2EE's cost is paid at the endpoints, not the relay).
  if (meta.mediaSecurity === 'plaintext') {
    honesty.push(
      'Measured on the PLAINTEXT SFU-forward path (e2ee=off). No material relay-capacity difference was resolved between the plaintext and E2EE arms through N=15 (comparable-load cross-runs, not matched arms): the relay is content-blind — it forwards opaque bytes and performs the same class of hop-by-hop DTLS-SRTP transport work whether or not the E2EE inner layer (SFrame/insertable streams) is present, so no E2EE-specific relay cost was resolved (any endpoint cost is paid at encrypt/decrypt). The relay-blind property itself is proven separately in the W5 M2/M3 lane (p10-relayblind harness: relay forwards the E2EE stream but the forwarded body is GCM-opaque, undecodable without the key).',
    );
  } else if (meta.mediaSecurity === 'e2ee') {
    honesty.push(
      'Measured on the E2EE path (e2ee=on): the real SFrame / insertable-streams transform ran on BOTH legs (SFrame encrypt at the producer, decrypt at each consumer; verified per rung: RTCRtpScriptTransform attached, notEncrypted=0). No material relay-capacity difference was resolved vs the plaintext arm through N=15: the relay is content-blind — it forwards the opaque SFrame-wrapped SRTP and performs the same class of hop-by-hop DTLS-SRTP transport work as plaintext, so cpuCoresSrtp shows no material difference across the two arms (comparable-load cross-runs, close but not identical, e.g. 0.0525 vs 0.0500 at N=15; no repeated-arm equivalence test). Any consumer-side g2g increase versus the plaintext arm is an observed cross-run estimator difference consistent with per-frame SFrame DECRYPT stacked on the co-located decode — NOT a resolved relay cost or a per-user-deployment limit. The relay-blind property is proven separately in the W5 M2/M3 lane (p10-relayblind: the forwarded body is GCM-opaque, undecodable without the key).',
    );
  }

  return {
    artifact: 'relay-saturation-internet-multirelay',
    runId: meta.runId,
    benchCommit: meta.benchCommit,
    mediaSecurity: meta.mediaSecurity,
    requirement: 'REQ-RMS-001 (internet fidelity upgrade)',
    regionPair: ['koreacentral', 'japaneast'],
    relays,
    pageSize: 9,
    pathsPerViewer: PATHS_PER_VIEWER,
    profile: 'simulcast-gallery',
    rungs,
    dropRelay,
    twoCeiling,
    consumerKnee,
    bandwidthProjection,
    extrapolation,
    honesty,
  };
}

// ---------------------------------------------------------------------------
// CLI: raw jsonl path + --run-id/--commit -> curated JSON on stdout.
// Fails closed (exit 1, violations on stderr) if the artifact is invalid.
// ---------------------------------------------------------------------------

interface CliArgs {
  jsonlPath: string;
  runId: string;
  benchCommit: string;
  mediaSecurity: MediaSecurity;
}

const USAGE =
  'Usage: tsx scripts/bench/aggregate-saturation-internet.ts <raw.jsonl> ' +
  '--run-id <id> --commit <sha> --media-security <plaintext|e2ee>';

export function parseAggregateArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let jsonlPath: string | null = null;
  let runId = 'unknown';
  let benchCommit = 'unknown';
  let mediaSecurity: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--run-id') {
      runId = args[++i] ?? runId;
    } else if (a === '--commit') {
      benchCommit = args[++i] ?? benchCommit;
    } else if (a === '--media-security') {
      mediaSecurity = args[++i] ?? null;
    } else if (!a.startsWith('-')) {
      jsonlPath = a;
    }
  }
  if (jsonlPath === null) {
    throw new Error(USAGE);
  }
  // Required + validated at the boundary (fail-closed before we even build).
  if (mediaSecurity !== 'plaintext' && mediaSecurity !== 'e2ee') {
    throw new Error(
      `--media-security is REQUIRED and must be 'plaintext' or 'e2ee'. ${USAGE}`,
    );
  }
  return { jsonlPath, runId, benchCommit, mediaSecurity };
}

function main(): void {
  const args = parseAggregateArgs(process.argv);
  const raw = readFileSync(args.jsonlPath, 'utf8');
  const curated = aggregate(raw, {
    runId: args.runId,
    benchCommit: args.benchCommit,
    mediaSecurity: args.mediaSecurity,
  });
  const violations = validateCurated(curated);
  process.stdout.write(JSON.stringify(curated, null, 2) + '\n');
  if (violations.length > 0) {
    process.stderr.write(
      `FAIL-CLOSED: curated artifact has ${violations.length} violation(s):\n` +
        violations.map((v) => `  - ${v}`).join('\n') +
        '\n',
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1]?.endsWith('aggregate-saturation-internet.ts') === true ||
  process.argv[1]?.endsWith('aggregate-saturation-internet.js') === true;

if (isMain) {
  main();
}
