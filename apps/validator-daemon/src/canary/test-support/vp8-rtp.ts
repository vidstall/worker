/**
 * VP8 RTP test helpers — build a VP8 RTP packet carrying an opaque BODY (the canary
 * SFrame) at the packet TAIL, plus a minimal RTCP Sender Report. Promoted verbatim from
 * canary-realmedia-detection.integration.test.ts so the M2b capture-core proof reuses them.
 * TEST scaffolding only (not production runtime).
 */
export const VP8_PT = 101;

/** Build a VP8 RTP packet carrying an opaque BODY (the canary SFrame) after a real-VP8 header. */
export function makeVp8RtpWithBody(args: {
  ssrc: number; seq: number; ts: number; pictureId: number; body: Uint8Array; keyframe: boolean;
}): Buffer {
  const { ssrc, seq, ts, pictureId, body, keyframe } = args;
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (VP8_PT & 0x7f) | 0x80;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  const desc = Buffer.from([0x90, 0x80, 0x80 | ((pictureId >> 8) & 0x7f), pictureId & 0xff]);
  const vp8PayloadHeader = keyframe
    ? Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01])
    : Buffer.from([0x11, 0x00, 0x00]);
  return Buffer.concat([header, desc, vp8PayloadHeader, Buffer.from(body)]);
}

/** Minimal RTCP Sender Report (PT=200) so each SSRC has a non-zero GetSenderReportNtpMs(). */
export function makeRtcpSenderReport(
  ssrc: number, rtpTimestamp: number, packetCount: number, octetCount: number,
): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80;
  buf[1] = 200;
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
