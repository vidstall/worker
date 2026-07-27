/**
 * W5 M2 P1.0 (REQ-MCS-012/013) — Zoom-style link admission + session-key roster.
 *
 * Decision baseline (CONTEXT D-M2-18, P1.0-FINALIZE-SPEC §1/§3/§4):
 *  - admission = room-id + room-password, checked ONLINE signaling-side
 *    (rate-limited; hash-verifier held signaling-side ⇒ dev-onchain IDLE).
 *  - #3 FIRST-JOINER-SETS-IT (host model): the first peer to reach a roomId with
 *    no passwordHash SETS it from hash(password) and becomes host; every later
 *    joiner must match or is rejected BEFORE any room/router is created.
 *  - each joiner announces its in-browser ed25519 session PUBLIC key
 *    (`peerPubkey`, base64 32-byte) → recorded in the in-memory room roster the
 *    coordinator later seals K_room to (P1/P3). A malformed (non-32-byte) pubkey
 *    FAILS admission loud.
 *  - #2 signature/nonce ride the wire UNVERIFIED in M2 (admission gate =
 *    password); relay-side ed25519 verify deferred → M3.
 *
 * Mirrors the integration-style harness in signaling.test.ts (real WS server,
 * mocked MediasoupManager — mediasoup native workers unavailable on Windows CI).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (copied from signaling.test.ts harness) ───────

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-1', kind: 'audio', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, close: vi.fn() }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

let transportCounter = 0;

function mockRouter() {
  return {
    rtpCapabilities: {
      codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
      headerExtensions: [],
    },
    createWebRtcTransport: vi.fn().mockImplementation(async () => {
      transportCounter++;
      return mockTransport(`transport-${transportCounter}`);
    }),
    createAudioLevelObserver: vi.fn().mockResolvedValue({
      on: vi.fn(),
      addProducer: vi.fn().mockResolvedValue(undefined),
      removeProducer: vi.fn().mockResolvedValue(undefined),
    }),
    canConsume: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}

function createMockManager(): { manager: MediasoupManager; createRouterSpy: ReturnType<typeof vi.fn> } {
  const router = mockRouter();
  const createRouterSpy = vi.fn().mockResolvedValue(router);
  const manager = {
    workers: [{ pid: 1 } as unknown],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: createRouterSpy,
    close: vi.fn(),
  } as unknown as MediasoupManager;
  return { manager, createRouterSpy };
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

// ── Helpers ───────────────────────────────────────────────────────────

interface StartedServer {
  wss: WebSocketServer;
  port: number;
  getRoomCount: () => number;
  createRouterSpy: ReturnType<typeof vi.fn>;
}

function startServer(): Promise<StartedServer> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const { manager, createRouterSpy } = createMockManager();
    const metrics = new MetricsTracker();
    const logger = mockLogger();
    const { wss, getRoomCount } = createSignalingServer(manager, metrics, logger);
    process.env['WS_PORT'] = originalPort;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, getRoomCount, createRouterSpy });
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

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Valid base64 of a 32-byte ed25519 session pubkey (deterministic per seed). */
function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) {
    server.close();
    server = undefined;
  }
  transportCounter = 0;
});

