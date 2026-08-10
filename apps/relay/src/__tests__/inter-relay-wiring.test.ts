/**
 * Integration-style tests for the inter-relay wiring in signaling.ts (G1).
 *
 * Verifies the relay WS server, when given an InterRelayContext:
 *   1. PRIMARY: announces a producer to the standby after handleProduce.
 *   2. STANDBY: records an inbound `pipe-producer` frame into the registry.
 *   3. STANDBY: a client `consume` WITHOUT producerId resolves the piped
 *      producer from room context (the announced producerId).
 *   4. Client-consume reconciliation: `{type:'consume', roomId, rtpCapabilities}`
 *      (no producerId) resolves via the registry; with producerId still works.
 *
 * Mocked MediasoupManager (mediasoup native workers unavailable on Windows CI).
 * Shared mocks/helpers live in inter-relay-wiring.fixtures.ts.
 *
 * Requirements: REQ-RO-004 (G1 integration wiring)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocketServer } from 'ws';
import type { InterRelayContext } from '../signaling/index.js';
import { InterRelayProducerRegistry, type InterRelaySocketLike } from '@dvconf/inter-relay-client';
import { createInterRelaySocketMap } from '../inter-relay-socket-map.js';
import type { types as msTypes } from 'mediasoup';
import {
  startServer,
  startServerFull,
  connect,
  waitForMessage,
  tick,
  resetTransportCounter,
} from './inter-relay-wiring.fixtures.js';

// ── Tests ─────────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
});

describe('inter-relay wiring (G1)', () => {
  beforeEach(() => { resetTransportCounter(); });

  it('RED-G1-WIRE-1: PRIMARY announces a producer to the standby after produce', async () => {
    const announceProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-A', peerId: 'peer-1' }));
    await joinReply;

    // send transport
    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await tReply;

    // produce
    const pReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {},
    }));
    await pReply;
    await tick(120);

    // The primary must have announced the produced producer
    expect(announceProducer).toHaveBeenCalledOnce();
    const call = announceProducer.mock.calls[0]!;
    expect(call[0]).toBe('room-A');               // roomId
    expect(call[1]).toMatchObject({ id: 'producer-PRIMARY-1', kind: 'audio' });

    ws.close();
  });

  it('RED-RA-1: a STANDBY fires onStandbyProducer with the local publisher peerId after produce', async () => {
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'clientA' }));
    await joinReply;

    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await tReply;

    const pReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {},
    }));
    await pReply;
    await tick(120);

    // REQ-RMS-034: standby announces its LOCAL-client producer UP, threading the
    // ORIGINAL publisher peerId (mapping.peerId) for E2EE/stream fidelity.
    expect(onStandbyProducer).toHaveBeenCalledWith(
      'roomA',
      expect.anything(),
      expect.objectContaining({ id: 'producer-PRIMARY-1', kind: 'audio' }),
      'clientA',
    );

    ws.close();
  });

  it('RED-RA-1b: a PRIMARY does NOT fire onStandbyProducer (forward path byte-stable)', async () => {
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'clientP' }));
    await joinReply;

    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await tReply;

    const pReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {},
    }));
    await pReply;
    await tick(120);

    // The reverse hop must fire ONLY on a standby; a primary keeps the forward leg.
    expect(onStandbyProducer).not.toHaveBeenCalled();

    ws.close();
  });

  it('RED-G1-WIRE-2: STANDBY records an inbound pipe-producer frame', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    // Inbound inter-relay announce (as if from the primary)
    ws.send(JSON.stringify({
      type: 'pipe-producer', roomId: 'room-B', producerId: 'producer-REAL-99', kind: 'video',
    }));
    await tick(120);

    const resolved = registry.resolve('room-B');
    expect(resolved?.producerId).toBe('producer-REAL-99');
    expect(resolved?.kind).toBe('video');

    ws.close();
  });

  // ── Part-3 reverse leg — PRIMARY receives a standby's reverse announce ─────
  it('RED-RA-3a: a PRIMARY receiving a pipe-producer frame fires onReverseAnnounce with the full announce', async () => {
    const onReverseAnnounce = vi.fn().mockResolvedValue(undefined);
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onReverseAnnounce,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port); // a peer that sends an inter-relay frame
    ws.send(JSON.stringify({
      type: 'pipe-producer',
      roomId: 'roomA',
      producerId: 'piped-up-1',
      kind: 'video',
      rtpParameters: { x: 1 },
      peerRelayId: 'ws://standbyA',
      producerPeerId: 'clientA',
    }));
    await tick();

    expect(onReverseAnnounce).toHaveBeenCalledWith(
      'roomA', 'piped-up-1', 'video', { x: 1 }, 'ws://standbyA', 'clientA',
    );

    ws.close();
  });

  it('RED-RA-3a-stable: a STANDBY receiving a pipe-producer frame does NOT fire onReverseAnnounce (records only; byte-stable)', async () => {
    const onReverseAnnounce = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onReverseAnnounce,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    ws.send(JSON.stringify({
      type: 'pipe-producer',
      roomId: 'roomA',
      producerId: 'p1',
      kind: 'video',
      producerPeerId: 'clientA',
    }));
    await tick();

    // standby records (existing) but never reverse-mints
    expect(onReverseAnnounce).not.toHaveBeenCalled();

    ws.close();
  });

  it('RED-G1-WIRE-3: STANDBY consume WITHOUT producerId resolves from room context', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'room-C', producerId: 'producer-PIPED-7', kind: 'audio' });
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-C', peerId: 'peer-2' }));
    await joinReply;

    // recv transport
    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    await tReply;

    // consume WITHOUT producerId — standby resolves from room context (registry)
    const cReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'consume', rtpCapabilities: {} }));
    const msg = await cReply;

    // Should succeed (consumed), not error
    expect(msg['type']).toBe('consumed');

    ws.close();
  });

  // ── Stage B / G2 — fresh-join re-announce of forwarded producers ──────────
  it('RED-G2-WIRE-4: STANDBY re-announces forwarded (registry) producers to a FRESH joiner', async () => {
    const registry = new InterRelayProducerRegistry();
    // A forwarded/minted producer lives ONLY in the registry (it is produced by
    // the coordinator, NOT handleProduce, so it is never in room.peers[*].producers).
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-D',
      producerId: 'producer-FWD-42',
      kind: 'video',
      producerPeerId: 'publisher-X',
    });
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const got: Record<string, unknown>[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString()) as Record<string, unknown>));

    // A FRESH browser HOMES to the standby and joins AFTER the producer was minted.
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-D', peerId: 'fresh-peer' }));
    await tick(150);

    const fwd = got.find(
      (m) => m['type'] === 'newProducer' && m['producerId'] === 'producer-FWD-42',
    );
    // RED today: handleJoin re-announce reads ONLY peer.producers (empty for a
    // forwarded producer), so the fresh joiner never learns the minted id.
    expect(
      fwd,
      'fresh joiner on a standby must receive newProducer for the forwarded producer',
    ).toBeTruthy();
    expect(fwd?.['kind']).toBe('video');
    expect(fwd?.['peerId']).toBe('publisher-X');

    ws.close();
  });

  // ── Part-3 reverse leg — A4 factory surface (registerReverseMinted + getRoom) ──
  // NOTE (corrected A6): the index.ts onReverseAnnounce orchestration closure is
  // unit-covered by reverse-announce-handler.test.ts -- it runs the REAL extracted
  // handler (getRoom guard + ensureReverseLeg-before-reverseMint ordering + the
  // truthy-mint registerReverseMinted call). A5 covers reverseMint ->
  // produceLocalFromPipe over REAL mediasoup ONLY (no index.ts closure). These units
  // pin the signaling.ts surface A4 adds (seed + fan + room lookup); the
  // registerReverseMinted -> fanLocalProducer client fan is exercised by RED-RA-4.
  it('RED-RA-4: registerReverseMinted fans a reverse-minted producer to a joined local client (REQ-RMS-034/027)', async () => {
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port, registerReverseMinted } = await startServerFull(interRelay);
    server = wss;

    // A primary-homed LOCAL client joins; it must RECEIVE the hub-minted reverse
    // producer's newProducer fan (it is NOT the original publisher 'clientA').
    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'local-listener' }));
    await joinReply;

    const fans: Record<string, unknown>[] = [];
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      if (m['type'] === 'newProducer') fans.push(m);
    });

    // A reverse-minted hub producer (origin = a DIFFERENT standby's relayId; the
    // ORIGINAL publisher 'clientA' is remote, so 'local-listener' must be notified).
    const fakeMinted = { id: 'reverse-1', kind: 'video', on: vi.fn() } as unknown as msTypes.Producer;
    registerReverseMinted('roomA', fakeMinted, 'ws://standbyA', 'clientA');
    await tick(150);

    const fan = fans.find((m) => m['producerId'] === 'reverse-1');
    expect(fan, 'local client must receive the reverse-minted producer fan').toBeTruthy();
    expect(fan?.['kind']).toBe('video');
    expect(fan?.['peerId']).toBe('clientA'); // bound to the ORIGINAL publisher, not the relayId

    ws.close();
  });

  it('RED-RB-1: registerReverseMinted fans DOWN to non-origin standbys via onPrimaryProducer (REQ-RMS-035/036)', async () => {
    // Pre-populate a socket map with TWO standby peer sockets.
    const socketMap = createInterRelaySocketMap();
    const stubSocketA = { readyState: 1, send: vi.fn() } as unknown as InterRelaySocketLike;
    const stubSocketB = { readyState: 1, send: vi.fn() } as unknown as InterRelaySocketLike;
    socketMap.attach('ws://standbyA', stubSocketA);
    socketMap.attach('ws://standbyB', stubSocketB);

    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
    };
    const { wss, port, registerReverseMinted } = await startServerFull(interRelay, socketMap);
    server = wss;

    // Join so rooms.get('roomA') is non-null (registerReverseMinted early-returns otherwise).
    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'local-listener' }));
    await joinReply;

    // Drive registerReverseMinted (synchronous): origin = standbyA; standbyB must
    // receive the fan. onPrimaryProducer is a sync vi.fn() so assert immediately.
    const fakeMinted = { id: 'piped-up-1', kind: 'video', on: vi.fn() } as unknown as msTypes.Producer;
    registerReverseMinted('roomA', fakeMinted, 'ws://standbyA', 'clientA');

    // REQ-RMS-036: must NOT echo back to origin standbyA.
    // REQ-RMS-035: must fan DOWN to standbyB carrying the original producerPeerId 'clientA'.
    const peers = onPrimaryProducer.mock.calls.map((c) => c[3]);
    expect(peers).toContain('ws://standbyB');
    expect(peers).not.toContain('ws://standbyA');
    expect(onPrimaryProducer).toHaveBeenCalledWith(
      'roomA',
      expect.anything(),
      expect.objectContaining({ id: 'piped-up-1' }),
      'ws://standbyB',
      'clientA',
    );

    ws.close();
  });

  // ── Part-3 reverse leg B3 -- DESIGN-1 lock-in: PRIMARY re-announces piped-up ──
  it('RED-RB-3: PRIMARY re-announces reverse-announced (piped-up) producers to a FRESH joiner (REQ-RMS-037)', async () => {
    // DESIGN-1: the unconditional record at handlePipeProducerAnnounce
    // (signaling.ts:863) means the PRIMARY registry is non-empty after a
    // standby reverse-announces. handleJoin's single registry loop
    // (signaling.ts:1130) therefore re-announces those piped-up producers to
    // any fresh joiner on the primary -- for free (no extra loop needed).
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    // (a) A standby relay sends a reverse pipe-producer announce to the primary.
    const standbyWs = await connect(port);
    standbyWs.send(JSON.stringify({
      type: 'pipe-producer',
      roomId: 'roomA',
      producerId: 'piped-up-1',
      kind: 'audio',
      rtpParameters: {},
      peerRelayId: 'ws://standbyA',
      producerPeerId: 'clientA',
    }));
    await tick(); // handlePipeProducerAnnounce records unconditionally (DESIGN-1)

    // (b) A fresh primary-homed browser joins AFTER the reverse announce.
    const freshWs = await connect(port);
    const got: Record<string, unknown>[] = [];
    freshWs.on('message', (d) => got.push(JSON.parse(d.toString()) as Record<string, unknown>));
    freshWs.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'freshP' }));
    await tick(150);

    // (c) The fresh joiner must receive a newProducer for the reverse-announced producer.
    const fwd = got.find(
      (m) => m['type'] === 'newProducer' && m['producerId'] === 'piped-up-1',
    );
    expect(
      fwd,
      'fresh primary-homed joiner must receive newProducer for the reverse-announced producer (DESIGN-1)',
    ).toBeTruthy();
    expect(fwd?.['peerId']).toBe('clientA'); // original publisher, not the relayId

    standbyWs.close();
    freshWs.close();
  });

  it('RED-RA-4-getroom: getRoom returns the room after a join and undefined for an unknown room (REQ-RMS-036)', async () => {
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port, getRoom } = await startServerFull(interRelay);
    server = wss;

    expect(getRoom('roomG')).toBeUndefined(); // no room yet

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomG', peerId: 'p-g' }));
    await joinReply;
    await tick();

    const room = getRoom('roomG') as { router?: unknown } | undefined;
    expect(room, 'getRoom must return the live room after a join').toBeTruthy();
    expect(room?.router).toBeDefined();
    expect(getRoom('nope')).toBeUndefined();

    ws.close();
  });
});
