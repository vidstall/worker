/**
 * RMS-live LOCAL — L3.3 CAPSTONE headline, MEDIA half (REQ-RMS-032).
 *
 * SPLIT NOTE: this is the cross-relay-MEDIA half of the L3.3 headline. The ON-CHAIN
 * half (Assertion A — LIVE localnet, REQ-RMS-031) lives in
 * `live/rms-live-local.integration.test.ts`. They are SEPARATE files because real
 * mediasoup Workers and a `sui start` localnet CANNOT co-reside in one vitest fork,
 * and `vitest.integration.config.ts` runs `singleFork:true` (so two localnet tests
 * never boot sui concurrently on :9000). This media file therefore runs under
 * `vitest.relay-integration.config.ts` (real-mediasoup-worker tests) — auto-matched
 * by its broad `integration/**` include (NOT under `live/`, NOT `canary-*`, NOT the
 * mesh-demo/audio-lastN excludes), so it needs no config edit.
 *
 *   ── Assertion B (REQ-RMS-032) — IN-PROCESS cross-relay MEDIA byte-identity ──
 *   IN-PROCESS real-mediasoup (3 Workers + loopback PipeTransports — DISCLOSED as
 *   co-resident single-process, NOT WAN/cross-host; the repo convention for the
 *   live link harness). Two distinct publishers homed on relay-A cascade over the
 *   REAL inter-relay announce path to relay-B AND relay-C; on EACH leg the forwarded
 *   SFrame media BODY is byte-identical to what was sent (REAL client crypto oracle)
 *   and decrypts (closing the L1 gap that proved real-RTP byte-identity on ONE leg
 *   only); a `P10_FORCE_TAMPER` RED hook flips a body byte → the equality FAILS
 *   (teeth). Both forwarded producers then fan as `newProducer` to >=2 local clients,
 *   each attributed to its ORIGINAL publisher peerId — RESOLVED from the REAL announce
 *   via `resolveByProducerId`, NEVER a literal (de-tautologizes the L1 4a overclaim) —
 *   proving every user sees every other cross-relay user.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/rms-live-local-media.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { WebSocket, WebSocketServer } from 'ws';
import {
  produceLocalFromPipe,
  createStandbyPipeTransport,
  PrimaryPipeCoordinator,
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  isPipeProducerAnnounce,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';
import { createSignalingServer, type InterRelayContext } from '../../signaling/index.js';
import { MetricsTracker } from '../../metrics.js';
import type { MediasoupManager } from '../../mediasoup-manager.js';
import {
  VP8_PT,
  makeVp8RtpWithBody,
  makeRtcpSenderReport,
  realKeying,
  locateForwardedSframe,
} from './_sframe-byteid-helpers.js';
import {
  decryptFrame,
  encryptFrame,
  SFRAME_TRAILER_LEN,
  codecOffsetForFrameType,
  type KeyLookup,
} from '@dvconf/shared';

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** VP8 codec set (mirrors multi-hop-byte-identity) — the SFrame body is the byte-id oracle. */
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

/** REUSED RED hook (verbatim semantics from multi-hop / the M1 bench). */
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';

/** Build the REAL SFrame ciphertext oracle (REAL client crypto via realKeying). */
async function buildSframes(): Promise<{
  sframes: Uint8Array[];
  sentBodiesB64: Set<string>;
  kid: number;
  keyLookup: KeyLookup;
  ctrToPlain: Map<number, Uint8Array>;
}> {
  const { kid, encryptKey, keyLookup } = await realKeying();
  const plaintexts = [
    new TextEncoder().encode('RMS-L3 headline frame ONE alpha alpha alpha'),
    new TextEncoder().encode('headline frame TWO bravo'),
    new TextEncoder().encode('headline THIRD frame charlie charlie charlie charlie'),
  ];
  const sframes: Uint8Array[] = [];
  const ctrToPlain = new Map<number, Uint8Array>();
  for (let i = 0; i < plaintexts.length; i++) {
    const codecOffset = codecOffsetForFrameType('key', plaintexts[i]!.length);
    const sframe = await encryptFrame(plaintexts[i]!, { kid, ctr: i }, encryptKey, codecOffset);
    sframes.push(sframe);
    ctrToPlain.set(i, plaintexts[i]!);
  }
  const sentBodiesB64 = new Set(sframes.map((s) => Buffer.from(s).toString('base64')));
  return { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain };
}

type Oracle = Awaited<ReturnType<typeof buildSframes>>;

/**
 * The L1-carry-forward closure, per leg: assert the FORWARDED SFrame body is byte-identical
 * to the sent ciphertext AND decrypts back to plaintext. The RED hook flips a body byte →
 * locateForwardedSframe misses → byteIdentical < mediaPackets → the equality assert FAILS.
 */
