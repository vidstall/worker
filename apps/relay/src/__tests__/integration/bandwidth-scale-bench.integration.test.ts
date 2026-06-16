/**
 * W5 M1 Phase 9 — SCALED bandwidth bench HARD-GATE (REQ-MCS-006).
 *
 * THE decisive milestone proof: on REAL mediasoup, the M1 hybrid layer-select +
 * off-page-pause mechanism forwards >=3x FEWER aggregate RTP bytes at N=12 tiles
 * than today's no-select baseline (every tile high).
 *
 *   HARD-ASSERT (N=12):  baselineTotalBytes / optimizedTotalBytes >= 3.0
 *
 * Built directly ON the P1 spike (simulcast-layer-bench-spike.integration.test.ts),
 * which de-risked the ONE precondition this bench multiplies across N tiles:
 * requesting spatialLayer:0 actually drops forwarded outbound-rtp bytes vs
 * spatialLayer:2 (spike single-tile ratio ~8.6x). This file scales that to a
 * realistic grid and applies the LOCKED M1 page-9 selection policy.
 *
 * ── Model ───────────────────────────────────────────────────────────────────
 * N tiles == N remote video producers. Each tile = a 3-spatial-layer VP8
 * simulcast producer on its own DirectTransport (distinct SSRC base per tile so
 * they never collide), consumed through its own UNPAUSED DirectTransport
 * consumer (one consumer per producer = one "tile"). Per the P1 finding we MUST
 * inject, on EVERY producer's three layer SSRCs: (a) a keyframe every 10th frame
 * and (b) an RTCP Sender Report every ~100ms — without per-layer keyframes +
 * per-layer SRs the SimulcastConsumer pins to spatialLayer 0 and a layer:2
 * request silently does nothing => false baseline (G-MCS-1).
 *
 * ── Two scenarios at N=12 ─────────────────────────────────────────────────────
 *   BASELINE  (today's no-select): ALL 12 consumers setPreferredLayers(:2).
 *   OPTIMIZED (M1 mechanism, page-size 9):
 *     - 1 active-speaker consumer at :2
 *     - 8 on-page thumbnails at :0
 *     - 3 off-page tiles PAUSED (consumer.pause() => ~0 forwarded media bytes)
 * Sum forwarded outbound-rtp byteCount DELTA across all 12 consumers over an
 * identical ~800ms window (settled ~1000ms after the layer/pause changes).
 *
 * ── Honesty bounds (mirrors relay-overlap W1-W7 mechanism-floor discipline) ──
 * This is a RELAY-SIDE mechanism floor on a SYNTHETIC DirectTransport source —
 * NOT WAN glass-to-glass, NOT a browser getStats().inboundRtp. The forwarded
 * outbound-rtp byteCount is the ground truth (literally the bytes mediasoup put
 * on the consumer's wire). Browser getStats validation is DISCLOSED-SEPARATE,
 * not this gate. consumer.currentLayers is a lagging JS getter (the spike showed
 * it reads 0 even while the high layer is demonstrably forwarded) -> diagnostics
 * only, never an assertion.
 *
 * Requirements touched: REQ-MCS-006 (scaled bandwidth hard-gate at N=12).
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/bandwidth-scale-bench.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// -- VP8-only codec (mirrors mediasoup-manager.ts:34 + the P1 spike) ----------

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

// Layer convention (CONTRACTS.md C1): spatialLayer:0=low/thumbnail, :1=mid,
// :2=high/active-speaker. encodings[] ordered low->high.
const LAYER_LOW = 0;
const LAYER_MID = 1;
const LAYER_HIGH = 2;

/** Realistic simulcast ladder per packet (mirrors the P1 spike asymmetry, ~1:7:18). */
const LADDER_BYTES = [60, 400, 1100] as const; // [low, mid, high]

