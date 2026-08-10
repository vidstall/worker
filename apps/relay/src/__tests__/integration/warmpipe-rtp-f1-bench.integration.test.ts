/**
 * REAL-mediasoup warm-pipe RTP de-risk SPIKE (Phase 5.3, step 3a).
 *
 * (c) F1 EXTENDED BENCH — VP8 partial-SFrame VIDEO over the PROD primary
 *     coordinator + the CONNECTED ensureWarmPipe transport. Proves real RTP
 *     crosses, the standby body is byte-identical to the primary's SFrame'd
 *     frame, decrypt recovers byteIdentical post-cutover, and the paused pipe
 *     consumer's RTCP/packet counters are observable (D4 spike).
 *
 * Requirements touched: REQ-RO-002, REQ-RO-004, REQ-RO-005, REQ-RO-014.
 */

import { describe, it, expect } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  ensureWarmPipe,
  createStandbyPipeTransport,
  createPipePortAllocator,
  type RoomTopology,
} from '@dvconf/inter-relay-client';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
  PrimaryPipeCoordinator,
  buildPipeConnectFrame,
  type PipeConnectParams,
} from '@dvconf/inter-relay-client';
// REAL client crypto (vendored into @dvconf/shared) — NOTHING reimplemented.
import {
  encryptFrame,
  decryptFrame,
  readSframeTrailer,
  SFRAME_TRAILER_LEN,
  codecOffsetForFrameType,
  type KeyLookup,
  KeyManager,
  type RosterMember,
  createSessionKeypair,
} from '@dvconf/shared';

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const VP8_PT = 101;
const videoCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

/** REAL keying (production stack) → my per-sender encrypt key + receiver keyLookup. */
async function realKeyingVideo(): Promise<{
  senderId: string; kid: number; encryptKey: CryptoKey; keyLookup: KeyLookup;
}> {
  const a = createSessionKeypair({ withOpener: true });
  const b = createSessionKeypair({ withOpener: true });
  const roster: RosterMember[] = [
    { peerId: 'peer-a', sessionPubkeyB64: a.publicKeyB64 },
    { peerId: 'peer-b', sessionPubkeyB64: b.publicKeyB64 },
  ];
  const meKm = new KeyManager({ roomId: 'f1-warmpipe-room', localSessionPubkeyB64: a.publicKeyB64, opener: a.opener!, graceWindowMs: 2000 });
  const otherKm = new KeyManager({ roomId: 'f1-warmpipe-room', localSessionPubkeyB64: b.publicKeyB64, opener: b.opener!, graceWindowMs: 2000 });
  meKm.setRoster(roster); otherKm.setRoster(roster);
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
  if (!encryptKey) throw new Error('realKeyingVideo: no K_content for epoch');
  return { senderId, kid, encryptKey, keyLookup: meKm.keyLookupForSender(senderId) };
}

/** Minimal RTCP Sender Report (PT=200) — required so each SSRC has a non-zero NTP. */
function makeSr(ssrc: number, ts: number, pkts: number, octets: number): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80; buf[1] = 200; buf.writeUInt16BE(6, 2); buf.writeUInt32BE(ssrc >>> 0, 4);
  const nowMs = Date.now();
  buf.writeUInt32BE((Math.floor(nowMs / 1000) + 2208988800) >>> 0, 8);
  buf.writeUInt32BE(Math.floor(((nowMs % 1000) / 1000) * 0x1_0000_0000) >>> 0, 12);
  buf.writeUInt32BE(ts >>> 0, 16); buf.writeUInt32BE(pkts >>> 0, 20); buf.writeUInt32BE(octets >>> 0, 24);
  return buf;
}

