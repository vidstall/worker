/**
 * REQ-RMS-025 — ACTIVE-forward integration (L1.2).
 *
 * The warm-pipe model (REQ-RO-004/005) opens a cross-process PipeTransport from
 * the PRIMARY relay to a STANDBY and consumes a PAUSED keepalive consumer (RTCP
 * liveness only). But that leaves the standby's router with NO producer its OWN
 * local clients can consume — a standby that takes over a busy room can't serve
 * anyone until it MINTS a local producer fed by the piped RTP.
 *
 * This test proves the missing ACTIVE-forward step: after the warm pipe is
 * connected, `produceLocalFromPipe(standbyPipe, announced)` mints a LOCAL producer
 * on the standby router from the SSRC-remapped rtpParameters the primary's announce
 * carried (REQ-RMS-026, threaded by L1.1). It is the production helper for the
 * manual `standbyPipe.produce({...})` step the warm-pipe SPIKE
 * (warmpipe-rtp.integration.test.ts) does by hand.
 *
 * REAL mediasoup (NOT a mock): two Workers => two child processes simulate the
 * primary + standby daemons; a manually-paired cross-PipeTransport carries real
 * Opus RTP. We assert, in priority order:
 *
 *   1. PRIMARY (deterministic): standbyRouter.canConsume({producerId: localProducer.id})
 *      is TRUE — the local producer was minted with valid rtpParameters and the
 *      standby's own clients can consume it. THE must-pass assertion.
 *   2. RTP liveness: a real downstream consumer of localProducer captures >=1 'rtp'
 *      packet within a bounded timeout — media actually forwards end-to-end.
 *   3. Body byte-identity: the forwarded packet's media PAYLOAD BODY is byte-
 *      identical to the sent payload. The 12-byte RTP header DIFFERS by design (a
 *      PipeTransport REMAPS the SSRC — exactly why rtpParameters carries the
 *      remapped ssrc), so we compare only the payload tail, never the full packet.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-active-forward.integration.test.ts
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
  PrimaryPipeCoordinator,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
  type PipePortAllocatorLike,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
// L1.3-b — Bridge A/B wiring under test (real-mediasoup ⇒ live signaling fan + N-1 mesh).
import { createSignalingServer, type InterRelayContext } from '../../signaling.js';
import { createInterRelaySocketMap } from '../../inter-relay-socket-map.js';
import { MetricsTracker } from '../../metrics.js';
import type { MediasoupManager } from '../../mediasoup-manager.js';

// ── Shared codec set (mirrors mediasoup-manager.ts / warmpipe-rtp) ─────────

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
/** Constant Opus payload — its bytes ride the tail of every RTP packet. */
const OPUS_PAYLOAD = Buffer.from([0xfc, 0xff, 0xfe]);

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

// ── Module-scoped real mediasoup workers (spawned once) ────────────────────

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
// L1.3-b — a THIRD worker/router C so one room can span ≥3 relays (the N-1 mesh).
let cWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;
let cRouter: msTypes.Router;

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  cWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
  cRouter = await cWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
  cWorker?.close();
});

/** Synthetic real-RTP Opus producer on the primary router (DirectTransport src). */
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

