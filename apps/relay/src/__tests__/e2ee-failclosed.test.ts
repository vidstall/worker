/**
 * REQ-RMS-038 — E2EE fail-closed (raw args, gate on `=== undefined`, cross-relay scoped).
 *
 * Headline invariant: in an E2EE room, cross-relay media whose ORIGINAL publisher
 * id (`producerPeerId`) is MISSING must be DROPPED — never bound to a relayId —
 * because without the publisher binding a client cannot attribute/decrypt the
 * SFrame. SAME-RELAY LOCAL consume (no inter-relay registry entry) must keep
 * working unchanged (the shipped M2/M3 single-relay E2EE SFU call must not regress).
 *
 * Three enforcement sites (driven THROUGH the real raw-WS harness):
 *   SITE A — fanLocalProducer (exercised via registerReverseMinted, its real caller):
 *     RC-1a  open room, missing publisher id  → graceful fallback binds to peerRelayId (byte-stable)
 *     RC-1b  E2EE room, missing publisher id  → DROP (no newProducer fan)
 *     RC-1c  E2EE room, publisher id present  → binds to the ORIGINAL publisher (never the relayId)
 *   SITE B — handleConsume (cross-relay scope = a registry entry exists):
 *     RC-1d  E2EE room, SAME-RELAY local consume (no registry entry) → SUCCEEDS (M2/M3 non-regression guard)
 *     RC-1e  E2EE room, cross-relay producer w/o publisher id → consume responds {error,'e2ee-missing-producer-peer-id'}
 *   SITE C — handleJoin re-announce loop (folded into RC-1e): the no-publisher-id
 *            cross-relay producer is NOT re-announced to a fresh E2EE joiner.
 *
 * Mocked MediasoupManager (native workers unavailable on Windows CI) — mocks copied
 * VERBATIM from inter-relay-wiring.test.ts; the E2EE join frame + valid 32-byte
 * pubkey are copied from room-password-roster.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';
import type { types as msTypes } from 'mediasoup';

// ── Mocks (copied VERBATIM from inter-relay-wiring.test.ts) ────────────────────

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-PRIMARY-1', kind: 'audio', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, close: vi.fn() }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

let transportCounter = 0;

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockImplementation(async () => {
      transportCounter++;
      return mockTransport(`transport-${transportCounter}`);
    }),
    canConsume: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}

function createMockManager(): MediasoupManager {
  const router = mockRouter();
  return {
    workers: [{ pid: 1 } as any],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

function startServer(
  interRelay: InterRelayContext,
): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const { wss } = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    );
    process.env['WS_PORT'] = originalPort;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port });
    });
  });
}

// Variant returning the factory's reverse-leg exports so SITE A (fanLocalProducer)
// can be driven through its REAL production caller, registerReverseMinted.
function startServerFull(
  interRelay: InterRelayContext,
): Promise<{
  wss: WebSocketServer;
  port: number;
  registerReverseMinted: (
    roomId: string,
    minted: msTypes.Producer,
    originRelayId: string,
    producerPeerId?: string,
  ) => void;
}> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const srv = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    ) as unknown as {
      wss: WebSocketServer;
      registerReverseMinted: (
        roomId: string,
        minted: msTypes.Producer,
        originRelayId: string,
        producerPeerId?: string,
      ) => void;
    };
    process.env['WS_PORT'] = originalPort;
    srv.wss.on('listening', () => {
      const addr = srv.wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss: srv.wss, port, registerReverseMinted: srv.registerReverseMinted });
    });
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

/** Persistent collector — every parsed inbound frame, in order. */
function collect(ws: WebSocket): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  ws.on('message', (d) => out.push(JSON.parse(d.toString()) as Record<string, unknown>));
  return out;
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/** Valid base64 of a 32-byte ed25519 session pubkey (deterministic per seed). */
function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
  transportCounter = 0;
});

