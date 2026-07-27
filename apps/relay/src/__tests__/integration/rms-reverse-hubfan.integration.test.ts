/**
 * REQ-RMS-035/036 (part-3 REVERSE leg) -- R-B Task B6b-2: the LIVE hub-fan DOWN +
 * exclude-origin, proven on REAL mediasoup routers by driving the SHIPPED
 * createSignalingServer.registerReverseMinted closure (signaling.ts:1989-2032).
 *
 * Sibling of rms-reverse-fan.integration.test.ts (B6a). B6a is COORDINATOR-level:
 * the onReverseMinted spy IS the fan seam, and it proves only the queued-then-
 * drained mint fires the callback on real mediasoup with the DEFAULT peer. B6a
 * does NOT cover the live signaling-layer hub-fan DOWN to NON-DEFAULT cascade
 * peers + the exclude-origin loop. THAT gap is this test.
 *
 * NOT a mock of the mechanism (anti-tautology): the test calls the REAL
 * server.registerReverseMinted returned by createSignalingServer -- the shipped
 * closure that closes over the real `rooms`, `originRegistry`, `fanLocalProducer`,
 * and the `interRelaySockets` map we pass as providedSockets. The exclude-origin
 * decision (`if (p === originRelayId) continue;`, signaling.ts:2017) lives ONLY in
 * production. The onPrimaryProducer spy contains ZERO filter logic -- it only
 * records which peers the REAL loop chose. Delete the production `continue` and the
 * test goes RED (origin reappears, length 2). The room.router is a REAL mediasoup
 * router (fed through the manager), the cascade peer C consumes the hub-fanned
 * producer byte-identical end-to-end, and P10_FORCE_TAMPER is the RED-hook teeth.
 *
 * SCOPE (defensible, documented): `minted` is a real Opus producer ON the real
 * room.router (== primaryRouter), attributed to origin standby-B via the
 * originRelayId argument -- exactly what the exclude-origin loop inspects. The
 * physical UP reverse-mint leg (standby-B media piped UP and minted onto the
 * primary) is already proven on real mediasoup by B6a (rms-reverse-fan) and the
 * reverse-leg integration test; re-piping it here would only double the RTP-settle
 * flake surface for fidelity B6b-2 does not own. standby-B is the EXCLUDED origin,
 * so it never receives media -- a stub socket key is the faithful representation;
 * only the non-origin cascade peer C needs a real router (for the byte-id forward).
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-reverse-hubfan.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { WebSocket, WebSocketServer } from 'ws';
import {
  produceLocalFromPipe,
  createPrimaryPipeTransport,
  createStandbyPipeTransport,
  pipeProducerOntoPrimaryTransport,
  InterRelayProducerRegistry,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import { createSignalingServer, type InterRelayContext } from '../../signaling/index.js';
import { createInterRelaySocketMap } from '../../inter-relay-socket-map.js';
import { MetricsTracker } from '../../metrics.js';
import type { MediasoupManager } from '../../mediasoup-manager.js';

// -- Shared codec / RTP fixtures (mirror rms-active-forward) -----------------------
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 100 },
];
const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;
/** Constant Opus payload -- rides the TAIL of every RTP packet (body, never remapped). */
const OPUS_PAYLOAD = Buffer.from([0xfc, 0xff, 0xfe]);
/** RED hook: with P10_FORCE_TAMPER=1, flip one media body byte on the DOWN hop. */
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';

function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2
  header[1] = OPUS_PT & 0x7f; // marker 0 + PT
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, OPUS_PAYLOAD]);
}
const pipeProducerRtpParameters: msTypes.RtpParameters = {
  codecs: [{ mimeType: 'audio/opus', payloadType: OPUS_PT, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc: OPUS_SSRC }],
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- Module-scoped real Workers: primary (room.router + minted) + C (DOWN sink) ----
// standby-B is the EXCLUDED origin -- it needs no real router (a stub socket key
// represents it; the exclude-origin loop never fans media to it).
let primaryWorker: msTypes.Worker;
let workerC: msTypes.Worker;
let primaryRouter: msTypes.Router; // == room.router (fed through the manager mock)
let routerC: msTypes.Router;       // standby-C HOME router (hub-fan DOWN sink)

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  workerC = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  routerC = await workerC.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  workerC?.close();
});

/** A real Opus source on the given router (DirectTransport) -- the hub copy. */
async function makeRtpSourceOn(
  router: msTypes.Router,
): Promise<{ producer: msTypes.Producer; start: () => void; stop: () => void }> {
  const dt = await router.createDirectTransport();
  const producer = await dt.produce({ kind: 'audio', rtpParameters: pipeProducerRtpParameters });
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

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as never;
}

