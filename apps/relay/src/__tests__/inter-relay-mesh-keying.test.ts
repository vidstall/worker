/**
 * REQ-RMS-008 unit tests — peerRelayId additive frame fields + back-compat guards.
 * Mirrors how producerPeerId? was added (inter-relay.ts:99-102): OPTIONAL, so
 * pre-mesh frames (no peerRelayId) still validate.
 */
import { describe, it, expect } from 'vitest';
import {
  isPipeProducerAnnounce,
  buildPipeProducerAnnounce,
  isPipeConnectFrame,
  buildPipeConnectFrame,
} from '../inter-relay.js';

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