async function assertLegByteIdentical(captured: Buffer[], oracle: Oracle, label: string): Promise<void> {
  const { sentBodiesB64, kid, keyLookup, ctrToPlain } = oracle;
  let mediaPackets = 0;
  let byteIdentical = 0;
  let decryptedOk = 0;
  const minBody = 1 + 16 + SFRAME_TRAILER_LEN;
  for (const pkt of captured) {
    if (pkt.length < 12 + 4 + 3 + minBody) continue;
    mediaPackets++;
    if (FORCE_TAMPER) {
      const ti = pkt.length - SFRAME_TRAILER_LEN - 1;
      if (ti >= 0) pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff;
    }
    const found = locateForwardedSframe(pkt, kid, sentBodiesB64);
    if (!found) continue;
    byteIdentical++;
    const body = Uint8Array.prototype.slice.call(pkt.subarray(found.bodyOffset));
    const recovered = await decryptFrame(body, keyLookup);
    expect(Buffer.from(recovered).equals(Buffer.from(ctrToPlain.get(found.ctr)!))).toBe(true);
    decryptedOk++;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[REQ-RMS-032 leg=${label}] mediaPackets=${mediaPackets} byteIdentical=${byteIdentical} ` +
      `decryptedOk=${decryptedOk}${FORCE_TAMPER ? ' [RED HOOK]' : ''}`,
  );
  expect(mediaPackets).toBeGreaterThan(0);
  expect(byteIdentical).toBe(mediaPackets); // RED hook → byteIdentical < mediaPackets → FAIL (teeth)
  expect(decryptedOk).toBe(byteIdentical);
}

/** A real VP8 producer on `router` (DirectTransport src) with a DISTINCT ssrc + a driver. */
async function makeVp8Publisher(
  router: msTypes.Router,
  ssrc: number,
): Promise<{ producer: msTypes.Producer; transport: msTypes.DirectTransport; start: (bodies: Uint8Array[]) => void; stop: () => void }> {
  const transport = await router.createDirectTransport();
  const producer = await transport.produce({
    kind: 'video',
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
      encodings: [{ ssrc, scalabilityMode: 'L1T1' }],
    },
  });
  let seq = 0;
  let pic = 0;
  let ts = 0;
  let frame = 0;
  let pktCount = 0;
  let octetCount = 0;
  let interval: NodeJS.Timeout | null = null;
  return {
    producer,
    transport,
    start: (bodies: Uint8Array[]) => {
      interval = setInterval(() => {
        const keyframe = frame % 10 === 0;
        const body = bodies[frame % bodies.length]!;
        const packet = makeVp8RtpWithBody({ ssrc, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe });
        producer.send(packet);
        pktCount += 1;
        octetCount += packet.length;
        if (keyframe) transport.sendRtcp(makeRtcpSenderReport(ssrc, ts, pktCount, octetCount));
        ts += 3000;
        frame++;
      }, 10);
    },
    stop: () => {
      if (interval !== null) clearInterval(interval);
    },
  };
}

// ── A mock MediasoupManager so a REAL createSignalingServer runs a live WS room in-process
//    (mediasoup-FREE — the producer that is FANNED is a REAL router-B/C producer minted by
//    produceLocalFromPipe). Cloned from rms-active-forward.integration.test.ts. ──

function mockRouter() {
  let n = 0;
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockImplementation(async () => ({
      id: `transport-${++n}`,
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
      connect: vi.fn().mockResolvedValue(undefined),
      produce: vi.fn(),
      consume: vi.fn(),
      setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    })),
    canConsume: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}
function createMockManager(): MediasoupManager {
  const router = mockRouter();
  return {
    workers: [{ pid: 1 } as unknown as msTypes.Worker],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}
function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as never;
}
function startSignaling(
  interRelay: InterRelayContext,
): Promise<{ wss: WebSocketServer; port: number; fanLocalProducer: unknown }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    delete process.env['INTER_RELAY_TOKEN']; // single-host bench: gate open
    const server = createSignalingServer(createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay);
    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;
    const { wss } = server;
    const fanLocalProducer = (server as unknown as { fanLocalProducer?: unknown }).fanLocalProducer;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, fanLocalProducer });
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

// ════════════════════════════════════════════════════════════════════════════
// Assertion B — IN-PROCESS cross-relay MEDIA byte-identity + fan (REQ-RMS-032)
//   DISCLOSURE: real mediasoup, but CO-RESIDENT single-process loopback PipeTransports
//   (3 Workers in ONE process) — NOT WAN / cross-host. The repo's deliberate live-link
//   harness convention; the cross-host claim is out of scope for L3 LOCAL.
// ════════════════════════════════════════════════════════════════════════════

describe('Assertion B — in-process cross-relay media: byte-identity on relay-B AND relay-C + fan to >=2 clients (REQ-RMS-032)', () => {
  let workerA: msTypes.Worker;
  let workerB: msTypes.Worker;
  let workerC: msTypes.Worker;
  let routerA: msTypes.Router; // PRIMARY (home) relay — publishers originate here
  let routerB: msTypes.Router; // standby leg B
  let routerC: msTypes.Router; // standby leg C

  let fanServer: WebSocketServer | undefined;

  beforeAll(async () => {
    workerA = await mediasoup.createWorker({ logLevel: 'warn' });
    workerB = await mediasoup.createWorker({ logLevel: 'warn' });
    workerC = await mediasoup.createWorker({ logLevel: 'warn' });
    routerA = await workerA.createRouter({ mediaCodecs });
    routerB = await workerB.createRouter({ mediaCodecs });
    routerC = await workerC.createRouter({ mediaCodecs });
  }, 30_000);

  afterEach(() => {
    if (fanServer) {
      fanServer.close();
      fanServer = undefined;
    }
  });

  afterAll(() => {
    workerA?.close();
    workerB?.close();
    workerC?.close();
  });

  it('forwards real SFrame media byte-identically to relay-B AND relay-C, then fans newProducer (ORIGINAL publisher) to >=2 local clients', async () => {
    const roomId = 'rms-live-headline-room';

    // ── ONE crypto oracle reused for both legs (REAL client crypto). ──
    const oracle = await buildSframes();

    // ── ONE registry + ONE announcer closure (the signaling.ts receipt path) + ONE coordinator. ──
    const registry = new InterRelayProducerRegistry();
    const pushAnnounce = createInterRelayAnnouncer({
      send: (data) => {
        const parsed = JSON.parse(data) as unknown;
        if (isPipeProducerAnnounce(parsed)) registry.record(parsed);
      },
    });
    const replies = new Map<string, PipeConnectParams>();
    const zeroAllocator: PipePortAllocatorLike = {
      allocate: () => 0, // OS-assigned port (rerun-safe, no EADDRINUSE)
      release: () => {},
      size: () => 0,
    };
    const coordinator = new PrimaryPipeCoordinator({
      announcer: pushAnnounce, // the REAL announcer closure index.ts uses
      portAllocator: zeroAllocator,
      paramSender: (_r: string, params: PipeConnectParams, peer?: string) =>
        replies.set(peer ?? DEFAULT_PEER_RELAY_ID, params),
    });

    // Two distinct publishers homed on A; each cascades to ONE standby leg (distinct SSRC).
    const LEGS = [
      { peer: 'publisher-B', cascade: 'relay-B', router: routerB, ssrc: 0x0b0b0b01 },
      { peer: 'publisher-C', cascade: 'relay-C', router: routerC, ssrc: 0x0c0c0c01 },
    ] as const;

    type LegState = {
      cfg: (typeof LEGS)[number];
      publisher: Awaited<ReturnType<typeof makeVp8Publisher>>;
      standbyPipe: msTypes.PipeTransport;
      lp: msTypes.Producer;
      sink: msTypes.Consumer;
      sinkTransport: msTypes.DirectTransport;
      captured: Buffer[];
    };
    const legs: LegState[] = [];

    // ── Drive the REAL mesh per leg: announce path → mint LOCAL producer → real-RTP sink. ──
    for (const cfg of LEGS) {
      const publisher = await makeVp8Publisher(routerA, cfg.ssrc);
      const standbyPipe = await createStandbyPipeTransport(cfg.router, 0);

      await coordinator.onStandbyConnectParams(
        roomId,
        { ip: '127.0.0.1', port: standbyPipe.tuple.localPort },
        cfg.cascade,
      );
      await coordinator.onProducer(roomId, routerA, publisher.producer, cfg.cascade, cfg.peer);

      const reply = replies.get(cfg.cascade)!;
      await standbyPipe.connect({ ip: reply.ip, port: reply.port } as Parameters<msTypes.PipeTransport['connect']>[0]);

      // The announce the coordinator EMITTED carries the ORIGINAL publisher (via the REAL wire
      // frame → guard → registry.record) — NOT the cascade relayId. This is the L2 attribution.
      const announced = registry.resolveAll(roomId, cfg.cascade)[0]!;
      expect(announced, `${cfg.cascade}: a producer must be announced`).toBeDefined();
      expect(announced.producerPeerId).toBe(cfg.peer);
      expect(announced.producerPeerId).not.toBe(cfg.cascade);

      const lp = await produceLocalFromPipe(standbyPipe, {
        producerId: announced.producerId,
        kind: announced.kind,
        rtpParameters: announced.rtpParameters!,
      });
      expect(lp.id).toBe(announced.producerId);
      expect(cfg.router.canConsume({ producerId: lp.id, rtpCapabilities: cfg.router.rtpCapabilities })).toBe(true);

      // Real-RTP sink on this leg's standby router (the byte-identity proof — not just canConsume).
      const sinkTransport = await cfg.router.createDirectTransport();
      const sink = await sinkTransport.consume({
        producerId: lp.id,
        rtpCapabilities: cfg.router.rtpCapabilities,
        paused: false,
      });
      const captured: Buffer[] = [];
      sink.on('rtp', (pkt: Buffer) => {
        captured.push(Buffer.from(pkt));
        if (captured.length > 1024) captured.shift();
      });

      legs.push({ cfg, publisher, standbyPipe, lp, sink, sinkTransport, captured });
    }

    // ── Drive RTP on BOTH legs; bounded-wait until each leg captured forwarded packets. ──
    for (const leg of legs) leg.publisher.start(oracle.sframes);
    for (const leg of legs) {
      try {
        await leg.sink.requestKeyFrame();
      } catch {
        /* best-effort PLI */
      }
    }
    const deadline = Date.now() + 8000;
    while (legs.some((leg) => leg.captured.length === 0) && Date.now() < deadline) {
      await sleepMs(50);
    }
    await sleepMs(300);
    for (const leg of legs) leg.publisher.stop();

    // ── ASSERTION B.1: byte-identity + decrypt on EACH leg (closes the L1 one-leg-only gap). ──
    for (const leg of legs) {
      expect(leg.captured.length, `${leg.cfg.cascade}: forwarded real RTP must be captured`).toBeGreaterThan(0);
      await assertLegByteIdentical(leg.captured, oracle, leg.cfg.cascade);
    }

    // ── ASSERTION B.2: fan BOTH forwarded producers to >=2 local clients, each attributed to
    //    its ORIGINAL publisher RESOLVED FROM THE REAL ANNOUNCE (resolveByProducerId, NOT a literal). ──
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: () => {} };
    const { wss, port, fanLocalProducer } = await startSignaling(interRelay);
    fanServer = wss;
    expect(typeof fanLocalProducer).toBe('function');

    const CLIENT_COUNT = 2;
    const clients: WebSocket[] = [];
    const clientFans: Array<Array<Record<string, unknown>>> = [];
    for (let i = 0; i < CLIENT_COUNT; i++) {
      const c = await connectPlain(port);
      await sendAndAwait(c, { type: 'join', roomId, peerId: `local-listener-${i}` }, 'routerRtpCapabilities');
      const fans: Array<Record<string, unknown>> = [];
      c.on('message', (data: WebSocket.RawData) => {
        const m = JSON.parse(data.toString()) as Record<string, unknown>;
        if (m['type'] === 'newProducer') fans.push(m);
      });
      clients.push(c);
      clientFans.push(fans);
    }

    for (const leg of legs) {
      const rec = registry.resolveByProducerId(roomId, leg.lp.id);
      expect(rec, `${leg.cfg.cascade}: resolveByProducerId must find the forwarded producer`).not.toBeNull();
      expect(rec!.producerPeerId).toBe(leg.cfg.peer); // ORIGINAL publisher (via the REAL announce path)
      expect(rec!.producerPeerId).not.toBe(leg.cfg.cascade); // NOT the cascade peerRelayId
      (fanLocalProducer as (r: string, p: string, prod: msTypes.Producer) => void)(roomId, rec!.producerPeerId!, leg.lp);
    }

    // Every client must see a newProducer for BOTH cross-relay producers ("every user sees every other").
    const fanDeadline = Date.now() + 3000;
    while (clientFans.some((f) => f.length < legs.length) && Date.now() < fanDeadline) {
      await sleepMs(25);
    }

    for (let i = 0; i < CLIENT_COUNT; i++) {
      const fans = clientFans[i]!;
      for (const leg of legs) {
        const fan = fans.find((m) => m['producerId'] === leg.lp.id);
        expect(fan, `client ${i} must receive newProducer for ${leg.cfg.cascade}`).toBeDefined();
        expect(fan!['peerId']).toBe(leg.cfg.peer); // ORIGINAL publisher
        expect(fan!['peerId']).not.toBe(leg.cfg.cascade); // NOT the cascade relayId
      }
    }

    // ── cleanup ──
    for (const c of clients) c.close();
    for (const leg of legs) {
      try {
        leg.sink.close();
        leg.sinkTransport.close();
        leg.lp.close();
        leg.publisher.producer.close();
        leg.publisher.transport.close();
        leg.standbyPipe.close();
      } catch {
        /* best-effort */
      }
    }
    coordinator.clear(roomId, 'relay-B');
    coordinator.clear(roomId, 'relay-C');
  }, 60_000);
});
