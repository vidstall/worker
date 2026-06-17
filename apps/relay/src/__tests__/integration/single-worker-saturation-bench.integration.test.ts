/**
 * W5 M1 — SINGLE-WORKER forwarding-CEILING bench (advisor-gate-2 follow-up).
 *
 * The P9 hard-gate (bandwidth-scale-bench.integration.test.ts) proved the
 * BANDWIDTH math: layer-select + off-page-pause forwards >=3x fewer bytes. It
 * did NOT answer "how big a room can ONE relay node actually hold?" — i.e. the
 * single mediasoup Worker CPU ceiling. That is the only scale question a SINGLE
 * developer machine can answer honestly (100 real browser clients on one box
 * would saturate the CLIENTS' encoders, not the relay — a meaningless number).
 *
 * ── Model: FAN-OUT, not N-producers-x-1-consumer ─────────────────────────────
 * In an SFU the expensive work is FORWARDING (copy each incoming packet to every
 * subscribed consumer), and that is what a single Worker's core spends CPU on.
 * So we model a realistic page: P=9 visible producers (1 active speaker + 8
 * thumbnails) fanned out to M VIEWERS. Each viewer = 1 DirectTransport carrying
 * 9 consumers (one per visible producer), exactly the M1 per-viewer downlink.
 *
 *   Worker forwarding copies ~= P * M  (e.g. M=100 -> ~900 forward paths — the
 *   same O(N x page_size) load a 100-person room imposes on the relay).
 *
 * Injection stays CONSTANT in M (only 9 producers to feed), so the JS injector
 * never becomes the M-dependent bottleneck — the Worker's C++ forwarding does.
 * mediasoup Workers are separate C++ subprocesses, so worker.getResourceUsage()
 * reads the FORWARDING CPU cleanly, not polluted by the Node injector thread.
 *
 * ── Two policies at each M ────────────────────────────────────────────────────
 *   BASELINE  (no select): all 9 consumers/viewer at spatialLayer:2 (high).
 *   OPTIMIZED (M1 page-9): consumer 0 at :2, consumers 1..8 at :0 (low).
 * Same forward-PATH count (P*M); OPTIMIZED moves most copies to the tiny low
 * layer, so it should sustain a far larger M before the core saturates.
 *
 * ── Signals (ramp M, find the knee) ──────────────────────────────────────────
 *   1. cpuCores = (d.ru_utime + d.ru_stime) ms / windowMs  — worker CPU in cores
 *      (mediasoup reports ru_utime/ru_stime in MILLISECONDS of CPU time).
 *   2. deliveryHealth = mean per-consumer forwarded throughput at M, relative to
 *      the smallest-M reference. ~1.0 = worker keeps up; a drop = it is dropping
 *      packets = SATURATED. (Sampled over the first few viewers to keep getStats
 *      overhead M-independent.)
 * The knee = the largest M where cpuCores stays below ~1 core AND deliveryHealth
 * stays >= ~0.9.
 *
 * ── Honesty bounds (mechanism-floor discipline, mirrors P9 + relay-overlap) ───
 *  - DirectTransport SKIPS SRTP encrypt/decrypt — real WebRTC pays that per
 *    packet, so the measured CPU is OPTIMISTIC (real ceiling is LOWER).
 *  - Single box, synthetic RTP source, no WAN, no jitter/congestion control.
 *  - One Worker == one core. Multi-worker / multi-node cascade (which spreads a
 *    big room across cores/hosts) is NOT built (DA-5) — extrapolating past one
 *    worker is a documented assumption, not a measurement.
 * This bench finds the ONE-WORKER forwarding ceiling; it is NOT a production
 * capacity number. It is exploratory (logs a curve), NOT a hard pass/fail gate.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/single-worker-saturation-bench.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// -- VP8-only codec (mirrors mediasoup-manager.ts:34 + the P9 gate) -----------
const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

const LAYER_LOW = 0;
const LAYER_HIGH = 2;
const PAGE_SIZE = 9; // LOCKED M1 default: 1 speaker + 8 thumbnails per viewer

/** Per-packet simulcast ladder bytes [low, mid, high] (mirrors the P9 gate ~1:7:18). */
const LADDER_BYTES = [60, 400, 1100] as const;

