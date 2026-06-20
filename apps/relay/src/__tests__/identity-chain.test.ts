/**
 * Unit tests for the producerPeerId identity chain (REQ-RO-018).
 *
 * The standby must learn WHICH peer published a piped producer so the client
 * can re-attach E2EE to that producer's per-producer key after cutover. The
 * peerId is threaded additively: builder -> frame -> guard -> registry record
 * -> resolve -> (the consumed response is asserted in the wiring suite). Old
 * frames WITHOUT producerPeerId stay valid (back-compat) so the locked suite
 * is unaffected.
 *
 * Requirements: REQ-RO-018
 */
import { describe, it, expect, vi } from 'vitest';
import {
  isPipeProducerAnnounce,
  buildPipeProducerAnnounce,
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  type PipeProducerAnnounce,
  type InterRelaySender,
} from '../inter-relay.js';

describe('producerPeerId identity chain (REQ-RO-018)', () => {
  it('RED-ID-1: builder carries producerPeerId when supplied', () => {
    const producer = { id: 'producer-xyz', kind: 'video' as const };
    const frame = buildPipeProducerAnnounce('room-9', producer, 'peer-alice');
    expect(frame).toEqual({
      type: 'pipe-producer',
      roomId: 'room-9',
      producerId: 'producer-xyz',
      kind: 'video',
      producerPeerId: 'peer-alice',
    });
    expect(isPipeProducerAnnounce(frame)).toBe(true);
  });

  it('RED-ID-2: builder omits producerPeerId when not supplied (back-compat)', () => {
    const frame = buildPipeProducerAnnounce('room-9', { id: 'p', kind: 'audio' as const });
    expect(frame).toEqual({ type: 'pipe-producer', roomId: 'room-9', producerId: 'p', kind: 'audio' });
    expect('producerPeerId' in frame).toBe(false);
    expect(isPipeProducerAnnounce(frame)).toBe(true);
  });

  it('RED-ID-3: guard rejects a non-string producerPeerId but accepts absent', () => {
    const bad = { type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'audio', producerPeerId: 42 };
    expect(isPipeProducerAnnounce(bad)).toBe(false);
    const absent = { type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'audio' };
    expect(isPipeProducerAnnounce(absent)).toBe(true);
  });

  it('RED-ID-4: producerPeerId survives record -> resolve', () => {
    const reg = new InterRelayProducerRegistry();
    const announce: PipeProducerAnnounce = {
      type: 'pipe-producer',
      roomId: 'room-id',
      producerId: 'producer-real-1',
      kind: 'video',
      producerPeerId: 'peer-bob',
    };
    reg.record(announce);
    const resolved = reg.resolve('room-id');
    expect(resolved?.producerId).toBe('producer-real-1');
    expect(resolved?.producerPeerId).toBe('peer-bob');
  });

  it('RED-ID-5: announcer forwards producerPeerId in the serialized frame', () => {
    const send = vi.fn();
    const sender: InterRelaySender = { send };
    const announce = createInterRelayAnnouncer(sender);
    announce('room-7', { id: 'producer-7', kind: 'audio' }, 'peer-carol');
    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse(send.mock.calls[0]![0] as string);
    expect(payload).toEqual({
      type: 'pipe-producer',
      roomId: 'room-7',
      producerId: 'producer-7',
      kind: 'audio',
      producerPeerId: 'peer-carol',
    });
  });
});
