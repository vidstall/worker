/**
 * REQ-RMS-008 unit tests — per-peer socket map, signaling wiring decisions
 * (header→peerId + recordPath gate), and the additive peerRelayId frame
 * fields on PipeProducerAnnounce / PipeConnectFrame (back-compat guards).
 * Mirrors how producerPeerId? was added (inter-relay.ts:99-102): OPTIONAL, so
 * pre-mesh frames (no peerRelayId) still validate.
 */
import { describe, it, expect } from 'vitest';
import {
  isPipeProducerAnnounce,
  buildPipeProducerAnnounce,
  isPipeConnectFrame,
  buildPipeConnectFrame,
  DEFAULT_PEER_RELAY_ID,
} from '@dvconf/inter-relay-client';
import {
  createInterRelaySocketMap,
  resolveInterRelayPeerId,
  shouldRecordPath,
} from '../inter-relay-socket-map.js';

// ── REQ-RMS-008 — per-peer inter-relay socket map (multi-peer cascade) ───────

describe('REQ-RMS-008 — per-peer inter-relay socket map (multi-peer cascade)', () => {
  it('attaches DISTINCT sockets per peerRelayId without displacing each other', () => {
    const map = createInterRelaySocketMap();
    const sockB = { readyState: 1, send: () => {} };
    const sockC = { readyState: 1, send: () => {} };
    map.attach('relay-B', sockB);
    map.attach('relay-C', sockC); // does NOT displace relay-B (the M1 single-socket bug)
    expect(map.get('relay-B')).toBe(sockB);
    expect(map.get('relay-C')).toBe(sockC);
    expect(map.size()).toBe(2);
  });
  it('detach removes only the named peer; re-attach on the same peerRelayId replaces it', () => {
    const map = createInterRelaySocketMap();
    const s1 = { readyState: 1, send: () => {} };
    const s2 = { readyState: 1, send: () => {} };
    map.attach('relay-B', s1);
    map.attach('relay-B', s2); // reconnect flap on the SAME peer replaces
    expect(map.get('relay-B')).toBe(s2);
    map.detach('relay-B', s2);
    expect(map.get('relay-B')).toBeNull();
  });
  it('a stale close (detach of an already-replaced socket) is a no-op — the live socket survives', () => {
    // Reconnect-flap ordering: relay-B reconnects (s2 replaces s1) BEFORE s1's close
    // event fires. The late s1 close must NOT evict the live s2 (detach guards on the
    // passed socket still being the attached one).
    const map = createInterRelaySocketMap();
    const s1 = { readyState: 1, send: () => {} };
    const s2 = { readyState: 1, send: () => {} };
    map.attach('relay-B', s1);
    map.attach('relay-B', s2);
    map.detach('relay-B', s1); // stale close of the displaced socket
    expect(map.get('relay-B')).toBe(s2); // live socket survives
  });
});

// Issue #4 — RED-first cover for the signaling.ts wiring DECISIONS, extracted to pure
// helpers so they are unit-testable (the createSignalingServer factory is not).

describe('REQ-RMS-008/006 — signaling wiring decisions (header→peerId + recordPath gate)', () => {
  it('resolveInterRelayPeerId reads x-inter-relay-peer-id, falls back to the default, handles array headers', () => {
    expect(resolveInterRelayPeerId({ 'x-inter-relay-peer-id': 'relay-B' }, DEFAULT_PEER_RELAY_ID)).toBe('relay-B');
    expect(resolveInterRelayPeerId({ 'x-inter-relay-peer-id': ['relay-C', 'x'] }, DEFAULT_PEER_RELAY_ID)).toBe('relay-C');
    expect(resolveInterRelayPeerId({}, DEFAULT_PEER_RELAY_ID)).toBe(DEFAULT_PEER_RELAY_ID); // no header → default (M1 path)
    expect(resolveInterRelayPeerId({ 'x-inter-relay-peer-id': '' }, DEFAULT_PEER_RELAY_ID)).toBe(DEFAULT_PEER_RELAY_ID); // empty → default
  });
  it('shouldRecordPath is true ONLY when a SpillTrigger is wired (M1 untouched when absent)', () => {
    expect(shouldRecordPath(undefined)).toBe(false); // vanilla M1 stack: no trigger → no recordPath
    expect(shouldRecordPath({ recordPath: () => {} })).toBe(true);
  });
  it('the attach→detach pair a tagged peer drives leaves the OTHER peer attached (the multi-peer co-attach proof)', () => {
    // Models the two-peer wiring signaling.ts performs from req.headers: two distinct
    // x-inter-relay-peer-id upgrades co-attach; one close detaches only its own peer.
    const map = createInterRelaySocketMap();
    const wsB = { readyState: 1, send: () => {} };
    const wsC = { readyState: 1, send: () => {} };
    const peerB = resolveInterRelayPeerId({ 'x-inter-relay-peer-id': 'relay-B' }, DEFAULT_PEER_RELAY_ID);
    const peerC = resolveInterRelayPeerId({ 'x-inter-relay-peer-id': 'relay-C' }, DEFAULT_PEER_RELAY_ID);
    map.attach(peerB, wsB);
    map.attach(peerC, wsC);
    map.detach(peerB, wsB); // relay-B closes
    expect(map.get('relay-B')).toBeNull();
    expect(map.get('relay-C')).toBe(wsC); // relay-C survives (the M1 single-socket displace bug is gone)
  });
});

describe('REQ-RMS-008 — peerRelayId on PipeProducerAnnounce (additive, back-compat)', () => {
  it('builder carries peerRelayId when supplied, omits it otherwise', () => {
    const withPeer = buildPipeProducerAnnounce('room-1', { id: 'prod-1', kind: 'video' }, 'pub-peer', 'relay-B');
    expect(withPeer.peerRelayId).toBe('relay-B');
    const without = buildPipeProducerAnnounce('room-1', { id: 'prod-1', kind: 'video' }, 'pub-peer');
    expect('peerRelayId' in without).toBe(false); // omitted, not undefined-valued
  });

  it('guard accepts a frame WITH peerRelayId and a legacy frame WITHOUT it', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', peerRelayId: 'relay-B' })).toBe(true);
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video' })).toBe(true); // back-compat
  });

  it('guard rejects a non-string peerRelayId', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', peerRelayId: 42 })).toBe(false);
  });
});

describe('REQ-RMS-008 — peerRelayId on PipeConnectFrame (additive, back-compat)', () => {
  it('builder carries peerRelayId; guard accepts with + without it', () => {
    const f = buildPipeConnectFrame('room-1', { ip: '127.0.0.1', port: 40010 }, 'relay-B');
    expect(f.peerRelayId).toBe('relay-B');
    expect(isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', ip: '127.0.0.1', port: 1, peerRelayId: 'relay-B' })).toBe(true);
    expect(isPipeConnectFrame({ type: 'pipe-connect', roomId: 'r', ip: '127.0.0.1', port: 1 })).toBe(true); // legacy
  });
});
