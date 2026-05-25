/**
 * Integration-style tests for the signaling server.
 *
 * Starts a real WebSocket server, connects clients, and verifies message routing.
 * Also verifies DAEMON-02 compliance: no @mysten/sui imports in the signaling package.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { createServer } from '../index.js';
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
    // import @mysten/sui. F62 M1 Stage 3 Phase 3.3 added cap-token-cache.ts which subscribes
    // to capability_events via SuiClient (CONTRACTS § 4.3). DAEMON-02 applies to the core
    // signaling path only.
    const chainAwareFiles = ['auto-register.ts', 'heartbeat.ts', 'cap-token-cache.ts'];

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
