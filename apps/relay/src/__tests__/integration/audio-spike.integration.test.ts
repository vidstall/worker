/**
 * REQ-RMS-001(b)/(c) — Opus AUDIO injection de-risk SPIKE (relay-mesh-scaling M1).
 *
 * NO audio harness exists in this repo (every bench is VP8-only). Per the BENCH-3
 * lesson, de-risk the audio-cost MECHANISM with a real-mediasoup spike BEFORE the
 * saturation bench composes the audio modes. This file is the source of `makeOpusRtp`
 * (mirrors makeVp8Rtp in single-worker-saturation-bench) + the AudioLevelObserver wiring
 * that the saturation bench reuses for modes (b) audio-only-N and (c) mixed-30+70.
 *
 * PRECONDITION ASSERTS (both must hold or the audio modes are unmeasurable):
 *   1. Real Opus RTP flows: an UNPAUSED Opus consumer forwards > 0 bytes over a window.
 *   2. The router's AudioLevelObserver(maxEntries:1) emits a 'volumes' event when audio
 *      flows — the signal server-side audio last-N (REQ-RMS-012) would later gate on.
 *
 * EXPLORATORY + SLOW -> SKIPPED unless RMS_BENCH=1 (mirrors SAT_BENCH gating).
 *
 * Run: RMS_BENCH=1 pnpm exec vitest run --config vitest.rms-bench.config.ts \
 *        apps/relay/src/__tests__/integration/audio-spike.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

const OPUS_PT = 100;
// mediasoup's AudioLevelObserver reads the per-packet audio level from the
// `urn:ietf:params:rtp-hdrext:ssrc-audio-level` RTP header extension (supportedRtpCapabilities
// preferredId 6, RFC 6464). Synthetic packets carry NO real Opus energy to decode, so the
// 'volumes' event ONLY fires if we declare + embed this extension. This is the honest spike
// mechanism (a real client encoder signals the same extension); see the DE-RISK FINDING below.
const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';
const AUDIO_LEVEL_EXT_ID = 6;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: OPUS_PT },
];

const RUN_RMS = process.env['RMS_BENCH'] === '1';
const WINDOW_MS = parseInt(process.env['RMS_WINDOW_MS'] ?? '2000', 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a single well-formed Opus RTP packet (mirrors makeVp8Rtp's header shape, audio
 * variant: 1 SSRC, no simulcast). `payloadBytes` models the ~per-packet Opus frame size
 * (a 20ms 48kHz stereo frame is ~80-160B at typical bitrates).
 */
export function makeOpusRtp(ssrc: number, seq: number, ts: number, payloadBytes: number): Buffer {
  // Set X=1 (extension present) so the one-byte RFC 5285 audio-level extension below is parsed.
  const header = Buffer.alloc(12);
  header[0] = 0x80 | 0x10; // version 2 + extension bit (X)
  header[1] = (OPUS_PT & 0x7f) | 0x80; // marker + PT
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  // RFC 5285 one-byte header extension block carrying ssrc-audio-level (RFC 6464):
  //   profile 0xBEDE, length 1 word; one element: id(4)|len(4) then the level byte.
  // Level byte = V(1) | level(7); level is -dBov magnitude. 0x80 => V=1, level=0 (loud).
  const ext = Buffer.alloc(8);
  ext.writeUInt16BE(0xbede, 0); // one-byte-header profile
  ext.writeUInt16BE(1, 2); // 1 32-bit word of extension data
  ext[4] = ((AUDIO_LEVEL_EXT_ID & 0x0f) << 4) | 0x00; // id=6, len field=0 => 1 data byte
  ext[5] = 0x80 | 0x0a; // V=1 (voice), level=10 (-10 dBov, clearly above any threshold)
  ext[6] = 0x00; // padding to word boundary
  ext[7] = 0x00;
  const payload = Buffer.alloc(Math.max(1, payloadBytes), 0xcd);
  return Buffer.concat([header, ext, payload]);
}

/** A producing Opus source on a DirectTransport that ticks 50 packets/s (20ms frames). */
export async function makeOpusProducer(router: msTypes.Router, index: number): Promise<{
  producer: msTypes.Producer; stop: () => void; close: () => void;
}> {
  const ssrc = 0x2000_0000 + index;
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [{ mimeType: 'audio/opus', payloadType: OPUS_PT, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
    headerExtensions: [{ uri: AUDIO_LEVEL_URI, id: AUDIO_LEVEL_EXT_ID }],
    encodings: [{ ssrc }],
  };
  const tx = await router.createDirectTransport();
  const producer = await tx.produce({ kind: 'audio', rtpParameters });
  let seq = 0; let ts = 0;
  const interval = setInterval(() => {
    producer.send(makeOpusRtp(ssrc, seq++, ts, 120));
    ts += 960; // 20ms @ 48kHz
  }, 20);
  return { producer, stop: () => clearInterval(interval), close: () => { clearInterval(interval); try { producer.close(); tx.close(); } catch { /* best-effort */ } } };
}

describe('REQ-RMS-001 — Opus audio injection spike (REAL mediasoup)', () => {
  let worker: msTypes.Worker;
  beforeAll(async () => { worker = await mediasoup.createWorker({ logLevel: 'warn' }); }, 60_000);
  afterAll(() => { worker?.close(); });

  (RUN_RMS ? it : it.skip)('forwards real Opus bytes and fires AudioLevelObserver volumes', async () => {
    const router = await worker.createRouter({ mediaCodecs });
    // DE-RISK FINDING (REQ-RMS-001 spike): mediasoup's AudioLevelObserver derives the level
    // from the ssrc-audio-level RTP HEADER EXTENSION (RFC 6464), NOT from decoding the Opus
    // payload — so with synthetic constant-byte packets the 'volumes' event NEVER fires at the
    // default -80 dBov threshold no matter how low you push it. The honest mechanism (used here)
    // is to DECLARE the extension on the producer and EMBED a -10 dBov level byte per packet
    // (makeOpusRtp). A real client encoder signals the very same extension; this is the spike's
    // honest wiring, surfaced (not hidden) per the BENCH-3 honesty discipline.
    const observer = await router.createAudioLevelObserver({ maxEntries: 1, threshold: -80, interval: 400 });

    let volumesFired = false;
    observer.on('volumes', () => { volumesFired = true; });

    const src = await makeOpusProducer(router, 0);
    await observer.addProducer({ producerId: src.producer.id });

    const sink = await router.createDirectTransport();
    const consumer = await sink.consume({ producerId: src.producer.id, rtpCapabilities: router.rtpCapabilities, paused: false });

    const read = async (): Promise<number> => {
      const stats = await consumer.getStats();
      const o = stats.find((s) => s.type === 'outbound-rtp') as { byteCount?: number } | undefined;
      return o?.byteCount ?? 0;
    };
    const before = await read();
    await sleep(WINDOW_MS);
    const after = await read();

    expect(after - before).toBeGreaterThan(0); // real Opus flowed
    expect(volumesFired).toBe(true);            // active-speaker signal works

    consumer.close(); sink.close(); src.close(); await observer.close(); router.close();
  }, 60_000);
});
