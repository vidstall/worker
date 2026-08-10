/**
 * Shared setup/fixtures for relay-blind-forward.integration.test.ts.
 *
 * W5 M2 Phase 5 — RELAY BLIND-FORWARD INVARIANT (REQ-MCS-011). See the sibling
 * test file's header comment for the full invariant / honesty-bounds
 * narrative. This module holds the SFrame-over-VP8 packet builders, the
 * per-layer SFrame tile harness (real mediasoup DirectTransport producer +
 * capturing consumer), and the forwarded-body locator/measurement helpers.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/relay-blind-forward.integration.test.ts
 */

import { beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

// -- VP8-only codec (mirrors mediasoup-manager.ts + the M1 bench) --------------

export const VP8_PT = 101;
export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

// Layer convention (CONTRACTS.md C1, mirrors the M1 bench): :0=low/thumbnail,
// :1=mid, :2=high/active-speaker. encodings[] ordered low->high.
export const LAYER_LOW = 0;
export const LAYER_MID = 1;
export const LAYER_HIGH = 2;

/** Simulcast ladder per packet content size (same ~1:7:18 asymmetry as M1). */
export const LADDER_CIPHERTEXT_BYTES = [60, 400, 1100] as const; // [low, mid, high]

// ── SFrame cleartext header (CONTRACTS.md §2, RFC 9605 §4.4.3) ────────────────
// Config byte | KID (short form, 1B for the demo range) | CTR (4B here). The
// relay never reads past this header — everything after is opaque ciphertext.
export const SFRAME_CONFIG_BYTE = 0x00; // RFC 9605 config: short KID + short CTR (demo)
export const SFRAME_KID = 7; // == membership epoch (CONTRACTS.md §2); 1-byte short form

// ── RED hook ──────────────────────────────────────────────────────────────────
// BLIND_FORCE_LAYER_HIGH=1 forces invariant (2)'s "low" scenario to ALSO select
// :2 => low ~= high => the layer-select ratio assertion FAILS. Proves GREEN is
// the mechanism, not a coincidence (mirrors the M1 bench BENCH_FORCE_OPTIMIZED_HIGH
// and the spike SPIKE_DISABLE_RTCP_SR red hooks).
export const FORCE_LAYER_HIGH = process.env['BLIND_FORCE_LAYER_HIGH'] === '1';

// BLIND_FORCE_TAMPER=1 simulates a NON-blind relay that mutated the ciphertext
// body in transit (flips one body byte of each captured forwarded packet before
// the byte-identity comparison) => byteIdentical drops below mediaPackets =>
// invariant (1) FAILS. The permanent, reproducible RED for the byte-preservation
// assertion (invariant (2) already has BLIND_FORCE_LAYER_HIGH). With the flag
// UNSET this is a no-op, so GREEN is the real forwarded bytes.
export const FORCE_TAMPER = process.env['BLIND_FORCE_TAMPER'] === '1';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a VP8 RTP packet whose payload models an SFrame frame:
 *   [VP8 descriptor][VP8 keyframe/interframe header][SFrame cleartext header]
 *   [opaque ciphertext body of `ciphertextBytes`]
 *
 * VP8 header semantics are VERBATIM from the M1 bench's makeVp8Rtp (real keyframe
 * start code on keyframes so the SimulcastConsumer can switch layers — G-MCS-1).
 * The SFrame header + ciphertext body are appended after the VP8 header; the
 * relay forwards them opaquely.
 *
 * Returns the full packet + the [offset,len) of the ciphertext body within the
 * payload, so the test can extract & compare exactly the bytes that must survive.
 */
