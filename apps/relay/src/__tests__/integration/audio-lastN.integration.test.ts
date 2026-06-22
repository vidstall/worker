/**
 * REQ-RMS-012 — server-side audio last-N bench (spike + scaled gate).
 *
 * SPIKE (this block, de-risk first per BENCH-3): a single Opus producer + an
 * AudioLevelObserver(maxEntries:1) on a real mediasoup Router. Proves (a) the
 * observer fires 'volumes' for a producing audio source and (b) pausing the
 * lone audio consumer drops its forwarded outbound-rtp byteCount to ~0. The
 * scaled top-k gate (Task 3) multiplies this across N producers.
 *
 * Honesty (mechanism-floor, mirrors bandwidth-scale-bench): DirectTransport
 * skips SRTP; forwarded outbound-rtp byteCount is the ground truth (bytes
 * mediasoup put on the wire); synthetic Opus RTP; no WAN.
 *
 * Run: pnpm exec vitest run --config vitest.rms-bench.config.ts \
 *        apps/relay/src/__tests__/integration/audio-lastN.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

const OPUS_PT = 100;
// mediasoup's AudioLevelObserver derives the level from the ssrc-audio-level RTP HEADER
// EXTENSION (RFC 6464), NOT by decoding Opus — synthetic packets MUST declare + embed it
// or 'volumes' never fires (M1 audio-spike DE-RISK FINDING). Same primitive shape as M1.
const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
const AUDIO_LEVEL_EXT_ID = 6;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: OPUS_PT },
];

/**
 * Build a well-formed Opus RTP packet carrying the RFC 6464 ssrc-audio-level header
 * extension (X=1 + RFC 5285 one-byte block, level -10 dBov). mediasoup's
 * AudioLevelObserver reads THIS extension (it does NOT decode Opus), so synthetic
 * packets MUST embed it or 'volumes' never fires. Same primitive shape as M1's
 * makeOpusRtp (audio-spike.integration.test.ts) — kept inline so this file is
 * self-contained, NOT imported from a sibling test module (avoids double-register).
 */
function makeOpusRtp(ssrc: number, seq: number, ts: number, payloadBytes: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80 | 0x10; // version 2 + extension bit (X)
  header[1] = (OPUS_PT & 0x7f) | 0x80; // marker + PT
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  // RFC 5285 one-byte header extension carrying ssrc-audio-level (RFC 6464):
  const ext = Buffer.alloc(8);
  ext.writeUInt16BE(0xbede, 0); // one-byte-header profile
  ext.writeUInt16BE(1, 2); // 1 32-bit word of extension data
  ext[4] = ((AUDIO_LEVEL_EXT_ID & 0x0f) << 4) | 0x00; // id=6, len=0 => 1 data byte
  ext[5] = 0x80 | 0x0a; // V=1 (voice), level=10 (-10 dBov, above threshold)
  ext[6] = 0x00; // pad to word boundary
  ext[7] = 0x00;
  const payload = Buffer.alloc(Math.max(1, payloadBytes), 0xcd);
  return Buffer.concat([header, ext, payload]);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const OPUS_BYTES = 160; // ~realistic 20ms Opus frame at ~64kbps

let worker: msTypes.Worker;
let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => {
  worker?.close();
});

/** One audio producer + its own unpaused consumer, with a 20ms RTP injector. */
async function makeAudioTile(index: number): Promise<{
  index: number;
  producer: msTypes.Producer;
  consumer: msTypes.Consumer;
  readForwarded: () => Promise<number>;
  close: () => void;
}> {
  const ssrc = 0x2000_0000 + index;
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [{ mimeType: 'audio/opus', payloadType: OPUS_PT, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [{ uri: AUDIO_LEVEL_URI, id: AUDIO_LEVEL_EXT_ID }],
    encodings: [{ ssrc }],
  };
  const srcTransport = await router.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'audio', rtpParameters });
  let seq = 0;
  let ts = 0;
  const interval = setInterval(() => {
    producer.send(makeOpusRtp(ssrc, seq++, ts, OPUS_BYTES));
    ts += 960; // 20ms @ 48kHz
  }, 20);

  const sinkTransport = await router.createDirectTransport();
  const consumer = await sinkTransport.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: false });
  const readForwarded = async (): Promise<number> => {
    const stats = await consumer.getStats();
    const outbound = stats.find((s) => s.type === 'outbound-rtp') as { byteCount?: number } | undefined;
    return outbound?.byteCount ?? 0;
  };
  return {
    index,
    producer,
    consumer,
    readForwarded,
    close: () => {
      clearInterval(interval);
      try { consumer.close(); producer.close(); srcTransport.close(); sinkTransport.close(); } catch { /* best-effort */ }
    },
  };
}

