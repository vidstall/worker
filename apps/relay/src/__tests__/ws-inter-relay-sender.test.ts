/**
 * BENCH-2 / G1 tests — PRIMARY announce link actually TRANSMITS
 * (createWsInterRelaySender): the sink wired in index.ts must put bytes on
 * the wire when a live socket is attached (the prior index.ts sink was a
 * no-op log stub — the announce never left the process). Best-effort: no
 * socket / a throwing socket must not crash the produce path.
 *
 * Requirements: REQ-RO-004 (G1 warm-pipe producerId wiring), REQ-RO-005 (paused).
 */

import { describe, it, expect, vi } from 'vitest';
import { createWsInterRelaySender, createInterRelayAnnouncer } from '@dvconf/inter-relay-client';

// ── C. createWsInterRelaySender — the announce actually transmits ────────

describe('createWsInterRelaySender — primary announce reaches the wire', () => {
  it('RED-BENCH2-8: with a live socket attached, send() puts the announce bytes on the wire', () => {
    const sent: string[] = [];
    const sock = {
      readyState: 1, // OPEN
      send: vi.fn((data: string) => sent.push(data)),
    };
    const sender = createWsInterRelaySender(() => sock as any);

    const announce = createInterRelayAnnouncer(sender);
    announce('room-A', { id: 'producer-PRIMARY-REAL', kind: 'audio' });

    expect(sock.send).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame['type']).toBe('pipe-producer');
    expect(frame['roomId']).toBe('room-A');
    expect(frame['producerId']).toBe('producer-PRIMARY-REAL');
  });

  it('RED-BENCH2-9: with NO socket attached yet, send() does not throw (best-effort queue/drop)', () => {
    const sender = createWsInterRelaySender(() => null);
    expect(() => sender.send('{"type":"pipe-producer"}')).not.toThrow();
  });

  it('RED-BENCH2-10: a socket that is not OPEN is treated as down (no send, no throw)', () => {
    const sock = { readyState: 3 /* CLOSED */, send: vi.fn() };
    const sender = createWsInterRelaySender(() => sock as any);
    expect(() => sender.send('frame')).not.toThrow();
    expect(sock.send).not.toHaveBeenCalled();
  });

  it('RED-BENCH2-11: a throwing socket is swallowed by the announcer (produce path never crashes)', () => {
    const sock = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('socket exploded');
      }),
    };
    const sender = createWsInterRelaySender(() => sock as any);
    const announce = createInterRelayAnnouncer(sender);
    expect(() =>
      announce('room-A', { id: 'p', kind: 'audio' }),
    ).not.toThrow();
  });
});
