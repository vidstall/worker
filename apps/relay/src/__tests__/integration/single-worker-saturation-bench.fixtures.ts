/**
 * Shared setup/fixtures for single-worker-saturation-bench.integration.test.ts.
 *
 * W5 M1 — SINGLE-WORKER forwarding-CEILING bench (advisor-gate-2 follow-up).
 * Full model/signals/honesty-bounds narrative lives in the sibling test file's
 * header comment (kept there since it documents the assertions, not this
 * setup module). Summary: models a P=9 (1 speaker + 8 thumbnails) page fanned
 * out to M viewers, ramps M, and finds the worker-CPU/delivery knee under
 * BASELINE (all consumers high layer) vs OPTIMIZED (M1 page-9 layer-select)
 * policies, across three capacity-calibration modes (video-only /
 * audio-only-N / mixed-30-70). EXPLORATORY + SLOW — SKIPPED unless
 * SAT_BENCH=1.
 *
 * Run: SAT_BENCH=1 [SAT_RAMP=10,20,30] pnpm exec vitest run \
 *        --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/single-worker-saturation-bench.integration.test.ts
 */

import { beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
// REQ-RMS-001 — reuse the Opus injection primitive from the de-risk spike (the only Opus
// source in the repo). The spike's own `it` stays `it.skip` unless RMS_BENCH=1, so importing
// it here under the rms-bench config does not run the spike test twice.
import { makeOpusProducer } from './audio-spike.integration.test.js';

// -- VP8-only codec (mirrors mediasoup-manager.ts:34 + the P9 gate) -----------
export const VP8_PT = 101;
// REQ-RMS-001 — add Opus so a single router serves BOTH video + audio producers (3-mode bench).
export const OPUS_PT = 100;
export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: OPUS_PT },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

export const LAYER_LOW = 0;
export const LAYER_HIGH = 2;
export const PAGE_SIZE = 9; // LOCKED M1 default: 1 speaker + 8 thumbnails per viewer

/** Per-packet simulcast ladder bytes [low, mid, high] (mirrors the P9 gate ~1:7:18). */
export const LADDER_BYTES = [60, 400, 1100] as const;

// Run ONLY when explicitly enabled (default suite skips this slow exploratory bench).
export const RUN_SATURATION = process.env['SAT_BENCH'] === '1';

// ── Ramp + windows. Default is a SMALL bounded ramp that always completes; deep
// curves are opt-in via SAT_RAMP="10,25,50,100,200" (mind the over-capacity stall). ─
export const RAMP: number[] = (process.env['SAT_RAMP'] ?? '10,20,30')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
// Settle clears the creation burst + simulcast layer-switch transient; a LONG
// window averages out single-box setInterval timer jitter (the dominant noise —
// injectionHealth swung 0.79-1.35 at a 1.5s window). Env-tunable.
export const SETTLE_MS = parseInt(process.env['SAT_SETTLE_MS'] ?? '2500', 10);
export const WINDOW_MS = parseInt(process.env['SAT_WINDOW_MS'] ?? '4000', 10);
export const HEALTH_SAMPLE_VIEWERS = 5; // sample first K viewers for per-consumer health

// ── RTP/RTCP builders (verbatim semantics from the P9 gate's makeVp8Rtp) ──────

