/**
 * REQ-RMS-027/028 — L1.3-b: standby fans newProducer to local clients + primary
 * drives N-1 mesh legs.
 *
 * REAL mediasoup (two/three Workers simulate the primary + standby(s) daemons),
 * a mocked MediasoupManager backing a REAL createSignalingServer (so the WS fan
 * wiring under test is exercised live), and the REAL PrimaryPipeCoordinator /
 * InterRelayProducerRegistry / createInterRelayAnnouncer primitives driving the
 * N-1 cascade-mesh legs.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-fan-mesh.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { WebSocket, WebSocketServer } from 'ws';
import {
  produceLocalFromPipe,
  createPrimaryPipeTransport,
  createStandbyPipeTransport,
  pipeProducerOntoPrimaryTransport,
  PrimaryPipeCoordinator,
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  isPipeProducerAnnounce,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
  type PipePortAllocatorLike,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
// L1.3-b — Bridge A/B wiring under test (real-mediasoup ⇒ live signaling fan + N-1 mesh).
import type { InterRelayContext } from '../../signaling/index.js';
import { createInterRelaySocketMap } from '../../inter-relay-socket-map.js';
import {
  mediaCodecs,
  makePrimaryRtpSource as fixtureMakePrimaryRtpSource,
  makePrimaryProducerWithSsrc as fixtureMakePrimaryProducerWithSsrc,
  startSignaling,
  connectPlain,
  sendAndAwait,
  sleepMs,
} from './rms-active-forward.fixtures.js';

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

const makePrimaryRtpSource = () => fixtureMakePrimaryRtpSource(primaryRouter);
const makePrimaryProducerWithSsrc = (ssrc: number) => fixtureMakePrimaryProducerWithSsrc(primaryRouter, ssrc);

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
      // REQ-RMS-029 arg order: (roomId, piped, producerPeerId?, peerRelayId?, rtpParameters?).
      announcer: (_roomId, piped, _producerPeerId, peerRelayId, rtpParameters) => {
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

  /**
   * Test 4c (REQ-RMS-029 — original publisher reaches the fan via the REAL announce
   * path). 4a proves the fan WIRING but feeds it a LITERAL 'publisher-original' peerId,
   * which makes the original-publisher claim tautological. 4c closes L1-gate partial #3
   * properly: the publisher id flows through the REAL PrimaryPipeCoordinator drive
   * (onProducer WITH a producerPeerId → drain → the REAL createInterRelayAnnouncer wire
   * frame → parsed through the REAL guard → recorded into the REAL registry), and the
   * fan's peerId is RESOLVED FROM THAT ANNOUNCE — not typed inline. If the drain failed
   * to thread producerPeerId, registry.resolveAll(...)[0].producerPeerId would be
   * undefined and BOTH the announce assertion and the fan assertion would fail.
   */
  it('4c: the ORIGINAL publisher producerPeerId reaches the fan through the REAL PrimaryPipeCoordinator announce path (not a literal) — closes L1-gate partial #3', async () => {
    const roomId = 'rms-fan-real-room';
    const CASCADE_PEER = 'relay-C';
    const ORIGINAL_PUBLISHER = 'publisher-original';

    // ── Mint a REAL forwarded producer on router C via a REAL coordinator drive. ──
    const src = await makePrimaryRtpSource(); // producer on primaryRouter (A)
    const standbyPipe = await createStandbyPipeTransport(cRouter, 0);

    // The REAL announce path: createInterRelayAnnouncer serializes the wire frame; we
    // parse it through the REAL guard and record into a REAL registry — exactly what
    // signaling.ts does on receipt. producerPeerId rides the actual JSON wire (no literal).
    const registry = new InterRelayProducerRegistry();
    const pushAnnounce = createInterRelayAnnouncer({
      send: (data) => {
        const parsed = JSON.parse(data) as unknown;
        if (isPipeProducerAnnounce(parsed)) registry.record(parsed);
      },
    });
    const replies = new Map<string, PipeConnectParams>();
    const zeroAllocator: PipePortAllocatorLike = {
      allocate: () => 0, // OS-assigned port (rerun-safe)
      release: () => {},
      size: () => 0,
    };
    const coordinator = new PrimaryPipeCoordinator({
      announcer: pushAnnounce, // the REAL announcer closure index.ts uses (forwards all slots)
      portAllocator: zeroAllocator,
      paramSender: (_r: string, params: PipeConnectParams, peer?: string) =>
        replies.set(peer ?? DEFAULT_PEER_RELAY_ID, params),
    });

    // Drive the coordinator with a REAL producerPeerId — the ORIGINAL publisher.
    await coordinator.onStandbyConnectParams(
      roomId,
      { ip: '127.0.0.1', port: standbyPipe.tuple.localPort },
      CASCADE_PEER,
    );
    await coordinator.onProducer(roomId, primaryRouter, src.producer, CASCADE_PEER, ORIGINAL_PUBLISHER);

    // The announce the coordinator EMITTED (and the standby registry RECORDED) carries
    // the ORIGINAL publisher — NOT the cascade relayId. THIS is the partial-#3 fix.
    const announced = registry.resolveAll(roomId, CASCADE_PEER)[0];
    expect(announced).toBeDefined();
    expect(announced!.producerPeerId).toBe(ORIGINAL_PUBLISHER);
    expect(announced!.producerPeerId).not.toBe(CASCADE_PEER);

    // Complete the handshake + mint the forwarded LOCAL producer on router C.
    const reply = replies.get(CASCADE_PEER)!;
    await standbyPipe.connect({
      ip: reply.ip,
      port: reply.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const localProducer = await produceLocalFromPipe(standbyPipe, {
      producerId: announced!.producerId,
      kind: announced!.kind,
      rtpParameters: announced!.rtpParameters!,
    });
    expect(
      cRouter.canConsume({ producerId: localProducer.id, rtpCapabilities: cRouter.rtpCapabilities }),
    ).toBe(true);

    // ── Stand up REAL signaling + a local client; fan using the producerPeerId
    //    RESOLVED FROM THE REAL ANNOUNCE (not a literal). ──
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: () => {} };
    const { wss, port, fanLocalProducer } = await startSignaling(interRelay);
    fanServer = wss;
    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId, peerId: 'local-listener' }, 'routerRtpCapabilities');
    const fans: Array<Record<string, unknown>> = [];
    client.on('message', (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === 'newProducer') fans.push(m);
    });

    expect(typeof fanLocalProducer).toBe('function');
    (fanLocalProducer as (r: string, p: string, prod: msTypes.Producer) => void)(
      roomId,
      announced!.producerPeerId!, // ← sourced from the REAL announce, NOT a literal
      localProducer,
    );

    const deadline = Date.now() + 2000;
    while (fans.length === 0 && Date.now() < deadline) await sleepMs(25);

    const fan = fans.find((m) => m['type'] === 'newProducer');
    expect(fan).toBeDefined();
    expect(fan!['producerId']).toBe(localProducer.id); // the FORWARDED producer id
    expect(fan!['peerId']).toBe(ORIGINAL_PUBLISHER); // ORIGINAL publisher (via the real announce path)
    expect(fan!['peerId']).not.toBe(CASCADE_PEER); // NOT the cascade peerRelayId

    // cleanup
    client.close();
    src.stop();
    coordinator.clear(roomId, CASCADE_PEER);
    try {
      localProducer.close();
      standbyPipe.close();
      src.producer.close();
    } catch { /* best-effort */ }
  }, 30_000);

  /**
   * Test 4d (REQ-RMS-029 — consume RESPONSE carries per-producer original publisher on
   * the MESH; L2.3). TWO distinct publishers' producers are forwarded over the mesh and
   * recorded under DISTINCT per-peer buckets (relay-B, relay-C), each WITH its OWN
   * producerPeerId, through the REAL announce→record path (REAL PrimaryPipeCoordinator →
   * REAL createInterRelayAnnouncer wire frame → REAL isPipeProducerAnnounce guard →
   * registry.record). NO hand-seeded records.
   *
   * Then a handleConsume-style resolution — `registry.resolveByProducerId(roomId,
   * <each producerId>)`, asserted at the registry+coordinator SEAM (the exact source
   * handleConsume now reads for the response's producerPeerId) — returns each producer's
   * OWN original publisher (publisher-A for producer-A, publisher-C for producer-C),
   * where the OLD `resolve(roomId)` (DEFAULT bucket) returns null. This proves the
   * consume RESPONSE now carries per-producer original-publisher attribution on the mesh
   * (multi-publisher robust). Forwarding is proven via canConsume===true (like 4b),
   * deterministic and RTP-flow-free; the producerId is the PIPED id the client sends.
   */
  it('4d: resolveByProducerId returns each mesh producer\'s OWN original publisher across distinct per-peer buckets — consume-response multi-publisher attribution (REQ-RMS-029)', async () => {
    const roomId = 'rms-multipub-room';
    const PUB_A = { peer: 'publisher-A', cascade: 'relay-B', router: standbyRouter, ssrc: 0x0a0a0a01 };
    const PUB_C = { peer: 'publisher-C', cascade: 'relay-C', router: cRouter, ssrc: 0x0c0c0c01 };

    // Two REAL producers on the primary (A) = two DISTINCT publishers (distinct SSRCs).
    const prodA = await makePrimaryProducerWithSsrc(PUB_A.ssrc);
    const prodC = await makePrimaryProducerWithSsrc(PUB_C.ssrc);

    // ONE real registry fed by ONE real announcer closure (the signaling.ts receipt path).
    const registry = new InterRelayProducerRegistry();
    const pushAnnounce = createInterRelayAnnouncer({
      send: (data) => {
        const parsed = JSON.parse(data) as unknown;
        if (isPipeProducerAnnounce(parsed)) registry.record(parsed);
      },
    });
    const replies = new Map<string, PipeConnectParams>();
    const zeroAllocator: PipePortAllocatorLike = {
      allocate: () => 0, // OS-assigned port (rerun-safe)
      release: () => {},
      size: () => 0,
    };
    const coordinator = new PrimaryPipeCoordinator({
      announcer: pushAnnounce, // the REAL announcer closure index.ts uses (forwards all slots)
      portAllocator: zeroAllocator,
      paramSender: (_r: string, params: PipeConnectParams, peer?: string) =>
        replies.set(peer ?? DEFAULT_PEER_RELAY_ID, params),
    });

    // Drive BOTH publishers through the REAL coordinator → DISTINCT cascade peers.
    const pipeA = await createStandbyPipeTransport(PUB_A.router, 0);
    await coordinator.onStandbyConnectParams(roomId, { ip: '127.0.0.1', port: pipeA.tuple.localPort }, PUB_A.cascade);
    await coordinator.onProducer(roomId, primaryRouter, prodA, PUB_A.cascade, PUB_A.peer);

    const pipeC = await createStandbyPipeTransport(PUB_C.router, 0);
    await coordinator.onStandbyConnectParams(roomId, { ip: '127.0.0.1', port: pipeC.tuple.localPort }, PUB_C.cascade);
    await coordinator.onProducer(roomId, primaryRouter, prodC, PUB_C.cascade, PUB_C.peer);

    // (a) Each landed in its OWN per-peer bucket WITH its own producerPeerId.
    const annA = registry.resolveAll(roomId, PUB_A.cascade);
    const annC = registry.resolveAll(roomId, PUB_C.cascade);
    expect(annA).toHaveLength(1);
    expect(annC).toHaveLength(1);
    expect(annA[0]!.producerPeerId).toBe(PUB_A.peer);
    expect(annC[0]!.producerPeerId).toBe(PUB_C.peer);
    const producerIdA = annA[0]!.producerId; // the PIPED id = exactly what the client sends in `consume`
    const producerIdC = annC[0]!.producerId;
    expect(producerIdA).not.toBe(producerIdC);

    // The OLD consume-response source — resolve(roomId) reads only the DEFAULT bucket —
    // MISSES both mesh records (they are per-peer-bucketed). This is the dead-path bug.
    expect(registry.resolve(roomId)).toBeNull();

    // (b) handleConsume-style resolution (the NEW response source): producerId-keyed,
    //     returns each producer's OWN original publisher. Multi-publisher robust.
    expect(registry.resolveByProducerId(roomId, producerIdA)?.producerPeerId).toBe(PUB_A.peer);
    expect(registry.resolveByProducerId(roomId, producerIdC)?.producerPeerId).toBe(PUB_C.peer);
    // No bleed across publishers, and a miss returns null.
    expect(registry.resolveByProducerId(roomId, producerIdA)?.producerPeerId).not.toBe(PUB_C.peer);
    expect(registry.resolveByProducerId(roomId, 'no-such-producer')).toBeNull();

    // Prove BOTH were genuinely FORWARDED over the mesh (mint each LOCAL producer →
    // canConsume===true on its router), exactly as 4b proves a leg forwarded.
    for (const cfg of [PUB_A, PUB_C]) {
      const reply = replies.get(cfg.cascade)!;
      const pipe = cfg.cascade === PUB_A.cascade ? pipeA : pipeC;
      await pipe.connect({ ip: reply.ip, port: reply.port } as Parameters<msTypes.PipeTransport['connect']>[0]);
      const announced = registry.resolveAll(roomId, cfg.cascade)[0]!;
      const localProducer = await produceLocalFromPipe(pipe, {
        producerId: announced.producerId,
        kind: announced.kind,
        rtpParameters: announced.rtpParameters!,
      });
      expect(localProducer.id).toBe(announced.producerId);
      expect(
        cfg.router.canConsume({ producerId: localProducer.id, rtpCapabilities: cfg.router.rtpCapabilities }),
      ).toBe(true);
      localProducer.close();
    }

    // cleanup
    coordinator.clear(roomId, PUB_A.cascade);
    coordinator.clear(roomId, PUB_C.cascade);
    try {
      pipeA.close();
      pipeC.close();
      prodA.close();
      prodC.close();
    } catch { /* best-effort */ }
  }, 30_000);
});