// ── Ramp + windows. Override the ramp via SAT_RAMP="25,50,100,200,400". ───────
const RAMP: number[] = (process.env['SAT_RAMP'] ?? '25,50,100,200,400')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
// Settle clears the creation burst + simulcast layer-switch transient; a LONG
// window averages out single-box setInterval timer jitter (the dominant noise —
// injectionHealth swung 0.79-1.35 at a 1.5s window). Env-tunable.
const SETTLE_MS = parseInt(process.env['SAT_SETTLE_MS'] ?? '4000', 10);
const WINDOW_MS = parseInt(process.env['SAT_WINDOW_MS'] ?? '6000', 10);
const HEALTH_SAMPLE_VIEWERS = 5; // sample first K viewers for per-consumer health

// ── RTP/RTCP builders (verbatim semantics from the P9 gate's makeVp8Rtp) ──────
function makeVp8Rtp(
  ssrc: number,
  seq: number,
  ts: number,
  pictureId: number,
  payloadBytes: number,
  keyframe: boolean,
): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (VP8_PT & 0x7f) | 0x80; // marker=1 + PT
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  const desc = Buffer.from([
    0x90,
    0x80,
    0x80 | ((pictureId >> 8) & 0x7f),
    pictureId & 0xff,
  ]);
  let vp8Hdr: Buffer;
  if (keyframe) {
    vp8Hdr = Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01]);
  } else {
    vp8Hdr = Buffer.from([0x11, 0x00, 0x00]);
  }
  const content = Buffer.alloc(Math.max(0, payloadBytes - vp8Hdr.length), 0xab);
  return Buffer.concat([header, desc, vp8Hdr, content]);
}

function makeRtcpSenderReport(
  ssrc: number,
  rtpTimestamp: number,
  packetCount: number,
  octetCount: number,
): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80;
  buf[1] = 200;
  buf.writeUInt16BE(6, 2);
  buf.writeUInt32BE(ssrc >>> 0, 4);
  const nowMs = Date.now();
  buf.writeUInt32BE((Math.floor(nowMs / 1000) + 2208988800) >>> 0, 8);
  buf.writeUInt32BE(Math.floor(((nowMs % 1000) / 1000) * 0x1_0000_0000) >>> 0, 12);
  buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
  buf.writeUInt32BE(packetCount >>> 0, 20);
  buf.writeUInt32BE(octetCount >>> 0, 24);
  return buf;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let worker: msTypes.Worker;

beforeAll(async () => {
  // ONE worker == one core. This IS the single-worker ceiling (NUM_WORKERS=1).
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
}, 60_000);

afterAll(() => {
  worker?.close();
});

// ── A visible producer (3-layer simulcast) with a keyframe + RTCP-SR injector ─
interface Producer {
  producer: msTypes.Producer;
  /** cumulative bytes this producer has injected across all 3 layers (to detect
   *  JS-injector starvation on a single box: should be M-INDEPENDENT). */
  sentBytes: () => number;
  stop: () => void;
  close: () => void;
}

