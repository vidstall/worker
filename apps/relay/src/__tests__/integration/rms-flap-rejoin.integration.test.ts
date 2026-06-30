/**
 * REQ-RMS-035 / REQ-RMS-036 (part-3 REVERSE-leg lane) -- R-B Task B6b-5:
 * FORWARD flap-dedup + room-wide clearRoom teardown-rejoin on REAL mediasoup.
 *
 * This test VERIFIES two already-shipped production fixes on real Workers (it does
 * NOT re-implement them). Both fixes live in PrimaryPipeCoordinator
 * (packages/inter-relay-client/src/inter-relay.ts):
 *
 *   - B6b-3 (commit af62ca9) FORWARD flap-dedup. drain() gained a per-leg
 *     forwardPipedIds Set: it marks producer.id BEFORE piping, then a benign
 *     "already exists" -> continue / transient -> unmark + rethrow guard. WITHOUT
 *     this dedup a flap (onProducer called twice with the SAME producer id) makes
 *     drain call transport.consume() a 2nd time for the already-piped producer,
 *     so the SAME source is forwarded TWICE on one leg: a DUPLICATE piped consumer
 *     + a DUPLICATE forward announce. Test 1 drives that flap on real mediasoup and
 *     proves the pipe + announce happen EXACTLY once.
 *
 *     HONEST NOTE (real-mediasoup behaviour, verified by the production-revert teeth
 *     run, see REQ-RMS-035-B6b5-flap-red.log): on this mediasoup version a 2nd
 *     pipeTransport.consume() of an already-piped producer SUCCEEDS silently -- it
 *     does NOT throw "Consumer already exists" (the failure mode the UNIT mock in
 *     inter-relay-primary-coordinator.test.ts models). The observable RED is a
 *     SECOND announce (announces.length === 2), i.e. a duplicate forward leg. The
 *     production drain's try/catch additionally tolerates the "already exists" /
 *     "duplicate" throw that some mediasoup paths raise, but the primary averted bug
 *     proven here is the duplicate forward, asserted as exactly-once announce.
 *
 *   - B6b-4 (commit 37d9239) coordinator clearRoom(roomId). It drops EVERY
 *     (room, peer) leg across ALL peerRelayId buckets (states / reverseMintPending /
 *     reverseMintedIds / forwardPipedIds). clear(roomId) is DEFAULT-only and LEAKS
 *     non-DEFAULT cascade legs. Test 2 proves clearRoom is room-WIDE on a NON-DEFAULT
 *     'relay-B' cascade leg: a teardown-then-rejoin RE-announces (the leaked
 *     forwardPipedIds would otherwise dedup the rejoin to silence).
 *
 * REAL mediasoup (NOT a mock): two Workers => two child processes simulate the
 * primary + standby daemons. Synthetic Opus RTP via a DirectTransport producer +
 * producer.send(makeRtpPacket(...)). NO ffmpeg/browser/UDP.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-flap-rejoin.integration.test.ts
 *
 * Requirements touched: REQ-RMS-035 (forward flap-dedup), REQ-RMS-036 (clearRoom
 * room-wide teardown), REQ-RMS-026 (SSRC remap, inherited from the forward leg).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  PrimaryPipeCoordinator,
  createStandbyPipeTransport,
  produceLocalFromPipe,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';

// -- Shared codec set (mirrors mediasoup-manager.ts / rms-active-forward) ------

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
  },
];

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;
/** Constant Opus payload -- its bytes ride the TAIL of every RTP packet. */
const OPUS_PAYLOAD = Buffer.from([0xfc, 0xff, 0xfe]);

/** RED hook: with P10_FORCE_TAMPER=1, flip one media body byte on the forward hop. */
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';

/** A minimal well-formed Opus RTP packet (12-byte header + constant payload). */
function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2, no padding/ext/cc
  header[1] = OPUS_PT & 0x7f; // marker 0 + payload type
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, OPUS_PAYLOAD]);
}

const pipeProducerRtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: OPUS_PT,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: OPUS_SSRC }],
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** OS-assigned-port allocator (allocate => 0): rerun-safe, no EADDRINUSE. */
const zeroAllocator: PipePortAllocatorLike = {
  allocate: () => 0,
  release: () => {},
  size: () => 0,
};

// -- Module-scoped real mediasoup workers (spawned once) ----------------------
// Two workers => two child processes simulating the primary + standby daemons.

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

