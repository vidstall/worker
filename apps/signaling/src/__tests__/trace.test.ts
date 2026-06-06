/**
 * P17 M1 / F63 (DOH-003) — signaling births one trace id per WS connection and
 * uses it across both join paths (unifies the previously per-join throwaway ids).
 *
 * RED before P7: the no-auth 'Peer joined room' log carried NO trace_id and the
 * dual-relay route used a fresh randomUUID unrelated to the connection.
 *
 * pino is only a transitive dep here, so we capture via a minimal fake Logger that
 * records child() bindings + info() merge objects.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import type { Logger } from '@dvconf/shared';
import { createServer } from '../index.js';
import type { DualRelayRouter } from '../relay-dual-router.js';

let wss: WebSocketServer | undefined;

/** Minimal pino-shaped logger that records each line's merged bindings + msg. */
function fakeLogger(records: Array<Record<string, unknown>>): Logger {
  const make = (bindings: Record<string, unknown>): unknown => ({
    child: (b: Record<string, unknown>) => make({ ...bindings, ...b }),
    info: (obj: Record<string, unknown>, msg?: string) =>
      records.push({ ...bindings, ...obj, msg }),
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  });
  return make({}) as Logger;
}

afterEach(() => {
  wss?.close();
  wss = undefined;
});

describe('signaling connection trace (DOH-003)', () => {
  it('a no-auth join logs + routes under the single connection trace_id', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const sendRelayAssigned = vi.fn();
    const dualRelayRouter = { sendRelayAssigned } as unknown as DualRelayRouter;

    wss = createServer(0, { logger: fakeLogger(lines), dualRelayRouter });
    const port = (wss.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
      ws.on('message', (d) => {
        if ((JSON.parse(d.toString()) as { type: string }).type === 'welcome') resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'join', roomId: 'r1' }));
    await new Promise((r) => setTimeout(r, 50));
    ws.close();

    const connected = lines.find((l) => l['msg'] === 'Peer connected');
    const joined = lines.find((l) => l['msg'] === 'Peer joined room');

    expect(connected?.['trace_id']).toBeDefined();
    expect(joined?.['trace_id']).toBe(connected?.['trace_id']);
    // The dual-relay advertisement rode the SAME connection trace id.
    expect(sendRelayAssigned.mock.calls[0]?.[2]).toBe(connected?.['trace_id']);
  });
});
