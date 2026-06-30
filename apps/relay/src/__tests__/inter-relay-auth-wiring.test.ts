/**
 * G3.2b — signaling-server inter-relay auth gate + cross-daemon link wiring.
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
 *   6. END-TO-END: a standby openInterRelayLink → primary announce → the frame
 *      crosses a REAL socket → the standby records it (the production loop).
 *
 * Mocked MediasoupManager (real mediasoup workers gated to the relay-integration
 * suite). Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS wiring + auth).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  createWsInterRelaySender,
  handleInboundInterRelayFrame,
  INTER_RELAY_SUBPROTOCOL,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import { openInterRelayLink } from '@dvconf/inter-relay-client';

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockResolvedValue({
      id: 't', iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      connect: vi.fn(),
      // REQ-RMS-037 (Task B4b): produce resolves a real Producer-shaped object so
      // handleProduce reaches the re-fan path (was `vi.fn()` → undefined → crash on
      // producer.id). VIDEO so the audio-observer arm is skipped (no observer mock).
      produce: vi.fn().mockResolvedValue({ id: 'producer-REAL-refan', kind: 'video', on: vi.fn(), close: vi.fn() }),
      consume: vi.fn(), setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
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

/** Start a relay signaling server on port 0 with an optional INTER_RELAY_TOKEN. */
function startServer(
  interRelay: InterRelayContext,
  token?: string,
): Promise<{ wss: WebSocketServer; port: number; factory: ReturnType<typeof createSignalingServer> }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    if (token === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = token;

    // REQ-RMS-037 (Task B4b): capture the FULL factory return so a test can drive
    // reannounceLocalProducersUp directly (additive — existing callers destructure
    // only { wss, port } and ignore the extra field).
    const factory = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    );
    const { wss } = factory;

    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;

    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, factory });
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