export function makeSframeVp8Rtp(args: {
  ssrc: number;
  seq: number;
  ts: number;
  pictureId: number;
  ctr: number;
  ciphertextBytes: number;
  keyframe: boolean;
}): { packet: Buffer; ciphertext: Buffer; sframeHeader: Buffer } {
  const { ssrc, seq, ts, pictureId, ctr, ciphertextBytes, keyframe } = args;

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

  // SFrame cleartext header: Config byte | KID (1B short form) | CTR (4B). This
  // is what the relay/receiver may read; it carries NO key material (CONTRACTS §2).
  const sframeHeader = Buffer.alloc(6);
  sframeHeader[0] = SFRAME_CONFIG_BYTE;
  sframeHeader[1] = SFRAME_KID & 0xff;
  sframeHeader.writeUInt32BE(ctr >>> 0, 2);

  // Opaque "ciphertext" body — deterministic-but-content-varying bytes per
  // (seq, ctr) so a forwarded copy that altered ANY byte would diverge. NOT a
  // real SFrame ciphertext (the encrypt/decrypt is client-side, P2/P3) — it is a
  // stand-in opaque payload (honesty bound, see file header).
  const bodyLen = Math.max(1, ciphertextBytes);
  const ciphertext = Buffer.alloc(bodyLen);
  for (let i = 0; i < bodyLen; i++) {
    ciphertext[i] = (seq * 31 + ctr * 17 + i * 13 + 0x5a) & 0xff;
  }

  const packet = Buffer.concat([header, desc, vp8PayloadHeader, sframeHeader, ciphertext]);
  return { packet, ciphertext, sframeHeader };
}

/** Minimal RTCP Sender Report (PT=200) — verbatim from the M1 bench / spike.
 *  Required so each layer SSRC has a non-zero GetSenderReportNtpMs(), the
 *  precondition CanSwitchToSpatialLayer() demands to leave layer 0 (G-MCS-1). */
export function makeRtcpSenderReport(
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

export let worker: msTypes.Worker;
export let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => {
  worker?.close();
});

// ── A single SFrame simulcast producer + its own unpaused consumer ────────────

export interface SframeTile {
  producer: msTypes.Producer;
  consumer: msTypes.Consumer;
  /** cumulative forwarded byteCount reader (outbound-rtp = bytes on the wire) */
  readForwarded: () => Promise<number>;
  /** the forwarded RTP packets captured on the consumer side (DirectTransport 'rtp') */
  capturedForwarded: Buffer[];
  /** the ciphertext bodies WE SENT, keyed by (layer index) → list, for comparison */
  sentCiphertextByLayer: Buffer[][];
  stop: () => void;
  close: () => void;
}

/** Build one SFrame tile: a 3-layer simulcast producer (distinct SSRC base) + an
 *  UNPAUSED DirectTransport consumer that CAPTURES every forwarded RTP packet,
 *  with a per-SSRC SFrame-keyframe + RTCP-SR injector (G-MCS-1 backbone). */