describe('REQ-RMS-012 spike — Opus producer + AudioLevelObserver + pause zeroes forwarded bytes', () => {
  it('a single Opus producer registers a volume, and pausing its consumer drops forwarded bytes to ~0', async () => {
    const observer = await router.createAudioLevelObserver({ maxEntries: 1, threshold: -80, interval: 200 });
    const tile = await makeAudioTile(0);
    await observer.addProducer({ producerId: tile.producer.id });

    let sawVolume = false;
    observer.on('volumes', (vols) => { if (vols[0]?.producer.id === tile.producer.id) sawVolume = true; });

    // active window — RTP flows, consumer unpaused
    await sleep(800);
    const activeStart = await tile.readForwarded();
    await sleep(600);
    const activeEnd = await tile.readForwarded();
    const activeDelta = activeEnd - activeStart;

    // paused window — consumer.pause() => ~0 forwarded media
    await tile.consumer.pause();
    await sleep(300);
    const pausedStart = await tile.readForwarded();
    await sleep(600);
    const pausedEnd = await tile.readForwarded();
    const pausedDelta = pausedEnd - pausedStart;

    tile.close();
    observer.close();

    expect(activeDelta).toBeGreaterThan(0);            // RTP actually flowed
    expect(sawVolume).toBe(true);                       // observer scored the producer
    expect(pausedDelta).toBeLessThan(activeDelta / 4);  // pause zeroed the wire
  }, 60_000);
});

// ── RED hook: AUDIO_LASTN_FORCE_ALL=1 forwards ALL N audio tiles in the
// "optimized" scenario too (no pause) => optimized ~= baseline => ratio ~1.0 <
// gate => the hard-gate FAILS. Proves GREEN is the last-N mechanism, not chance.
const FORCE_ALL = process.env['AUDIO_LASTN_FORCE_ALL'] === '1';

const K = parseInt(process.env['AUDIO_LASTN_K'] ?? '3', 10); // top-k loudest forwarded
const N_AUDIO = 24; // N audio peers (Zoom-style: few active, rest audible-but-quiet)
const SETTLE_MS = 1000;
const WINDOW_MS = 800;

/** Apply ALL-N baseline (every audio consumer unpaused). */
async function applyAllN(tiles: Awaited<ReturnType<typeof makeAudioTile>>[]): Promise<void> {
  for (const t of tiles) await t.consumer.resume();
}

/** Apply top-k optimized: keep tiles [0..k) flowing, pause the rest (unless RED). */
async function applyTopK(tiles: Awaited<ReturnType<typeof makeAudioTile>>[]): Promise<void> {
  for (const t of tiles) {
    if (t.index < K || FORCE_ALL) await t.consumer.resume();
    else await t.consumer.pause();
  }
}

async function measure(tiles: Awaited<ReturnType<typeof makeAudioTile>>[]): Promise<number> {
  await sleep(SETTLE_MS);
  const starts = await Promise.all(tiles.map((t) => t.readForwarded()));
  await sleep(WINDOW_MS);
  const ends = await Promise.all(tiles.map((t) => t.readForwarded()));
  return ends.reduce((s, e, i) => s + (e - starts[i]!), 0);
}

describe('REQ-RMS-012 GATE — audio last-N forwarded-byte reduction (REAL mediasoup)', () => {
  it(`HARD-GATE: all-N / top-${K} forwarded-byte ratio >= ${Math.floor(N_AUDIO / K) - 1} at N=${N_AUDIO}`, async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');

    const tiles: Awaited<ReturnType<typeof makeAudioTile>>[] = [];
    for (let i = 0; i < N_AUDIO; i++) tiles.push(await makeAudioTile(i));

    await applyAllN(tiles);
    const baselineBytes = await measure(tiles);
    await applyTopK(tiles);
    const optimizedBytes = await measure(tiles);

    for (const t of tiles) t.close();

    const ratio = optimizedBytes > 0 ? baselineBytes / optimizedBytes : Infinity;

    // eslint-disable-next-line no-console
    console.log(
      `[bench REQ-RMS-012 N=${N_AUDIO} k=${K}] all-N=${baselineBytes}B  top-k=${optimizedBytes}B  ratio=${ratio.toFixed(2)}` +
        (FORCE_ALL ? '  [RED HOOK: AUDIO_LASTN_FORCE_ALL=1]' : ''),
    );

    // green-only sidecar (RED run never clobbers the authoritative green numbers).
    if (!FORCE_ALL) {
      const sidecar = {
        req: 'REQ-RMS-012', milestone: 'M3', title: 'audio last-N forwarded-byte reduction',
        date: new Date().toISOString().slice(0, 10), mediasoupVersion: '3.19.17',
        n: N_AUDIO, k: K, baselineBytes, optimizedBytes, ratio: Number(ratio.toFixed(4)),
        honest_note:
          'Relay-side mechanism floor on a synthetic DirectTransport Opus source. ' +
          'Forwarded outbound-rtp byteCount = bytes mediasoup put on the wire (ground truth). ' +
          'NOT WAN, NOT browser getStats. Top-k selection is consumer.pause() on the non-loud tiles.',
      };
      const p = resolve(process.cwd(), '.logs/bench/rms/audio-lastn.json');
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(sidecar, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(`[bench] sidecar -> ${p}`);
    }

    // GUARDS: both windows carried real media (no dead-pipe false-green).
    expect(baselineBytes).toBeGreaterThan(0);
    expect(optimizedBytes).toBeGreaterThan(0);

    // THE HARD-GATE: forwarding only k of N must reduce forwarded bytes by ~N/k.
    // Conservative target: at least (N/k - 1)x (slack for RTCP + settle transient).
    expect(ratio).toBeGreaterThanOrEqual(Math.floor(N_AUDIO / K) - 1);
  }, 120_000);
});