async function makeProducer(router: msTypes.Router, index: number): Promise<Producer> {
  const base = 0x1000_0000 + index * 0x10;
  const ssrcs = [base, base + 1, base + 2] as const;
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [
      { mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] },
    ],
    encodings: [
      { ssrc: ssrcs[0], scalabilityMode: 'L1T1' },
      { ssrc: ssrcs[1], scalabilityMode: 'L1T1' },
      { ssrc: ssrcs[2], scalabilityMode: 'L1T1' },
    ],
  };
  const srcTransport = await router.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'video', rtpParameters });

  const seqs = [0, 0, 0];
  const pics = [0, 0, 0];
  const pkt = [0, 0, 0];
  const oct = [0, 0, 0];
  let ts = 0;
  let frame = 0;
  const tick = (): void => {
    const keyframe = frame % 10 === 0;
    for (let l = 0; l < 3; l++) {
      producer.send(makeVp8Rtp(ssrcs[l]!, seqs[l]!++, ts, pics[l]!++ & 0x7fff, LADDER_BYTES[l]!, keyframe));
      pkt[l]! += 1;
      oct[l]! += LADDER_BYTES[l]!;
    }
    if (keyframe) {
      for (let l = 0; l < 3; l++) {
        srcTransport.sendRtcp(makeRtcpSenderReport(ssrcs[l]!, ts, pkt[l]!, oct[l]!));
      }
    }
    ts += 3000;
    frame++;
  };
  const interval = setInterval(tick, 10);
  return {
    producer,
    sentBytes: () => oct[0]! + oct[1]! + oct[2]!,
    stop: () => clearInterval(interval),
    close: () => {
      clearInterval(interval);
      try {
        producer.close();
        srcTransport.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

// ── A viewer: ONE transport carrying 9 consumers (one per visible producer) ───
interface Viewer {
  consumers: msTypes.Consumer[];
  readForwarded: () => Promise<number>; // summed outbound-rtp byteCount across its 9
  close: () => void;
}

async function makeViewer(
  router: msTypes.Router,
  producers: Producer[],
  optimized: boolean,
): Promise<Viewer> {
  const sink = await router.createDirectTransport();
  // Create this viewer's 9 consumers concurrently (one channel round-trip each;
  // sequential awaits across hundreds of viewers were the 600s smoke timeout).
  const consumers = await Promise.all(
    producers.map(async (p, i) => {
      const c = await sink.consume({
        producerId: p.producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
      });
      // BASELINE: all high. OPTIMIZED: tile 0 = speaker high, 1..8 = thumbnail low.
      const high = !optimized || i === 0;
      await c.setPreferredLayers({ spatialLayer: high ? LAYER_HIGH : LAYER_LOW, temporalLayer: 0 });
      if (high) await c.requestKeyFrame();
      return c;
    }),
  );
  const readForwarded = async (): Promise<number> => {
    let sum = 0;
    for (const c of consumers) {
      const stats = await c.getStats();
      const o = stats.find((s) => s.type === 'outbound-rtp') as { byteCount?: number } | undefined;
      sum += o?.byteCount ?? 0;
    }
    return sum;
  };
  return {
    consumers,
    readForwarded,
    close: () => {
      try {
        for (const c of consumers) c.close();
        sink.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

interface Sample {
  m: number;
  forwardPaths: number; // P * M
  cpuCores: number; // worker CPU cores used over the window (PRIMARY ceiling signal)
  ruMaxRssMb: number; // worker RSS at end of window
  perViewerThroughput: number; // mean forwarded bytes/viewer over window (sampled)
  deliveryHealth: number; // perViewerThroughput / ref (1.0 = keeping up)
  injectionHealth: number; // injected bytes/window vs ref (M-INDEPENDENT if injector healthy)
}

const BATCH = 20; // viewers added per parallel batch (channel-friendly)
// Early-stop AT the one-core crossing (default 0.95): past ~1 core the worker is
// so loaded that channel ops (consume/getStats) crawl and the harness stalls —
// stopping at the crossing keeps the run bounded AND captures the knee we want.
const SAT_CORES = parseFloat(process.env['SAT_STOP_CORES'] ?? '0.95');
const SAT_HEALTH = parseFloat(process.env['SAT_STOP_HEALTH'] ?? '0.6'); // delivery collapsed

/** One INCREMENTAL pass for a policy: build 9 producers once, then GROW the
 *  viewer set through the ramp (never rebuilding lower-M viewers), measuring the
 *  worker CPU + sampled delivery at each checkpoint. Early-stops once clearly
 *  saturated so the hopeless tail is skipped. Logs each point as it lands. */
async function rampPass(optimized: boolean): Promise<Sample[]> {
  const label = optimized ? 'OPTIMIZED (1x:2 + 8x:0)' : 'BASELINE (all 9 x:2)';
  const router = await worker.createRouter({ mediaCodecs });
  const producers: Producer[] = [];
  for (let i = 0; i < PAGE_SIZE; i++) producers.push(await makeProducer(router, i));

  const viewers: Viewer[] = [];
  const samples: Sample[] = [];
  let ref = 0;
  let refInj = 0;
  for (const target of RAMP) {
    while (viewers.length < target) {
      const add = Math.min(BATCH, target - viewers.length);
      const batch = await Promise.all(
        Array.from({ length: add }, () => makeViewer(router, producers, optimized)),
      );
      viewers.push(...batch);
    }
    await sleep(SETTLE_MS);

    const sampleViewers = viewers.slice(0, Math.min(HEALTH_SAMPLE_VIEWERS, viewers.length));
    const cpu0 = await worker.getResourceUsage();
    const fwd0 = await Promise.all(sampleViewers.map((v) => v.readForwarded()));
    const inj0 = producers.reduce((s, p) => s + p.sentBytes(), 0);
    await sleep(WINDOW_MS);
    const inj1 = producers.reduce((s, p) => s + p.sentBytes(), 0);
    const fwd1 = await Promise.all(sampleViewers.map((v) => v.readForwarded()));
    const cpu1 = await worker.getResourceUsage();

    const cpuMs = cpu1.ru_utime - cpu0.ru_utime + (cpu1.ru_stime - cpu0.ru_stime);
    const cpuCores = Number((cpuMs / WINDOW_MS).toFixed(3));
    const deltas = fwd1.map((e, i) => e - fwd0[i]!);
    const perViewerThroughput = Math.round(deltas.reduce((s, x) => s + x, 0) / Math.max(1, deltas.length));
    const injectedDelta = inj1 - inj0;
    if (ref === 0) {
      ref = perViewerThroughput || 1;
      refInj = injectedDelta || 1;
    }
    const deliveryHealth = Number((perViewerThroughput / ref).toFixed(2));
    const injectionHealth = Number((injectedDelta / refInj).toFixed(2));

    const s: Sample = {
      m: target,
      forwardPaths: PAGE_SIZE * target,
      cpuCores,
      ruMaxRssMb: Number((cpu1.ru_maxrss / 1024).toFixed(1)),
      perViewerThroughput,
      deliveryHealth,
      injectionHealth,
    };
    samples.push(s);
    // eslint-disable-next-line no-console
    console.log(
      `[${label}] M=${String(target).padStart(4)} paths=${String(s.forwardPaths).padStart(5)} ` +
        `cpu=${cpuCores.toFixed(3)}cores rss=${s.ruMaxRssMb}MB perViewer=${perViewerThroughput}B ` +
        `deliveryHealth=${deliveryHealth.toFixed(2)} injectionHealth=${injectionHealth.toFixed(2)}`,
    );
    // Early-stop once CLEARLY past the ceiling. If delivery collapsed but the
    // injector ALSO sagged (injectionHealth low), the bound is partly harness
    // (single-box JS starvation) — still a real "this box can't push more", but
    // flagged so the brief reports it conservatively, not as a pure worker limit.
    if (cpuCores >= SAT_CORES || deliveryHealth < SAT_HEALTH) {
      // eslint-disable-next-line no-console
      console.log(
        `[${label}] early-stop at M=${target} ` +
          `(cpu=${cpuCores}cores deliveryHealth=${deliveryHealth} injectionHealth=${injectionHealth})`,
      );
      break;
    }
  }

  for (const v of viewers) v.close();
  for (const p of producers) p.close();
  router.close();
  return samples;
}

/** First M where the worker hits one core OR delivery falls below 0.9. The
 *  `bound` distinguishes a genuine worker-CPU limit from a partly-harness one:
 *  if delivery sagged WHILE the injector also sagged (injectionHealth < 0.9) the
 *  single box couldn't FEED fast enough, so the number is conservative (the real
 *  worker could forward more if fed) — reported as 'box-bound', not 'worker-CPU'. */
function knee(
  samples: Sample[],
): { m: number; reason: string; bound: 'worker-cpu' | 'delivery' | 'box-bound' } | null {
  for (const s of samples) {
    if (s.cpuCores >= 1.0) return { m: s.m, reason: `cpuCores=${s.cpuCores} >= 1 core`, bound: 'worker-cpu' };
    if (s.deliveryHealth < 0.9) {
      const bound = s.injectionHealth < 0.9 ? 'box-bound' : 'delivery';
      return {
        m: s.m,
        reason: `deliveryHealth=${s.deliveryHealth.toFixed(2)} < 0.9 (injectionHealth=${s.injectionHealth.toFixed(2)})`,
        bound,
      };
    }
  }
  return null; // never saturated within the ramp
}

describe('W5 M1 — single-worker forwarding-ceiling bench (REAL mediasoup, advisor-gate-2)', () => {
  it(
    'ramps viewers per page-9 grid and locates the one-worker CPU/delivery knee',
    async () => {
      // OPTIMIZED first (the M1 mechanism), then BASELINE (no-select contrast).
      const optimizedCurve = await rampPass(/*optimized*/ true);
      const baselineCurve = await rampPass(/*optimized*/ false);

      const optKnee = knee(optimizedCurve);
      const baseKnee = knee(baselineCurve);
      const lastRamp = RAMP[RAMP.length - 1];
      // eslint-disable-next-line no-console
      console.log(
        `\n[knee] OPTIMIZED: ${optKnee ? `M=${optKnee.m} [${optKnee.bound}] ${optKnee.reason}` : `NOT saturated up to M=${optimizedCurve[optimizedCurve.length - 1]?.m ?? lastRamp}`}` +
          `\n[knee] BASELINE:  ${baseKnee ? `M=${baseKnee.m} [${baseKnee.bound}] ${baseKnee.reason}` : `NOT saturated up to M=${baselineCurve[baselineCurve.length - 1]?.m ?? lastRamp}`}`,
      );

      const sidecar = {
        bench: 'single-worker-forwarding-ceiling',
        phase: 'W5 M1 advisor-gate-2 follow-up',
        mediasoupVersion: mediasoup.version,
        numWorkers: 1,
        pageSize: PAGE_SIZE,
        windowMs: WINDOW_MS,
        settleMs: SETTLE_MS,
        ramp: RAMP,
        optimizedCurve,
        baselineCurve,
        optimizedKnee: optKnee,
        baselineKnee: baseKnee,
        honest_note:
          'ONE mediasoup Worker (==one core) forwarding ceiling. DirectTransport SKIPS SRTP -> measured CPU is OPTIMISTIC, real WebRTC ceiling is LOWER. Single box, synthetic RTP, no WAN/jitter. Multi-worker/multi-node cascade (DA-5) NOT built; extrapolating past one worker is a documented assumption, not a measurement. Exploratory curve, not a pass/fail gate.',
      };
      const sidecarPath = resolve(
        process.cwd(),
        '.evidence/verification/transmission-m1-single-worker-saturation.json',
      );
      mkdirSync(dirname(sidecarPath), { recursive: true });
      writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(`[saturation] sidecar -> ${sidecarPath}`);

      // ── Sanity guards only (EXPLORATORY bench, NOT a hard pass/fail gate) ─────
      // Real media flowed and the injector was healthy at the smallest M (no
      // dead-pipe false read, reference point trustworthy).
      expect(optimizedCurve[0]!.perViewerThroughput).toBeGreaterThan(0);
      expect(baselineCurve[0]!.perViewerThroughput).toBeGreaterThan(0);
      expect(optimizedCurve[0]!.deliveryHealth).toBe(1);
      expect(baselineCurve[0]!.deliveryHealth).toBe(1);
      // The worker did real forwarding work somewhere on the ramp (load registered
      // on the clean subprocess CPU read — not a no-op measurement).
      const peakCpu = Math.max(...optimizedCurve.map((s) => s.cpuCores), ...baselineCurve.map((s) => s.cpuCores));
      expect(peakCpu).toBeGreaterThan(0.1);
      // NOTE: we deliberately do NOT assert OPTIMIZED CPU < BASELINE CPU — the
      // smoke run showed they are ~EQUAL, because forwarding CPU tracks PACKET
      // count (both layers share the packet rate), not payload bytes. Layer-select
      // saves downlink BANDWIDTH; PAGINATION+PAUSE (fewer paths) is what saves
      // relay CPU. That finding is the point of this bench, not a failure.
    },
    600_000,
  );
});
