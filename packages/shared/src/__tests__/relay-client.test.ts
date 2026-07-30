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