function connectWithToken(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, INTER_RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * REQ-RMS-037 (Task B4b): connect as a TAGGED inter-relay peer carrying a DISTINCT
 * x-inter-relay-peer-id (the "attach a standby" path) so the primary buckets it
 * under `peerRelayId` and the re-fan-on-attach targets JUST this peer.
 */
function connectInterRelay(port: number, token: string, peerRelayId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, INTER_RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${token}`, 'x-inter-relay-peer-id': peerRelayId },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a message and await the next inbound message of `expectType`. */
function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const reply = JSON.parse(data.toString());
      if (reply.type === expectType) {
        ws.off('message', onMessage);
        resolve(reply);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

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

describe('inter-relay cross-daemon link END-TO-END (G3.2b)', () => {
  it('standby openInterRelayLink → primary announce → standby registry records over a real socket', async () => {
    const TOKEN = 'e2e-secret';
    // PRIMARY: holds the accepted standby socket; its sender transmits over it.
    const primaryBox: { socket: InterRelaySocketLike | null } = { socket: null };
    const primarySender = createWsInterRelaySender(() => primaryBox.socket, mockLogger());
    const announceProducer = createInterRelayAnnouncer(primarySender);
    const primaryInterRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: (roomId, producer) => announceProducer(roomId, producer),
      attachPeerSocket: (s) => { primaryBox.socket = s; },
    };
    const { wss, port } = await startServer(primaryInterRelay, TOKEN);
    server = wss;

    // STANDBY: open the real outbound link + route inbound frames to the handler.
    const standbyRegistry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();
    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      onFrame: (raw) => handleInboundInterRelayFrame(raw, { registry: standbyRegistry, onAnnounce }),
      logger: mockLogger(),
    });
    await tick(200); // link open + primary attach

    // PRIMARY produces → announces the REAL producerId across the live socket.
    primaryInterRelay.announceProducer('room-E2E', { id: 'producer-REAL-e2e', kind: 'audio' });
    await tick(200);

    expect(standbyRegistry.resolve('room-E2E')?.producerId).toBe('producer-REAL-e2e');
    // C6: the inbound handler threads the frame's peerRelayId (undefined — this
    // E2E announce carries no cascade peer → the standby defaults to DEFAULT).
    expect(onAnnounce).toHaveBeenCalledWith('room-E2E', undefined);

    link.close();
  });
});

describe('inter-relay re-fan-on-attach + standby UP re-announce (REQ-RMS-037, Task B4b)', () => {
  it('RED-RB-4a: a primary re-fans existing producers DOWN to a NEWLY-attached standby ONLY (no re-broadcast to synced peers)', async () => {
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    // An untagged client joins + produces BEFORE any standby attaches.
    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientP' }, 'routerRtpCapabilities');
    const created = await sendAndAwait(client, { type: 'createTransport', direction: 'send' }, 'transportCreated');
    await sendAndAwait(
      client,
      { type: 'produce', transportId: created.id, kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
      'produced',
    );
    await tick();

    // The pre-attach produce fanned ONE legacy (empty-keys) call (c[3] === undefined);
    // clear it so we count ONLY the re-fan to the newly-attached peer.
    onPrimaryProducer.mockClear();

    // NOW a standby attaches as a TAGGED inter-relay peer (Bearer + peerRelayId header).
    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    // Exactly ONE re-fan, to JUST standbyB (4th arg = peerRelayId), carrying the
    // original local publisher (clientP) as the 5th arg — NOT a re-broadcast.
    const calls = onPrimaryProducer.mock.calls.filter((c) => c[3] === 'ws://standbyB');
    expect(calls.length).toBe(1);
    expect(calls[0]![4]).toBe('clientP');

    client.close();
    standby.close();
  });

  it('RED-RB-4b: reannounceLocalProducersUp re-drives a standby local producer UP (link-reopen back-fill capability)', async () => {
    // 3b ships the back-fill as a CAPABILITY (factory fn + late-bind). Its automatic
    // trigger on link reopen has no clean per-room seam — the standby link is single-
    // box / per-daemon and its open event is owned by inter-relay-link.ts — so the
    // reopen back-fill is covered structurally by RED-RA-2b (the A2 reverse queue
    // back-fills pre-connect producers). This asserts the capability the wiring would
    // invoke. RED today: reannounceLocalProducersUp does not exist on the factory.
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyProducer,
    };
    const { wss, port, factory } = await startServer(interRelay); // token unset
    server = wss;

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomS', peerId: 'clientS' }, 'routerRtpCapabilities');
    const created = await sendAndAwait(client, { type: 'createTransport', direction: 'send' }, 'transportCreated');
    await sendAndAwait(
      client,
      { type: 'produce', transportId: created.id, kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
      'produced',
    );
    await tick();

    // The live produce already fired onStandbyProducer once; clear it so we count
    // ONLY the reopen re-announce.
    onStandbyProducer.mockClear();

    factory.reannounceLocalProducersUp('roomS');
    await tick();

    expect(onStandbyProducer).toHaveBeenCalledTimes(1);
    const call = onStandbyProducer.mock.calls[0]!;
    expect(call[0]).toBe('roomS');   // roomId
    expect(call[3]).toBe('clientS'); // the original local publisher (REQ-RMS-029)

    client.close();
  });

  it('RED-RB-6b1: re-fan-on-attach replays REVERSE-MINTED hub copies DOWN to a new standby, EXCLUDING any whose origin IS that standby (REQ-RMS-036)', async () => {
    // GAP COVERAGE (ledger B4b #2): RED-RB-4a exercises the LOCAL-producer re-fan
    // arm (signaling.ts:780-784) with an EMPTY originRegistry. THIS test isolates
    // the REVERSE-MINTED arm (signaling.ts:790-795) -- the hub copies of OTHER
    // standbys' streams -- and proves the exclude-origin guard (line 793) never
    // echoes a producer back to the standby it came from.
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port, factory } = await startServer(interRelay, 'relay-secret');
    server = wss;

    // A local client joins to CREATE the room (registerReverseMinted no-ops on an
    // unknown room). It does NOT produce -- so the LOCAL-producer re-fan arm
    // contributes ZERO onPrimaryProducer calls and we observe the reverse arm alone.
    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientLocal' }, 'routerRtpCapabilities');
    await tick();

    // Seed the originRegistry with TWO reverse-minted hub copies via the real seam:
    //   - one whose origin is standbyC (a DIFFERENT relay -> MUST be re-fanned to B)
    //   - one whose origin is standbyB (the relay about to attach -> MUST be excluded)
    const mintedFromC = { id: 'rev-minted-C', kind: 'video' as const, on: vi.fn() } as any;
    const mintedFromB = { id: 'rev-minted-B', kind: 'video' as const, on: vi.fn() } as any;
    factory.registerReverseMinted('roomA', mintedFromC, 'ws://standbyC', 'clientC');
    factory.registerReverseMinted('roomA', mintedFromB, 'ws://standbyB', 'clientB');

    // registerReverseMinted hub-fans immediately to ALREADY-attached peers (none
    // yet) -- clear so we count ONLY the re-fan triggered by the attach below.
    onPrimaryProducer.mockClear();

    // standbyB attaches as a TAGGED inter-relay peer -> triggers re-fan-on-attach.
    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    // Exactly ONE reverse-minted re-fan reaches standbyB: the standbyC-origin copy.
    const calls = onPrimaryProducer.mock.calls.filter((c) => c[3] === 'ws://standbyB');
    expect(calls.length).toBe(1);
    expect(calls[0]![2]).toBe(mintedFromC);  // the live minted Producer handle
    expect(calls[0]![4]).toBe('clientC');    // original publisher (REQ-RMS-029)
    // EXCLUDE-ORIGIN (REQ-RMS-036): the standbyB-origin copy is NEVER echoed back.
    expect(calls.some((c) => c[2] === mintedFromB)).toBe(false);

    client.close();
    standby.close();
  });

  it('RED-RB-6b2: a reverse-minted producer whose @close fired is dropped from the originRegistry and is NOT re-fanned on a later attach (REQ-RMS-036 cleanup teeth)', async () => {
    // TEETH for the @close cleanup arm (signaling.ts:2003). Prior units mocked
    // minted.on = vi.fn() so @close NEVER fired -> the cleanup was uncovered. Here
    // the fake Producer CAPTURES the '@close' handler the factory registers, fires
    // it (as the real Producer would on close), and proves the entry is gone so the
    // dead handle is never replayed to a freshly-attached standby.
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port, factory } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientLocal' }, 'routerRtpCapabilities');
    await tick();

    const closeHandlers: Array<() => void> = [];
    const mintedFromC = {
      id: 'rev-minted-C',
      kind: 'video' as const,
      closed: false,
      on: (ev: string, cb: () => void) => { if (ev === '@close') closeHandlers.push(cb); },
    } as any;
    factory.registerReverseMinted('roomA', mintedFromC, 'ws://standbyC', 'clientC');

    // The @close arm MUST be wired (teeth: drop this assertion's target -> RED).
    expect(closeHandlers.length).toBe(1);
    closeHandlers.forEach((cb) => cb()); // producer closes -> originRegistry entry dropped
    onPrimaryProducer.mockClear();

    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    // The closed producer is GONE from the registry -> never replayed to standbyB.
    expect(onPrimaryProducer.mock.calls.some((c) => c[2] === mintedFromC)).toBe(false);

    client.close();
    standby.close();
  });

  it('RED-RB-6b3: re-fan-on-attach SKIPS a .closed reverse-minted producer even if its registry entry survived (defense-in-depth guard); a live sibling is still re-fanned', async () => {
    // Defense-in-depth for a REGRESSED/missed @close: if the cleanup ever fails to
    // drop a closed producer, the re-fan loop must not echo a dead handle. `on:
    // vi.fn()` NEVER fires @close, so the entry SURVIVES; setting .closed=true
    // simulates the closed-but-still-registered state. The guard skips ONLY the
    // closed one -- the live sibling is still re-fanned (selective, not a blanket).
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onPrimaryProducer,
      attachPeerSocket: vi.fn(),
    };
    const { wss, port, factory } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const client = await connectPlain(port);
    await sendAndAwait(client, { type: 'join', roomId: 'roomA', peerId: 'clientLocal' }, 'routerRtpCapabilities');
    await tick();

    // Both origins differ from the attaching standbyB (so neither is excluded by origin).
    const mintedClosed = { id: 'rev-closed', kind: 'video' as const, closed: false, on: vi.fn() } as any;
    const mintedLive = { id: 'rev-live', kind: 'video' as const, closed: false, on: vi.fn() } as any;
    factory.registerReverseMinted('roomA', mintedClosed, 'ws://standbyC', 'clientC');
    factory.registerReverseMinted('roomA', mintedLive, 'ws://standbyD', 'clientD');

    mintedClosed.closed = true; // closed, but its entry was NOT cleaned up (regression sim)
    onPrimaryProducer.mockClear();

    const standby = await connectInterRelay(port, 'relay-secret', 'ws://standbyB');
    await tick();

    const toB = onPrimaryProducer.mock.calls.filter((c) => c[3] === 'ws://standbyB');
    expect(toB.some((c) => c[2] === mintedClosed)).toBe(false); // RED today: re-fanned w/o the guard
    expect(toB.some((c) => c[2] === mintedLive)).toBe(true);    // live sibling still re-fanned

    client.close();
    standby.close();
  });
});
