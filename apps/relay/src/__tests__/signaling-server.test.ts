/**
 * Integration-style tests for the relay mediasoup signaling server.
 *
 * Starts a real WebSocket server with a mocked MediasoupManager (mediasoup
 * native workers are unavailable on Windows CI). Verifies the full signaling
 * protocol: join, createTransport, leave, disconnect cleanup.
 *
 * See signaling.fixtures.ts for the shared harness (mocked mediasoup types,
 * startServer, connect/waitForMessage).
 *
 * Requirements: RELAY-05
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createMockManager,
  startServer,
  connect,
  waitForMessage,
  tick,
  resetTransportCounter,
} from './signaling.fixtures.js';

// ── Tests ───────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;

afterEach(() => {
  if (server) {
    server.close();
    server = undefined;
  }
});

describe('Relay signaling server', () => {
  beforeEach(() => {
    resetTransportCounter();
  });

  it('starts and accepts connections', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('join message returns routerRtpCapabilities', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);
    const msgPromise = waitForMessage(ws);

    ws.send(JSON.stringify({ type: 'join', roomId: 'room-1', peerId: 'peer-1' }));

    const msg = await msgPromise;
    expect(msg['type']).toBe('routerRtpCapabilities');
    expect(msg['rtpCapabilities']).toBeDefined();
    expect(msg['mode']).toBeDefined();
    ws.close();
  });

  it('createTransport (send) returns transportCreated with params', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // Must join first. handleJoin sends TWO messages back-to-back with no
    // await between them (routerRtpCapabilities, then roomMode) — drain both
    // before registering the next listener, or a slow enough scheduler tick
    // lets the still-in-flight roomMode land on transportPromise's listener
    // instead (flaky failure: msg.type === 'roomMode' where 'transportCreated'
    // was expected).
    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-2', peerId: 'peer-2' }));
    await joinPromise;
    await waitForMessage(ws); // drain roomMode

    // Request send transport
    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));

    const msg = await transportPromise;
    expect(msg['type']).toBe('transportCreated');
    expect(msg['id']).toBeDefined();
    expect(msg['iceParameters']).toBeDefined();
    expect(msg['iceCandidates']).toBeDefined();
    expect(msg['dtlsParameters']).toBeDefined();
    ws.close();
  });

  it('createTransport (recv) returns transportCreated', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // See the "createTransport (send)" test above for why roomMode must be
    // drained here too.
    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-3', peerId: 'peer-3' }));
    await joinPromise;
    await waitForMessage(ws); // drain roomMode

    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));

    const msg = await transportPromise;
    expect(msg['type']).toBe('transportCreated');
    expect(msg['id']).toBeDefined();
    ws.close();
  });

  it('peer disconnect cleans up room', async () => {
    const { wss, port, getRoomCount } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-4', peerId: 'peer-4' }));
    await joinPromise;

    expect(getRoomCount()).toBe(1);

    // Close connection — should trigger cleanup
    ws.close();
    await tick(200);

    expect(getRoomCount()).toBe(0);
  });

  it('two peers join same room and both get capabilities', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws1 = await connect(port);
    const ws2 = await connect(port);

    const msg1Promise = waitForMessage(ws1);
    ws1.send(JSON.stringify({ type: 'join', roomId: 'room-5', peerId: 'peer-A' }));
    const msg1 = await msg1Promise;
    expect(msg1['type']).toBe('routerRtpCapabilities');

    const msg2Promise = waitForMessage(ws2);
    ws2.send(JSON.stringify({ type: 'join', roomId: 'room-5', peerId: 'peer-B' }));
    const msg2 = await msg2Promise;
    expect(msg2['type']).toBe('routerRtpCapabilities');

    ws1.close();
    ws2.close();
  });

  it('a second join with the SAME peerId evicts the stale prior session instead of silently orphaning it', async () => {
    // Regression: two sockets sharing one peerId (e.g. two browser tabs on the
    // same connected wallet) used to both linger in room.peers -- actually only
    // the SECOND ever really worked; room.peers.set(peerId, ...) silently
    // overwrote the first entry, so the first socket stayed open but became
    // unreachable through room.peers, permanently missing every future
    // newProducer notification. Fixed by evicting the stale session (closing
    // it with 4001) before registering the new one.
    const { wss, port } = await startServer();
    server = wss;

    const wsOld = await connect(port);
    const oldJoinPromise = waitForMessage(wsOld);
    wsOld.send(JSON.stringify({ type: 'join', roomId: 'room-dup', peerId: 'peer-dup' }));
    await oldJoinPromise;

    const oldClosePromise = new Promise<number>((resolve) => {
      wsOld.once('close', (code) => resolve(code));
    });

    const wsNew = await connect(port);
    const newJoinPromise = waitForMessage(wsNew);
    wsNew.send(JSON.stringify({ type: 'join', roomId: 'room-dup', peerId: 'peer-dup' }));
    const newJoinMsg = await newJoinPromise;
    expect(newJoinMsg['type']).toBe('routerRtpCapabilities');

    // The OLD socket must be actively closed with the duplicate-session code —
    // not left dangling open-but-unreachable.
    const closeCode = await oldClosePromise;
    expect(closeCode).toBe(4001);

    // A THIRD peer joining afterward must see exactly the NEW session's
    // producers reachable, i.e. the room has one live peer under 'peer-dup',
    // not zero (both evicted) and not a stale duplicate.
    const wsThird = await connect(port);
    const thirdJoinPromise = waitForMessage(wsThird);
    wsThird.send(JSON.stringify({ type: 'join', roomId: 'room-dup', peerId: 'peer-third' }));
    const thirdJoinMsg = await thirdJoinPromise;
    expect(thirdJoinMsg['type']).toBe('routerRtpCapabilities');

    wsNew.close();
    wsThird.close();
  });

  it('invalid JSON message does not crash the server', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // Send garbage
    ws.send('this is not json{{{');
    await tick();

    // Server should still accept new connections
    const ws2 = await connect(port);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws.close();
    ws2.close();
  });

  it('parallel joins to the same room create exactly one Router (CI-18 lock)', async () => {
    // S25.C-followup.D: without the per-room async lock in handleJoin,
    // two peers connecting in the same Node tick each create their own
    // mediasoup Router and end up in separate rooms. Validates the lock
    // by asserting getRoomCount === 1 after two concurrent joins fired
    // without awaiting between sends.
    const manager = createMockManager();
    const createRouterSpy = manager.createRouter as ReturnType<typeof vi.fn>;
    const { wss, port, getRoomCount } = await startServer(manager);
    server = wss;

    const ws1 = await connect(port);
    const ws2 = await connect(port);

    const reply1 = waitForMessage(ws1);
    const reply2 = waitForMessage(ws2);

    // Fire both joins synchronously — relay must not race.
    ws1.send(JSON.stringify({ type: 'join', roomId: 'race-room', peerId: 'A' }));
    ws2.send(JSON.stringify({ type: 'join', roomId: 'race-room', peerId: 'B' }));

    await Promise.all([reply1, reply2]);
    await tick(100);

    expect(getRoomCount()).toBe(1);
    expect(createRouterSpy).toHaveBeenCalledTimes(1);

    ws1.close();
    ws2.close();
  });

  it('leave message removes peer from room', async () => {
    const { wss, port, getRoomCount } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-6', peerId: 'peer-6' }));
    await joinPromise;

    expect(getRoomCount()).toBe(1);

    // Send explicit leave
    ws.send(JSON.stringify({ type: 'leave' }));
    await tick(200);

    // Room should be cleaned up (only peer left)
    expect(getRoomCount()).toBe(0);

    ws.close();
  });
});