export function makeVp8Rtp(
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

export function makeRtcpSenderReport(
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

export interface Sample {
  m: number;
  forwardPaths: number; // P * M (video)
  audioPaths: number; // audio fan-out paths counted in this mode (0 in video-only)
  cpuCores: number; // worker CPU cores used over the window (PRIMARY ceiling signal)
  ruMaxRssMb: number; // worker RSS at end of window
  perViewerThroughput: number; // mean forwarded bytes/viewer over window (sampled)
  deliveryHealth: number; // perViewerThroughput / ref (1.0 = keeping up)
  injectionHealth: number; // injected bytes/window vs ref (M-INDEPENDENT if injector healthy)
}

// REQ-RMS-001 — the three named capacity-calibration modes (Step 2.4).
export type AudioMode = 'video-only' | 'audio-only-N' | 'mixed-30-70';
export interface RampMode {
  optimized: boolean;
  audio: AudioMode;
}

// ── An audio-only viewer: ONE transport carrying one consumer per audio producer ──
interface AudioViewer {
  consumers: msTypes.Consumer[];
  readForwarded: () => Promise<number>; // summed outbound-rtp byteCount across its audio consumers
  close: () => void;
}

async function makeAudioViewer(
  router: msTypes.Router,
  audioProducers: Array<Awaited<ReturnType<typeof makeOpusProducer>>>,
): Promise<AudioViewer> {
  const sink = await router.createDirectTransport();
  const consumers = await Promise.all(
    audioProducers.map(async (p) =>
      sink.consume({
        producerId: p.producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
      }),
    ),
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

const BATCH = 20; // viewers added per parallel batch (channel-friendly)
// Early-stop AT the one-core crossing (default 0.95): past ~1 core the worker is
// so loaded that channel ops (consume/getStats) crawl and the harness stalls —
// stopping at the crossing keeps the run bounded AND captures the knee we want.
const SAT_CORES = parseFloat(process.env['SAT_STOP_CORES'] ?? '0.95');
const SAT_HEALTH = parseFloat(process.env['SAT_STOP_HEALTH'] ?? '0.6'); // delivery collapsed

/** One INCREMENTAL pass for a mode: build the producers once (video and/or audio
 *  per the mode), then GROW the viewer set through the ramp (never rebuilding
 *  lower-M viewers), measuring the worker CPU + sampled delivery at each
 *  checkpoint. Early-stops once clearly saturated so the hopeless tail is
 *  skipped. Logs each point as it lands.
 *
 *  Modes (REQ-RMS-001):
 *   - video-only : PAGE_SIZE video producers, video viewers, audioPaths=0 (this is
 *                  the curve C_worker is read from — the per-room ceiling).
 *   - audio-only-N: NO video; N=RAMP[last] audio producers; each "viewer" consumes
 *                  ALL N audio producers (O(N^2) fan). audioPaths = N * M.
 *   - mixed-30-70: PAGE_SIZE video producers AND up to 70 audio producers; each
 *                  viewer consumes the 9 video AND every audio producer.
 *                  audioPaths = audioProducers.length * M. */
// The mixed/audio modes fan EVERY viewer out to EVERY audio producer (O(N^2)).
// On a single dev box that consumer count makes viewer-creation channel round-trips
// the bottleneck (NOT worker forwarding CPU), so these modes run on their OWN,
// smaller ramp (env-tunable) and the mixed-mode audio fan is capped — keeping the
// run inside the 600s window while the video-only ramp (the curve C_worker is read
// from) goes as deep as SAT_RAMP. Plan default mixed audio fan = 70.
const MIXED_AUDIO_COUNT = parseInt(process.env['RMS_MIXED_AUDIO'] ?? '70', 10);
const AUDIO_RAMP: number[] = (process.env['RMS_AUDIO_RAMP'] ?? RAMP.join(','))
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

export async function rampPass(mode: RampMode): Promise<Sample[]> {
  const { optimized, audio } = mode;
  // Video-only walks the full SAT_RAMP (find the worker knee); the heavier audio
  // fan-out modes walk the smaller AUDIO_RAMP so the run stays bounded.
  const ramp = audio === 'video-only' ? RAMP : AUDIO_RAMP;
  const label =
    audio === 'video-only'
      ? optimized
        ? 'video-only OPTIMIZED (1x:2 + 8x:0)'
        : 'video-only BASELINE (all 9 x:2)'
      : audio === 'audio-only-N'
        ? 'audio-only-N (O(N^2) fan)'
        : 'mixed-30-70 (9 video + 70 audio)';
  const router = await worker.createRouter({ mediaCodecs });

  // Video producers: present in every mode EXCEPT audio-only-N.
  const producers: Producer[] = [];
  if (audio !== 'audio-only-N') {
    for (let i = 0; i < PAGE_SIZE; i++) producers.push(await makeProducer(router, i));
  }

  // Audio producers: 0 (video-only), N=ramp[last] (audio-only-N, the O(N^2) fan),
  // MIXED_AUDIO_COUNT (mixed-30-70, plan default 70).
  const audioProducers: Array<Awaited<ReturnType<typeof makeOpusProducer>>> = [];
  const audioCount =
    audio === 'video-only' ? 0 : audio === 'audio-only-N' ? ramp[ramp.length - 1]! : MIXED_AUDIO_COUNT;
  for (let i = 0; i < audioCount; i++) audioProducers.push(await makeOpusProducer(router, i));

  // A viewer in any mode exposes the same {readForwarded, close} surface so the
  // sampling/early-stop machinery below is mode-agnostic.
  interface AnyViewer {
    readForwarded: () => Promise<number>;
    close: () => void;
  }
  const makeViewerForMode = async (): Promise<AnyViewer> => {
    if (audio === 'audio-only-N') return makeAudioViewer(router, audioProducers);
    const v = await makeViewer(router, producers, optimized);
    if (audio === 'video-only') return v;
    // mixed-30-70: a video viewer PLUS an audio companion consuming every audio producer.
    const av = await makeAudioViewer(router, audioProducers);
    return {
      readForwarded: async () => (await v.readForwarded()) + (await av.readForwarded()),
      close: () => {
        v.close();
        av.close();
      },
    };
  };

  const viewers: AnyViewer[] = [];
  const samples: Sample[] = [];
  let ref = 0;
  let refInj = 0;
  for (const target of ramp) {
    while (viewers.length < target) {
      const add = Math.min(BATCH, target - viewers.length);
      const batch = await Promise.all(Array.from({ length: add }, () => makeViewerForMode()));
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
    // Audio-only mode has no VIDEO injector (producers.length===0 -> injectedDelta 0);
    // its delivery is gated by audio forwarding (perViewerThroughput), so peg
    // injectionHealth to 1 there to avoid a divide-by-refInj=1 false starvation read.
    const injectionHealth =
      producers.length === 0 ? 1 : Number((injectedDelta / refInj).toFixed(2));

    const s: Sample = {
      m: target,
      forwardPaths: producers.length * target,
      audioPaths: audioProducers.length * target,
      cpuCores,
      ruMaxRssMb: Number((cpu1.ru_maxrss / 1024).toFixed(1)),
      perViewerThroughput,
      deliveryHealth,
      injectionHealth,
    };
    samples.push(s);
    // eslint-disable-next-line no-console
    console.log(
      `[${label}] M=${String(target).padStart(4)} vpaths=${String(s.forwardPaths).padStart(5)} ` +
        `apaths=${String(s.audioPaths).padStart(5)} cpu=${cpuCores.toFixed(3)}cores rss=${s.ruMaxRssMb}MB ` +
        `perViewer=${perViewerThroughput}B deliveryHealth=${deliveryHealth.toFixed(2)} injectionHealth=${injectionHealth.toFixed(2)}`,
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
  for (const ap of audioProducers) ap.close();
  router.close();
  return samples;
}

/** First M where the worker hits one core OR delivery falls below 0.9. The
 *  `bound` distinguishes a genuine worker-CPU limit from a partly-harness one:
 *  if delivery sagged WHILE the injector also sagged (injectionHealth < 0.9) the
 *  single box couldn't FEED fast enough, so the number is conservative (the real
 *  worker could forward more if fed) — reported as 'box-bound', not 'worker-CPU'. */
export function knee(
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