/** Synthetic real-RTP Opus producer on the PRIMARY router (DirectTransport src). */
async function makePrimaryRtpSource(): Promise<{
  producer: msTypes.Producer;
  start: () => void;
  stop: () => void;
}> {
  const directTransport = await primaryRouter.createDirectTransport();
  const producer = await directTransport.produce({
    kind: 'audio',
    rtpParameters: pipeProducerRtpParameters,
  });
  let seq = 0;
  let ts = 0;
  let interval: NodeJS.Timeout | null = null;
  return {
    producer,
    start: () => {
      interval = setInterval(() => {
        producer.send(makeRtpPacket(seq++, ts));
        ts += 960; // 20 ms @ 48 kHz
      }, 10);
    },
    stop: () => {
      if (interval !== null) clearInterval(interval);
    },
  };
}

/**
 * A second real Opus producer on the PRIMARY router with a DISTINCT SSRC. Used by
 * Test 2 (clearRoom): like rms-active-forward 4b/4d it asserts forwarding via
 * canConsume (deterministic) WITHOUT flowing RTP, so it never needs .send() -- only
 * a valid distinct SSRC (the RtpListener rejects a duplicate SSRC at produce time).
 */
async function makePrimaryProducerWithSsrc(ssrc: number): Promise<msTypes.Producer> {
  const directTransport = await primaryRouter.createDirectTransport();
  return directTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [
        {
          mimeType: 'audio/opus',
          payloadType: OPUS_PT,
          clockRate: 48000,
          channels: 2,
          parameters: {},
          rtcpFeedback: [],
        },
      ],
      encodings: [{ ssrc }],
    },
  });
}

type Announced = {
  producerId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
};

// -- Test 1 (REQ-RMS-035) -- FORWARD flap-dedup on REAL mediasoup --------------

