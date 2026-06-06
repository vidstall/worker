/**
 * Unit tests for openInterRelayLink (G3.2b) — the STANDBY's outbound WS dial to
 * the PRIMARY's signaling server. ws-coupled, so it lives in inter-relay-link.ts
 * (keeps inter-relay.ts duck-typed). Tested against a real `ws` server so the
 * upgrade headers + inbound wiring are genuinely exercised (the live socket
 * itself is otherwise isMainModule glue).
 *
 * Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS link)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import type { IncomingHttpHeaders } from 'node:http';
import { openInterRelayLink, createStandbyLinkManager } from '../inter-relay-link.js';
import { INTER_RELAY_SUBPROTOCOL } from '../inter-relay.js';

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

/** Start a raw ws server that captures the first upgrade's headers/protocol. */
function startCapturingServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  headers: () => IncomingHttpHeaders | null;
  pushTo: (sock: WsServerSocket, frame: unknown) => void;
  firstSocket: () => Promise<WsServerSocket>;
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    let captured: IncomingHttpHeaders | null = null;
    let resolveSock: ((s: WsServerSocket) => void) | null = null;
    const sockPromise = new Promise<WsServerSocket>((r) => { resolveSock = r; });
    wss.on('connection', (ws, req) => {
      captured = req.headers;
      resolveSock?.(ws);
    });
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        wss,
        port,
        headers: () => captured,
        pushTo: (sock, frame) => sock.send(JSON.stringify(frame)),
        firstSocket: () => sockPromise,
      });
    });
  });
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
  vi.useRealTimers();
});

// ── createStandbyLinkManager (dedup + reconnect state machine, G3.2b) ────
// Extracted from index.ts glue so the dedup/reconnect logic is unit-tested with
// an injected socket factory + fake timers (no real sockets/clock needed).

/** Fake socket factory capturing each socket's close listener. */
interface FakeSocket {
  closeCb: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
  on(event: 'close', cb: () => void): void;
  fireClose(): void;
}
function fakeSocketFactory() {
  const sockets: FakeSocket[] = [];
  const open = vi.fn((_url: string): FakeSocket => {
    const s: FakeSocket = {
      closeCb: null,
      close: vi.fn(),
      on(_event, cb) {
        s.closeCb = cb;
      },
      fireClose() {
        s.closeCb?.();
      },
    };
    sockets.push(s);
    return s;
  });
  return { open, sockets };
}

describe('createStandbyLinkManager', () => {
  it('dials once; a same-URL re-connect while OPEN does not stack a second link', () => {
    const { open } = fakeSocketFactory();
    const mgr = createStandbyLinkManager({ open, reconnectMs: 1000 });
    mgr.connectTo('ws://p:4000');
    mgr.connectTo('ws://p:4000');
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a new URL closes the old socket and dials the new one', () => {
    const { open, sockets } = fakeSocketFactory();
    const mgr = createStandbyLinkManager({ open, reconnectMs: 1000 });
    mgr.connectTo('ws://a:4000');
    mgr.connectTo('ws://b:4000');
    expect(sockets[0]!.close).toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]![0]).toBe('ws://b:4000');
  });

  it('re-dials the same URL once after a non-shutdown close (reconnectMs)', () => {
    vi.useFakeTimers();
    const { open, sockets } = fakeSocketFactory();
    const mgr = createStandbyLinkManager({ open, reconnectMs: 1000 });
    mgr.connectTo('ws://a:4000');
    sockets[0]!.fireClose();
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[1]![0]).toBe('ws://a:4000');
  });

  it('shutdown() closes the link and suppresses reconnect', () => {
    vi.useFakeTimers();
    const { open, sockets } = fakeSocketFactory();
    const mgr = createStandbyLinkManager({ open, reconnectMs: 1000 });
    mgr.connectTo('ws://a:4000');
    mgr.shutdown();
    expect(sockets[0]!.close).toHaveBeenCalled();
    sockets[0]!.fireClose();
    vi.advanceTimersByTime(5000);
    expect(open).toHaveBeenCalledTimes(1); // no reconnect after shutdown
  });
});

describe('openInterRelayLink', () => {
  it('dials with the Bearer token + inter-relay subprotocol on the upgrade', async () => {
    const srv = await startCapturingServer();
    server = srv.wss;

    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${srv.port}`,
      token: 'standby-secret',
      onFrame: vi.fn(),
      logger: mockLogger(),
    });
    await srv.firstSocket();

    const h = srv.headers();
    expect(h?.['authorization']).toBe('Bearer standby-secret');
    expect(h?.['sec-websocket-protocol']).toBe(INTER_RELAY_SUBPROTOCOL);

    link.close();
  });

  it('omits the Authorization header when no token is configured', async () => {
    const srv = await startCapturingServer();
    server = srv.wss;

    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${srv.port}`,
      onFrame: vi.fn(),
      logger: mockLogger(),
    });
    await srv.firstSocket();

    expect(srv.headers()?.['authorization']).toBeUndefined();
    link.close();
  });

  it('delivers an inbound frame pushed by the primary to onFrame', async () => {
    const srv = await startCapturingServer();
    server = srv.wss;

    const onFrame = vi.fn();
    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${srv.port}`,
      token: 't',
      onFrame,
      logger: mockLogger(),
    });
    const sock = await srv.firstSocket();

    // Primary pushes a pipe-producer announce down the link the standby opened.
    srv.pushTo(sock, {
      type: 'pipe-producer', roomId: 'room-Z', producerId: 'producer-REAL-1', kind: 'audio',
    });
    await tick(120);

    expect(onFrame).toHaveBeenCalledOnce();
    const raw = onFrame.mock.calls[0]![0];
    const parsed = JSON.parse(raw.toString());
    expect(parsed).toMatchObject({ type: 'pipe-producer', roomId: 'room-Z', producerId: 'producer-REAL-1' });

    link.close();
  });

  it('exposes the live socket so the caller can detect readyState/close', async () => {
    const srv = await startCapturingServer();
    server = srv.wss;

    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${srv.port}`,
      onFrame: vi.fn(),
    });
    await srv.firstSocket();
    // Client-side OPEN lands a tick after the server sees the connection.
    if (link.readyState !== 1) await new Promise((r) => link.once('open', r));

    expect(link.readyState).toBe(1); // WebSocket.OPEN
    link.close();
  });
});
