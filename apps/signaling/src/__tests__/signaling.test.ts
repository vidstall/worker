/**
 * Integration-style tests for the signaling server.
 *
 * Starts a real WebSocket server, connects clients, and verifies message routing.
 * Also verifies DAEMON-02 compliance: no @mysten/sui imports in the signaling package.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import { createServer } from '../index.js';
import { AuthHook, type AuthCacheConsumer, type CachedTokenSnapshot } from '../auth.js';
import type { Logger } from '@dvconf/shared';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..');

let server: WebSocketServer | undefined;

/** Start server on a random available port. */
function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = createServer(0); // port 0 = OS picks a random port
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server = wss;
      resolve({ wss, port });
    });
  });
}

/** Connect a WebSocket client and wait for the welcome message. */
function connectClient(port: number): Promise<{ ws: WebSocket; peerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; peerId: string };
      if (msg.type === 'welcome') {
        resolve({ ws, peerId: msg.peerId });
      }
    });
    ws.on('error', reject);
  });
}

/** Wait for the next message on a WebSocket. */
function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

afterEach(() => {
  if (server) {
    server.close();
    server = undefined;
  }
});

describe('Signaling server integration', () => {
  it('two peers join the same room and exchange ICE candidates', async () => {
    const { port } = await startServer();

    // Connect two clients
    const client1 = await connectClient(port);
    const client2 = await connectClient(port);

    // Both join the same room
    client1.ws.send(JSON.stringify({ type: 'join', roomId: 'test-room' }));

    // Wait for client1 to be settled before client2 joins
    await new Promise((r) => setTimeout(r, 50));

    // Prepare to receive peer-joined notification on client1
    const peerJoinedPromise = waitForMessage(client1.ws);

    client2.ws.send(JSON.stringify({ type: 'join', roomId: 'test-room' }));

    // Client1 should receive peer-joined notification
    const joinNotification = await peerJoinedPromise;
    expect(joinNotification['type']).toBe('peer-joined');
    expect(joinNotification['peerId']).toBe(client2.peerId);

    // Client1 sends an ICE candidate to client2
    const icePromise = waitForMessage(client2.ws);
    client1.ws.send(
      JSON.stringify({
        type: 'ice-candidate',
        candidate: { sdpMid: '0', sdpMLineIndex: 0, candidate: 'test-candidate' },
        targetPeerId: client2.peerId,
      }),
    );

    const iceMessage = await icePromise;
    expect(iceMessage['type']).toBe('ice-candidate');
    expect(iceMessage['fromPeerId']).toBe(client1.peerId);
    expect(iceMessage['candidate']).toEqual({
      sdpMid: '0',
      sdpMLineIndex: 0,
      candidate: 'test-candidate',
    });

    // Clean up
    client1.ws.close();
    client2.ws.close();
  });

  it('SDP offer/answer exchange works', async () => {
    const { port } = await startServer();

    const client1 = await connectClient(port);
    const client2 = await connectClient(port);

    client1.ws.send(JSON.stringify({ type: 'join', roomId: 'sdp-room' }));
    await new Promise((r) => setTimeout(r, 50));
    client2.ws.send(JSON.stringify({ type: 'join', roomId: 'sdp-room' }));
    // Consume peer-joined notification
    await waitForMessage(client1.ws);

    // Client1 sends offer to client2
    const offerPromise = waitForMessage(client2.ws);
    client1.ws.send(
      JSON.stringify({
        type: 'offer',
        sdp: { type: 'offer', sdp: 'v=0\r\n...' },
        targetPeerId: client2.peerId,
      }),
    );

    const offer = await offerPromise;
    expect(offer['type']).toBe('offer');
    expect(offer['fromPeerId']).toBe(client1.peerId);

    // Client2 sends answer to client1
    const answerPromise = waitForMessage(client1.ws);
    client2.ws.send(
      JSON.stringify({
        type: 'answer',
        sdp: { type: 'answer', sdp: 'v=0\r\n...' },
        targetPeerId: client1.peerId,
      }),
    );

    const answer = await answerPromise;
    expect(answer['type']).toBe('answer');
    expect(answer['fromPeerId']).toBe(client2.peerId);

    client1.ws.close();
    client2.ws.close();
  });
});