/**
 * Manager whose createRouter returns the REAL primaryRouter, so room.router is real
 * (the shipped registerReverseMinted passes room.router to onPrimaryProducer, and
 * `minted` lives on that same router -- the production invariant). handleJoin only
 * needs manager.createRouter + getNextWorker at join time; a real router tolerates
 * the best-effort AudioLevelObserver attach and is never closed mid-test (room.router
 * .close() fires ONLY on last-peer disconnect, signaling.ts:1881 -- after assertions).
 */
function managerWithRealRouter(real: msTypes.Router): MediasoupManager {
  return {
    workers: [{ pid: 1 } as unknown as msTypes.Worker],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(real),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

type B6bServer = ReturnType<typeof createSignalingServer>;

/** Start the REAL signaling server with interRelay (5th) + providedSockets (6th). */
function startSignaling(
  interRelay: InterRelayContext,
  manager: MediasoupManager,
  sockets: ReturnType<typeof createInterRelaySocketMap>,
): Promise<{ server: B6bServer; port: number }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    delete process.env['INTER_RELAY_TOKEN']; // single-host bench: token gate open
    const server = createSignalingServer(manager, new MetricsTracker(), mockLogger(), undefined, interRelay, sockets);
    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;
    server.wss.on('listening', () => {
      const addr = server.wss.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function connectPlain(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const reply = JSON.parse(data.toString()) as Record<string, unknown>;
      if (reply['type'] === expectType) {
        ws.off('message', onMessage);
        resolve(reply);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}

let openServer: WebSocketServer | undefined;
let openClient: WebSocket | undefined;
afterEach(() => {
  // Close client + wss LAST (best-effort). Closing the client empties the room ->
  // room.router.close() fires; that is the module-scoped primaryRouter, so this runs
  // only AFTER all assertions. Never call server.closeRooms() here.
  try { openClient?.close(); } catch { /* best-effort */ }
  openClient = undefined;
  if (openServer) { try { openServer.close(); } catch { /* best-effort */ } openServer = undefined; }
});

describe('REQ-RMS-035/036 -- part-3 REVERSE hub-fan DOWN: registerReverseMinted fans to non-origin standbys, excludes origin (real routers)', () => {
  it('drives the REAL registerReverseMinted -- hub-fans DOWN to standby-C (RMS-035) but NEVER to origin standby-B (RMS-036); the selected hub producer is byte-identical when piped to C router (P10 RED hook = teeth)', async () => {
    const roomId = 'rms-reverse-hubfan-room';
    const ORIGIN = 'standby-B';        // origin of the reverse announce -- MUST be excluded
    const OTHER = 'standby-C';         // non-origin cascade peer -- MUST receive
    const ORIGINAL_PUBLISHER = 'alice-publisher';

    // (1) REAL inter-relay socket map with BOTH cascade peers attached. The shipped
    //     loop iterates THIS map's keys() (signaling.ts:2016) because we pass it as
    //     providedSockets (bound at signaling.ts:682). Stubs only need {readyState, send}.
    const sockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    sockets.attach(ORIGIN, stub());
    sockets.attach(OTHER, stub());

    // (2) onPrimaryProducer SPY -- the OBSERVATION seam. Records WHICH peers the REAL
    //     loop called. It contains ZERO exclude logic (anti-tautology).
    const onPrimaryProducerCalls: Array<{
      roomId: string; router: msTypes.Router; producer: msTypes.Producer; peerRelayId?: string; producerPeerId?: string;
    }> = [];
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: () => {},
      onPrimaryProducer: (rid, router, producer, peerRelayId, producerPeerId) => {
        onPrimaryProducerCalls.push({ roomId: rid, router, producer, peerRelayId, producerPeerId });
      },
    };

    // (3) Start the REAL signaling server (room.router == real primaryRouter).
    const { server, port } = await startSignaling(interRelay, managerWithRealRouter(primaryRouter), sockets);
    openServer = server.wss;

    // (4) Join ONE local client so the room exists (rooms.get(roomId) != null) AND so
    //     the local fan (fanLocalProducer inside registerReverseMinted) has a target.
    const client = await connectPlain(port);
    openClient = client;
    const localFans: Array<Record<string, unknown>> = [];
    await sendAndAwait(client, { type: 'join', roomId, peerId: 'primary-local-listener' }, 'routerRtpCapabilities');
    client.on('message', (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === 'newProducer') localFans.push(m);
    });
    expect(server.getRoom(roomId)).toBeDefined(); // clear failure if room creation regressed

    // (5) The REAL hub copy: a real Opus producer ON the real room.router. Attributed
    //     to origin standby-B via the originRelayId arg below (the up reverse-mint leg
    //     that births this copy is proven on real mediasoup by B6a -- see header SCOPE).
    const src = await makeRtpSourceOn(primaryRouter);
    const minted = src.producer;
    expect(primaryRouter.canConsume({ producerId: minted.id, rtpCapabilities: primaryRouter.rtpCapabilities })).toBe(true);

    // (6) DRIVE THE REAL SEAM. server.registerReverseMinted IS the shipped closure
    //     (signaling.ts:1989-2032); its exclude-origin loop runs for real over our map.
    server.registerReverseMinted(roomId, minted, ORIGIN, ORIGINAL_PUBLISHER);

    // -- ASSERTION A (REQ-RMS-035/036, DETERMINISTIC, the must-pass teeth) --
    const calledPeers = onPrimaryProducerCalls.map((c) => c.peerRelayId);
    expect(calledPeers).toContain(OTHER);        // RMS-035: non-origin standby IS fanned
    expect(calledPeers).not.toContain(ORIGIN);   // RMS-036: origin is NEVER echoed back
    expect(onPrimaryProducerCalls).toHaveLength(1);
    const cascade = onPrimaryProducerCalls.find((c) => c.peerRelayId === OTHER)!;
    expect(cascade.router).toBe(primaryRouter);  // the REAL room.router the loop passed
    expect(cascade.producer).toBe(minted);       // the REAL hub producer (not a copy)
    expect(cascade.producer.id).toBe(minted.id);
    expect(cascade.producerPeerId).toBe(ORIGINAL_PUBLISHER); // RMS-029 publisher binding survives

    // -- ASSERTION B (REAL byte-identity at standby-C, keyed to the REAL cascade call) --
    // Pipe the REAL minted producer (exactly what the loop handed onPrimaryProducer for
    // standby-C) DOWN to routerC and consume it there. The pipe REMAPS the header SSRC
    // (RMS-026); the OPUS_PAYLOAD tail is byte-identical.
    const downSender = await createPrimaryPipeTransport(cascade.router, 0);  // on primaryRouter
    const downReceiver = await createStandbyPipeTransport(routerC, 0);
    await downSender.connect({ ip: '127.0.0.1', port: downReceiver.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await downReceiver.connect({ ip: '127.0.0.1', port: downSender.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const downPiped = await pipeProducerOntoPrimaryTransport(downSender, cascade.producer.id);
    const localOnC = await produceLocalFromPipe(downReceiver, { producerId: downPiped.id, kind: downPiped.kind, rtpParameters: downPiped.rtpParameters });
    expect(routerC.canConsume({ producerId: localOnC.id, rtpCapabilities: routerC.rtpCapabilities })).toBe(true);

    const sinkT = await routerC.createDirectTransport();
    const sink = await sinkT.consume({ producerId: localOnC.id, rtpCapabilities: routerC.rtpCapabilities, paused: false });
    const captured: Buffer[] = [];
    sink.on('rtp', (pkt: Buffer) => { captured.push(Buffer.from(pkt)); if (captured.length > 256) captured.shift(); });

    // DRIVE real RTP: minted(primary) -> downPipe -> localOnC(C) -> sink.
    src.start();
    const deadline = Date.now() + 5000;
    while (captured.length === 0 && Date.now() < deadline) await sleep(50);
    await sleep(300);
    src.stop();

    expect(captured.length).toBeGreaterThan(0);
    let mediaPackets = 0;
    let byteIdentical = 0;
    for (const pkt of captured) {
      if (pkt.length < 12 + OPUS_PAYLOAD.length) continue;
      mediaPackets++;
      if (FORCE_TAMPER) { const ti = pkt.length - 1; pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff; }
      if (pkt.subarray(pkt.length - OPUS_PAYLOAD.length).equals(OPUS_PAYLOAD)) byteIdentical++;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-035/036 hub-fan] cascadePeers=${calledPeers.join(',')} excluded=${ORIGIN} ` +
        `captured=${captured.length} mediaPackets=${mediaPackets} byteIdentical=${byteIdentical} ` +
        `localFans=${localFans.length}${FORCE_TAMPER ? ' [P10 RED HOOK]' : ''}`,
    );
    expect(mediaPackets).toBeGreaterThan(0);
    expect(byteIdentical).toBe(mediaPackets); // P10 RED hook flips a tail byte -> RED (teeth)

    // (secondary) the local fan fired for the primary's own client (fanLocalProducer
    // ran inside registerReverseMinted, signaling.ts:2004 -- proves the FULL body ran).
    const fanDeadline = Date.now() + 2000;
    while (!localFans.some((m) => m['producerId'] === minted.id) && Date.now() < fanDeadline) await sleep(25);
    expect(localFans.some((m) => m['producerId'] === minted.id)).toBe(true);

    // -- teardown (reverse-dependency; best-effort) --
    try {
      sink.close(); sinkT.close(); localOnC.close();
      downPiped.close(); downSender.close(); downReceiver.close();
      src.producer.close();
    } catch { /* best-effort */ }
    // client + wss closed in afterEach LAST.
  }, 30_000);
});
