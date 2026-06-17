/**
 * W5 M2 Phase 5 — RELAY BLIND-FORWARD INVARIANT (REQ-MCS-011).
 *
 * The relay-blind invariant for Content E2EE (Option A, SFrame / RFC 9605): the
 * relay forwards an SFrame-encrypted producer's RTP reading ONLY the cleartext
 * RTP/SFrame header for routing + M1 simulcast layer-select — it MUST NOT decode
 * or mutate the encrypted payload. This file PROVES that invariant on REAL
 * mediasoup over DirectTransport, reusing the M1 bandwidth-bench backbone
 * (makeVp8Rtp / makeRtcpSenderReport semantics, G-MCS-1).
 *
 * SFrame model (CONTRACTS.md §2, RFC 9605 §4.4.3 — cleartext header || ciphertext
 * || tag). The relay only ever sees VP8 RTP, so we model an SFrame frame INSIDE
 * the VP8 RTP payload:
 *
 *   RTP header (12B) | VP8 descriptor | VP8 keyframe/interframe header
 *                    | [SFrame: Config byte | KID | CTR] | ciphertext body | tag
 *
 * The VP8 descriptor + keyframe header stay parseable (real VP8 keyframe start
 * code) so the SimulcastConsumer can still switch spatial layers (G-MCS-1 — the
 * relay routes/selects on cleartext metadata). Everything AFTER the VP8 header
 * (the SFrame header + ciphertext body + tag) is OPAQUE to the relay.
 *
 * ── Two invariants proven ────────────────────────────────────────────────────
 *   (1) BLIND / BYTE-PRESERVING: capture the forwarded RTP on the consumer side
 *       (DirectTransport consumers emit a per-packet 'rtp' event). The ciphertext
 *       body is byte-IDENTICAL to what was sent. mediasoup rewrites only RTP
 *       header fields (SSRC/seq/ts) for routing; it NEVER touches the payload
 *       body => structurally there is no decode/decrypt/mutate path. We ALSO
 *       confirm the cleartext SFrame header (KID/CTR) survives unchanged so the
 *       receiver can still pick the decryption key by KID (CONTRACTS.md §2).
 *   (2) M1 LAYER-SELECT COEXISTS OVER CIPHERTEXT: with the SAME ciphertext
 *       payloads, setPreferredLayers(:0) drops forwarded outbound-rtp byteCount
 *       materially vs (:2) — the relay layer-selects on the cleartext header
 *       without ever reading the ciphertext (reuses the M1 measureScenario
 *       pattern). A documented RED hook proves GREEN is the mechanism.
 *
 * ── RED hook (mirrors the M1 bench BENCH_FORCE_OPTIMIZED_HIGH discipline) ──────
 * BLIND_FORCE_LAYER_HIGH=1 forces the "low" scenario in invariant (2) to ALSO
 * select spatialLayer:2 => low ~= high => the >=3x layer-select assertion FAILS.
 * This is the documented RED that proves the layer-select GREEN is the mechanism,
 * not a coincidence (same shape as the M1 bench red hook + the spike's
 * SPIKE_DISABLE_RTCP_SR=1). The byte-preservation invariant (1) has its own RED
 * discipline noted inline (an intentionally-wrong byte expectation fails).
 *
 * ── Honesty bounds (DA-2/DA-3, D-M2-8 — mirrors the M1 bench honesty block) ────
 * This is a RELAY-SIDE mechanism floor on a SYNTHETIC DirectTransport source —
 * NOT WAN glass-to-glass, NOT a browser getStats(), and it does NOT prove real-
 * browser SFrame-over-VP8-simulcast interop (that is P10's BROWSER relay-blind
 * proof + a real-deployment concern). The "ciphertext" here is opaque random
 * bytes standing in for a real SFrame ciphertext — it proves the relay FORWARDS
 * an opaque payload unchanged and selects layers on the cleartext header, which
 * is the structural blind-forward property; it does NOT exercise a real SFrame
 * encrypt/decrypt (client-side, P2/P3). The relay's blindness is STRUCTURAL
 * (mediasoup has no SFrame/decode path; the payload is opaque to it). The
 * validator-blindness in M2 is ECONOMIC/OPERATIONAL (it holds the key). This is
 * NEVER a cryptographic "relay/validator cannot decrypt" claim — M2 has NO
 * cryptographic validator-exclusion (Path C → M3, D-M2-7/8).
 *
 * Requirements touched: REQ-MCS-011 (relay blind-forward invariant + M1 coexist).
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/relay-blind-forward.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

// -- VP8-only codec (mirrors mediasoup-manager.ts + the M1 bench) --------------

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

// Layer convention (CONTRACTS.md C1, mirrors the M1 bench): :0=low/thumbnail,
// :1=mid, :2=high/active-speaker. encodings[] ordered low->high.
const LAYER_LOW = 0;
const LAYER_MID = 1;
const LAYER_HIGH = 2;

/** Simulcast ladder per packet content size (same ~1:7:18 asymmetry as M1). */
const LADDER_CIPHERTEXT_BYTES = [60, 400, 1100] as const; // [low, mid, high]

