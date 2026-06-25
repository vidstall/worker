/**
 * Relay-overlap M1 — client-perceived cutover MTTR bench (Phase 5.3, step 3b).
 *
 * Produces THE number for advisor gate 2 and asserts it against the
 * REQUIREMENTS success-metric (P95 <= 100 ms / P99 <= 200 ms).
 *
 *   MTTR = t1 - t0
 *     t0 = client's LAST RTP packet from the PRIMARY relay (primary media stops
 *          — the "kill").
 *     t1 = client's FIRST RTP packet from the warm STANDBY relay after it
 *          detected RTP silence and resumed its pre-created paused standby
 *          consumer (cutover complete — client sees media again).
 *
 * Built ON the step-3a spike (warmpipe-rtp.integration.test.ts), which PROVED
 * real Opus RTP flows publisher -> primary router -> production-faithful manual
 * cross-PipeTransport warm pipe -> standby router -> consumer after a
 * paused->resume cutover (~0-1 ms relay-level resume). This file reuses that
 * exact backbone and adds: a replicated client rtp-timeout-watcher, dual
 * client sinks (primary active + standby pre-paused), a deterministic "kill",
 * and an N-iteration percentile loop + report artifact.
 *
 * ── What is real ──────────────────────────────────────────────────────────
 * IN-PROCESS, REAL-mediasoup: two real Workers (primary + standby relays,
 * distinct child processes), two Routers, real PipeTransports, real Opus RTP.
 * The "client" is two DirectTransport consumers — one on the primary router
 * (active), one on the standby router's piped producer (pre-created PAUSED,
 * REQ-RO-005). DirectTransport emits a per-packet 'rtp' event => sub-ms
 * client-perceived arrival timestamps (a browser WebRTC consumer hides arrival
 * behind a jitter buffer + getStats() polling, which the prior
 * mediasoup-client-harness showed to be unreliable + Windows-teardown-unstable
 * — unsuitable for a clean per-iteration percentile loop).
 *
 * ── Honesty bounds ────────────────────────────────────────────────────────
 * This is an OPTIMISTIC FLOOR for the detection + relay/resume mechanism, not a
 * WAN glass-to-glass latency. In-process loopback omits real-deployment terms a
 * cross-process / WAN client adds: WebRTC jitter-buffer playout (~20-60 ms), OS
 * UDP scheduling, network RTT. The inter-relay WS connect-param exchange is
 * genuinely ~0 at cutover (warm pipe is pre-established before the kill — the
 * whole point of REQ-RO-004/005). MTTR is bounded below by RTP_TIMEOUT_MS; the
 * detection window dominates.
 *
 * Env knobs: RTP_TIMEOUT_MS (default 50), BENCH_RUNS (default 30),
 * BENCH_WARMUP_MS (250), BENCH_SETTLE_MS (400), JITTER_BUFFER_MS (0),
 * HEARTBEAT_INTERVAL_MS (reserved/no-op).
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/relay-overlap-mttr.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
  pipeSrtpEnabled,
} from '@dvconf/inter-relay-client';
import { ensureWarmPipe, type RoomTopology } from '@dvconf/inter-relay-client';
import { LatencyWriter } from '@dvconf/shared';

// ── Env knobs ─────────────────────────────────────────────────────────────

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

const RTP_TIMEOUT_MS = envInt('RTP_TIMEOUT_MS', 50);
const RUNS = envInt('BENCH_RUNS', 30);
const WARMUP_MS = envInt('BENCH_WARMUP_MS', 250);
const SETTLE_MS = envInt('BENCH_SETTLE_MS', 400);
const JITTER_BUFFER_MS = envInt('JITTER_BUFFER_MS', 0);
const HEARTBEAT_INTERVAL_MS = envInt('HEARTBEAT_INTERVAL_MS', 0);

// ── nearest-rank percentile (mirrors scripts/bench/replay.ts) ──────────────

function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

// ── Replicated dvconf-client rtp-timeout-watcher (behaviour-verbatim) ──────
// Source of truth: dvconf-client/src/hooks/rtp-timeout-watcher.ts. Cross-repo
// import is forbidden; this mirror keeps the SAME semantics (fire once after
// timeoutMs of silence, reset on each packet, idempotent destroy).

interface RtpTimeoutWatcher {
  onPacketReceived(): void;
  destroy(): void;
}

function createRtpTimeoutWatcher(
  onTimeout: () => void,
  timeoutMs: number,
): RtpTimeoutWatcher {
  let fired = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  function schedule(): void {
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(() => {
      if (!fired) {
        fired = true;
        onTimeout();
      }
    }, timeoutMs);
  }
  schedule();
  return {
    onPacketReceived(): void {
      if (fired) return;
      schedule();
    },
    destroy(): void {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      fired = true;
    },
  };
}

// ── codec + synthetic RTP source (mirrors the step-3a spike) ───────────────

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
  },
];

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;

function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const payload = Buffer.from([0xfc, 0xff, 0xfe]);
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = OPUS_PT & 0x7f;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, payload]);
}

const pipeProducerRtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: OPUS_PT,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: OPUS_SSRC }],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ── module-scoped real workers (spawned once) ──────────────────────────────

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

// ── per-run scaffold (publisher, warm pipe, dual client sinks) ─────────────

interface RunScaffold {
  start(): void;
  killPrimary(): void;
  lastPrimaryRtpAt(): number | null;
  firstStandbyRtpAt(): number | null;
  standbyCount(): number;
  primaryCount(): number;
  resumeStandby(): Promise<void>;
  setWatcher(w: RtpTimeoutWatcher): void;
  teardown(): void;
}

async function armRun(): Promise<RunScaffold> {
  // synthetic Opus RTP publisher on the PRIMARY (DirectTransport-fed source)
  const srcTransport = await primaryRouter.createDirectTransport();
  const srcProducer = await srcTransport.produce({
    kind: 'audio',
    rtpParameters: pipeProducerRtpParameters,
  });
  let seq = 0;
  let ts = 0;
  let pubInterval: NodeJS.Timeout | null = null;

  // warm pipe: production-faithful manual cross-PipeTransport pairing
  const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
  const standbyPipe = await standbyRouter.createPipeTransport({
    listenIp: { ip: '0.0.0.0', announcedIp: '127.0.0.1' },
    port: 0,
    enableRtx: false,
    enableSrtp: pipeSrtpEnabled(),
  } as Parameters<msTypes.Router['createPipeTransport']>[0]);
  await primaryPipe.connect({
    ip: '127.0.0.1',
    port: standbyPipe.tuple.localPort,
  } as Parameters<msTypes.PipeTransport['connect']>[0]);
  await standbyPipe.connect({
    ip: '127.0.0.1',
    port: primaryPipe.tuple.localPort,
  } as Parameters<msTypes.PipeTransport['connect']>[0]);

  const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(
    primaryPipe,
    srcProducer.id,
  );
  const pipedProducerId = primaryPipeConsumer.id;
  const pipedProducer = await standbyPipe.produce({
    id: pipedProducerId,
    kind: primaryPipeConsumer.kind,
    rtpParameters: primaryPipeConsumer.rtpParameters,
    paused: primaryPipeConsumer.producerPaused,
  } as Parameters<msTypes.PipeTransport['produce']>[0]);

  // exercise the as-built standby warm-pipe contract (REQ-RO-005): a PAUSED
  // pipe consumer for the real producer id (production code path).
  const topology: RoomTopology = {
    roomId: 'bench-room',
    role: 'standby',
    primaryEndpoint: 'ws://127.0.0.1:0',
    standbyEndpoint: 'ws://127.0.0.1:0',
    pipePort: 0,
    pipeConsumer: null,
    pipeTransport: null,
  };
  const warmPipeConsumer = await ensureWarmPipe(
    topology,
    standbyRouter,
    0,
    pipedProducerId,
  );
  // REQ-RO-005 invariant: the warm standby consumer MUST start paused
  // (RTCP-only keepalive) — locks the paused-warm-pipe contract into the bench.
  if (warmPipeConsumer === null || warmPipeConsumer.paused !== true) {
    throw new Error('REQ-RO-005 violated: warm-pipe consumer must be created paused');
  }

  // CLIENT: dual DirectTransport sinks
  const primarySinkT = await primaryRouter.createDirectTransport();
  const primarySink = await primarySinkT.consume({
    producerId: srcProducer.id,
    rtpCapabilities: primaryRouter.rtpCapabilities,
    paused: false,
  });
  let primaryCount = 0;
  let lastPrimaryAt: number | null = null;
  let watcher: RtpTimeoutWatcher | null = null;
  primarySink.on('rtp', () => {
    primaryCount++;
    lastPrimaryAt = Date.now();
    watcher?.onPacketReceived();
  });

  const standbySinkT = await standbyRouter.createDirectTransport();
  const standbySink = await standbySinkT.consume({
    producerId: pipedProducer.id,
    rtpCapabilities: standbyRouter.rtpCapabilities,
    paused: true,
  });
  let standbyCount = 0;
  let firstStandbyAt: number | null = null;
  standbySink.on('rtp', () => {
    standbyCount++;
    if (firstStandbyAt === null) firstStandbyAt = Date.now();
  });

  return {
    start: () => {
      pubInterval = setInterval(() => {
        srcProducer.send(makeRtpPacket(seq++, ts));
        ts += 960; // 20 ms @ 48 kHz
      }, 10);
    },
    killPrimary: () => {
      // "Kill primary" = the PRIMARY RELAY drops the client. The room peer
      // (publisher) keeps sending and the warm pipe keeps carrying RTP to the
      // standby — exactly the failure relay-overlap redundancy protects
      // against. Modelled by closing the client's PRIMARY sink consumer: the
      // client's primary media path goes silent immediately while the standby
      // pipe stays live, so the resumed standby sink has real RTP to deliver.
      // (Closing the consumer, not the publisher: stopping the source would
      // also starve the standby — that is a source outage, not a relay
      // failover, and is not what M1 redundancy addresses.)
      primarySink.close();
    },
    lastPrimaryRtpAt: () => lastPrimaryAt,
    firstStandbyRtpAt: () => firstStandbyAt,
    standbyCount: () => standbyCount,
    primaryCount: () => primaryCount,
    resumeStandby: async () => {
      if (JITTER_BUFFER_MS > 0) await sleep(JITTER_BUFFER_MS);
      await standbySink.resume();
    },
    setWatcher: (w) => {
      watcher = w;
    },
    teardown: () => {
      if (pubInterval !== null) clearInterval(pubInterval);
      try {
        primarySink.close();
        standbySink.close();
        warmPipeConsumer?.close();
        // N2 leak fix (G3.1): ensureWarmPipe now retains its internal pipe
        // transport on topology — close it so it does not accumulate idle on
        // standbyRouter across the N-iteration loop.
        topology.pipeTransport?.close();
        pipedProducer.close();
        primaryPipeConsumer.close();
        primaryPipe.close();
        standbyPipe.close();
        srcProducer.close();
        srcTransport.close();
        primarySinkT.close();
        standbySinkT.close();
      } catch {
        // best-effort cleanup
      }
    },
  };
}

interface RunResult {
  mttrMs: number;
  detectMs: number;
  resumeToFirstMs: number;
  primaryPkts: number;
  standbyPkts: number;
}

async function measureOnce(): Promise<RunResult> {
  const scaffold = await armRun();
  let watcherFiredAt: number | null = null;
  let resumeError: unknown = null;

  const watcher = createRtpTimeoutWatcher(() => {
    watcherFiredAt = Date.now();
    scaffold.resumeStandby().catch((e) => {
      resumeError = e;
    });
  }, RTP_TIMEOUT_MS);
  scaffold.setWatcher(watcher);

  scaffold.start();
  await sleep(WARMUP_MS);

  scaffold.killPrimary();
  const t0 = scaffold.lastPrimaryRtpAt();

  await sleep(RTP_TIMEOUT_MS + SETTLE_MS);
  watcher.destroy();

  const t1 = scaffold.firstStandbyRtpAt();
  const primaryPkts = scaffold.primaryCount();
  const standbyPkts = scaffold.standbyCount();
  scaffold.teardown();

  if (resumeError !== null) {
    throw new Error(`resumeStandby failed: ${String(resumeError)}`);
  }
  if (t0 === null) throw new Error('no primary RTP observed (publisher dead?)');
  if (watcherFiredAt === null) throw new Error('watcher never fired');
  if (t1 === null) {
    throw new Error('no standby RTP after cutover (warm pipe not flowing?)');
  }

  return {
    mttrMs: t1 - t0,
    detectMs: watcherFiredAt - t0,
    resumeToFirstMs: t1 - watcherFiredAt,
    primaryPkts,
    standbyPkts,
  };
}

function fmt(n: number): string {
  return n.toFixed(1);
}

function buildReport(results: RunResult[], failures: number): string {
  const mttr = results.map((r) => r.mttrMs).sort((a, b) => a - b);
  const detect = results.map((r) => r.detectMs).sort((a, b) => a - b);
  const resume = results.map((r) => r.resumeToFirstMs).sort((a, b) => a - b);
  const n = mttr.length;
  const p50 = percentile(mttr, 0.5);
  const p95 = percentile(mttr, 0.95);
  const p99 = percentile(mttr, 0.99);
  const mean = mttr.reduce((s, v) => s + v, 0) / n;
  const min = mttr[0]!;
  const max = mttr[n - 1]!;
  const p95Pass = p95 <= 100;
  const p99Pass = p99 <= 200;
  const verdict = p95Pass && p99Pass ? 'PASS' : 'FAIL';

  const L: string[] = [];
  L.push('# Relay-Overlap M1 — Client-Perceived Cutover MTTR Bench');
  L.push('');
  L.push('**Date:** 2026-06-05  ');
  L.push('**Branch:** bench-3b-client-mttr (off spike-warmpipe-rtp)  ');
  L.push(`**Verdict:** **${verdict}** vs success-metric P95 <= 100 ms / P99 <= 200 ms`);
  L.push('');
  L.push('## Result');
  L.push('');
  L.push('| Metric | Value (ms) | Target | Pass |');
  L.push('|---|---:|---|:--:|');
  L.push(`| N (runs) | ${n} | >=30 | ${n >= 30 ? 'yes' : 'no'} |`);
  L.push(`| P50 MTTR | ${fmt(p50)} | - | - |`);
  L.push(`| **P95 MTTR** | **${fmt(p95)}** | <= 100 | ${p95Pass ? 'yes' : 'no'} |`);
  L.push(`| **P99 MTTR** | **${fmt(p99)}** | <= 200 | ${p99Pass ? 'yes' : 'no'} |`);
  L.push(`| mean | ${fmt(mean)} | - | - |`);
  L.push(`| min / max | ${fmt(min)} / ${fmt(max)} | - | - |`);
  L.push(`| failed runs | ${failures} | 0 | ${failures === 0 ? 'yes' : 'no'} |`);
  L.push('');
  L.push('### MTTR component breakdown');
  L.push('');
  L.push('| Component | P50 (ms) | P95 (ms) |');
  L.push('|---|---:|---:|');
  L.push(
    `| detection window (kill -> watcher fired) | ${fmt(percentile(detect, 0.5))} | ${fmt(percentile(detect, 0.95))} |`,
  );
  L.push(
    `| relay + resume (watcher fired -> first standby RTP) | ${fmt(percentile(resume, 0.5))} | ${fmt(percentile(resume, 0.95))} |`,
  );
  L.push('');
  L.push('## Knob values');
  L.push('');
  L.push('| Knob | Value |');
  L.push('|---|---:|');
  L.push(`| RTP_TIMEOUT_MS | ${RTP_TIMEOUT_MS} |`);
  L.push(`| JITTER_BUFFER_MS | ${JITTER_BUFFER_MS} |`);
  L.push(`| HEARTBEAT_INTERVAL_MS | ${HEARTBEAT_INTERVAL_MS} (reserved; no-op in this rig) |`);
  L.push(`| BENCH_WARMUP_MS | ${WARMUP_MS} |`);
  L.push(`| BENCH_SETTLE_MS | ${SETTLE_MS} |`);
  L.push('');
  L.push('## Methodology');
  L.push('');
  L.push(
    '- **In-process, real-mediasoup**: two real Workers (primary + standby relays, distinct child processes), two Routers, real PipeTransports, real Opus RTP. Warm pipe built by the production-faithful manual cross-PipeTransport pairing proven by the step-3a spike.',
  );
  L.push(
    '- **Client model**: dual DirectTransport consumers — primary router (active) + standby router piped producer (pre-created PAUSED, REQ-RO-005). DirectTransport emits a per-packet rtp event -> sub-ms client-perceived arrival timestamps.',
  );
  L.push(
    '- **Detection**: the dvconf-client rtp-timeout-watcher replicated verbatim (fire once after RTP_TIMEOUT_MS of silence, reset per packet), attached to the primary sink.',
  );
  L.push(
    "- **t0** = client's last RTP from the primary sink (the primary relay drops the client). **t1** = client's first RTP from the standby after resume. **MTTR = t1 - t0.**",
  );
  L.push(
    '- **"Kill primary"** = the PRIMARY RELAY drops the client, modelled by closing the client\'s PRIMARY sink consumer (`primarySink.close()`). The room peer (publisher) keeps sending and the warm pipe keeps carrying RTP to the standby — exactly the failure relay-overlap redundancy protects against, so the resumed standby sink has real RTP to deliver. (Deliberately NOT "stop the publisher": starving the source would also starve the standby — a source outage, not a relay failover, which M1 does not address.)',
  );
  L.push('');
  L.push('## Honesty / bounds');
  L.push('');
  L.push(
    '- **Optimistic floor** for the detection + relay/resume mechanism, **not** a WAN glass-to-glass latency. In-process loopback omits real-deployment terms a cross-process / WAN client adds: WebRTC jitter-buffer playout (~20-60 ms), OS UDP scheduling, network RTT.',
  );
  L.push(
    '- The inter-relay WS connect-param exchange is **genuinely ~0 at cutover**: the warm pipe is pre-established before the kill (the point of REQ-RO-004/005), so it is off the cutover critical path.',
  );
  L.push(
    `- MTTR is **bounded below by RTP_TIMEOUT_MS (${RTP_TIMEOUT_MS} ms)**; the detection window dominates (relay-level resume ~0-1 ms, spike-confirmed). Lowering RTP_TIMEOUT_MS lowers MTTR at the cost of false-positive cutovers on transient jitter.`,
  );
  L.push('');
  return L.join('\n');
}

describe('relay-overlap M1 — client-perceived cutover MTTR (P95/P99 bench)', () => {
  it(
    `runs N=${RUNS} cutovers and meets P95<=100ms / P99<=200ms`,
    async () => {
      const writer = new LatencyWriter({
        source: 'client',
        instance: 'relay-overlap-mttr',
        outputDir: resolve(process.cwd(), '.logs/bench'),
        scenario: 'adhoc',
      });

      const results: RunResult[] = [];
      let failures = 0;
      for (let i = 0; i < RUNS; i++) {
        try {
          const r = await measureOnce();
          results.push(r);
          writer.write('L_g2g_optA', r.mttrMs, {
            run: i,
            detect_ms: r.detectMs,
            resume_to_first_ms: r.resumeToFirstMs,
            primary_pkts: r.primaryPkts,
            standby_pkts: r.standbyPkts,
            rtp_timeout_ms: RTP_TIMEOUT_MS,
          });
          // eslint-disable-next-line no-console
          console.log(
            `[mttr-bench] run ${i + 1}/${RUNS}: MTTR=${fmt(r.mttrMs)}ms ` +
              `(detect=${fmt(r.detectMs)} resume+relay=${fmt(r.resumeToFirstMs)}) ` +
              `pPkts=${r.primaryPkts} sPkts=${r.standbyPkts}`,
          );
        } catch (e) {
          failures++;
          // eslint-disable-next-line no-console
          console.error(`[mttr-bench] run ${i + 1}/${RUNS} FAILED: ${String(e)}`);
        }
        await sleep(50);
      }
      writer.close();

      expect(results.length).toBeGreaterThan(0);

      const report = buildReport(results, failures);
      const evidencePath = resolve(
        process.cwd(),
        '.evidence/verification/relay-overlap-m1-bench-2026-06-05.md',
      );
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, report, 'utf8');
      // eslint-disable-next-line no-console
      console.log(`\n[mttr-bench] report -> ${evidencePath}`);
      // eslint-disable-next-line no-console
      console.log('\n' + report);

      const mttr = results.map((r) => r.mttrMs).sort((a, b) => a - b);
      const p95 = percentile(mttr, 0.95);
      const p99 = percentile(mttr, 0.99);
      // Hard assertions on the advisor-gate success metric.
      expect(results.length).toBeGreaterThanOrEqual(30);
      expect(p95).toBeLessThanOrEqual(100);
      expect(p99).toBeLessThanOrEqual(200);
    },
    180_000,
  );
});
