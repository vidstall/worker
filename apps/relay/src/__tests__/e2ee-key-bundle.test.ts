/**
 * W5 M2 P4 (REQ-MCS-012, transport half) — BLIND signaling broadcast of the
 * sealed `e2eeKeyBundle`.
 *
 * Contract: CONTRACTS.md §1 (FROZEN). The coordinator's KeyManager (client, P3)
 * produces an `E2EEKeyBundleMessage` and emits ONE bundle over the signaling WS.
 * Signaling broadcasts it RECIPIENT-OBLIVIOUS to the OTHER room members and
 * NEVER holds / derives / decrypts / logs a key — it forwards opaque bytes.
 *
 *   interface E2EEKeyBundleMessage {
 *     type: 'e2eeKeyBundle';
 *     roomId: string; epoch: number; kid: number; coordinatorPubkey: string;
 *     envelopes: { recipientPubkey: string; sealedKey: string }[];
 *   }
 *
 * Invariants asserted here (qc verifies the same):
 *  (a) every OTHER member receives the byte-identical bundle; the SENDER gets no echo.
 *  (b) recipient-oblivious — each recipient gets the FULL envelopes array (incl.
 *      envelopes addressed to OTHER members); NO per-recipient filtering.
 *  (c) room-scoping / anti-spoof — a member of room A sending a bundle whose
 *      `roomId` = room B does NOT broadcast into room B (room derived from ws).
 *  (d) no key leak in logs — no log entry contains any `sealedKey` value; the
 *      info log carries ONLY { kid, epoch, roomId, envelopeCount, recipientCount }.
 *  (e) a member not in any room sending a bundle is ignored (no throw).
 *
 * Mirrors the integration-style harness in room-password-roster.test.ts (real WS
 * server, mocked MediasoupManager — mediasoup native workers unavailable on
 * Windows CI). The logger is a captured spy so (d) can inspect every call arg.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (copied from room-password-roster.test.ts harness) ──

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

function createMockManager(): { manager: MediasoupManager } {
  const router = mockRouter();
  const manager = {
    workers: [{ pid: 1 } as unknown],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
  return { manager };
}

/** A logger whose calls are captured so test (d) can scan every arg for leaks. */
function captureLogger() {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const mk = (level: string) => (...args: unknown[]) => {
    calls.push({ level, args });
  };
  const logger = {
    info: vi.fn(mk('info')),
    warn: vi.fn(mk('warn')),
    error: vi.fn(mk('error')),
    debug: vi.fn(mk('debug')),
    fatal: vi.fn(mk('fatal')),
    trace: vi.fn(mk('trace')),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as never;
  return { logger, calls };
}

// ── Helpers ───────────────────────────────────────────────────────────

interface StartedServer {
  wss: WebSocketServer;
  port: number;
  getRoomCount: () => number;
  calls: Array<{ level: string; args: unknown[] }>;
}

function startServer(): Promise<StartedServer> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const { manager } = createMockManager();
    const metrics = new MetricsTracker();
    const { logger, calls } = captureLogger();
    const { wss, getRoomCount } = createSignalingServer(manager, metrics, logger);
    process.env['WS_PORT'] = originalPort;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, getRoomCount, calls });
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

/**
 * Wait for the NEXT message of a specific `type` (skips earlier frames such as
 * routerRtpCapabilities / rosterPeer / newProducer that the join path emits).
 */
function waitForType(
  ws: WebSocket,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        ws.off('message', onMsg);
        reject(new Error(`Timeout waiting for ${type}`));
      },
      timeoutMs,
    );
    const onMsg = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
  });
}

/**
 * Resolve to the first frame of `type` within `windowMs`, or `null` if none
 * arrives — used to assert a frame is NOT delivered (no echo / no cross-room).
 */
function expectNoType(ws: WebSocket, type: string, windowMs = 400): Promise<null | Record<string, unknown>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(null);
    }, windowMs);
    const onMsg = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
  });
}

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Valid base64 of a 32-byte ed25519 session pubkey (deterministic per seed). */
function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