// ── SFrame cleartext header (CONTRACTS.md §2, RFC 9605 §4.4.3) ────────────────
// Config byte | KID (short form, 1B for the demo range) | CTR (4B here). The
// relay never reads past this header — everything after is opaque ciphertext.
const SFRAME_CONFIG_BYTE = 0x00; // RFC 9605 config: short KID + short CTR (demo)
const SFRAME_KID = 7; // == membership epoch (CONTRACTS.md §2); 1-byte short form

// ── RED hook ──────────────────────────────────────────────────────────────────
// BLIND_FORCE_LAYER_HIGH=1 forces invariant (2)'s "low" scenario to ALSO select
// :2 => low ~= high => the layer-select ratio assertion FAILS. Proves GREEN is
// the mechanism, not a coincidence (mirrors the M1 bench BENCH_FORCE_OPTIMIZED_HIGH
// and the spike SPIKE_DISABLE_RTCP_SR red hooks).
const FORCE_LAYER_HIGH = process.env['BLIND_FORCE_LAYER_HIGH'] === '1';

// BLIND_FORCE_TAMPER=1 simulates a NON-blind relay that mutated the ciphertext
// body in transit (flips one body byte of each captured forwarded packet before
// the byte-identity comparison) => byteIdentical drops below mediaPackets =>
// invariant (1) FAILS. The permanent, reproducible RED for the byte-preservation
// assertion (invariant (2) already has BLIND_FORCE_LAYER_HIGH). With the flag
// UNSET this is a no-op, so GREEN is the real forwarded bytes.
const FORCE_TAMPER = process.env['BLIND_FORCE_TAMPER'] === '1';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
function makeSframeVp8Rtp(args: {
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

let worker: msTypes.Worker;
let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => {
  worker?.close();
});

// ── A single SFrame simulcast producer + its own unpaused consumer ────────────

interface SframeTile {
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
async function makeSframeTile(index: number): Promise<SframeTile> {
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
function locateForwardedSframe(
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

const SETTLE_MS = 1200; // settle after layer changes (M1 bench used 1200)
const WINDOW_MS = 800; // identical measurement window

/** Sum forwarded outbound-rtp DELTA over WINDOW_MS after a SETTLE_MS settle. */
async function measureForwarded(tile: SframeTile): Promise<number> {
  await sleep(SETTLE_MS);
  const start = await tile.readForwarded();
  await sleep(WINDOW_MS);
  const end = await tile.readForwarded();
  return end - start;
}

describe('W5 M2 P5 — relay blind-forward invariant (REAL mediasoup, REQ-MCS-011)', () => {
  it(
    'INVARIANT (1): forwards SFrame ciphertext BYTE-IDENTICAL + cleartext KID/CTR header survives (relay is blind)',
    async () => {
      const tile = await makeSframeTile(0);
      // Hold the high layer so we capture full-size ciphertext bodies.
      await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
      await tile.consumer.requestKeyFrame();
      await sleep(SETTLE_MS);
      // let a window of packets be forwarded + captured
      await sleep(600);

      const forwarded = tile.capturedForwarded.slice();
      tile.stop();

      // GUARD: real media was forwarded + captured (no dead-pipe false-green).
      expect(forwarded.length).toBeGreaterThan(0);

      // Build a set of every ciphertext body WE SENT (any layer) so a forwarded
      // body must byte-match one of them. mediasoup may forward any subset of the
      // simulcast layers; what matters is each forwarded body is byte-identical
      // to a SENT body and the SFrame header (KID) is preserved unchanged.
      const sentBodies = new Set<string>();
      for (const layer of tile.sentCiphertextByLayer) {
        for (const body of layer) sentBodies.add(body.toString('base64'));
      }
      expect(sentBodies.size).toBeGreaterThan(0);

      let byteIdentical = 0; // forwarded packets whose SFrame body byte-matches a sent body
      let kidPreserved = 0; // …of those, how many also preserved KID == SFRAME_KID
      let mediaPackets = 0; // forwarded packets large enough to carry our SFrame body
      for (const pkt of forwarded) {
        // skip tiny artifacts (RTX/padding) that can't hold our smallest body
        if (pkt.length < 12 + 4 + 3 + 6 + 1) continue;
        mediaPackets++;
        // RED hook (BLIND_FORCE_TAMPER=1): simulate a non-blind relay that altered
        // the ciphertext body in transit — flip the last body byte so it can no
        // longer byte-match a sent body => byteIdentical < mediaPackets => fail.
        if (FORCE_TAMPER) pkt[pkt.length - 1] = (pkt[pkt.length - 1]! ^ 0xff) & 0xff;
        const found = locateForwardedSframe(pkt, sentBodies);
        if (!found) continue;
        // The ciphertext body is byte-IDENTICAL to a body we sent — the relay
        // rewrote ONLY RTP/codec HEADER fields (extension/SSRC/seq/ts/descriptor)
        // for routing, NEVER the SFrame body. (This is the byte-preservation proof.)
        byteIdentical++;
        // The cleartext SFrame KID also survives unchanged (CONTRACTS §2 — the
        // receiver picks its decryption key by this KID, so it MUST be preserved).
        if (found.kid === SFRAME_KID) kidPreserved++;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[blind-forward REQ-MCS-011 invariant-1] forwarded=${forwarded.length} mediaPackets=${mediaPackets} ` +
          `ciphertextByteIdentical=${byteIdentical} kidPreserved=${kidPreserved}`,
      );

      // We must have forwarded a meaningful number of media packets.
      expect(mediaPackets).toBeGreaterThan(0);
      // EVERY forwarded media packet's ciphertext body is byte-identical to a SENT
      // body — i.e. the relay forwarded the opaque payload unchanged (no decode /
      // decrypt / mutate path). (RED: an off-by-one in the locator, or a relay
      // that mutated the body, drops byteIdentical below mediaPackets => fails.)
      expect(byteIdentical).toBe(mediaPackets);
      // …and on every one of those, the cleartext KID survived unchanged.
      expect(kidPreserved).toBe(byteIdentical);
      // Sanity: a NONSENSE body never matches (the comparison is real, not vacuous).
      expect(sentBodies.has(Buffer.from('not-a-real-ciphertext-body').toString('base64'))).toBe(false);

      tile.close();
    },
    120_000,
  );

  it(
    'INVARIANT (2): M1 layer-select drops forwarded byteCount on :0 vs :2 OVER ciphertext (>=3x; RED hook BLIND_FORCE_LAYER_HIGH)',
    async () => {
      const tile = await makeSframeTile(1);

      // HIGH scenario (:2) — active-speaker-grade, full ciphertext.
      await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
      await tile.consumer.requestKeyFrame();
      const highBytes = await measureForwarded(tile);

      // LOW scenario (:0) — thumbnail-grade. Under the RED hook, force :2 so low
      // ~= high and the ratio assertion FAILS (proves GREEN is the mechanism).
      if (FORCE_LAYER_HIGH) {
        await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_HIGH, temporalLayer: 0 });
        await tile.consumer.requestKeyFrame();
      } else {
        await tile.consumer.setPreferredLayers({ spatialLayer: LAYER_LOW, temporalLayer: 0 });
      }
      const lowBytes = await measureForwarded(tile);

      const ratio = lowBytes > 0 ? highBytes / lowBytes : Infinity;
      // eslint-disable-next-line no-console
      console.log(
        `[blind-forward REQ-MCS-011 invariant-2] forwarded outbound-rtp over ${WINDOW_MS}ms: ` +
          `high(:2)=${highBytes} bytes  low(:0)=${lowBytes} bytes  ratio=${ratio.toFixed(2)}` +
          (FORCE_LAYER_HIGH ? '  [RED HOOK: BLIND_FORCE_LAYER_HIGH=1]' : ''),
      );

      tile.stop();
      tile.close();

      // GUARD: both windows carried real media (no dead-pipe false-green).
      expect(highBytes).toBeGreaterThan(0);
      expect(lowBytes).toBeGreaterThan(0);

      // The relay layer-selected over CIPHERTEXT payloads: :0 forwards materially
      // FEWER bytes than :2, WITHOUT the relay ever decoding the body. >=3x mirrors
      // the M1 single-tile ladder (~1:18 high:low; >=3x is a conservative floor).
      // RED: BLIND_FORCE_LAYER_HIGH=1 makes low~=high => ratio~1 => this FAILS.
      expect(ratio).toBeGreaterThanOrEqual(3.0);
    },
    120_000,
  );
});