describe('REQ-RMS-025 — standby ACTIVE-forward: produceLocalFromPipe mints a LOCAL producer from the cross-process pipe', () => {
  it('mints a LOCAL producer the standby router can consume + real RTP forwards through it (body byte-identical, header SSRC remapped by design)', async () => {
    const src = await makePrimaryRtpSource();

    // ── PRIMARY HALF: pipe transport + pipe the room producer onto it ──
    // port:0 => OS-assigned (avoid PIPE_PORT_RANGE collisions across reruns).
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
    // ── STANDBY HALF: the pipe transport ensureWarmPipe would retain on topology. ──
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);

    // CONNECT-PARAM EXCHANGE (in production: over the inter-relay WS link).
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // Primary consumes the room producer onto its pipe => puts RTP on the wire and
    // yields the PIPED consumer whose .id + (remapped) rtpParameters the announce
    // carries to the standby (REQ-RMS-026). This is what the announce registry holds.
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(
      primaryPipe,
      src.producer.id,
    );
    const announced = {
      producerId: primaryPipeConsumer.id,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
    };
    // The piped consumer's SSRC is REMAPPED vs the source (the whole reason the
    // announce carries rtpParameters) — assert it so the byte-identity expectation
    // below (header differs, body identical) is grounded.
    const pipedSsrc = announced.rtpParameters.encodings?.[0]?.ssrc;
    expect(pipedSsrc).toBeDefined();
    expect(pipedSsrc).not.toBe(OPUS_SSRC);

    // ── L1.2 UNDER TEST: mint the LOCAL producer on the standby from the announce. ──
    const localProducer = await produceLocalFromPipe(standbyPipe, announced);

    // ASSERTION 1 (must-pass, deterministic): the standby's own clients can consume it.
    expect(localProducer.id).toBe(announced.producerId);
    expect(
      standbyRouter.canConsume({
        producerId: localProducer.id,
        rtpCapabilities: standbyRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // ── DOWNSTREAM SINK on the standby — observes that RTP actually forwards. ──
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

    // ── DRIVE real RTP through the warm pipe → the local producer → the sink. ──
    src.start();
    // Bounded wait for the first packet(s) to settle across the pipe.
    const deadline = Date.now() + 4000;
    while (captured.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    await sleep(200);
    src.stop();

    // ASSERTION 2: real RTP forwarded end-to-end through the minted local producer.
    expect(captured.length).toBeGreaterThan(0);
    const stats = await sink.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    // ASSERTION 3: media BODY byte-identical (header SSRC remapped by design).
    // The constant Opus payload rides the packet TAIL; the pipe remaps the 12-byte
    // header's SSRC but never the payload. Comparing the trailing payload bytes is
    // robust to any header-length change the pipe introduces.
    const bodyIdentical = captured.filter((pkt) =>
      pkt.subarray(pkt.length - OPUS_PAYLOAD.length).equals(OPUS_PAYLOAD),
    ).length;
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-025 active-forward] captured=${captured.length} ` +
        `inboundPacketCount=${inbound?.packetCount} pipedSsrc=0x${(pipedSsrc ?? 0).toString(16)} ` +
        `sourceSsrc=0x${OPUS_SSRC.toString(16)} bodyIdentical=${bodyIdentical}`,
    );
    expect(bodyIdentical).toBeGreaterThan(0);

    // cleanup
    try {
      sink.close();
      localProducer.close();
      primaryPipeConsumer.close();
      src.producer.close();
      primaryPipe.close();
      standbyPipe.close();
      sinkTransport.close();
    } catch {
      /* best-effort */
    }
  }, 30_000);

  // NOTE: the coordinator wiring around produceLocalFromPipe (forwardLocalProducers
  // dedup, the onLocalProducer callback, the retryable-vs-duplicate error split,
  // clear(), and the legacy no-rtpParameters skip) is unit-tested with mock mediasoup
  // in apps/relay/src/__tests__/inter-relay-warmpipe.test.ts (no real Workers needed).
  // This integration test proves the primitive on REAL mediasoup end-to-end.
});

// ── L1.3-b harness helpers (a mock MediasoupManager so a REAL createSignalingServer
//    can run a live WS room in-process; mediasoup-FREE — the forwarded producer that
//    is FANNED is a REAL router-C producer minted above by produceLocalFromPipe). ──

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
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
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
    // L1.3-b — the NEW return field under test.
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
const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let fanServer: WebSocketServer | undefined;
afterEach(() => { if (fanServer) { fanServer.close(); fanServer = undefined; } });

describe('REQ-RMS-027/028 — L1.3-b: standby fans newProducer to local clients + primary drives N-1 mesh legs', () => {
  /**
   * Test 4a (standby fan, Bridge B). A standby that minted a LOCAL forwarded
   * producer (REAL router-C producer via produceLocalFromPipe) hands it to the
   * signaling layer's NEW `fanLocalProducer(roomId, peerId, producer)` (returned
   * from createSignalingServer), which fires `newProducer` to the standby's OWN
   * local WebRTC clients. The fan must carry the FORWARDED producer's id AND the
   * ORIGINAL publisher peerId (producerPeerId), NOT the cascade peerRelayId.
   *
   * RED before the wiring: createSignalingServer does NOT yet return
   * fanLocalProducer → it is `undefined` → invoking it throws.
   */
  it('4a: createSignalingServer returns fanLocalProducer that fans newProducer (forwarded id + ORIGINAL producerPeerId) to a local client', async () => {
    // ── Mint a REAL forwarded producer on standby router C (prod primitives). ──
    const src = await makePrimaryRtpSource(); // producer on primaryRouter (A)
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
    const standbyPipe = await createStandbyPipeTransport(cRouter, 0);
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(primaryPipe, src.producer.id);
    const announced = {
      producerId: primaryPipeConsumer.id,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
    };
    const localProducer = await produceLocalFromPipe(standbyPipe, announced);
    // Sanity: the forwarded producer is genuinely consumable on router C (L1.2 must-pass).
    expect(
      cRouter.canConsume({ producerId: localProducer.id, rtpCapabilities: cRouter.rtpCapabilities }),
    ).toBe(true);

    // ── Stand up a REAL signaling server + join ONE local client. ──
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new (await import('@dvconf/inter-relay-client')).InterRelayProducerRegistry(),
      announceProducer: () => {},
    };
    const { wss, port, fanLocalProducer } = await startSignaling(interRelay);
    fanServer = wss;
    const roomId = 'rms-fan-room';

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId, peerId: 'local-listener' }, 'routerRtpCapabilities');
    const fans: Array<Record<string, unknown>> = [];
    client.on('message', (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === 'newProducer') fans.push(m);
    });

    // ── Bridge B UNDER TEST: fan the forwarded producer to local clients. The
    //    index.ts adapter passes `producerPeerId ?? peerRelayId` as the peerId;
    //    here the ORIGINAL publisher ('publisher-original') resolves first. ──
    expect(typeof fanLocalProducer).toBe('function');
    (fanLocalProducer as (r: string, p: string, prod: msTypes.Producer) => void)(
      roomId,
      'publisher-original',
      localProducer,
    );

    // Allow the WS frame to land on the client.
    const deadline = Date.now() + 2000;
    while (fans.length === 0 && Date.now() < deadline) await sleepMs(25);

    const fan = fans.find((m) => m['type'] === 'newProducer');
    expect(fan).toBeDefined();
    expect(fan!['producerId']).toBe(localProducer.id);     // the FORWARDED producer id
    expect(fan!['peerId']).toBe('publisher-original');     // ORIGINAL producerPeerId
    expect(fan!['peerId']).not.toBe('relay-C');            // NOT the cascade peerRelayId

    // cleanup
    client.close();
    try {
      localProducer.close();
      primaryPipeConsumer.close();
      primaryPipe.close();
      standbyPipe.close();
      src.producer.close();
    } catch { /* best-effort */ }
  }, 30_000);

  /**
   * Test 4b (N-1 mesh legs, Bridge A). One producer on router A is driven through
   * a REAL PrimaryPipeCoordinator PER cascade peer (enumerated via the inter-relay
   * socket map's keys()), so it is forwarded to BOTH standby router B AND standby
   * router C. Each leg mints a LOCAL producer from its announced rtpParameters and
   * is `canConsume===true` on its router.
   *
   * RED before the inter-relay.ts change: PrimaryPipeCoordinator.onProducer does
   * NOT yet pass `peerRelayId` to paramSender → the per-peer pipe-connect reply is
   * keyed `undefined` (overwritten across legs) → `replies.has('relay-B')` fails.
   */
  it('4b: PrimaryPipeCoordinator drives N-1 legs — one producer on A is canConsume on BOTH router B and router C', async () => {
    const src = await makePrimaryRtpSource(); // producer on primaryRouter (A)

    // The per-peer socket map (L1.3-a keys()) enumerates the cascade peers (B, C).
    const sockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    sockets.attach('relay-B', stub());
    sockets.attach('relay-C', stub());
    const peerToRouter: Record<string, msTypes.Router> = {
      'relay-B': standbyRouter,
      'relay-C': cRouter,
    };

    const announces = new Map<
      string,
      { producerId: string; kind: msTypes.MediaKind; rtpParameters: msTypes.RtpParameters }
    >();
    const replies = new Map<string, PipeConnectParams>();
    const zeroAllocator: PipePortAllocatorLike = {
      allocate: () => 0, // every leg = OS-assigned port (rerun-safe, no EADDRINUSE)
      release: () => {},
      size: () => 0,
    };
    const coordinator = new PrimaryPipeCoordinator({
      announcer: (_roomId, piped, peerRelayId, rtpParameters) => {
        announces.set(peerRelayId ?? DEFAULT_PEER_RELAY_ID, {
          producerId: piped.id,
          kind: piped.kind,
          rtpParameters: rtpParameters as msTypes.RtpParameters,
        });
      },
      portAllocator: zeroAllocator,
      // L1.3-b — paramSender gained a trailing `peerRelayId`; capture the DOWN reply per peer.
      paramSender: (
        _roomId: string,
        params: PipeConnectParams,
        peerRelayId?: string,
      ) => {
        replies.set(peerRelayId ?? DEFAULT_PEER_RELAY_ID, params);
      },
    });

    const roomId = 'rms-mesh-room';
    const standbyPipes: Record<string, msTypes.PipeTransport> = {};

    // N-1 fanout: drive ONE coordinator leg per cascade peer (socket map keys()).
    for (const peerRelayId of sockets.keys()) {
      const router = peerToRouter[peerRelayId]!;
      const standbyPipe = await createStandbyPipeTransport(router, 0);
      standbyPipes[peerRelayId] = standbyPipe;
      await coordinator.onStandbyConnectParams(
        roomId,
        { ip: '127.0.0.1', port: standbyPipe.tuple.localPort },
        peerRelayId,
      );
      await coordinator.onProducer(roomId, primaryRouter, src.producer, peerRelayId);
    }

    // Each leg got its OWN announce + its OWN pipe-connect reply, keyed by peerRelayId.
    expect(replies.has('relay-B')).toBe(true);
    expect(replies.has('relay-C')).toBe(true);
    expect(announces.has('relay-B')).toBe(true);
    expect(announces.has('relay-C')).toBe(true);

    // Complete each handshake + mint the LOCAL forwarded producer; assert canConsume.
    for (const peerRelayId of sockets.keys()) {
      const router = peerToRouter[peerRelayId]!;
      const standbyPipe = standbyPipes[peerRelayId]!;
      const reply = replies.get(peerRelayId)!;
      await standbyPipe.connect({
        ip: reply.ip,
        port: reply.port,
      } as Parameters<msTypes.PipeTransport['connect']>[0]);
      const announced = announces.get(peerRelayId)!;
      const localProducer = await produceLocalFromPipe(standbyPipe, announced);
      expect(localProducer.id).toBe(announced.producerId);
      expect(
        router.canConsume({ producerId: localProducer.id, rtpCapabilities: router.rtpCapabilities }),
      ).toBe(true);
      localProducer.close();
    }

    // cleanup
    src.stop();
    coordinator.clear(roomId, 'relay-B');
    coordinator.clear(roomId, 'relay-C');
    for (const p of Object.values(standbyPipes)) {
      try { p.close(); } catch { /* best-effort */ }
    }
    try { src.producer.close(); } catch { /* best-effort */ }
  }, 30_000);
});
