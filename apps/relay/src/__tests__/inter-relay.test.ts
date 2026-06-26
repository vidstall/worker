/**
 * Unit tests for inter-relay.ts (REQ-RO-004 G1 integration wiring).
 *
 * Covers the inter-relay producer-announce contract + the standby-side
 * producerId resolution that replaces the `pipe-producer-${roomId}` placeholder.
 *
 * TDD contract — RED cases:
 *   1. isPipeProducerAnnounce type guard accepts valid / rejects malformed frames.
 *   2. buildPipeProducerAnnounce produces the locked shape from a producer.
 *   3. Registry.record + resolve: announced producerId is resolvable per room.
 *   4. Registry.resolve returns null before any announce (standby stays paused).
 *   5. Registry.record is idempotent on duplicate producerId (dedup → no duplicate-pipe).
 *   6. Registry tracks multiple producers per room (audio + video) via resolveAll.
 *   7. Registry.clear drops a room (worker.died rebuild / room close).
 *
 * LIVE two-relay verification DEFERRED to bench (Phase 5.3).
 *
 * Requirements: REQ-RO-004 (G1)
 */

import { describe, it, expect, vi } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import {
  isPipeProducerAnnounce,
  buildPipeProducerAnnounce,
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  isPipeConnectFrame,
  buildPipeConnectFrame,
  type PipeProducerAnnounce,
  type InterRelaySender,
  type PipeConnectFrame,
  type PipeConnectParams,
} from '@dvconf/inter-relay-client';

// ── isPipeProducerAnnounce ─────────────────────────────────────────────

describe('isPipeProducerAnnounce', () => {
  it('accepts a valid pipe-producer frame', () => {
    const frame: PipeProducerAnnounce = {
      type: 'pipe-producer',
      roomId: 'room-1',
      producerId: 'producer-abc',
      kind: 'audio',
    };
    expect(isPipeProducerAnnounce(frame)).toBe(true);
  });

  it('rejects a frame with wrong type', () => {
    expect(isPipeProducerAnnounce({ type: 'join', roomId: 'r', producerId: 'p', kind: 'audio' })).toBe(false);
  });

  it('rejects a frame missing producerId', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', kind: 'audio' })).toBe(false);
  });

  it('rejects a frame with invalid kind', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'data' })).toBe(false);
  });

  it('rejects null / non-object', () => {
    expect(isPipeProducerAnnounce(null)).toBe(false);
    expect(isPipeProducerAnnounce('pipe-producer')).toBe(false);
    expect(isPipeProducerAnnounce(42)).toBe(false);
  });
});

// ── buildPipeProducerAnnounce ──────────────────────────────────────────

describe('buildPipeProducerAnnounce', () => {
  it('produces the locked frame shape from a producer', () => {
    const producer = { id: 'producer-xyz', kind: 'video' as const };
    const frame = buildPipeProducerAnnounce('room-9', producer);

    expect(frame).toEqual({
      type: 'pipe-producer',
      roomId: 'room-9',
      producerId: 'producer-xyz',
      kind: 'video',
    });
    // The frame must pass its own type guard (round-trip)
    expect(isPipeProducerAnnounce(frame)).toBe(true);
  });
});

// ── InterRelayProducerRegistry ─────────────────────────────────────────

describe('InterRelayProducerRegistry', () => {
  it('RED-G1-1: resolves an announced producerId for a room', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room-1', producerId: 'producer-real-123', kind: 'audio' });

    const resolved = reg.resolve('room-1');
    expect(resolved).not.toBeNull();
    expect(resolved?.producerId).toBe('producer-real-123');
    expect(resolved?.kind).toBe('audio');
  });

  it('RED-G1-2: resolve returns null before any announce (standby stays paused)', () => {
    const reg = new InterRelayProducerRegistry();
    expect(reg.resolve('room-never-announced')).toBeNull();
  });

  it('RED-G1-3: record is idempotent on duplicate producerId (dedup, no duplicate-pipe)', () => {
    const reg = new InterRelayProducerRegistry();
    const announce: PipeProducerAnnounce = {
      type: 'pipe-producer',
      roomId: 'room-2',
      producerId: 'producer-dup',
      kind: 'audio',
    };
    reg.record(announce);
    reg.record(announce);
    reg.record(announce);

    // Only one producer recorded for the room
    expect(reg.resolveAll('room-2')).toHaveLength(1);
  });

  it('RED-G1-4: tracks multiple distinct producers per room (audio + video)', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room-3', producerId: 'producer-audio', kind: 'audio' });
    reg.record({ type: 'pipe-producer', roomId: 'room-3', producerId: 'producer-video', kind: 'video' });

    const all = reg.resolveAll('room-3');
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.producerId).sort()).toEqual(['producer-audio', 'producer-video']);
  });

  it('RED-G1-5: clear drops a room (worker.died rebuild / room close)', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room-4', producerId: 'p', kind: 'audio' });
    expect(reg.roomCount).toBe(1);

    reg.clear('room-4');
    expect(reg.roomCount).toBe(0);
    expect(reg.resolve('room-4')).toBeNull();
  });
});

// ── createInterRelayAnnouncer (primary→standby push, index.ts glue) ─────