/** Valid base64 of a deterministic 48-byte opaque sealed key (per seed). */
function sealed(seed: number): string {
  return Buffer.concat([
    createHash('sha256').update(`sealed-a-${seed}`).digest(),
    createHash('sha256').update(`sealed-b-${seed}`).digest(),
  ])
    .subarray(0, 48)
    .toString('base64');
}

/** Join a peer (E2EE/admission path) and await its routerRtpCapabilities. */
async function joinPeer(
  port: number,
  roomId: string,
  peerId: string,
  pwd: string,
  keySeed: number,
): Promise<WebSocket> {
  const ws = await connect(port);
  const reply = waitForType(ws, 'routerRtpCapabilities');
  ws.send(
    JSON.stringify({ type: 'join', roomId, peerId, roomPassword: pwd, peerPubkey: pubkey32(keySeed) }),
  );
  await reply;
  return ws;
}

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) {
    server.close();
    server = undefined;
  }
  transportCounter = 0;
});

describe('W5 M2 P4 — e2eeKeyBundle BLIND broadcast (recipient-oblivious)', () => {
  it('(a) every OTHER member receives the byte-identical bundle; the sender gets NO echo', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await joinPeer(s.port, 'kb-a', 'host', 'pw', 1);
    const wsB = await joinPeer(s.port, 'kb-a', 'memberB', 'pw', 2);
    const wsC = await joinPeer(s.port, 'kb-a', 'memberC', 'pw', 3);
    await tick(120);

    const bundle = {
      type: 'e2eeKeyBundle' as const,
      roomId: 'kb-a',
      epoch: 1,
      kid: 1,
      coordinatorPubkey: pubkey32(1),
      envelopes: [
        { recipientPubkey: pubkey32(1), sealedKey: sealed(1) },
        { recipientPubkey: pubkey32(2), sealedKey: sealed(2) },
        { recipientPubkey: pubkey32(3), sealedKey: sealed(3) },
      ],
    };

    // host is the coordinator/sender → it must NOT receive an echo of its own bundle.
    const noEcho = expectNoType(wsHost, 'e2eeKeyBundle', 500);
    const gotB = waitForType(wsB, 'e2eeKeyBundle');
    const gotC = waitForType(wsC, 'e2eeKeyBundle');

    wsHost.send(JSON.stringify(bundle));

    const [echo, mb, mc] = await Promise.all([noEcho, gotB, gotC]);
    expect(echo).toBeNull(); // sender got no echo

    // Byte-identical bundle to each other member.
    for (const m of [mb, mc]) {
      expect(m['type']).toBe('e2eeKeyBundle');
      expect(m['roomId']).toBe('kb-a');
      expect(m['epoch']).toBe(1);
      expect(m['kid']).toBe(1);
      expect(m['coordinatorPubkey']).toBe(pubkey32(1));
      expect(m['envelopes']).toEqual(bundle.envelopes);
    }

    wsHost.close();
    wsB.close();
    wsC.close();
  });

  it('(b) recipient-oblivious — each recipient gets the FULL envelopes array (incl. envelopes for OTHER members)', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await joinPeer(s.port, 'kb-b', 'host', 'pw', 1);
    const wsB = await joinPeer(s.port, 'kb-b', 'memberB', 'pw', 2);
    const wsC = await joinPeer(s.port, 'kb-b', 'memberC', 'pw', 3);
    await tick(120);

    const envelopes = [
      { recipientPubkey: pubkey32(1), sealedKey: sealed(1) },
      { recipientPubkey: pubkey32(2), sealedKey: sealed(2) },
      { recipientPubkey: pubkey32(3), sealedKey: sealed(3) },
    ];
    const bundle = {
      type: 'e2eeKeyBundle' as const,
      roomId: 'kb-b',
      epoch: 5,
      kid: 5,
      coordinatorPubkey: pubkey32(1),
      envelopes,
    };

    const gotB = waitForType(wsB, 'e2eeKeyBundle');
    const gotC = waitForType(wsC, 'e2eeKeyBundle');
    wsHost.send(JSON.stringify(bundle));
    const [mb, mc] = await Promise.all([gotB, gotC]);

    // memberB receives ALL 3 envelopes — including the ones for host + memberC
    // (no per-recipient filtering). Same for memberC.
    for (const m of [mb, mc]) {
      const recv = (m['envelopes'] as Array<{ recipientPubkey: string }>).map((e) => e.recipientPubkey);
      expect(recv).toHaveLength(3);
      expect(recv).toContain(pubkey32(1));
      expect(recv).toContain(pubkey32(2));
      expect(recv).toContain(pubkey32(3));
    }

    wsHost.close();
    wsB.close();
    wsC.close();
  });

  it('(c) room-scoping / anti-spoof — a room-A member sending roomId=room-B does NOT broadcast into room B', async () => {
    const s = await startServer();
    server = s.wss;

    // Room A: attacker + a co-member. Room B: a victim.
    const wsAttacker = await joinPeer(s.port, 'room-A', 'attacker', 'pwA', 1);
    const wsACo = await joinPeer(s.port, 'room-A', 'a-co', 'pwA', 2);
    const wsVictim = await joinPeer(s.port, 'room-B', 'victim', 'pwB', 3);
    await tick(120);

    const spoof = {
      type: 'e2eeKeyBundle' as const,
      roomId: 'room-B', // spoofed — attacker is in room-A
      epoch: 9,
      kid: 9,
      coordinatorPubkey: pubkey32(1),
      envelopes: [{ recipientPubkey: pubkey32(3), sealedKey: sealed(9) }],
    };

    // The victim (room B) must NOT receive the spoofed bundle.
    const victimGot = expectNoType(wsVictim, 'e2eeKeyBundle', 500);
    wsAttacker.send(JSON.stringify(spoof));
    expect(await victimGot).toBeNull();

    // a-warn must be logged for the spoof attempt.
    const warned = s.calls.some(
      (c) =>
        c.level === 'warn' &&
        JSON.stringify(c.args).includes('room-B') &&
        /e2ee|bundle|mismatch|spoof|room/i.test(JSON.stringify(c.args)),
    );
    expect(warned).toBe(true);

    wsAttacker.close();
    wsACo.close();
    wsVictim.close();
  });

  it('(d) no key leak in logs — no sealedKey value appears; info log carries only kid/epoch/roomId/counts', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await joinPeer(s.port, 'kb-d', 'host', 'pw', 1);
    const wsB = await joinPeer(s.port, 'kb-d', 'memberB', 'pw', 2);
    await tick(120);

    const secretSealed = sealed(777);
    const bundle = {
      type: 'e2eeKeyBundle' as const,
      roomId: 'kb-d',
      epoch: 3,
      kid: 3,
      coordinatorPubkey: pubkey32(1),
      envelopes: [
        { recipientPubkey: pubkey32(1), sealedKey: sealed(1) },
        { recipientPubkey: pubkey32(2), sealedKey: secretSealed },
      ],
    };

    const gotB = waitForType(wsB, 'e2eeKeyBundle');
    wsHost.send(JSON.stringify(bundle));
    await gotB;
    await tick(80);

    // No log call anywhere may contain any sealedKey value.
    const allLogs = JSON.stringify(s.calls);
    expect(allLogs).not.toContain(secretSealed);
    expect(allLogs).not.toContain(sealed(1));

    // The broadcast info log carries ONLY the allowed metadata fields.
    const infoCall = s.calls.find(
      (c) =>
        c.level === 'info' &&
        c.args.some((a) => typeof a === 'object' && a !== null && 'envelopeCount' in (a as object)),
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall!.args.find(
      (a) => typeof a === 'object' && a !== null && 'envelopeCount' in (a as object),
    ) as Record<string, unknown>;
    expect(meta['kid']).toBe(3);
    expect(meta['epoch']).toBe(3);
    expect(meta['roomId']).toBe('kb-d');
    expect(meta['envelopeCount']).toBe(2);
    expect(meta['recipientCount']).toBe(1); // host excluded → 1 recipient (memberB)
    // No envelope/sealedKey/key-material field leaked into the metadata object.
    expect(Object.keys(meta)).not.toContain('envelopes');
    expect(Object.keys(meta)).not.toContain('sealedKey');

    wsHost.close();
    wsB.close();
  });

  it('(e) a member NOT in any room sending a bundle is ignored (no throw, no broadcast)', async () => {
    const s = await startServer();
    server = s.wss;

    // A peer in a real room (so there IS a possible broadcast target) + an
    // un-joined socket that sends a bundle for that room.
    const wsMember = await joinPeer(s.port, 'kb-e', 'member', 'pw', 1);
    await tick(80);

    const wsOrphan = await connect(s.port); // never sent a join
    const memberGot = expectNoType(wsMember, 'e2eeKeyBundle', 500);
    wsOrphan.send(
      JSON.stringify({
        type: 'e2eeKeyBundle',
        roomId: 'kb-e',
        epoch: 1,
        kid: 1,
        coordinatorPubkey: pubkey32(9),
        envelopes: [{ recipientPubkey: pubkey32(1), sealedKey: sealed(1) }],
      }),
    );

    // The real member must NOT receive a bundle from an un-joined sender.
    expect(await memberGot).toBeNull();
    // The orphan socket stays open (no crash) — a follow-up ping works.
    expect(wsOrphan.readyState).toBe(WebSocket.OPEN);
    // Bind to the !mapping guard specifically (not merely the absence of a
    // broadcast): the orphan path logs its own warn.
    const orphanWarned = s.calls.some(
      (c) => c.level === 'warn' && /not in any room/i.test(JSON.stringify(c.args)),
    );
    expect(orphanWarned).toBe(true);

    wsMember.close();
    wsOrphan.close();
  });

  it('(f) malformed bundle (missing/non-array envelopes) is dropped cleanly — no junk frame to peers, ignore+warn, no error', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await joinPeer(s.port, 'kb-f', 'host', 'pw', 1);
    const wsB = await joinPeer(s.port, 'kb-f', 'memberB', 'pw', 2);
    await tick(120);

    // An admitted in-room sender emits a bundle with NO `envelopes` field. Without
    // the Array.isArray guard this half-broadcasts `envelopes:undefined` to peers
    // and then throws on `.length` (caught → error log + error reply).
    const malformed = {
      type: 'e2eeKeyBundle',
      roomId: 'kb-f',
      epoch: 2,
      kid: 2,
      coordinatorPubkey: pubkey32(1),
      // envelopes intentionally OMITTED
    };

    const bGot = expectNoType(wsB, 'e2eeKeyBundle', 500);
    wsHost.send(JSON.stringify(malformed));

    // No junk frame reaches the other member; the sender's socket stays open.
    expect(await bGot).toBeNull();
    expect(wsHost.readyState).toBe(WebSocket.OPEN);

    // Dropped via ignore+warn (mirrors the other bad-input guards) …
    const warned = s.calls.some(
      (c) =>
        c.level === 'warn' && /invalid envelopes|missing.*envelopes/i.test(JSON.stringify(c.args)),
    );
    expect(warned).toBe(true);
    // … and NOT a thrown TypeError surfaced through the outer handler.
    const errored = s.calls.some((c) => c.level === 'error');
    expect(errored).toBe(false);

    wsHost.close();
    wsB.close();
  });

  it('(g) single-member room — recipientCount is 0 and the info log still fires (no recipients, no error)', async () => {
    const s = await startServer();
    server = s.wss;

    const wsHost = await joinPeer(s.port, 'kb-g', 'host', 'pw', 1);
    await tick(80);

    wsHost.send(
      JSON.stringify({
        type: 'e2eeKeyBundle',
        roomId: 'kb-g',
        epoch: 1,
        kid: 1,
        coordinatorPubkey: pubkey32(1),
        envelopes: [{ recipientPubkey: pubkey32(1), sealedKey: sealed(1) }],
      }),
    );
    await tick(120);

    const infoCall = s.calls.find(
      (c) =>
        c.level === 'info' &&
        c.args.some((a) => typeof a === 'object' && a !== null && 'recipientCount' in (a as object)),
    );
    expect(infoCall).toBeDefined();
    const meta = infoCall!.args.find(
      (a) => typeof a === 'object' && a !== null && 'recipientCount' in (a as object),
    ) as Record<string, unknown>;
    expect(meta['recipientCount']).toBe(0);
    expect(meta['envelopeCount']).toBe(1);
    expect(wsHost.readyState).toBe(WebSocket.OPEN);

    wsHost.close();
  });
});
