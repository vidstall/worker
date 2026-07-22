/**
 * Shared SFrame byte-identity test helpers (extracted from
 * relay-blind-realsframe.integration.test.ts so the 1-hop and the REQ-RMS-020
 * multi-hop tests share ONE byte-comparison framework — no copy-paste drift).
 * NOTHING here reimplements crypto: realKeying drives the SHIPPED client stack.
 */
import {
  readSframeTrailer,
  SFRAME_TRAILER_LEN,
  type KeyLookup,
  KeyManager,
  type RosterMember,
  createSessionKeypair,
} from '@dvconf/shared';

export const VP8_PT = 101;

/** Minimal RTCP Sender Report (PT=200) — VERBATIM from P5 / the M1 bench. */
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

/** VP8 RTP packet with an arbitrary opaque BODY after a real-VP8 header. VERBATIM from P5. */
export function makeVp8RtpWithBody(args: {
  ssrc: number;
  seq: number;
  ts: number;
  pictureId: number;
  body: Uint8Array;
  keyframe: boolean;
}): Buffer {
  const { ssrc, seq, ts, pictureId, body, keyframe } = args;

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
      0x9d, 0x01, 0x2a, // VP8 keyframe start code (G-MCS-1)
      0x80, 0x02, // width 640
      0xe0, 0x01, // height 480
    ]);
  } else {
    vp8PayloadHeader = Buffer.from([0x11, 0x00, 0x00]); // P-bit=1 => interframe
  }

  return Buffer.concat([header, desc, vp8PayloadHeader, Buffer.from(body)]);
}

/** REAL keying (production source) — drives the SHIPPED P1/P3 path, no crypto here. */
export async function realKeying(): Promise<{
  senderId: string;
  kid: number;
  encryptKey: CryptoKey;
  keyLookup: KeyLookup;
}> {
  const a = createSessionKeypair({ withOpener: true });
  const b = createSessionKeypair({ withOpener: true });
  const roster: RosterMember[] = [
    { peerId: 'peer-a', sessionPubkeyB64: a.publicKeyB64 },
    { peerId: 'peer-b', sessionPubkeyB64: b.publicKeyB64 },
  ];

  const meKm = new KeyManager({
    roomId: 'p10-relayblind-room',
    localSessionPubkeyB64: a.publicKeyB64,
    opener: a.opener!,
    graceWindowMs: 2000,
  });
  const otherKm = new KeyManager({
    roomId: 'p10-relayblind-room',
    localSessionPubkeyB64: b.publicKeyB64,
    opener: b.opener!,
    graceWindowMs: 2000,
  });
  meKm.setRoster(roster);
  otherKm.setRoster(roster);

  if (meKm.isCoordinator()) {
    const bundle = await meKm.bootstrapRoomKey();
    await otherKm.applyBundle(bundle);
  } else {
    const bundle = await otherKm.bootstrapRoomKey();
    await meKm.applyBundle(bundle);
  }

  const senderId = a.publicKeyB64;
  const kid = meKm.kid;
  const encryptKey = await meKm.contentKeyForSenderAtKid(senderId, kid);
  if (!encryptKey) throw new Error('realKeying: no K_content for the bootstrapped epoch');
  const keyLookup = meKm.keyLookupForSender(senderId);
  return { senderId, kid, encryptKey, keyLookup };
}

/** Locate the REAL partial-SFrame body in a FORWARDED VP8 RTP packet. VERBATIM from P5/P10. */
export function locateForwardedSframe(
  pkt: Buffer,
  kid: number,
  sentBodiesB64: Set<string>,
): { bodyOffset: number; kid: number; ctr: number } | null {
  const scanEnd = Math.min(pkt.length - SFRAME_TRAILER_LEN, 64);
  for (let off = 12; off < scanEnd; off++) {
    const cand = pkt.subarray(off);
    if (cand.length < SFRAME_TRAILER_LEN + 16) break; // too short to hold body + trailer
    if (sentBodiesB64.has(cand.toString('base64'))) {
      const trailer = readSframeTrailer(cand);
      void kid; // kid is asserted by the caller against trailer.kid
      return { bodyOffset: off, kid: trailer.kid, ctr: trailer.ctr };
    }
  }
  return null;
}
