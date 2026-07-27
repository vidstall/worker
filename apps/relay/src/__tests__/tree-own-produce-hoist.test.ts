/**
 * Cascade-tree Phase T-B — signaling-level SPY coverage for the §3.3 OWN-PRODUCE HOIST.
 * REQ-RMS-042/044/046 (T7 follow-up).
 *
 * THE GAP THIS CLOSES (Task 9 spec-review): reverting signaling.ts's own-produce hoist
 *   `if (interRelay?.treeActive && interRelay.fanToTreeNeighbors) { fanToTreeNeighbors(...) }`
 * (handleProduce) makes an OWN produce fall through to the role-branched UP-only
 * `onStandbyProducer` path again — and NO test caught it (Task 9's integration harness
 * reconstructs the fan, so it can't see the signaling dispatch; the T7 unit suite only
 * covers the coordinator callback threading). This drives the REAL `handleProduce` via
 * `createSignalingServer` (mocked MediasoupManager — NO mediasoup Workers) and asserts the
 * hoist actually fires, so a revert of the hoist goes RED here.
 *
 * RED-on-revert proof: comment out the treeActive branch (handleProduce) → an OWN produce
 * on a chain-STANDBY node hits `onStandbyProducer` (UP-only) → `fanToTreeNeighbors` is never
 * called AND `onStandbyProducer` IS → the two hoist TESTS below fail. Restored → GREEN.
 *
 * Harness mirrors primary-produce-drive.test.ts (real createSignalingServer, mock manager).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';

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
      produce: vi.fn().mockResolvedValue({
        id: 'producer-OWN-hoist',
        kind: 'video',
        on: vi.fn(),
        close: vi.fn(),
      }),
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
    workers: [{ pid: 1 } as unknown as import('mediasoup').types.Worker],
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
function startServer(interRelay: InterRelayContext): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    delete process.env['INTER_RELAY_TOKEN']; // bench / single-host: gate open
    const { wss } = createSignalingServer(createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay);
    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port });
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
const tick = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData): void => {
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

/** Drive one OWN local-client produce through the REAL handleProduce. */
async function driveOwnProduce(interRelay: InterRelayContext, roomId: string): Promise<{ close: () => void }> {
  const { wss, port } = await startServer(interRelay);
  const ws = await connectPlain(port);
  await sendAndAwait(ws, { type: 'join', roomId, peerId: 'peer-1' }, 'routerRtpCapabilities');
  const created = await sendAndAwait(ws, { type: 'createTransport', direction: 'send' }, 'transportCreated');
  await sendAndAwait(
    ws,
    { type: 'produce', transportId: created['id'], kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
    'produced',
  );
  await tick();
  return { close: () => { ws.close(); wss.close(); } };
}

let closer: { close: () => void } | undefined;
afterEach(() => { closer?.close(); closer = undefined; });

describe('T-B §3.3 own-produce HOIST — handleProduce routes ANY own produce through fanToTreeNeighbors (REQ-RMS-042/044/046)', () => {
  it('a chain-STANDBY node OWN produce (treeActive) fires fanToTreeNeighbors with (roomId, router, producer, peerId, producer.id, null, undefined) and does NOT hit the UP-only onStandbyProducer branch [RED if the hoist is reverted]', async () => {
    const fanToTreeNeighbors = vi.fn();
    const onStandbyProducer = vi.fn();
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',              // an internal/leaf CHAIN-standby node
      treeActive: true,             // RMS_TREE_ACTIVE
      fanToTreeNeighbors,
      onStandbyProducer,
      onPrimaryProducer,
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    closer = await driveOwnProduce(interRelay, 'room-hoist-standby');

    // The hoist fired — an OWN produce goes through the UNIFORM tree fan, NOT the role branch.
    expect(fanToTreeNeighbors).toHaveBeenCalledOnce();
    const call = fanToTreeNeighbors.mock.calls[0]!;
    expect(call[0]).toBe('room-hoist-standby');              // roomId
    expect(call[1]).toBeDefined();                            // room.router
    expect((call[2] as { id?: string }).id).toBe('producer-OWN-hoist'); // the real Producer
    expect(call[3]).toBe('peer-1');                           // producerPeerId (the local publisher)
    expect(call[4]).toBe('producer-OWN-hoist');              // originProducerId === producer.id (own produce IS the origin)
    expect(call[5]).toBeNull();                               // receiveEdgeUrl === null (local origin → fan ALL neighbors)
    expect(call[6]).toBeUndefined();                          // inboundHopTtl === undefined (seeds from diameter)

    // The pre-§3.3 UP-only path is NOT taken (this is what a revert would wrongly re-enable).
    expect(onStandbyProducer).not.toHaveBeenCalled();
    expect(onPrimaryProducer).not.toHaveBeenCalled();
  });

  it('the hoist is ROLE-INDEPENDENT: a chain-PRIMARY node OWN produce also routes through fanToTreeNeighbors, NOT the primary onPrimaryProducer star-fan branch', async () => {
    const fanToTreeNeighbors = vi.fn();
    const onPrimaryProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      treeActive: true,
      fanToTreeNeighbors,
      onPrimaryProducer,
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    closer = await driveOwnProduce(interRelay, 'room-hoist-primary');

    expect(fanToTreeNeighbors).toHaveBeenCalledOnce();
    expect(fanToTreeNeighbors.mock.calls[0]![5]).toBeNull();       // local-origin receiveEdge
    expect(fanToTreeNeighbors.mock.calls[0]![6]).toBeUndefined();  // no inbound budget
    expect(onPrimaryProducer).not.toHaveBeenCalled();             // NOT the flat-STAR primary fan
  });

  it('FLAG-OFF byte-stability: treeActive undefined → the hoist NEVER fires; a chain-standby own produce still hits the shipped UP-only onStandbyProducer branch (4-arg)', async () => {
    const fanToTreeNeighbors = vi.fn();
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      // treeActive omitted (flag OFF) — the shipped role-branched path must be byte-stable.
      fanToTreeNeighbors,          // present but MUST NOT be called when treeActive is falsy
      onStandbyProducer,
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    closer = await driveOwnProduce(interRelay, 'room-flagoff-standby');

    expect(fanToTreeNeighbors).not.toHaveBeenCalled();       // the guard `treeActive &&` blocks it
    expect(onStandbyProducer).toHaveBeenCalledOnce();        // shipped UP-only reverse announce
    const call = onStandbyProducer.mock.calls[0]!;
    expect(call[0]).toBe('room-flagoff-standby');
    expect((call[2] as { id?: string }).id).toBe('producer-OWN-hoist');
    expect(call[3]).toBe('peer-1');
    expect(call.length).toBe(4);                             // EXACT 4-arg shipped tuple (no tree widening)
  });
});