export async function makeSframeTile(index: number): Promise<SframeTile> {
  const base = 0x2000_0000 + index * 0x10;
  const ssrcs = [base, base + 1, base + 2] as const; // low, mid, high

  const rtpParameters: msTypes.RtpParameters = {
    codecs: [
      { mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] },
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
  const ctrs = [0, 0, 0];
  const pktCount = [0, 0, 0];
  const octetCount = [0, 0, 0];
  const sentCiphertextByLayer: Buffer[][] = [[], [], []];
  let ts = 0;
  let frame = 0;

  const sendAll = (): void => {
    const keyframe = frame % 10 === 0; // keyframe every 10th frame (~100ms)
    for (let layer = 0; layer < 3; layer++) {
      const built = makeSframeVp8Rtp({
        ssrc: ssrcs[layer]!,
        seq: seqs[layer]!++,
        ts,
        pictureId: pics[layer]!++ & 0x7fff,
        ctr: ctrs[layer]!++,
        ciphertextBytes: LADDER_CIPHERTEXT_BYTES[layer]!,
        keyframe,
      });
      producer.send(built.packet);
      // Record only a bounded recent window of sent ciphertext bodies per layer
      // (so the byte-identity check has a corpus to match against without
      // unbounded memory).
      const recorded = sentCiphertextByLayer[layer]!;
      recorded.push(built.ciphertext);
      if (recorded.length > 64) recorded.shift();
      pktCount[layer]! += 1;
      octetCount[layer]! += built.packet.length;
    }
    if (frame % 10 === 0) {
      for (let layer = 0; layer < 3; layer++) {
        srcTransport.sendRtcp(makeRtcpSenderReport(ssrcs[layer]!, ts, pktCount[layer]!, octetCount[layer]!));
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
    paused: false, // UNPAUSED — RTP must flow to be captured + counted
  });

  // Capture every forwarded RTP packet (DirectTransport consumers emit per-packet
  // 'rtp'; a plain consumer does not). This is the ground truth of what the relay
  // put on the consumer's wire.
  const capturedForwarded: Buffer[] = [];
  consumer.on('rtp', (rtpPacket: Buffer) => {
    // bound memory: keep the most recent ~512 packets
    capturedForwarded.push(Buffer.from(rtpPacket));
    if (capturedForwarded.length > 512) capturedForwarded.shift();
  });

  const readForwarded = async (): Promise<number> => {
    const stats = await consumer.getStats();
    const outbound = stats.find((s) => s.type === 'outbound-rtp') as { byteCount?: number } | undefined;
    return outbound?.byteCount ?? 0;
  };

  return {
    producer,
    consumer,
    readForwarded,
    capturedForwarded,
    sentCiphertextByLayer,
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

/**
 * Locate the SFrame cleartext header + ciphertext body in a FORWARDED VP8 RTP
 * packet, by SCANNING for the SFrame header signature (Config byte 0x00 || KID).
 *
 * Why scan, not a fixed offset: the relay (mediasoup) legitimately rewrites RTP-
 * and codec-level HEADER bytes for routing — it adds a variable-length RTP header
 * extension and may rewrite the VP8 payload descriptor (PictureID/TL0PICIDX) for
 * simulcast. That header rewriting is EXACTLY the cleartext-metadata routing the
 * relay-blind invariant PERMITS (RFC 9605 §4.4.3). What MUST NOT change is the
 * SFrame header + ciphertext BODY. A receiver likewise locates the SFrame header
 * relative to the VP8 payload start; here we find it by signature and assert the
 * body bytes to EOF survive unchanged. Confirmed empirically: the forwarded
 * offset varies (e.g. 39 vs 46) but the body is always byte-identical.
 *
 * Returns the matched {kid, ctr, ciphertext} only when the trailing body is
 * byte-identical to one of `sentBodiesB64` (so a spurious 0x00,KID coincidence in
 * the header region cannot produce a false positive). Returns null otherwise.
 */
export function locateForwardedSframe(
  pkt: Buffer,
  sentBodiesB64: Set<string>,
): { kid: number; ctr: number; bodyLen: number } | null {
  // Scan only the header region (well before any real body) for the SFrame
  // signature: Config byte (0x00) immediately followed by our KID.
  const scanEnd = Math.min(pkt.length - 7, 64);
  for (let off = 12; off < scanEnd; off++) {
    if (pkt[off] === SFRAME_CONFIG_BYTE && pkt[off + 1] === (SFRAME_KID & 0xff)) {
      const body = pkt.subarray(off + 6).toString('base64');
      if (sentBodiesB64.has(body)) {
        return { kid: pkt[off + 1]!, ctr: pkt.readUInt32BE(off + 2), bodyLen: pkt.length - (off + 6) };
      }
    }
  }
  return null;
}

export const SETTLE_MS = 1200; // settle after layer changes (M1 bench used 1200)
export const WINDOW_MS = 800; // identical measurement window

/** Sum forwarded outbound-rtp DELTA over WINDOW_MS after a SETTLE_MS settle. */
export async function measureForwarded(tile: SframeTile): Promise<number> {
  await sleep(SETTLE_MS);
  const start = await tile.readForwarded();
  await sleep(WINDOW_MS);
  const end = await tile.readForwarded();
  return end - start;
}