describe('REQ-RMS-035 -- FORWARD flap-dedup: a SAME-producer flap re-onProducer pipes + announces EXACTLY once on real mediasoup (no DUPLICATE forward leg), media byte-identical (P10 RED hook = teeth)', () => {
  it('onProducer twice with the SAME producer id (standby link flap) does NOT re-pipe -> announce stays 1 (no duplicate forward), no throw, media still forwards byte-identical', async () => {
    const roomId = 'rms-flap-room';
    const src = await makePrimaryRtpSource(); // real producer on primaryRouter (A)

    // The standby's pipe transport (DEFAULT peer -- single standby). port:0 => OS-assigned.
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);

    // Drive the REAL PrimaryPipeCoordinator: it mints its OWN primary pipe in
    // onProducer, pipes the source onto it, announces the PIPED consumer, replies DOWN.
    const announces: Announced[] = [];
    const replies = new Map<string, PipeConnectParams>();
    const coordinator = new PrimaryPipeCoordinator({
      announcer: (_roomId, piped, _producerPeerId, _peerRelayId, rtpParameters) => {
        announces.push({
          producerId: piped.id,
          kind: piped.kind,
          rtpParameters: rtpParameters as msTypes.RtpParameters,
        });
      },
      portAllocator: zeroAllocator,
      paramSender: (_roomId, params, peer) => {
        replies.set(peer ?? DEFAULT_PEER_RELAY_ID, params);
      },
    });

    // -- S2 handshake + the SINGLE forward drive. --
    await coordinator.onStandbyConnectParams(roomId, {
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    });
    await coordinator.onProducer(roomId, primaryRouter, src.producer);

    // Announce fired EXACTLY once for the single source producer.
    expect(announces.length).toBe(1);
    const announced = announces[0]!;
    // The pipe REMAPS the SSRC (REQ-RMS-026); the announce carries the REMAPPED ssrc.
    const remappedSsrc = announced.rtpParameters.encodings?.[0]?.ssrc;
    expect(remappedSsrc).toBeDefined();
    expect(remappedSsrc).not.toBe(OPUS_SSRC);

    const reply = replies.get(DEFAULT_PEER_RELAY_ID);
    expect(reply).toBeDefined();

    // Standby completes the handshake + mints the LOCAL forwarded producer.
    await standbyPipe.connect({
      ip: reply!.ip,
      port: reply!.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const localProducer = await produceLocalFromPipe(standbyPipe, announced);
    expect(localProducer.id).toBe(announced.producerId);
    expect(
      standbyRouter.canConsume({
        producerId: localProducer.id,
        rtpCapabilities: standbyRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // -- Downstream sink on the standby -- observes real RTP forwarding. --
    const sinkTransport = await standbyRouter.createDirectTransport();
    const sink = await sinkTransport.consume({
      producerId: localProducer.id,
      rtpCapabilities: standbyRouter.rtpCapabilities,
      paused: false,
    });
    const captured: Buffer[] = [];
    sink.on('rtp', (pkt: Buffer) => {
      captured.push(Buffer.from(pkt));
      if (captured.length > 256) captured.shift();
    });

    // -- DRIVE real RTP: source -> primary pipe -> standby local producer -> sink. --
    src.start();
    const deadline = Date.now() + 4000;
    while (captured.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    await sleep(200);
    src.stop();

    expect(captured.length).toBeGreaterThan(0);
    const stats = await sink.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    // BODY byte-identity (header SSRC remapped by design). The constant Opus payload
    // rides the packet TAIL; the pipe remaps the header SSRC but never the body. The
    // P10 RED hook flips exactly one body byte so byteIdentical < mediaPackets -> the
    // byte-identity assertion FAILS (the teeth).
    let mediaPackets = 0;
    let byteIdentical = 0;
    for (const pkt of captured) {
      if (pkt.length < 12 + OPUS_PAYLOAD.length) continue; // sanity gate (real media)
      mediaPackets++;
      if (FORCE_TAMPER) {
        const ti = pkt.length - 1;
        pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff;
      }
      if (pkt.subarray(pkt.length - OPUS_PAYLOAD.length).equals(OPUS_PAYLOAD)) {
        byteIdentical++;
      }
    }
    expect(mediaPackets).toBeGreaterThan(0);
    expect(byteIdentical).toBe(mediaPackets); // teeth: P10 flips a byte -> FAIL

    // -- FLAP: re-onProducer the SAME producer id (standby link flap / re-attach). --
    // The flap is modeled IN-PROCESS at the onProducer seam (a 2nd same-id re-drive --
    // gap #3's re-fan trigger); it does NOT tear down/recreate the pipe transport. A
    // real WS-link drop/reopen is a separate daemon-layer concern (deferred, B6b-1).
    // WITHOUT the forwardPipedIds dedup, drain() re-pipes -> transport.consume() a
    // 2nd time for the already-piped producer. On this mediasoup version that 2nd
    // consume SUCCEEDS silently (it does NOT throw) and yields a DUPLICATE piped
    // consumer + a DUPLICATE forward announce (proven RED: announces.length === 2,
    // see REQ-RMS-035-B6b5-flap-red.log). WITH the dedup, drain() skips it
    // (piped.has -> continue): no duplicate, NO second announce, the already-minted
    // forward path stays intact. The plain await also asserts the flap does NOT throw.
    await coordinator.onProducer(roomId, primaryRouter, src.producer); // must NOT throw
    expect(announces.length).toBe(1); // exactly-once: no SECOND (duplicate) announce

    // Media still forwards after the flap (the local producer + pipe survived).
    captured.length = 0;
    src.start();
    const reDeadline = Date.now() + 4000;
    while (captured.length === 0 && Date.now() < reDeadline) {
      await sleep(50);
    }
    await sleep(200);
    src.stop();
    expect(captured.length).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-035 flap-dedup] announces=${announces.length} ` +
        `mediaPackets=${mediaPackets} byteIdentical=${byteIdentical} ` +
        `remappedSsrc=0x${(remappedSsrc ?? 0).toString(16)} sourceSsrc=0x${OPUS_SSRC.toString(16)} ` +
        `reflowCaptured=${captured.length}${FORCE_TAMPER ? ' [P10 RED HOOK]' : ''}`,
    );

    // -- cleanup --
    src.stop();
    try {
      sink.close();
      sinkTransport.close();
      localProducer.close();
      standbyPipe.close();
      src.producer.close();
    } catch {
      /* best-effort */
    }
    coordinator.clear(roomId);
  }, 30_000);
});

// -- Test 2 (REQ-RMS-036) -- clearRoom room-wide teardown-rejoin (NON-DEFAULT) -

describe('REQ-RMS-036 -- clearRoom room-wide teardown-rejoin on a NON-DEFAULT cascade leg (real mediasoup): a leaked clear() would dedup the rejoin to silence; clearRoom drops the relay-B leg room-wide so a rejoin RE-announces on a FRESH pipe', () => {
  it('clearRoom drops the relay-B cascade leg room-wide -> a rejoin of the SAME source producer re-announces (#2) + mints a FRESH pipe transport, canConsume on the fresh leg', async () => {
    const roomId = 'rms-clearroom-room';
    const CASCADE_PEER = 'relay-B'; // NON-DEFAULT: proves clearRoom is room-WIDE, not just DEFAULT
    // Distinct SSRC; canConsume-only (no RTP flow) -- forwarding proven like 4b/4d.
    const src = await makePrimaryProducerWithSsrc(0x0b0b0b01);

    const announces: Announced[] = [];
    const replies: PipeConnectParams[] = [];
    const coordinator = new PrimaryPipeCoordinator({
      announcer: (_roomId, piped, _producerPeerId, _peerRelayId, rtpParameters) => {
        announces.push({
          producerId: piped.id,
          kind: piped.kind,
          rtpParameters: rtpParameters as msTypes.RtpParameters,
        });
      },
      portAllocator: zeroAllocator,
      paramSender: (_roomId, params) => {
        replies.push(params);
      },
    });

    // -- FIRST JOIN on the relay-B cascade leg. --
    const standbyPipe1 = await createStandbyPipeTransport(standbyRouter, 0);
    await coordinator.onStandbyConnectParams(
      roomId,
      { ip: '127.0.0.1', port: standbyPipe1.tuple.localPort },
      CASCADE_PEER,
    );
    await coordinator.onProducer(roomId, primaryRouter, src, CASCADE_PEER);
    expect(announces.length).toBe(1);
    expect(replies.length).toBe(1);
    const reply1 = replies[0]!;
    await standbyPipe1.connect({
      ip: reply1.ip,
      port: reply1.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const local1 = await produceLocalFromPipe(standbyPipe1, announces[0]!);
    expect(local1.id).toBe(announces[0]!.producerId);
    expect(
      standbyRouter.canConsume({
        producerId: local1.id,
        rtpCapabilities: standbyRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // -- TEARDOWN: room-wide clear (mirrors index.ts releaseRoom -> primaryPipe.clearRoom).
    //    TEETH: swapping this to coordinator.clear(roomId) (DEFAULT-only) LEAKS the relay-B
    //    leg -- a stale forwardPipedIds + a still-live pipe transport -- so the rejoin
    //    onProducer is deduped (piped.has -> continue): NO second announce -> the
    //    announces.length === 2 assertion below FAILS (RED). --
    coordinator.clearRoom(roomId);
    try {
      local1.close();
      standbyPipe1.close();
    } catch {
      /* best-effort */
    }

    // -- REJOIN: a FRESH standby pipe, the SAME source producer id, the SAME relay-B leg. --
    const standbyPipe2 = await createStandbyPipeTransport(standbyRouter, 0);
    await coordinator.onStandbyConnectParams(
      roomId,
      { ip: '127.0.0.1', port: standbyPipe2.tuple.localPort },
      CASCADE_PEER,
    );
    await coordinator.onProducer(roomId, primaryRouter, src, CASCADE_PEER);

    // The relay-B leg was dropped ROOM-WIDE -> a NEW announce fired for the SAME source
    // producer (the forward dedup for the non-DEFAULT leg was cleared) + a FRESH pipe
    // transport was minted (a fresh DOWN reply, a distinct piped consumer id).
    expect(announces.length).toBe(2); // teeth: clear() leaks -> stays 1 -> FAILS
    expect(replies.length).toBe(2); // fresh mint -> fresh DOWN reply
    expect(announces[1]!.producerId).not.toBe(announces[0]!.producerId); // distinct piped consumer

    const reply2 = replies[1]!;
    await standbyPipe2.connect({
      ip: reply2.ip,
      port: reply2.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const local2 = await produceLocalFromPipe(standbyPipe2, announces[1]!);
    expect(local2.id).toBe(announces[1]!.producerId);
    expect(
      standbyRouter.canConsume({
        producerId: local2.id,
        rtpCapabilities: standbyRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-036 clearRoom] cascadePeer=${CASCADE_PEER} announces=${announces.length} ` +
        `replies=${replies.length} firstPiped=${announces[0]!.producerId} ` +
        `secondPiped=${announces[1]!.producerId}`,
    );

    // -- cleanup --
    coordinator.clearRoom(roomId);
    try {
      local2.close();
      standbyPipe2.close();
      src.close();
    } catch {
      /* best-effort */
    }
  }, 30_000);
});