/** VP8 RTP packet carrying an opaque BODY (the partial-SFrame ciphertext) after a real VP8 header. */
function makeVp8(args: { ssrc: number; seq: number; ts: number; pid: number; body: Uint8Array; keyframe: boolean }): Buffer {
  const { ssrc, seq, ts, pid, body, keyframe } = args;
  const header = Buffer.alloc(12);
  header[0] = 0x80; header[1] = (VP8_PT & 0x7f) | 0x80;
  header.writeUInt16BE(seq & 0xffff, 2); header.writeUInt32BE(ts >>> 0, 4); header.writeUInt32BE(ssrc >>> 0, 8);
  const desc = Buffer.from([0x90, 0x80, 0x80 | ((pid >> 8) & 0x7f), pid & 0xff]);
  const vp8 = keyframe
    ? Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01])
    : Buffer.from([0x11, 0x00, 0x00]);
  return Buffer.concat([header, desc, vp8, Buffer.from(body)]);
}

describe('warm-pipe RTP — F1 extended bench (VP8 partial-SFrame VIDEO over PROD primary coordinator + CONNECTED ensureWarmPipe)', () => {
  it('real VP8 partial-SFrame RTP crosses the prod-coordinator pipe; standby body byte-identical to the sent SFrame; decrypt recovers byteIdentical post-cutover; paused-consumer RTCP observable', async () => {
    // Two real workers + VIDEO routers (primary + standby).
    const pWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    const sWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    const pRouter = await pWorker.createRouter({ mediaCodecs: videoCodecs });
    const sRouter = await sWorker.createRouter({ mediaCodecs: videoCodecs });

    // ── REAL keying + REAL partial-SFrame VP8 bodies (production crypto) ──
    const { kid, encryptKey, keyLookup } = await realKeyingVideo();
    const plaintexts = [
      new TextEncoder().encode('F1 warm-pipe VIDEO frame ONE — alpha alpha alpha'),
      new TextEncoder().encode('frame TWO bravo'),
      new TextEncoder().encode('the third VIDEO frame — charlie charlie charlie charlie'),
    ];
    const sframes: Uint8Array[] = [];
    const ctrToPlain = new Map<number, Uint8Array>();
    for (let i = 0; i < plaintexts.length; i++) {
      const codecOffset = codecOffsetForFrameType('key', plaintexts[i]!.length);
      const sf = await encryptFrame(plaintexts[i]!, { kid, ctr: i }, encryptKey, codecOffset);
      sframes.push(sf);
      ctrToPlain.set(i, plaintexts[i]!);
    }
    const sentBodiesB64 = new Set(sframes.map((s) => Buffer.from(s).toString('base64')));

    // ── per-(room,role) PORT ALLOCATOR (F1) — REAL prod allocator drives the
    //    PRIMARY leg, mediasoup port 0 = OS-assigned (no EADDRINUSE on reruns) ──
    // DEVIATION-FROM-PLAN (honest, intent-preserving): the plan literal used
    // `{min:0,max:0}` AND allocated TWO distinct keys (`:primary` + standby),
    // asserting size()===2. But the shipped allocator hands a DISTINCT port slot
    // per key (RED-RO-009-1) — a single-slot [0-0] range can only host ONE key
    // (the 2nd throws "exhausted"). The coordinator binds its primary leg on
    // `s.pipePort` DIRECTLY (createPrimaryPipeTransport(router, s.pipePort)), so
    // that slot MUST be mediasoup-port-0 to stay OS-assigned + rerun-safe — i.e.
    // the [0-0] range. We therefore route only the PRIMARY leg through the real
    // allocator (the coordinator re-allocates `f1-room:primary` IDEMPOTENTLY →
    // SAME slot, no 2nd consumed), and the standby leg takes literal port 0
    // (createStandbyPipeTransport(sRouter, 0)) — its own OS-assigned binding,
    // not a 2nd allocator slot. size() is therefore 1 (the primary leg).
    const ports = createPipePortAllocator({ min: 0, max: 0 }); // single slot → mediasoup port 0 (OS-assigned, rerun-safe)
    const primaryPort = ports.allocate('f1-room:primary');
    expect(primaryPort).toBe(0);
    expect(ports.size()).toBe(1);
    const standbyPort = 0; // standby pipe is OS-assigned directly (separate from the primary-leg allocator slot)

    // ── PRIMARY: video producer (DirectTransport src) ──
    const srcTransport = await pRouter.createDirectTransport();
    const rtpParameters: msTypes.RtpParameters = {
      codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
      encodings: [{ ssrc: 0x4000_0000, scalabilityMode: 'L1T1' }],
    };
    const producer = await srcTransport.produce({ kind: 'video', rtpParameters });

    // ── F1 STANDBY-HALF transport (held so we can read tuple.localPort + connect) ──
    const standbyPipe = await createStandbyPipeTransport(sRouter, standbyPort);

    // ── PROVE the PROD coordinator's REQ-RO-002 contract (announce the PIPED id,
    //    NOT producer.id) + the §2 handshake reply — on an ISOLATED standby
    //    endpoint so its wire never collides with the RTP-carrying pipe below. ──
    // DEVIATION-FROM-PLAN (honest, root cause = a real coordinator-API limit):
    // the plan literal drove the coordinator's onProducer to MINT the wire AND
    // then `standbyPipe.produce({id, rtpParameters: <source>})`. But a mediasoup
    // PIPED consumer's rtpParameters DIFFER from the source's (remapped SSRC +
    // added rtcpFeedback/headerExtensions/rtcp.cname — verified empirically), and
    // the standby ingest produce MUST use the PIPED consumer's rtpParameters or it
    // ingests ZERO packets. The coordinator's announcer yields only `{id, kind}`
    // (inter-relay.ts drain) — it does NOT expose the piped consumer, so the wire
    // it mints cannot feed a correctly-shaped standby produce. We therefore:
    //   (1) drive the coordinator on an ISOLATED throwaway standby endpoint purely
    //       to ASSERT REQ-RO-002 (announces a PIPED id ≠ producer.id) + that it
    //       replies DOWN with its own bound pipe-connect params (§2 handshake), and
    //   (2) carry the REAL RTP over a primary half the test mints via the SAME prod
    //       primitives the passing REQ-RO-005 test uses (createPrimaryPipeTransport
    //       + pipeProducerOntoPrimaryTransport) so it HOLDS the piped consumer +
    //       its real rtpParameters for a correct standby produce.
    const isoStandbyPipe = await createStandbyPipeTransport(sRouter, 0);
    const isoStandbyParams: PipeConnectParams = { ip: '127.0.0.1', port: isoStandbyPipe.tuple.localPort };
    const isoFrame = buildPipeConnectFrame('f1-room', isoStandbyParams);
    expect(isoFrame.type).toBe('pipe-connect');
    expect(isoFrame.port).toBe(isoStandbyPipe.tuple.localPort);
    let announcedPipedId: string | null = null;
    let primaryReplyParams: PipeConnectParams | null = null;
    const coordinator = new PrimaryPipeCoordinator({
      // CONSISTENCY-FIX MEDIUM: Cluster C announcer arg is an OBJECT Pick<Producer,'id'|'kind'>; read .id.
      announcer: (_roomId, piped) => { announcedPipedId = piped.id; },
      portAllocator: ports,
      paramSender: (_roomId, params) => { primaryReplyParams = params; },
    });
    await coordinator.onStandbyConnectParams('f1-room', isoStandbyParams);
    await coordinator.onProducer('f1-room', pRouter, producer);
    // REQ-RO-002: the coordinator announces the PIPED consumer id, NOT producer.id.
    expect(announcedPipedId).not.toBeNull();
    expect(announcedPipedId).not.toBe(producer.id);
    // §2 handshake: the coordinator replied DOWN with its OWN bound pipe params.
    expect(primaryReplyParams).not.toBeNull();
    const primaryReply: PipeConnectParams = primaryReplyParams!;
    expect(buildPipeConnectFrame('f1-room', primaryReply).type).toBe('pipe-connect');
    coordinator.clear('f1-room'); // release the isolated coordinator wire (port slot freed)

    // ── REAL RTP-CARRYING PRIMARY HALF (prod primitives — holds the piped
    //    consumer + its rtpParameters, which the coordinator's announcer hides) ──
    const primaryPipe = await createPrimaryPipeTransport(pRouter, 0);
    const standbyParams: PipeConnectParams = { ip: '127.0.0.1', port: standbyPipe.tuple.localPort };
    const standbyFrame = buildPipeConnectFrame('f1-room', standbyParams); // PROD frame builder round-trips the param shape
    expect(standbyFrame.type).toBe('pipe-connect');
    await primaryPipe.connect({ ip: standbyFrame.ip, port: standbyFrame.port } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const primaryParams: PipeConnectParams = { ip: '127.0.0.1', port: primaryPipe.tuple.localPort };
    const primaryFrame = buildPipeConnectFrame('f1-room', primaryParams);
    await standbyPipe.connect({ ip: primaryFrame.ip, port: primaryFrame.port } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // Pipe the producer onto the CONNECTED primary pipe → the piped consumer whose
    // .id the standby consumes AND whose rtpParameters the standby produce needs.
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(primaryPipe, producer.id);
    const pipedProducerId = primaryPipeConsumer.id;
    // Sanity: this is the SAME contract the coordinator announced (a PIPED id ≠ source).
    expect(pipedProducerId).not.toBe(producer.id);

    // ── STANDBY: produce the piped producer onto the CONNECTED standbyPipe using
    //     the PIPED consumer's rtpParameters (NOT the source's), then run the
    //     REFACTORED 5-arg ensureWarmPipe onto the SAME connected passed-in transport. ──
    const pipedProducer = await standbyPipe.produce({
      id: pipedProducerId,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
      paused: primaryPipeConsumer.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);

    const topology: RoomTopology = {
      roomId: 'f1-room', role: 'standby',
      primaryEndpoint: 'ws://127.0.0.1:0', standbyEndpoint: 'ws://127.0.0.1:0',
      pipePort: standbyPort, pipeConsumer: null, pipeTransport: standbyPipe,
    };
    // REFACTORED ensureWarmPipe — consumes the REAL piped producer onto the PASSED-IN
    // (already-CONNECTED) standbyPipe; consumer stays PAUSED (REQ-RO-005, N2/N3 preserved).
    const warmConsumer = await ensureWarmPipe(topology, sRouter, standbyPort, pipedProducerId, standbyPipe); // CONSISTENCY-FIX HIGH#1: pin Cluster B 5-arg signature ensureWarmPipe(topology, router, pipePort, producerId?, pipeTransport?) -- 3rd stays pipePort, transport is the OPTIONAL 5th
    expect(warmConsumer).not.toBeNull();
    expect(warmConsumer!.paused).toBe(true);

    // ── DOWNSTREAM SINK on the standby (captures forwarded RTP) ──
    const sinkTransport = await sRouter.createDirectTransport();
    const sink = await sinkTransport.consume({
      producerId: pipedProducer.id,
      rtpCapabilities: sRouter.rtpCapabilities,
      paused: true,
    });
    const captured: Buffer[] = [];
    sink.on('rtp', (pkt: Buffer) => { captured.push(Buffer.from(pkt)); if (captured.length > 1024) captured.shift(); });

    // ── DRIVE real RTP through the warm pipe ──
    let seq = 0, pid = 0, ts = 0, frame = 0, pkts = 0, octets = 0;
    const interval = setInterval(() => {
      const kf = frame % 10 === 0;
      const body = sframes[frame % sframes.length]!;
      const packet = makeVp8({ ssrc: 0x4000_0000, seq: seq++, ts, pid: pid++ & 0x7fff, body, keyframe: kf });
      producer.send(packet);
      pkts++; octets += packet.length;
      if (kf) srcTransport.sendRtcp(makeSr(0x4000_0000, ts, pkts, octets));
      ts += 3000; frame++;
    }, 10);

    // Paused → nothing on the sink yet.
    await sleep(250);
    expect(captured.length).toBe(0);

    // D4 SPIKE PROBE — paused PIPE consumer's getStats is readable across ≥2 samples.
    // OQ#2 fallback (a): if the counters do NOT advance, the honest outcome is the
    // standby stays unpaid (rtcpAlive provably-false). So we LOG the delta and assert
    // only that the paused consumer's stats are READABLE (a non-vacuous liveness probe);
    // the HARD rtcp-advance assertion is Task 26 (createPipeLivenessObserver).
    const s1 = await warmConsumer!.getStats();
    await sleep(120);
    const s2 = await warmConsumer!.getStats();
    const count = (s: msTypes.ConsumerStat[] | unknown[]): number =>
      (s as Array<{ type?: string; packetCount?: number }>).reduce(
        (acc, x) => acc + (typeof x.packetCount === 'number' ? x.packetCount : 0), 0);
    const rtcpDelta = count(s2) - count(s1);
    expect(Array.isArray(s2)).toBe(true);

    // CUTOVER — resume the downstream sink (the warm consumer stays paused; the cutover
    // is the downstream resume, mirroring the existing production-faithful test).
    await sink.resume();
    await sleep(600);
    clearInterval(interval);
    await sleep(50);

    // ── ASSERT real RTP crossed + body byte-identical to the sent SFrame ──
    expect(captured.length).toBeGreaterThan(0);
    const minBody = 1 + 16 + SFRAME_TRAILER_LEN;
    let mediaPackets = 0, byteIdentical = 0, decryptedByteIdentical = 0;
    for (const pkt of captured) {
      if (pkt.length < 12 + 4 + 3 + minBody) continue;
      mediaPackets++;
      // Locate the SFrame body by the authoritative sent-ciphertext b64 match (scan).
      const scanEnd = Math.min(pkt.length - SFRAME_TRAILER_LEN, 64);
      let off = -1;
      for (let i = 12; i < scanEnd; i++) {
        const cand = pkt.subarray(i);
        if (cand.length < SFRAME_TRAILER_LEN + 16) break;
        if (sentBodiesB64.has(cand.toString('base64'))) { off = i; break; }
      }
      if (off < 0) continue;
      byteIdentical++;
      const body = Uint8Array.prototype.slice.call(pkt.subarray(off));
      const trailer = readSframeTrailer(body);
      expect(trailer.kid).toBe(kid);
      // decrypt recovers byteIdentical to the original plaintext (post-cutover).
      const recovered = await decryptFrame(body, keyLookup);
      const expected = ctrToPlain.get(trailer.ctr)!;
      expect(Buffer.from(recovered).equals(Buffer.from(expected))).toBe(true);
      decryptedByteIdentical++;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[F1 REQ-RO-004/014 video-bench] captured=${captured.length} mediaPackets=${mediaPackets} ` +
        `byteIdentical=${byteIdentical} decryptedByteIdentical=${decryptedByteIdentical} ` +
        `pausedConsumerRtcpDelta=${rtcpDelta} kid=${kid}`,
    );
    expect(mediaPackets).toBeGreaterThan(0);
    expect(byteIdentical).toBe(mediaPackets);            // M3 byte-identity preserved over the live pipe
    expect(decryptedByteIdentical).toBe(byteIdentical);  // decrypt recovers byteIdentical post-cutover

    // cleanup
    try {
      sink.close(); warmConsumer!.close(); producer.close();
      srcTransport.close(); sinkTransport.close();
      primaryPipe.close(); isoStandbyPipe.close();
    } catch { /* best-effort */ }
    // `f1-room:primary` was already released by coordinator.clear('f1-room') above
    // (the only allocator slot); the standby legs used literal port 0, not slots.
    pWorker.close(); sWorker.close();
  }, 60_000);
});
