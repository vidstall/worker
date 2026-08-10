/**
 * A dead/unreachable relay endpoint makes the underlying `ws` emit 'error'.
 * Node's EventEmitter special-cases an 'error' event with zero listeners
 * into a synchronous throw -- which crashed the whole bot process (not just
 * the one session) before RelayClient attached a listener of its own. These
 * tests confirm `ready` rejects cleanly instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayClient, type WsLike } from '../mediasoup-node/relay-client.js';

/** Minimal WsLike fake -- records registered handlers so a test can fire them.
 *  `ping`/`terminate` are omitted by default (matching a minimal transport
 *  with no liveness support); pass `withHeartbeat: true` to add spies for
 *  them, exercising RelayClient's heartbeat loop. */
function fakeWs(
  opts: { withHeartbeat?: boolean } = {},
): WsLike & { emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws: WsLike & { emit: (event: string, ...args: unknown[]) => void } = {
    send: vi.fn(),
    close: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
  if (opts.withHeartbeat) {
    ws.ping = vi.fn();
    ws.terminate = vi.fn();
  }
  return ws;
}

describe('RelayClient', () => {
  it('ready resolves on open', async () => {
    const ws = fakeWs();
    const client = new RelayClient(ws);
    ws.emit('open');
    await expect(client.ready).resolves.toBeUndefined();
  });

  it('ready rejects (does not throw/crash) when ws emits error', async () => {
    const ws = fakeWs();
    const client = new RelayClient(ws);
    ws.emit('error', new Error('connect ETIMEDOUT 159.203.167.217:443'));
    await expect(client.ready).rejects.toThrow('connect ETIMEDOUT 159.203.167.217:443');
  });

  it('wraps a non-Error error payload in an Error', async () => {
    const ws = fakeWs();
    const client = new RelayClient(ws);
    ws.emit('error', 'boom');
    await expect(client.ready).rejects.toThrow('boom');
  });
});

describe('RelayClient — close observability (bare, no network call)', () => {
  it('registers a close handler that logs the given context via the injected logger', () => {
    const ws = fakeWs();
    const warn = vi.fn();
    new RelayClient(ws, null, { roomId: 'room-1', peerId: 'bot-1', relayUrl: 'ws://relay:4000' }, { warn });

    ws.emit('close');

    expect(warn).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warn.mock.calls[0]!;
    expect(ctx).toEqual({ roomId: 'room-1', peerId: 'bot-1', relayUrl: 'ws://relay:4000' });
    expect(msg).toMatch(/relay WS closed/i);
  });

  it('a close with no logger wired is a silent no-op (does not throw)', () => {
    const ws = fakeWs();
    new RelayClient(ws);
    expect(() => ws.emit('close')).not.toThrow();
  });

  it('close triggers no send()/network call', () => {
    const ws = fakeWs();
    const warn = vi.fn();
    new RelayClient(ws, null, { roomId: 'room-1' }, { warn });
    ws.emit('close');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('invokes the optional onClose callback in addition to the log line', () => {
    const ws = fakeWs();
    const warn = vi.fn();
    const onClose = vi.fn();
    new RelayClient(ws, null, { roomId: 'room-1' }, { warn }, onClose);

    ws.emit('close');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('omitting onClose is a silent no-op (does not throw)', () => {
    const ws = fakeWs();
    new RelayClient(ws, null, {}, undefined, undefined);
    expect(() => ws.emit('close')).not.toThrow();
  });
});

describe('RelayClient — WS ping/pong heartbeat (client side)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not ping before the socket opens', () => {
    const ws = fakeWs({ withHeartbeat: true });
    new RelayClient(ws, null, {}, undefined, undefined, 1000);
    vi.advanceTimersByTime(5000);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('pings each tick once open, and keeps pinging when pong answers every ping', () => {
    const ws = fakeWs({ withHeartbeat: true });
    new RelayClient(ws, null, {}, undefined, undefined, 1000);
    ws.emit('open');

    vi.advanceTimersByTime(1000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    ws.emit('pong');

    vi.advanceTimersByTime(1000);
    expect(ws.ping).toHaveBeenCalledTimes(2);
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('terminates the socket after a missed pong (2 ticks with no pong reply)', () => {
    const ws = fakeWs({ withHeartbeat: true });
    new RelayClient(ws, null, {}, undefined, undefined, 1000);
    ws.emit('open');

    vi.advanceTimersByTime(1000); // tick 1: ping sent, no pong
    expect(ws.ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000); // tick 2: still no pong -> terminate
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('falls back to close() when the transport has no terminate()', () => {
    const ws = fakeWs({ withHeartbeat: true });
    delete (ws as { terminate?: unknown }).terminate;
    new RelayClient(ws, null, {}, undefined, undefined, 1000);
    ws.emit('open');

    vi.advanceTimersByTime(2000);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('stops the heartbeat when close() is called explicitly', () => {
    const ws = fakeWs({ withHeartbeat: true });
    const client = new RelayClient(ws, null, {}, undefined, undefined, 1000);
    ws.emit('open');
    client.close();

    vi.advanceTimersByTime(5000);
    expect(ws.ping).not.toHaveBeenCalled();
  });

  it('stops the heartbeat once the socket close event fires', () => {
    const ws = fakeWs({ withHeartbeat: true });
    new RelayClient(ws, null, {}, undefined, undefined, 1000);
    ws.emit('open');
    vi.advanceTimersByTime(1000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    ws.emit('close');
    vi.advanceTimersByTime(5000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('skips the heartbeat entirely when the WsLike has no ping() support', () => {
    const ws = fakeWs(); // no withHeartbeat -- no ping/terminate
    new RelayClient(ws, null, {}, undefined, undefined, 1000);
    ws.emit('open');
    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(ws.close).not.toHaveBeenCalled();
  });
});
