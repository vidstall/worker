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
  CuratedSaturationInternet,
  DropRelayEvent,
  Extrapolation,
  PercentileTriple,
  RelayNode,
  RungRow,
  TwoCeilingReal,
} from './saturation-internet.schema';

const PATHS_PER_VIEWER = 9;
const NIC_MBPS = 100;
const N_AT_TARGET = 100;

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
  meta: { runId: string; benchCommit: string },
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
  const twoCeiling: TwoCeilingReal = {
    cWorkerSrtp: tc.cWorkerSrtp,
    kRcpuAt100: tc.kRcpuAt100,
    kRbwAt100: tc.kRbwAt100,
    binding: tc.binding,
    floorAt100: tc.floorAt100,
    planningAt100: tc.planningAt100,
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
    'Ceiling is EXTRAPOLATED from measured per-path CPU + per-viewer Mbps slopes — the run was NOT pushed to saturation.',
    '3 relays = redundant placement in the 1-primary / 1-warm-standby model (NOT a multi-active mesh; no mesh economics claimed).',
    'Mesh re-formation after failover is deferred (REQ-RMS-023, out of scope for this run).',
    'Drop-relay = primary-death -> promote standby -> >=2 relays survive (smh D2 scope); it is not a network-partition test.',
  ];

  return {
    artifact: 'relay-saturation-internet-multirelay',
    runId: meta.runId,
    benchCommit: meta.benchCommit,
    requirement: 'REQ-RMS-001 (internet fidelity upgrade)',
    regionPair: ['koreacentral', 'japaneast'],
    relays,
    pageSize: 9,
    pathsPerViewer: PATHS_PER_VIEWER,
    profile: 'simulcast-gallery',
    rungs,
    dropRelay,
    twoCeiling,
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
}

export function parseAggregateArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let jsonlPath: string | null = null;
  let runId = 'unknown';
  let benchCommit = 'unknown';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--run-id') {
      runId = args[++i] ?? runId;
    } else if (a === '--commit') {
      benchCommit = args[++i] ?? benchCommit;
    } else if (!a.startsWith('-')) {
      jsonlPath = a;
    }
  }
  if (jsonlPath === null) {
    throw new Error(
      'Usage: tsx scripts/bench/aggregate-saturation-internet.ts <raw.jsonl> --run-id <id> --commit <sha>',
    );
  }
  return { jsonlPath, runId, benchCommit };
}

function main(): void {
  const args = parseAggregateArgs(process.argv);
  const raw = readFileSync(args.jsonlPath, 'utf8');
  const curated = aggregate(raw, {
    runId: args.runId,
    benchCommit: args.benchCommit,
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