// ── RED hook ────────────────────────────────────────────────────────────────
// BENCH_FORCE_OPTIMIZED_HIGH=1 forces the OPTIMIZED scenario to ALSO select
// spatialLayer:2 on every visible tile and SKIP the off-page pause => the
// optimized total ~= baseline total => ratio ~1.0 < 3.0 => the hard-gate FAILS.
// This is the documented RED that proves GREEN is the mechanism, not a coincidence
// (mirrors the spike's SPIKE_DISABLE_RTCP_SR=1 red hook).
const FORCE_OPTIMIZED_HIGH = process.env['BENCH_FORCE_OPTIMIZED_HIGH'] === '1';

/**
 * Build a well-formed VP8 RTP packet (verbatim semantics from the P1 spike's
 * makeVp8Rtp): 12-byte RTP header (marker=1), VP8 payload descriptor with
 * X=1/S=1/I=1 + 15-bit PictureID, and a VP8 payload header that is a real
 * keyframe signature (P-bit=0 + 0x9d 0x01 0x2a + w/h) on keyframes so the
 * SimulcastConsumer can switch to that layer (no encoder to answer a PLI on a
 * synthetic source), inter-frame (P-bit=1) otherwise. Content sized per layer.
 */
function makeVp8Rtp(
  ssrc: number,
  seq: number,
  ts: number,
  pictureId: number,
  payloadBytes: number,
  keyframe: boolean,
): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2
  header[1] = (VP8_PT & 0x7f) | 0x80; // marker=1 + PT
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  const desc = Buffer.from([
    0x90, // X=1, S=1
    0x80, // I=1 (PictureID present)
    0x80 | ((pictureId >> 8) & 0x7f), // M=1 + PID high 7 bits
    pictureId & 0xff, // PID low 8 bits
  ]);

  let vp8PayloadHeader: Buffer;
  if (keyframe) {
    vp8PayloadHeader = Buffer.from([
      0x10, 0x00, 0x00, // frame tag: P-bit=0 => keyframe
      0x9d, 0x01, 0x2a, // VP8 keyframe start code
      0x80, 0x02, // width 640
      0xe0, 0x01, // height 480
    ]);
  } else {
    vp8PayloadHeader = Buffer.from([0x11, 0x00, 0x00]); // P-bit=1 => interframe
  }
  const content = Buffer.alloc(Math.max(0, payloadBytes - vp8PayloadHeader.length), 0xab);
  return Buffer.concat([header, desc, vp8PayloadHeader, content]);
}

/** Minimal RTCP Sender Report (PT=200) — verbatim semantics from the P1 spike.
 *  Required so each layer's producer stream has a non-zero GetSenderReportNtpMs(),
 *  the precondition CanSwitchToSpatialLayer() demands to leave layer 0. */
function makeRtcpSenderReport(
  ssrc: number,
  rtpTimestamp: number,
  packetCount: number,
  octetCount: number,
): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80;
  buf[1] = 200; // SR
  buf.writeUInt16BE(6, 2);
  buf.writeUInt32BE(ssrc >>> 0, 4);
  const nowMs = Date.now();
  const ntpSec = Math.floor(nowMs / 1000) + 2208988800;
  const ntpFrac = Math.floor(((nowMs % 1000) / 1000) * 0x1_0000_0000);
  buf.writeUInt32BE(ntpSec >>> 0, 8);
  buf.writeUInt32BE(ntpFrac >>> 0, 12);
  buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
  buf.writeUInt32BE(packetCount >>> 0, 20);
  buf.writeUInt32BE(octetCount >>> 0, 24);
  return buf;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── A single tile: simulcast producer + its own unpaused consumer ────────────

interface Tile {
  index: number;
  producer: msTypes.Producer;
  consumer: msTypes.Consumer;
  /** cumulative forwarded byteCount reader (outbound-rtp = bytes on the wire) */
  readForwarded: () => Promise<number>;
  stop: () => void;
  close: () => void;
}

let worker: msTypes.Worker;
let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => {
  worker?.close();
});

/** Build one tile: a 3-layer simulcast producer (distinct SSRC base per tile) +
 *  an UNPAUSED consumer, with a per-SSRC keyframe + RTCP-SR injector running. */