describe('W5 M2 P1.0 — room-password admission (first-joiner-sets-it host model)', () => {
  it('first joiner with NO existing passwordHash SETS the password and is admitted (becomes host)', async () => {
    const s = await startServer();
    server = s.wss;
    const ws = await connect(s.port);
    const reply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'pw-room-1', peerId: 'host-1', roomPassword: 'sekret', peerPubkey: pubkey32(1) }));
    const msg = await reply;
    expect(msg['type']).toBe('routerRtpCapabilities');
    expect(s.getRoomCount()).toBe(1);
    ws.close();
  });

  it('second joiner with the WRONG password is rejected with an error BEFORE any router/room is created', async () => {
    const s = await startServer();
    server = s.wss;

    // Host sets the password.
    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'pw-room-2', peerId: 'host', roomPassword: 'correct', peerPubkey: pubkey32(1) }));
    await hostReply;
    expect(s.createRouterSpy).toHaveBeenCalledTimes(1);

    // Wrong-password joiner.
    const wsBad = await connect(s.port);
    const badReply = waitForMessage(wsBad);
    wsBad.send(JSON.stringify({ type: 'join', roomId: 'pw-room-2', peerId: 'intruder', roomPassword: 'WRONG', peerPubkey: pubkey32(2) }));
    const msg = await badReply;
    expect(msg['type']).toBe('error');
    // No SECOND router was created (the room already existed; the wrong-password
    // joiner is rejected before being added). Room peer count stays at 1.
    expect(s.createRouterSpy).toHaveBeenCalledTimes(1);

    wsHost.close();
    wsBad.close();
  });

  it('second joiner with the RIGHT password is admitted into the host room', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'pw-room-3', peerId: 'host', roomPassword: 'pw3', peerPubkey: pubkey32(1) }));
    await hostReply;

    const wsGuest = await connect(s.port);
    const guestReply = waitForMessage(wsGuest);
    wsGuest.send(JSON.stringify({ type: 'join', roomId: 'pw-room-3', peerId: 'guest', roomPassword: 'pw3', peerPubkey: pubkey32(2) }));
    const msg = await guestReply;
    expect(msg['type']).toBe('routerRtpCapabilities');
    expect(s.getRoomCount()).toBe(1);

    wsHost.close();
    wsGuest.close();
  });

  it('a wrong password does NOT corrupt the host room — the host stays joined', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'pw-room-4', peerId: 'host', roomPassword: 'right', peerPubkey: pubkey32(1) }));
    await hostReply;
    expect(s.getRoomCount()).toBe(1);

    const wsBad = await connect(s.port);
    const badReply = waitForMessage(wsBad);
    wsBad.send(JSON.stringify({ type: 'join', roomId: 'pw-room-4', peerId: 'bad', roomPassword: 'no', peerPubkey: pubkey32(2) }));
    await badReply;

    // Room still exists with only the host.
    expect(s.getRoomCount()).toBe(1);
    wsHost.close();
    wsBad.close();
  });
});

