/**
 * P10 Step-2 harness — capture analysis (E2EE + non-E2EE control).
 *
 * Split out of p10-relayblind-browser.ts (pure code movement, no behavior change).
 */

import {
  decryptFrame,
  readSframeTrailer,
  SFRAME_TRAILER_LEN,
} from '../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';
import type { CaptureRoom } from './relay-standup.js';

/** Result of analysing one captured payload window. */
export interface RoomAnalysis {
  forwarded: number;
  mediaPackets: number;
  /** relay-side INBOUND RTP packets the relay RECEIVED from the browser. */
  relayReceivedPackets: number;
  /** E2EE: real SFrame ciphertext samples (captured at the sender boundary == the bytes
   *  the relay receives over loopback) carrying a config-0x01 + 14-byte trailer. */
  sframeHeaderObserved: number;
  /** E2EE: …whose AES-GCM body FAILS to decrypt with NO key (the relay-blind point). */
  undecodableWithoutKey: number;
  /** E2EE: forwarded tap packets in which we could LOCATE a whole captured SFrame body
   *  (only single-RTP-packet frames; large frames fragment across MTU so they don't match). */
  forwardedSframeMatched: number;
  /** E2EE: …of those LOCATED forwarded bodies, the ones that FAIL decrypt with NO key —
   *  invariant (B) where measurable: a located forwarded body stays content-opaque. Per-packet
   *  byte-identity of forwarded ciphertext is the HERMETIC Step-1 (relay-blind-realsframe). */
  forwardedUndecodableWithoutKey: number;
  /** non-E2EE: forwarded packets whose body decoded to readable VP8 with NO key. */
  cleartextRecovered: number;
  /** first payload for the side-by-side hex sample. */
  samplePayloadHex: string | null;
  /** for E2EE: the recovered {kid, ctr} from the first SFrame header observed. */
  sampleHeader: { kid: number; ctr: number } | null;
  /** for non-E2EE: the recovered cleartext snippet (printable). */
  sampleCleartext: string | null;
}

/**
 * Analyse the E2EE room. The M3 Lane B DUAL relay-blind invariant, both legs load-bearing:
 *   (A) the SFU now FORWARDS the E2EE stream (forwarded > 0): the PARTIAL-SFrame keeps the
 *       cleartext VP8 keyframe markers at the FRONT, so the SFU keyframe-select gate
 *       advances (the full-frame P10 Finding-B stall is FIXED). The relay RECEIVES the
 *       ciphertext (relayReceivedPackets > 0) AND forwards it.
 *   (B) the content is STILL opaque without the key. The PRIMARY opacity proof is on the
 *       page-captured sender-boundary ciphertext — the EXACT whole-frame bytes the relay
 *       receives over loopback: each carries the REAL config-0x01 + 14-byte TRAILER (parsed
 *       FROM THE END by `readSframeTrailer`) AND FAILS AES-GCM decrypt WITHOUT the key
 *       (undecodableWithoutKey === sframeHeaderObserved). We ALSO walk the actual forwarded
 *       tap packets and, for any whole SFrame body we can LOCATE (only single-RTP-packet
 *       frames — large frames fragment across MTU so they never whole-match), assert the
 *       SHIPPED `decryptFrame(body, ()=>null)` REJECTS (forwardedUndecodableWithoutKey ===
 *       forwardedSframeMatched, vacuously true when fragmentation locates none). Per-packet
 *       byte-identity of FORWARDED ciphertext is the HERMETIC Step-1's job
 *       (relay-blind-realsframe.integration.test.ts, byteIdentical===mediaPackets), where a
 *       finite single-packet body set makes it deterministic.
 *   We prove "undecodable" with the SHIPPED `decryptFrame` + a null key lookup.
 */
