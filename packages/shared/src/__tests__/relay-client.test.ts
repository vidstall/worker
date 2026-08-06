/**
 * A dead/unreachable relay endpoint makes the underlying `ws` emit 'error'.
 * Node's EventEmitter special-cases an 'error' event with zero listeners
 * into a synchronous throw -- which crashed the whole bot process (not just
 * the one session) before RelayClient attached a listener of its own. These
 * tests confirm `ready` rejects cleanly instead.
 */

import { describe, it, expect, vi } from 'vitest';
import { RelayClient, type WsLike } from '../mediasoup-node/relay-client.js';

/** Minimal WsLike fake -- records registered handlers so a test can fire them. */
function fakeWs(): WsLike & { emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
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
