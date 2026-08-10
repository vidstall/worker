/**
 * G3.2b — signaling-server inter-relay auth gate.
 *
 * Verifies createSignalingServer with INTER_RELAY_TOKEN:
 *   1. DROPS a server-side `pipe-producer` from an UNTAGGED (client) socket when
 *      a token is configured (a client cannot poison the standby registry).
 *   2. RECORDS a `pipe-producer` from a TAGGED inter-relay peer (valid Bearer).
 *   3. token UNSET → untagged pipe-producer still recorded (backward-compat;
 *      single-host / in-process bench path unchanged).
 *   4. attachPeerSocket(socket) fires for a tagged peer; attachPeerSocket(null)
 *      on its close (single-box detach).
 *   5. onStandbyRoomReady(roomId, router) fires once on the standby first join.
 *
 * Mocked MediasoupManager (real mediasoup workers gated to the relay-integration
 * suite). Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS wiring + auth).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WebSocketServer } from 'ws';
import type { InterRelayContext } from '../signaling/index.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';
import {
  startServer,
  connectPlain,
  connectWithToken,
  tick,
} from './inter-relay-auth-wiring.fixtures.js';

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
});

describe('inter-relay auth gate (G3.2b)', () => {
  it('DROPS a pipe-producer from an untagged client when INTER_RELAY_TOKEN is set', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: vi.fn() };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port); // no Bearer header → untagged
    ws.send(JSON.stringify({ type: 'pipe-producer', roomId: 'r-drop', producerId: 'p', kind: 'audio' }));
    await tick();

    expect(registry.resolve('r-drop')).toBeNull(); // dropped, not recorded
    ws.close();
  });

  it('RECORDS a pipe-producer from a tagged inter-relay peer (valid Bearer)', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: vi.fn() };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectWithToken(port, 'relay-secret');
    ws.send(JSON.stringify({ type: 'pipe-producer', roomId: 'r-keep', producerId: 'p-real', kind: 'video' }));
    await tick();

    expect(registry.resolve('r-keep')?.producerId).toBe('p-real');
    ws.close();
  });

  it('records an untagged pipe-producer when INTER_RELAY_TOKEN is UNSET (backward-compat)', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: vi.fn() };
    const { wss, port } = await startServer(interRelay, undefined); // token unset
    server = wss;

    const ws = await connectPlain(port);
    ws.send(JSON.stringify({ type: 'pipe-producer', roomId: 'r-compat', producerId: 'p-compat', kind: 'audio' }));
    await tick();

    expect(registry.resolve('r-compat')?.producerId).toBe('p-compat');
    ws.close();
  });

  it('calls attachPeerSocket with the accepted socket for a tagged peer, then null on close', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectWithToken(port, 'relay-secret');
    await tick();
    expect(attachPeerSocket).toHaveBeenCalledTimes(1);
    expect(attachPeerSocket.mock.calls[0]![0]).not.toBeNull();

    ws.close();
    await tick();
    // last call detaches (single-box)
    const lastArg = attachPeerSocket.mock.calls.at(-1)![0];
    expect(lastArg).toBeNull();
  });

  it('does NOT attach an untagged client as an inter-relay peer', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port); // a normal client
    await tick();
    expect(attachPeerSocket).not.toHaveBeenCalled();
    ws.close();
  });

  it('fires onStandbyRoomReady(roomId, router) once on the standby first peer join', async () => {
    const onStandbyRoomReady = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port);
    const reply = new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-S', peerId: 'peer-1' }));
    await reply;
    await tick();

    expect(onStandbyRoomReady).toHaveBeenCalledTimes(1);
    expect(onStandbyRoomReady.mock.calls[0]![0]).toBe('room-S');
    expect(onStandbyRoomReady.mock.calls[0]![1]).toBeDefined(); // the room router
    ws.close();
  });

  it('does NOT fire onStandbyRoomReady when this relay is primary', async () => {
    const onStandbyRoomReady = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port);
    const reply = new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-P', peerId: 'peer-1' }));
    await reply;
    await tick();

    expect(onStandbyRoomReady).not.toHaveBeenCalled();
    ws.close();
  });

  it('fires onStandbyRoomReady ONCE across two joins to the SAME room (per-room)', async () => {
    const onStandbyRoomReady = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws1 = await connectPlain(port);
    const r1 = new Promise((r) => ws1.once('message', r));
    ws1.send(JSON.stringify({ type: 'join', roomId: 'room-twice', peerId: 'p1' }));
    await r1;

    const ws2 = await connectPlain(port);
    const r2 = new Promise((r) => ws2.once('message', r));
    ws2.send(JSON.stringify({ type: 'join', roomId: 'room-twice', peerId: 'p2' }));
    await r2;
    await tick();

    // Room created once (first join) → the warm pipe opens once, not per joiner.
    expect(onStandbyRoomReady).toHaveBeenCalledTimes(1);
    ws1.close();
    ws2.close();
  });

  it('a second tagged peer displaces the first; the first peer close does NOT detach the second', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws1 = await connectWithToken(port, 'relay-secret');
    await tick();
    const ws2 = await connectWithToken(port, 'relay-secret');
    await tick();

    // Both tagged → attached; the latest call is the second (non-null) socket.
    expect(attachPeerSocket.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(attachPeerSocket.mock.calls.at(-1)![0]).not.toBeNull();

    // Close the FIRST peer → must NOT detach (the attached socket is ws2).
    const before = attachPeerSocket.mock.calls.length;
    ws1.close();
    await tick();
    const detachedAfterWs1 = attachPeerSocket.mock.calls.slice(before).some((c) => c[0] === null);
    expect(detachedAfterWs1).toBe(false);

    // Close the SECOND (attached) peer → detaches (single-box null).
    ws2.close();
    await tick();
    expect(attachPeerSocket.mock.calls.at(-1)![0]).toBeNull();
  });
});