async function makeTile(index: number): Promise<Tile> {
  // Distinct, non-overlapping SSRC base per tile (3 SSRCs each).
  const base = 0x1000_0000 + index * 0x10;
  const ssrcs = [base, base + 1, base + 2] as const; // low, mid, high

  const rtpParameters: msTypes.RtpParameters = {
    codecs: [
      {
        mimeType: 'video/VP8',
        payloadType: VP8_PT,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [],
      },
    ],
    encodings: [
      { ssrc: ssrcs[LAYER_LOW], scalabilityMode: 'L1T1' },
      { ssrc: ssrcs[LAYER_MID], scalabilityMode: 'L1T1' },
      { ssrc: ssrcs[LAYER_HIGH], scalabilityMode: 'L1T1' },
    ],
  };

  const srcTransport = await router.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'video', rtpParameters });

  const seqs = [0, 0, 0];
  const pics = [0, 0, 0];
  const pktCount = [0, 0, 0];
  const octetCount = [0, 0, 0];
  let ts = 0;
  let frame = 0;
  const sendAll = (): void => {
    const keyframe = frame % 10 === 0; // keyframe every 10th frame (~100ms)
    for (let layer = 0; layer < 3; layer++) {
      const pkt = makeVp8Rtp(
        ssrcs[layer]!,
        seqs[layer]!++,
        ts,
        pics[layer]!++ & 0x7fff,
        LADDER_BYTES[layer]!,
        keyframe,
      );
      producer.send(pkt);
      pktCount[layer]! += 1;
      octetCount[layer]! += LADDER_BYTES[layer]!;
    }
    // RTCP SR per SSRC every ~100ms (the layer-switch precondition).
    if (frame % 10 === 0) {
      for (let layer = 0; layer < 3; layer++) {
        srcTransport.sendRtcp(
          makeRtcpSenderReport(ssrcs[layer]!, ts, pktCount[layer]!, octetCount[layer]!),
        );
      }
    }
    ts += 3000; // ~33ms @ 90kHz
    frame++;
  };
  const interval = setInterval(sendAll, 10);

  const sinkTransport = await router.createDirectTransport();
  const consumer = await sinkTransport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false, // UNPAUSED bench sink — RTP must flow to be counted
  });

  const readForwarded = async (): Promise<number> => {
    const stats = await consumer.getStats();
    const outbound = stats.find((s) => s.type === 'outbound-rtp') as
      | { byteCount?: number }
      | undefined;
    return outbound?.byteCount ?? 0;
  };

  return {
    index,
    producer,
    consumer,
    readForwarded,
    stop: () => clearInterval(interval),
    close: () => {
      clearInterval(interval);
      try {
        consumer.close();
        producer.close();
        srcTransport.close();
        sinkTransport.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

const SETTLE_MS = 1200; // settle after layer/pause changes (spike used 1000)
const WINDOW_MS = 800; // identical measurement window for both scenarios

/** Sum the forwarded outbound-rtp DELTA across all tiles over WINDOW_MS, after
 *  letting the selection settle for SETTLE_MS. Returns total + per-tile deltas. */
async function measureScenario(
  tiles: Tile[],
): Promise<{ total: number; perTile: number[] }> {
  await sleep(SETTLE_MS);
  const starts = await Promise.all(tiles.map((t) => t.readForwarded()));
  await sleep(WINDOW_MS);
  const ends = await Promise.all(tiles.map((t) => t.readForwarded()));
  const perTile = ends.map((e, i) => e - starts[i]!);
  const total = perTile.reduce((s, v) => s + v, 0);
  return { total, perTile };
}

const PAGE_SIZE = 9; // LOCKED M1 default: 1 speaker + 8 thumbnails visible/page

/** Apply the OPTIMIZED M1 page-9 policy to a fresh grid:
 *   tile 0 = active speaker -> :2
 *   tiles 1..(PAGE_SIZE-1) = on-page thumbnails -> :0
 *   tiles PAGE_SIZE.. = off-page -> paused (~0 forwarded media)
 * Under the RED hook every visible tile is forced to :2 and nothing is paused. */
async function applyOptimized(tiles: Tile[]): Promise<void> {
  for (const t of tiles) {
    if (t.index === 0) {
      await t.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
      await t.consumer.requestKeyFrame();
    } else if (t.index < PAGE_SIZE) {
      if (FORCE_OPTIMIZED_HIGH) {
        await t.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
        await t.consumer.requestKeyFrame();
      } else {
        await t.consumer.setPreferredLayers({ spatialLayer: LAYER_LOW, temporalLayer: 0 });
      }
    } else {
      // off-page
      if (FORCE_OPTIMIZED_HIGH) {
        await t.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
        await t.consumer.requestKeyFrame();
      } else {
        await t.consumer.pause(); // ~0 forwarded media bytes
      }
    }
  }
}

/** Apply the BASELINE no-select policy: every tile at high (:2), none paused. */
async function applyBaseline(tiles: Tile[]): Promise<void> {
  for (const t of tiles) {
    await t.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
    await t.consumer.requestKeyFrame();
  }
}

interface ScaleResult {
  n: number;
  pageSize: number;
  baselineBytes: number;
  optimizedBytes: number;
  ratio: number;
  baselinePerTile: number[];
  optimizedPerTile: number[];
  speakerTileBytes: number;
  thumbnailTileBytes: number; // a representative on-page thumbnail
  offPagePausedBytes: number; // a representative off-page paused tile
  windowMs: number;
  settleMs: number;
}

/** Run both scenarios at scale N with page-size 9 and return measured numbers. */
async function runScale(n: number): Promise<ScaleResult> {
  const tiles: Tile[] = [];
  for (let i = 0; i < n; i++) tiles.push(await makeTile(i));

  // BASELINE first (every tile high), then OPTIMIZED on the SAME grid.
  await applyBaseline(tiles);
  const baseline = await measureScenario(tiles);

  await applyOptimized(tiles);
  const optimized = await measureScenario(tiles);

  for (const t of tiles) t.close();

  const ratio = optimized.total > 0 ? baseline.total / optimized.total : Infinity;
  const offPageIdx = n > PAGE_SIZE ? PAGE_SIZE : n - 1; // an off-page tile if one exists
  return {
    n,
    pageSize: PAGE_SIZE,
    baselineBytes: baseline.total,
    optimizedBytes: optimized.total,
    ratio,
    baselinePerTile: baseline.perTile,
    optimizedPerTile: optimized.perTile,
    speakerTileBytes: optimized.perTile[0]!,
    thumbnailTileBytes: optimized.perTile[1]!, // tile 1 is always an on-page thumbnail
    offPagePausedBytes: optimized.perTile[offPageIdx]!,
    windowMs: WINDOW_MS,
    settleMs: SETTLE_MS,
  };
}

describe('W5 M1 P9 — scaled bandwidth bench (REAL mediasoup, REQ-MCS-006)', () => {
  it(
    'HARD-GATE: baseline/optimized forwarded-byte ratio >= 3.0 at N=12 (page-size 9)',
    async () => {
      const r = await runScale(12);

      // eslint-disable-next-line no-console
      console.log(
        `[bench REQ-MCS-006 N=12] forwarded outbound-rtp over ${r.windowMs}ms window: ` +
          `baseline(all :2)=${r.baselineBytes} bytes  ` +
          `optimized(1x:2 + 8x:0 + 3 paused)=${r.optimizedBytes} bytes  ` +
          `ratio=${r.ratio.toFixed(2)}  ` +
          `[speaker=${r.speakerTileBytes} thumb=${r.thumbnailTileBytes} offpage-paused=${r.offPagePausedBytes}]` +
          (FORCE_OPTIMIZED_HIGH ? '  [RED HOOK: BENCH_FORCE_OPTIMIZED_HIGH=1]' : ''),
      );

      // -- sidecar JSON (dated; green-only write, see guard below) --------------
      const sidecar = {
        req: 'REQ-MCS-006',
        phase: 'W5 M1 P9',
        title: 'scaled bandwidth bench >=3x@N=12 hard-gate',
        date: '2026-06-16',
        mediasoupVersion: '3.19.17',
        redHook: FORCE_OPTIMIZED_HIGH,
        n12: {
          n: r.n,
          pageSize: r.pageSize,
          baselineBytes: r.baselineBytes,
          optimizedBytes: r.optimizedBytes,
          ratio: Number(r.ratio.toFixed(4)),
          speakerTileBytes: r.speakerTileBytes,
          representativeThumbnailBytes: r.thumbnailTileBytes,
          representativeOffPagePausedBytes: r.offPagePausedBytes,
          baselinePerTile: r.baselinePerTile,
          optimizedPerTile: r.optimizedPerTile,
          windowMs: r.windowMs,
          settleMs: r.settleMs,
        },
        honest_note:
          'Relay-side mechanism floor on a synthetic DirectTransport source. Forwarded outbound-rtp byteCount = bytes mediasoup placed on the consumer wire (ground truth). NOT WAN glass-to-glass, NOT browser getStats().inboundRtp (disclosed-separate). consumer.currentLayers is a lagging getter -> diagnostics only.',
      };
      const sidecarPath = resolve(
        process.cwd(),
        '.evidence/verification/transmission-m1-bench-2026-06-16.json',
      );
      mkdirSync(dirname(sidecarPath), { recursive: true });
      // Append the N=25 demo into the same sidecar below, so write after the demo.

      // ===== HARD-GATE assertions (N=12) =====================================
      // GUARD: both windows carried real media (no dead-pipe false-green).
      expect(r.baselineBytes).toBeGreaterThan(0);
      expect(r.optimizedBytes).toBeGreaterThan(0);
      // GUARD: the off-page PAUSED tile forwarded ~0 media — well below an on-page
      // thumbnail (proves pause() actually stopped the wire, not a coincidence).
      if (!FORCE_OPTIMIZED_HIGH) {
        expect(r.offPagePausedBytes).toBeLessThan(r.thumbnailTileBytes);
      }
      // GUARD: the speaker tile (high) forwarded materially more than a thumbnail
      // (low) — the layer-select actually took effect across the grid.
      if (!FORCE_OPTIMIZED_HIGH) {
        expect(r.speakerTileBytes).toBeGreaterThan(r.thumbnailTileBytes);
      }

      // ===== N=25 stretch demo (3 pages, same page-9 policy) =================
      const demo = await runScale(25);
      // eslint-disable-next-line no-console
      console.log(
        `[bench REQ-MCS-006 N=25 DEMO] baseline(all :2)=${demo.baselineBytes} bytes  ` +
          `optimized(1x:2 + 8x:0 + 16 paused)=${demo.optimizedBytes} bytes  ` +
          `ratio=${demo.ratio.toFixed(2)}`,
      );

      // write the combined sidecar (N=12 gate + N=25 demo) now that both ran.
      // SELF-CLOBBER GUARD (relay-overlap N1 lesson): a RED-hook run
      // (BENCH_FORCE_OPTIMIZED_HIGH=1) deliberately produces a FAILING ratio; it
      // must NOT overwrite the authoritative GREEN gate sidecar at the same dated
      // path. The RED run still logs to console + the .evidence/tdd RED log for the
      // causality proof, but the committed sidecar always holds the green numbers.
      if (!FORCE_OPTIMIZED_HIGH) {
        writeFileSync(
          sidecarPath,
          JSON.stringify(
            {
              ...sidecar,
              n25Demo: {
                n: demo.n,
                pageSize: demo.pageSize,
                baselineBytes: demo.baselineBytes,
                optimizedBytes: demo.optimizedBytes,
                ratio: Number(demo.ratio.toFixed(4)),
                windowMs: demo.windowMs,
                settleMs: demo.settleMs,
              },
            },
            null,
            2,
          ),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(`[bench] sidecar -> ${sidecarPath}`);
      }

      // THE HARD-GATE (REQ-MCS-006): >=3x aggregate byte reduction at N=12.
      expect(r.ratio).toBeGreaterThanOrEqual(3.0);
      // N=25 demo: softer assert (demo evidence; the gate is N=12). The mechanism
      // only gets STRONGER as N grows (more off-page paused tiles), so it must at
      // least also clear 3x.
      expect(demo.ratio).toBeGreaterThanOrEqual(3.0);
    },
    180_000,
  );
});