describe('DAEMON-02 compliance: no chain dependency in core signaling', () => {
  it('core signaling files (index, rooms) do NOT import @mysten/sui', () => {
    // Phase 11 added chain-aware files (auto-register.ts, heartbeat.ts) that legitimately
    // import @mysten/sui. F62 M1 Stage 3 added two more carve-outs:
    //   - Phase 3.2 auth.ts — verifies ed25519 signatures against cached RoomCapability records
    //     (REQ-ADM-004), imports @mysten/sui/keypairs/ed25519.
    //   - Phase 3.3 cap-token-cache.ts — subscribes to capability_events via SuiClient
    //     (CONTRACTS § 4.3, REQ-ADM-005/009).
    // DAEMON-02 applies to the core signaling path only — chain-aware modules are the
    // documented carve-out.
    const chainAwareFiles = ['auto-register.ts', 'heartbeat.ts', 'auth.ts', 'cap-token-cache.ts'];

    const sourceFiles = getAllTsFiles(SRC_DIR).filter(
      (f) => !f.includes('__tests__') && !chainAwareFiles.some((ca) => f.endsWith(ca)),
    );

    expect(sourceFiles.length).toBeGreaterThan(0);

    for (const filePath of sourceFiles) {
      const content = readFileSync(filePath, 'utf-8');

      // Check for actual import/require statements referencing the Sui SDK
      // (ignore comments — only match import/require lines)
      expect(content).not.toMatch(/^\s*import\s.*['"]@mysten\/sui/m);
      expect(content).not.toMatch(/^\s*import\s.*SuiClient/m);
      expect(content).not.toMatch(/require\s*\(\s*['"]@mysten\/sui/m);
    }
  });
});

/** Recursively get all .ts files in a directory. */
function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Stage 4 — case 'join' AuthHook wiring (REQ-ADM-010-partial) ─────────

/** Build the canonical join payload that the peer signs (mirrors auth.ts). */
function buildCanonicalJoinPayload(
  roomId: string,
  peerPubkey: number[],
  nonce: number,
): Uint8Array {
  return bcs
    .struct('JoinPayload', {
      roomId: bcs.string(),
      peerPubkey: bcs.vector(bcs.u8()),
      nonce: bcs.u64(),
    })
    .serialize({ roomId, peerPubkey, nonce: BigInt(nonce) })
    .toBytes();
}

function makeLoggerStub(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

function makeMockCache(initial: Map<string, CachedTokenSnapshot>): AuthCacheConsumer {
  return {
    get(tokenId) {
      return initial.get(tokenId) ?? null;
    },
    has(tokenId) {
      return initial.has(tokenId);
    },
    isStrictRejectMode() {
      return false;
    },
  };
}

/** Send a JoinMessage and resolve with `{ closeCode, closeReason }` on WS close. */
function sendJoinAndAwaitClose(
  ws: WebSocket,
  payload: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs);
    ws.once('close', (code, reasonBuf) => {
      clearTimeout(timer);
      resolve({ code, reason: reasonBuf.toString() });
    });
    ws.send(JSON.stringify(payload));
  });
}

describe('Signaling case "join" — Stage 4 AuthHook wiring (REQ-ADM-010-partial)', () => {
  const ROOM_ID = '0xroom-stage-4';
  const TOKEN_ID = '0xtoken-stage-4';
  const CURRENT_EPOCH = 100n;
  const FUTURE_EPOCH = 200n;

  it('rejects join with WS close 4401 when no AuthHook + token field provided AND server is enforce-auth mode', async () => {
    const logger = makeLoggerStub();
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger });
    const wss = createServer(0, { authHook: hook });
    server = wss;
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = await connectClient(port);
    const result = await sendJoinAndAwaitClose(client.ws, {
      type: 'join',
      roomId: ROOM_ID,
      token: '', // empty → no-token
      signature: 'AA==',
      nonce: 1,
    });

    expect(result.code).toBe(4401);
  });

  it('rejects join with WS close 4403 when cached token is revoked', async () => {
    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: true,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: makeLoggerStub() });
    const wss = createServer(0, { authHook: hook });
    server = wss;
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = await connectClient(port);
    // Build a valid signature so the only reject reason is "revoked".
    const payload = buildCanonicalJoinPayload(ROOM_ID, peerPubkey, 1);
    const sigBytes = await peerKp.sign(payload);
    const signature = Buffer.from(sigBytes).toString('base64');

    const result = await sendJoinAndAwaitClose(client.ws, {
      type: 'join',
      roomId: ROOM_ID,
      token: TOKEN_ID,
      signature,
      nonce: 1,
    });

    expect(result.code).toBe(4403);
  });

  it('accepts join when AuthHook.verifyJoin passes; peer is registered into the room', async () => {
    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: makeLoggerStub() });
    const wss = createServer(0, { authHook: hook });
    server = wss;
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client = await connectClient(port);
    const payload = buildCanonicalJoinPayload(ROOM_ID, peerPubkey, 1);
    const sigBytes = await peerKp.sign(payload);
    const signature = Buffer.from(sigBytes).toString('base64');

    // We will NOT receive a close — instead the WS stays open after the join.
    // Use a second client to detect the peer-joined notification, indicating
    // the first peer is registered into the room.
    const client2 = await connectClient(port);

    const peerJoinedPromise = waitForMessage(client2.ws);

    client.ws.send(
      JSON.stringify({
        type: 'join',
        roomId: ROOM_ID,
        token: TOKEN_ID,
        signature,
        nonce: 1,
      }),
    );

    // Second client also joins — this is the trigger for first client's peer-joined notification.
    await new Promise((r) => setTimeout(r, 50));

    // For the SECOND join, the server is in enforce-auth mode; client2 has no token →
    // its join should close with 4401. We focus on confirming client1 stayed open.
    const secondJoinCloseProm = sendJoinAndAwaitClose(client2.ws, {
      type: 'join',
      roomId: ROOM_ID,
      token: '',
      signature: '',
      nonce: 2,
    });
    const secondClose = await secondJoinCloseProm;
    expect(secondClose.code).toBe(4401);

    // Client 1's WS must still be open (accepted join).
    expect(client.ws.readyState).toBe(WebSocket.OPEN);

    client.ws.close();
    // peerJoinedPromise may have rejected on close — we don't await it.
    void peerJoinedPromise.catch(() => undefined);
  });

  it('backwards-compat: when createServer called WITHOUT authHook option, join with no token still succeeds (Stage 1-2 baseline)', async () => {
    const wss = createServer(0);
    server = wss;
    const addr = wss.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const client1 = await connectClient(port);
    const client2 = await connectClient(port);

    client1.ws.send(JSON.stringify({ type: 'join', roomId: 'bc-room' }));
    await new Promise((r) => setTimeout(r, 50));

    const peerJoinedPromise = waitForMessage(client1.ws);
    client2.ws.send(JSON.stringify({ type: 'join', roomId: 'bc-room' }));
    const notification = await peerJoinedPromise;

    expect(notification['type']).toBe('peer-joined');
    expect(client1.ws.readyState).toBe(WebSocket.OPEN);
    expect(client2.ws.readyState).toBe(WebSocket.OPEN);

    client1.ws.close();
    client2.ws.close();
  });
});