describe('REQ-RMS-038 — E2EE fail-closed (cross-relay scoped)', () => {
  beforeEach(() => { transportCounter = 0; });

  // ── SITE A — fanLocalProducer (via registerReverseMinted) ────────────────────

  it('RED-RC-1a: OPEN room, missing publisher id → graceful fallback binds to peerRelayId (byte-stable)', async () => {
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port, registerReverseMinted } = await startServerFull(interRelay);
    server = wss;

    // OPEN room: a legacy join with NO roomPassword ⇒ no roomConfigs entry ⇒ e2ee=false.
    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'open-a', peerId: 'local-listener' }));
    await joinReply;

    const msgs = collect(ws);
    const minted = { id: 'reverse-1a', kind: 'video', on: vi.fn() } as unknown as msTypes.Producer;
    // producerPeerId UNDEFINED, peerRelayId = origin 'ws://standbyA'.
    registerReverseMinted('open-a', minted, 'ws://standbyA', undefined);
    await tick(150);

    const fan = msgs.find((m) => m['type'] === 'newProducer' && m['producerId'] === 'reverse-1a');
    expect(fan, 'open room must still fan the producer (graceful fallback)').toBeTruthy();
    // Byte-stable: in an open room with no publisher id, bind to the peerRelayId.
    expect(fan?.['peerId']).toBe('ws://standbyA');

    ws.close();
  });

  it('RED-RC-1b: E2EE room, CROSS-RELAY producer missing publisher id → DROPPED (no newProducer fan)', async () => {
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port, registerReverseMinted } = await startServerFull(interRelay);
    server = wss;

    // E2EE room: first joiner (host) sets roomPassword + e2ee:true.
    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'join', roomId: 'e2ee-b', peerId: 'local-listener',
      roomPassword: 'pw', peerPubkey: pubkey32(1), e2ee: true,
    }));
    await joinReply;

    const msgs = collect(ws);
    const minted = { id: 'reverse-1b', kind: 'video', on: vi.fn() } as unknown as msTypes.Producer;
    // producerPeerId UNDEFINED in an E2EE room ⇒ fail-closed DROP.
    registerReverseMinted('e2ee-b', minted, 'ws://standbyA', undefined);
    await tick(150);

    const fan = msgs.find((m) => m['type'] === 'newProducer' && m['producerId'] === 'reverse-1b');
    expect(
      fan,
      'E2EE room must DROP a cross-relay producer with no original publisher id (never bind to the relayId)',
    ).toBeUndefined();

    ws.close();
  });

  it('RED-RC-1c: E2EE room, publisher id present → binds to the ORIGINAL publisher (never the relayId)', async () => {
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port, registerReverseMinted } = await startServerFull(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'join', roomId: 'e2ee-c', peerId: 'local-listener',
      roomPassword: 'pw', peerPubkey: pubkey32(1), e2ee: true,
    }));
    await joinReply;

    const msgs = collect(ws);
    const minted = { id: 'reverse-1c', kind: 'video', on: vi.fn() } as unknown as msTypes.Producer;
    // ORIGINAL publisher 'clientX' is present (and remote) ⇒ fan binds to it.
    registerReverseMinted('e2ee-c', minted, 'ws://standbyA', 'clientX');
    await tick(150);

    const fan = msgs.find((m) => m['type'] === 'newProducer' && m['producerId'] === 'reverse-1c');
    expect(fan, 'E2EE room must fan a cross-relay producer that DOES carry a publisher id').toBeTruthy();
    expect(fan?.['peerId']).toBe('clientX');        // the ORIGINAL publisher
    expect(fan?.['peerId']).not.toBe('ws://standbyA'); // NEVER the relayId

    ws.close();
  });

  // ── SITE B — handleConsume ───────────────────────────────────────────────────

  it('RED-RC-1d: E2EE room, SAME-RELAY LOCAL consume SUCCEEDS (no registry entry ⇒ NOT fail-closed) [M2/M3 guard]', async () => {
    // interRelay PRESENT so the registry-resolve path runs (reg === null for a local
    // producer) — this guards against an over-broad gate that NPEs/errors on local consume.
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    // Host A (first joiner) sets the E2EE room.
    const wsA = await connect(port);
    const aJoin = waitForMessage(wsA);
    wsA.send(JSON.stringify({
      type: 'join', roomId: 'e2ee-d', peerId: 'clientA',
      roomPassword: 'pw', peerPubkey: pubkey32(1), e2ee: true,
    }));
    await aJoin;

    // Peer B joins the SAME E2EE room (matching password).
    const wsB = await connect(port);
    const bJoin = waitForMessage(wsB);
    wsB.send(JSON.stringify({
      type: 'join', roomId: 'e2ee-d', peerId: 'clientB',
      roomPassword: 'pw', peerPubkey: pubkey32(2), e2ee: true,
    }));
    await bJoin;

    const bMsgs = collect(wsB);

    // A produces a LOCAL producer (mock id 'producer-PRIMARY-1'); never enters the registry.
    const aT = waitForMessage(wsA);
    wsA.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await aT;
    const aP = waitForMessage(wsA);
    wsA.send(JSON.stringify({ type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {} }));
    await aP;
    await tick(120);

    // B consumes A's LOCAL producer by id.
    const bT = waitForMessage(wsB);
    wsB.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    await bT;
    wsB.send(JSON.stringify({ type: 'consume', producerId: 'producer-PRIMARY-1', rtpCapabilities: {} }));
    await tick(150);

    const consumed = bMsgs.find((m) => m['type'] === 'consumed' && m['producerId'] === 'producer-PRIMARY-1');
    const errored = bMsgs.find(
      (m) => m['type'] === 'error' && m['reason'] === 'e2ee-missing-producer-peer-id',
    );
    expect(errored, 'local consume in an E2EE room must NOT fail-closed').toBeUndefined();
    expect(consumed, 'same-relay local consume must SUCCEED in an E2EE room (M2/M3 non-regression)').toBeTruthy();

    wsA.close();
    wsB.close();
  });

  it('RED-RC-1e: E2EE room, CROSS-RELAY producer w/o publisher id → consume fails closed + NOT re-announced on join', async () => {
    // Pre-seed the inter-relay registry with a cross-relay announce that LACKS a
    // producerPeerId (a pre-mesh / publisher-less frame).
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'e2ee-e', producerId: 'producer-NOPID-1', kind: 'audio' });
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const msgs = collect(ws);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'join', roomId: 'e2ee-e', peerId: 'joiner',
      roomPassword: 'pw', peerPubkey: pubkey32(1), e2ee: true,
    }));
    await joinReply;
    await tick(120);

    // SITE C — the publisher-less cross-relay producer must NOT be re-announced to a
    // fresh E2EE joiner.
    const reannounced = msgs.find(
      (m) => m['type'] === 'newProducer' && m['producerId'] === 'producer-NOPID-1',
    );
    expect(
      reannounced,
      'E2EE fresh-join re-announce must SKIP a cross-relay producer with no publisher id',
    ).toBeUndefined();

    // SITE B — an explicit consume of that producer must fail closed.
    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    await tReply;
    ws.send(JSON.stringify({ type: 'consume', producerId: 'producer-NOPID-1', rtpCapabilities: {} }));
    await tick(150);

    const consumed = msgs.find((m) => m['type'] === 'consumed' && m['producerId'] === 'producer-NOPID-1');
    const errored = msgs.find(
      (m) => m['type'] === 'error' && m['reason'] === 'e2ee-missing-producer-peer-id',
    );
    expect(consumed, 'a publisher-less cross-relay producer must NOT be consumed in an E2EE room').toBeUndefined();
    expect(errored, 'consume must respond error e2ee-missing-producer-peer-id').toBeTruthy();
    expect(errored?.['producerId']).toBe('producer-NOPID-1');

    ws.close();
  });
});
