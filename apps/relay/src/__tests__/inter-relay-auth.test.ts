/**
 * Unit tests for the G3.2b inter-relay WS auth + inbound-frame helpers.
 *
 * G3.2b pins the cross-daemon inter-relay link auth (G3-SUBSPEC):
 *   - Bearer INTER_RELAY_TOKEN over the WS upgrade, compared with
 *     crypto.timingSafeEqual (NOT the `===` in cp-daemon checkBearer).
 *   - clients connecting WITHOUT the token must NOT be rejected — the gate is
 *     at the dispatch/tag level, so isValidInterRelayToken only TAGS a peer.
 *   - the standby's inbound link handler records the announce + drives the
 *     StandbyWarmPipeCoordinator re-run (onAnnounce).
 *
 * These two helpers are pure (no `ws` coupling) so they stay in inter-relay.ts
 * alongside the existing duck-typed registry/sender. The live socket open lives
 * in inter-relay-link.ts (ws-coupled), tested in inter-relay-link.test.ts.
 *
 * Requirements: REQ-RO-004 (G1 wiring) · G3 (cross-daemon WS auth)
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isValidInterRelayToken,
  handleInboundInterRelayFrame,
  INTER_RELAY_SUBPROTOCOL,
  InterRelayProducerRegistry,
} from '@dvconf/inter-relay-client';

// ── INTER_RELAY_SUBPROTOCOL ────────────────────────────────────────────

describe('INTER_RELAY_SUBPROTOCOL', () => {
  it('is the pinned v1 subprotocol label', () => {
    expect(INTER_RELAY_SUBPROTOCOL).toBe('dvconf-inter-relay.v1');
  });
});

// ── isValidInterRelayToken (timingSafeEqual Bearer check) ───────────────

describe('isValidInterRelayToken', () => {
  it('accepts an exact Bearer token match', () => {
    expect(isValidInterRelayToken('Bearer s3cr3t-token', 's3cr3t-token')).toBe(true);
  });

  it('rejects a wrong token of the SAME length (timingSafeEqual content)', () => {
    expect(isValidInterRelayToken('Bearer aaaaaa', 'bbbbbb')).toBe(false);
  });

  it('rejects a token of a different length (no timingSafeEqual throw)', () => {
    expect(isValidInterRelayToken('Bearer short', 's3cr3t-token')).toBe(false);
  });

  it('rejects a header without the Bearer prefix', () => {
    expect(isValidInterRelayToken('s3cr3t-token', 's3cr3t-token')).toBe(false);
  });

  it('rejects an undefined / missing header', () => {
    expect(isValidInterRelayToken(undefined, 's3cr3t-token')).toBe(false);
  });

  it('rejects when no expected token is configured (empty)', () => {
    // INTER_RELAY_TOKEN unset → no socket can be tagged (dispatch-gate handles
    // the unset case separately; tagging must never validate against empty).
    expect(isValidInterRelayToken('Bearer anything', '')).toBe(false);
    expect(isValidInterRelayToken('Bearer ', '')).toBe(false);
  });

  it('rejects an empty presented token', () => {
    expect(isValidInterRelayToken('Bearer ', 's3cr3t-token')).toBe(false);
  });
});

// ── handleInboundInterRelayFrame (standby inbound link handler) ─────────

describe('handleInboundInterRelayFrame', () => {
  it('records a valid pipe-producer frame and fires onAnnounce with the roomId', async () => {
    const registry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();

    const raw = JSON.stringify({
      type: 'pipe-producer',
      roomId: 'room-link-1',
      producerId: 'producer-REAL-77',
      kind: 'video',
    });
    const handled = await handleInboundInterRelayFrame(raw, { registry, onAnnounce });

    expect(handled).toBe(true);
    expect(registry.resolve('room-link-1')?.producerId).toBe('producer-REAL-77');
    // C6: the inbound handler threads the frame's peerRelayId (undefined here —
    // a legacy frame omits it → the standby coordinator defaults to DEFAULT).
    expect(onAnnounce).toHaveBeenCalledWith('room-link-1', undefined);
  });

  // C6 (REQ-RMS-008) — a CASCADE frame carries the primary-echoed peerRelayId
  // (= the standby's own outbound x-inter-relay-peer-id). The inbound handler
  // threads it into onAnnounce so ensure()/onAnnounce key the SAME (room,peer)
  // warm-pipe state — without this the displaced standby's announce misses its
  // ensure state and mints 0 (the live C6 collision root cause).
  it('threads the frame peerRelayId into onAnnounce (mesh cascade)', async () => {
    const registry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();

    const raw = JSON.stringify({
      type: 'pipe-producer',
      roomId: 'room-mesh-1',
      producerId: 'producer-REAL-88',
      kind: 'video',
      peerRelayId: 'ws://127.0.0.1:4004',
    });
    const handled = await handleInboundInterRelayFrame(raw, { registry, onAnnounce });

    expect(handled).toBe(true);
    // Recorded under the cascade peer key (not DEFAULT).
    expect(registry.resolve('room-mesh-1', 'ws://127.0.0.1:4004')?.producerId).toBe('producer-REAL-88');
    expect(onAnnounce).toHaveBeenCalledWith('room-mesh-1', 'ws://127.0.0.1:4004');
  });

  it('works without an onAnnounce callback (records only)', async () => {
    const registry = new InterRelayProducerRegistry();
    const raw = JSON.stringify({
      type: 'pipe-producer',
      roomId: 'room-link-2',
      producerId: 'p2',
      kind: 'audio',
    });
    const handled = await handleInboundInterRelayFrame(raw, { registry });
    expect(handled).toBe(true);
    expect(registry.resolve('room-link-2')?.producerId).toBe('p2');
  });

  it('ignores malformed JSON (returns false, no record/onAnnounce)', async () => {
    const registry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();
    const handled = await handleInboundInterRelayFrame('not-json{{{', { registry, onAnnounce });
    expect(handled).toBe(false);
    expect(registry.roomCount).toBe(0);
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it('ignores a non-pipe-producer frame (returns false)', async () => {
    const registry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();
    const raw = JSON.stringify({ type: 'join', roomId: 'r', peerId: 'p' });
    const handled = await handleInboundInterRelayFrame(raw, { registry, onAnnounce });
    expect(handled).toBe(false);
    expect(registry.roomCount).toBe(0);
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it('accepts a Buffer payload (ws message data is Buffer)', async () => {
    const registry = new InterRelayProducerRegistry();
    const raw = Buffer.from(
      JSON.stringify({ type: 'pipe-producer', roomId: 'room-buf', producerId: 'pb', kind: 'audio' }),
    );
    const handled = await handleInboundInterRelayFrame(raw, { registry });
    expect(handled).toBe(true);
    expect(registry.resolve('room-buf')?.producerId).toBe('pb');
  });
});
