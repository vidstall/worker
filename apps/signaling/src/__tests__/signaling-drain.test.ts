/**
 * P17 M2b-P9 (DOH-021) — signaling daemon stop-accept gate + connection drain.
 *
 * The graceful-shutdown plan's `setAccepting(false)` flips a module-level flag
 * gated at the TOP of `wss.on('connection')` — ABOVE the F62 `authHook.verifyJoin`
 * path — so a refused socket is closed 1001 and NEVER reaches the join/auth code.
 * `drainConnections()` closes every live peer socket (1001) so the drain settles.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { createServer, setAccepting, drainConnections } from '../index.js';
import type { AuthHook } from '../auth.js';

let server: WebSocketServer | undefined;

function startServer(opts?: Parameters<typeof createServer>[1]): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = createServer(0, opts);
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server = wss;
      resolve({ wss, port });
    });
  });
}

/** Resolve with the close code (or 'welcome' if accepted first). */
function connectAndAwaitOutcome(port: number): Promise<{ outcome: 'welcome' | 'closed'; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string };
      if (msg.type === 'welcome') resolve({ outcome: 'welcome' });
    });
    ws.on('close', (code) => resolve({ outcome: 'closed', code }));
    ws.on('error', () => {
      /* close handler resolves */
    });
  });
}

function connectWelcome(port: number): Promise<{ ws: WebSocket; peerId: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; peerId: string };
      if (msg.type === 'welcome') resolve({ ws, peerId: msg.peerId });
    });
    ws.on('error', reject);
  });
}

afterEach(() => {
  setAccepting(true); // reset the module flag so sibling tests still accept
  if (server) {
    server.close();
    server = undefined;
  }
});

describe('signaling stop-accept gate (DOH-021)', () => {
  it('default (accepting) — a new socket gets welcome (non-regression)', async () => {
    const { port } = await startServer();
    const res = await connectAndAwaitOutcome(port);
    expect(res.outcome).toBe('welcome');
  });

  it('setAccepting(false) refuses a new socket with close code 1001', async () => {
    const { port } = await startServer();
    setAccepting(false);
    const res = await connectAndAwaitOutcome(port);
    expect(res.outcome).toBe('closed');
    expect(res.code).toBe(1001);
  });

  it('a refused socket NEVER reaches F62 authHook.verifyJoin', async () => {
    const verifyJoin = vi.fn().mockResolvedValue({ accepted: true });
    const authHook = { verifyJoin } as unknown as AuthHook;
    const { port } = await startServer({ authHook });
    setAccepting(false);
    await connectAndAwaitOutcome(port);
    // give any (erroneous) async handler a tick to fire
    await new Promise((r) => setTimeout(r, 50));
    expect(verifyJoin).not.toHaveBeenCalled();
  });

  it('drainConnections() closes a live peer socket with 1001', async () => {
    const { port } = await startServer();
    const { ws } = await connectWelcome(port);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    drainConnections();
    expect(await closed).toBe(1001);
  });
});