export async function analyseE2EE(room: CaptureRoom, pageRun: Record<string, unknown>): Promise<RoomAnalysis> {
  const a: RoomAnalysis = {
    forwarded: room.packets.length,
    mediaPackets: 0,
    relayReceivedPackets: room.relayReceivedSnapshot,
    sframeHeaderObserved: 0,
    undecodableWithoutKey: 0,
    forwardedSframeMatched: 0,
    forwardedUndecodableWithoutKey: 0,
    cleartextRecovered: 0,
    samplePayloadHex: null,
    sampleHeader: null,
    sampleCleartext: null,
  };

  // The page captured the first few REAL SFrame ciphertexts (hex) it sent to the relay.
  // These are byte-identical to what the relay holds over loopback (sender boundary).
  const samplesHex = (pageRun['cipherSamples'] as string[] | undefined) ?? [];
  // The exact sent SFrame bodies (b64) — authoritatively locate the SFrame body inside a
  // forwarded tap packet (mediasoup rewrites RTP/VP8 HEADER bytes, never the SFrame body).
  const sentBodiesB64 = new Set<string>();
  for (const hex of samplesHex) {
    const sframe = Buffer.from(hex, 'hex');
    if (sframe.length < SFRAME_TRAILER_LEN + 16) continue;
    // (B-1) real config 0x01 + 14-byte TRAILER parses key-free FROM THE END (M3 Lane B).
    let trailer: { kid: number; ctr: number; codecOffset: number };
    try {
      trailer = readSframeTrailer(sframe);
    } catch {
      continue;
    }
    a.sframeHeaderObserved++;
    sentBodiesB64.add(sframe.toString('base64'));
    if (a.sampleHeader === null) {
      a.sampleHeader = { kid: trailer.kid, ctr: trailer.ctr };
      a.samplePayloadHex = sframe.subarray(0, Math.min(40, sframe.length)).toString('hex');
    }
    // (B-2) THE RELAY-BLIND POINT (sender-boundary sample): a keyless reader cannot recover
    // the frame — the SHIPPED `decryptFrame` with a null key lookup REJECTS (AES-GCM auth).
    let decoded = false;
    try {
      await decryptFrame(Uint8Array.prototype.slice.call(sframe), () => null);
      decoded = true; // would mean readable with no key — must NOT happen.
    } catch {
      decoded = false; // expected: undecodable without the key.
    }
    if (!decoded) a.undecodableWithoutKey++;
  }

  // (A) + (B-3): walk the ACTUAL forwarded tap packets. Count media packets, and for each
  // one that carries one of our sent SFrame bodies, assert the FORWARDED body is still
  // GCM-opaque (decryptFrame with a null key REJECTS). This is the headline: the SFU
  // FORWARDED the E2EE stream, yet each forwarded body remains content-opaque.
  const minMedia = 12 + 4 + 10;
  for (const pkt of room.packets) {
    if (pkt.length < minMedia) continue;
    a.mediaPackets++;
    // Locate the SFrame body by the AUTHORITATIVE sent-body match (mediasoup never rewrites
    // the body), then confirm it is content-opaque without the key.
    const scanEnd = Math.min(pkt.length - SFRAME_TRAILER_LEN, 64);
    for (let off = 12; off < scanEnd; off++) {
      const cand = pkt.subarray(off);
      if (cand.length < SFRAME_TRAILER_LEN + 16) break;
      if (sentBodiesB64.has(cand.toString('base64'))) {
        // LOCATED a whole captured SFrame body in this forwarded packet (only happens for
        // single-RTP-packet frames; large frames fragment across MTU and never whole-match).
        a.forwardedSframeMatched++;
        let forwardedDecoded = false;
        try {
          await decryptFrame(Uint8Array.prototype.slice.call(cand), () => null);
          forwardedDecoded = true; // readable with no key — must NOT happen.
        } catch {
          forwardedDecoded = false; // expected: forwarded body opaque without the key.
        }
        if (!forwardedDecoded) a.forwardedUndecodableWithoutKey++;
        break;
      }
    }
  }
  return a;
}

/**
 * Analyse the non-E2EE control capture: the forwarded body is the RAW VP8 bitstream
 * (no SFrame, no key). We DECODE it with NO key — a VP8 keyframe carries the
 * well-known start code 0x9d 0x01 0x2a in cleartext (the relay reads it; so can any
 * passive observer). Recovering that proves the non-E2EE body is readable on the wire.
 * This is the load-bearing contrast: identical relay mechanics, cleartext outcome.
 */
export async function analyseControl(room: CaptureRoom): Promise<RoomAnalysis> {
  const a: RoomAnalysis = {
    forwarded: room.packets.length,
    mediaPackets: 0,
    relayReceivedPackets: room.relayReceivedSnapshot,
    sframeHeaderObserved: 0,
    undecodableWithoutKey: 0,
    forwardedSframeMatched: 0,
    forwardedUndecodableWithoutKey: 0,
    cleartextRecovered: 0,
    samplePayloadHex: null,
    sampleCleartext: null,
    sampleHeader: null,
  };
  // VP8 keyframe start code (uncompressed-data-chunk magic, RFC 6386 §9.1) — cleartext.
  const VP8_KEYFRAME_MAGIC = Buffer.from([0x9d, 0x01, 0x2a]);
  const minMedia = 12 + 4 + 10;
  for (const pkt of room.packets) {
    if (pkt.length < minMedia) continue;
    a.mediaPackets++;
    // Scan the cleartext payload for the VP8 keyframe magic — readable with NO key.
    const idx = pkt.indexOf(VP8_KEYFRAME_MAGIC, 12);
    if (idx >= 0) {
      a.cleartextRecovered++;
      if (a.sampleCleartext === null) {
        a.sampleCleartext = `VP8 keyframe magic 0x9d012a @ offset ${idx} (cleartext, no key)`;
        a.samplePayloadHex = pkt.subarray(12, Math.min(12 + 40, pkt.length)).toString('hex');
      }
    }
  }
  // Fallback sample if no keyframe magic landed in the window (interframes only): still
  // record a payload sample — the body is raw VP8 either way (relay reads VP8 headers).
  if (a.samplePayloadHex === null && room.packets.length > 0) {
    const pkt = room.packets.find((p) => p.length >= minMedia) ?? room.packets[0]!;
    a.samplePayloadHex = pkt.subarray(12, Math.min(12 + 40, pkt.length)).toString('hex');
  }
  return a;
}