describe('W5 M2 P1.0 — {peerId → sessionPubkey} roster capture + malformed-key reject', () => {
  it('the host roster captures the joiner sessionPubkey (announced to the room)', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'roster-1', peerId: 'host', roomPassword: 'p', peerPubkey: pubkey32(1) }));
    await hostReply;

    // A second joiner triggers a roster-announce frame to the host carrying the
    // new peer's sessionPubkey.
    const announce = waitForMessage(wsHost);
    const wsGuest = await connect(s.port);
    const guestReply = waitForMessage(wsGuest);
    const guestKey = pubkey32(2);
    wsGuest.send(JSON.stringify({ type: 'join', roomId: 'roster-1', peerId: 'guest', roomPassword: 'p', peerPubkey: guestKey }));
    await guestReply;

    const frame = await announce;
    expect(frame['type']).toBe('rosterPeer');
    expect(frame['peerId']).toBe('guest');
    expect(frame['sessionPubkey']).toBe(guestKey);

    wsHost.close();
    wsGuest.close();
  });

  it('COVERT (negative): a NO-password legacy joiner is admitted but triggers ZERO rosterPeer to the host (signaling.ts:963)', async () => {
    // The mirror of the positive announce above + the cross-lock for the covert canary
    // publisher (validator-daemon RelaySignalingCovertTransport, REQ-MLW-A-11): a join that
    // OMITS roomPassword takes the legacy path (signaling.ts:790) → sessionPubkey stays
    // undefined → the :963 `if (sessionPubkey !== undefined)` roster broadcast is skipped. The
    // legacy peer's media is still forwarded, but no existing member is told a new MEMBER
    // appeared. This pins the NEGATIVE direction on the REAL relay (not just the canary's
    // in-test FakeRelay model).
    const s = await startServer();
    server = s.wss;

    // Host joins WITH a password → it has a sessionPubkey and is a roster-broadcast target.
    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'covert-neg', peerId: 'host', roomPassword: 'p', peerPubkey: pubkey32(1) }));
    await hostReply;

    // Collect EVERY frame the host receives from here on.
    const hostFrames: Record<string, unknown>[] = [];
    wsHost.on('message', (d) => hostFrames.push(JSON.parse(d.toString()) as Record<string, unknown>));

    // The covert joiner joins the SAME room with NO roomPassword / no peerPubkey (legacy path).
    const wsCovert = await connect(s.port);
    const covertReply = waitForMessage(wsCovert);
    wsCovert.send(JSON.stringify({ type: 'join', roomId: 'covert-neg', peerId: 'covert' }));
    const covertMsg = await covertReply;
    // It IS admitted (legacy path — the password gate only engages when roomPassword is sent).
    expect(covertMsg['type']).toBe('routerRtpCapabilities');
    expect(s.getRoomCount()).toBe(1);

    await tick(200);

    // The host received ZERO rosterPeer frames about the covert peer — covert by omission.
    const rosterAboutCovert = hostFrames.filter(
      (f) => f['type'] === 'rosterPeer' && f['peerId'] === 'covert',
    );
    expect(rosterAboutCovert.length).toBe(0);

    wsHost.close();
    wsCovert.close();
  });

  it('a malformed (non-32-byte) peerPubkey FAILS admission loud (error reply, no room created)', async () => {
    const s = await startServer();
    server = s.wss;

    const ws = await connect(s.port);
    const reply = waitForMessage(ws);
    // 16-byte key (wrong length) → must be rejected before room creation.
    const shortKey = createHash('md5').update('x').digest('base64'); // 16 bytes
    ws.send(JSON.stringify({ type: 'join', roomId: 'roster-bad', peerId: 'p', roomPassword: 'p', peerPubkey: shortKey }));
    const msg = await reply;
    expect(msg['type']).toBe('error');
    expect(s.getRoomCount()).toBe(0);
    expect(s.createRouterSpy).not.toHaveBeenCalled();
    ws.close();
  });

  it('teardown drops the peer sessionPubkey from the roster on disconnect (roster shrinks)', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'teardown-1', peerId: 'host', roomPassword: 'p', peerPubkey: pubkey32(1) }));
    await hostReply;

    const wsGuest = await connect(s.port);
    const guestReply = waitForMessage(wsGuest);
    wsGuest.send(JSON.stringify({ type: 'join', roomId: 'teardown-1', peerId: 'guest', roomPassword: 'p', peerPubkey: pubkey32(2) }));
    await guestReply;

    // Guest leaves → roster must shrink (host remains, room stays).
    wsGuest.close();
    await tick(200);
    expect(s.getRoomCount()).toBe(1);

    // Host leaves → room empties; its passwordHash/config + rate-limiter must be
    // cleaned up so the roomId is reusable from scratch (first-joiner-sets-it).
    wsHost.close();
    await tick(200);
    expect(s.getRoomCount()).toBe(0);

    // A brand-new host can now SET a fresh password on the SAME roomId.
    const wsNew = await connect(s.port);
    const newReply = waitForMessage(wsNew);
    wsNew.send(JSON.stringify({ type: 'join', roomId: 'teardown-1', peerId: 'host2', roomPassword: 'different', peerPubkey: pubkey32(3) }));
    const msg = await newReply;
    expect(msg['type']).toBe('routerRtpCapabilities');
    wsNew.close();
  });
});

describe('W5 M2 P1.0 — rate-limiter (Zoom-equivalent brute-force defense)', () => {
  it('repeated WRONG-password attempts are rate-limited (later attempts get a rate-limit error)', async () => {
    const s = await startServer();
    server = s.wss;

    // Host sets the password.
    const wsHost = await connect(s.port);
    const hostReply = waitForMessage(wsHost);
    wsHost.send(JSON.stringify({ type: 'join', roomId: 'rl-room', peerId: 'host', roomPassword: 'realpw', peerPubkey: pubkey32(1) }));
    await hostReply;

    // Hammer wrong passwords from many sockets. After the threshold the relay
    // must refuse with a rate-limit error rather than a plain wrong-password
    // error — the brute-force defense kicks in.
    let sawRateLimit = false;
    for (let i = 0; i < 12; i++) {
      const ws = await connect(s.port);
      const reply = waitForMessage(ws);
      ws.send(JSON.stringify({ type: 'join', roomId: 'rl-room', peerId: `bf-${i}`, roomPassword: `bad-${i}`, peerPubkey: pubkey32(100 + i) }));
      const msg = await reply;
      expect(msg['type']).toBe('error');
      if (typeof msg['message'] === 'string' && /rate|too many|locked/i.test(msg['message'])) {
        sawRateLimit = true;
      }
      ws.close();
    }
    expect(sawRateLimit).toBe(true);

    wsHost.close();
  });
});