describe('createInterRelayAnnouncer', () => {
  it('RED-G1-6: announceProducer serializes the locked frame and pushes via the sender', () => {
    const send = vi.fn();
    const sender: InterRelaySender = { send };
    const announce = createInterRelayAnnouncer(sender);

    announce('room-7', { id: 'producer-7', kind: 'audio' });

    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse(send.mock.calls[0]![0] as string);
    expect(payload).toEqual({
      type: 'pipe-producer',
      roomId: 'room-7',
      producerId: 'producer-7',
      kind: 'audio',
    });
  });

  it('RED-G1-7: announceProducer swallows sender errors (link down ≠ crash produce path)', () => {
    const sender: InterRelaySender = {
      send: vi.fn(() => {
        throw new Error('inter-relay link down');
      }),
    };
    const announce = createInterRelayAnnouncer(sender);

    // Must NOT throw — the primary's produce path stays healthy even if the
    // standby link is temporarily down (announce is best-effort).
    expect(() => announce('room-8', { id: 'p8', kind: 'video' })).not.toThrow();
  });

  it('REQ-RMS-026: forwards the 5th rtpParameters arg into the emitted frame', () => {
    const send = vi.fn();
    const sender: InterRelaySender = { send };
    const announce = createInterRelayAnnouncer(sender);
    const rtp = { codecs: [{ mimeType: 'video/VP8' }], encodings: [{ ssrc: 1234 }] } as unknown as msTypes.RtpParameters;

    announce('room-9', { id: 'piped-9', kind: 'video' }, undefined, 'relay-B', rtp);

    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse(send.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(payload['rtpParameters']).toEqual(rtp); // the standby needs it for transport.produce()
    expect(payload['peerRelayId']).toBe('relay-B'); // 4th-arg slot still threads the cascade peer
  });
});

// ── isPipeConnectFrame (REQ-RO-006) ───────────────────────────────────
// The symmetric pipe-connect connect-param frame, exchanged BOTH ways. Mirrors
// PipeProducerAnnounce exactly (flat JSON, string-literal discriminant,
// typeof-every-field guard, NO version/correlation id). srtpParameters is
// OPTIONAL (single-host scope = enableSrtp:false → undefined).

describe('isPipeConnectFrame', () => {
  it('RED-RO-006-1: accepts a valid pipe-connect frame (no srtpParameters)', () => {
    const frame: PipeConnectFrame = {
      type: 'pipe-connect',
      roomId: 'room-1',
      ip: '127.0.0.1',
      port: 40000,
    };
    expect(isPipeConnectFrame(frame)).toBe(true);
  });

  it('RED-RO-006-2: accepts a valid pipe-connect frame WITH srtpParameters', () => {
    const frame: PipeConnectFrame = {
      type: 'pipe-connect',
      roomId: 'room-1',
      ip: '10.0.0.7',
      port: 40005,
      srtpParameters: {
        cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        keyBase64: 'YWJjZGVmZ2hpamtsbW5vcA==',
      } as PipeConnectFrame['srtpParameters'],
    };
    expect(isPipeConnectFrame(frame)).toBe(true);
  });

  it('RED-RO-006-3: rejects a frame with the wrong type', () => {
    expect(
      isPipeConnectFrame({ type: 'pipe-producer', roomId: 'r', ip: '127.0.0.1', port: 40000 }),
    ).toBe(false);
  });

  it('RED-RO-006-4: rejects a frame missing ip', () => {
    expect(isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', port: 40000 })).toBe(false);
  });

  it('RED-RO-006-5: rejects a frame whose port is not a number', () => {
    expect(
      isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', ip: '127.0.0.1', port: '40000' }),
    ).toBe(false);
  });

  it('RED-RO-006-6: rejects null / non-object', () => {
    expect(isPipeConnectFrame(null)).toBe(false);
    expect(isPipeConnectFrame('pipe-connect')).toBe(false);
    expect(isPipeConnectFrame(42)).toBe(false);
  });
});

// ── buildPipeConnectFrame (REQ-RO-006) ────────────────────────────────

describe('buildPipeConnectFrame', () => {
  it('RED-RO-006-7: produces the locked frame shape from PipeConnectParams (no srtp)', () => {
    const params: PipeConnectParams = { ip: '127.0.0.1', port: 40010 };
    const frame = buildPipeConnectFrame('room-9', params);

    expect(frame).toEqual({
      type: 'pipe-connect',
      roomId: 'room-9',
      ip: '127.0.0.1',
      port: 40010,
    });
    // round-trip: the built frame passes its own guard
    expect(isPipeConnectFrame(frame)).toBe(true);
  });

  it('RED-RO-006-8: carries srtpParameters through when present', () => {
    const params: PipeConnectParams = {
      ip: '10.0.0.7',
      port: 40011,
      srtpParameters: {
        cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        keyBase64: 'YWJjZGVmZ2hpamtsbW5vcA==',
      } as PipeConnectParams['srtpParameters'],
    };
    const frame = buildPipeConnectFrame('room-10', params);

    expect(frame.type).toBe('pipe-connect');
    expect(frame.roomId).toBe('room-10');
    expect(frame.ip).toBe('10.0.0.7');
    expect(frame.port).toBe(40011);
    expect(frame.srtpParameters).toEqual(params.srtpParameters);
    expect(isPipeConnectFrame(frame)).toBe(true);
  });
});
