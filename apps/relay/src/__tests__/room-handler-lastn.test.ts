/**
 * REQ-RMS-012 — server-side audio last-N forward gate in notifyNewProducer.
 *
 * Hermetic unit test (NO mediasoup): asserts an AUDIO producer is fanned out
 * ONLY to peers when it is in the room's top-k loudest set (room.audioTopK), and
 * a VIDEO producer is always fanned out (last-N is audio-only). The top-k set is
 * populated by the AudioLevelObserver wiring (signaling.ts); here it is injected.
 */
import { describe, it, expect } from 'vitest';
import { createLogger } from '@dvconf/shared';
import { notifyNewProducer, type RoomState, type PeerState } from '../room-handler.js';

const logger = createLogger('test');

function fakePeer(peerId: string): PeerState {
  const sent: Record<string, unknown>[] = [];
  const ws = { readyState: 1, OPEN: 1, send: (s: string) => sent.push(JSON.parse(s)) } as unknown as PeerState['ws'];
  (ws as unknown as { _sent: Record<string, unknown>[] })._sent = sent;
  return { peerId, ws, sendTransport: null, recvTransport: null, producers: [], consumers: [], samplerStops: new Map() };
}
const sentOf = (p: PeerState): Record<string, unknown>[] =>
  (p.ws as unknown as { _sent: Record<string, unknown>[] })._sent;

function fakeRoom(audioTopK: Set<string>): RoomState {
  return {
    roomId: 'r1', router: {} as RoomState['router'], mode: 'sfu', peers: new Map(), audioTopK,
  } as unknown as RoomState;
}

describe('REQ-RMS-012 — notifyNewProducer audio last-N', () => {
  it('an AUDIO producer NOT in the top-k set is NOT fanned out to peers', async () => {
    const room = fakeRoom(new Set(['prod-loud'])); // some other producer is loud
    const a = fakePeer('a'); const b = fakePeer('b');
    room.peers.set('a', a); room.peers.set('b', b);
    const quietProducer = { id: 'prod-quiet', kind: 'audio' } as unknown as import('mediasoup').types.Producer;

    await notifyNewProducer(room, 'a', quietProducer, logger);

    expect(sentOf(b).filter((m) => m['type'] === 'newProducer')).toHaveLength(0);
  });

  it('an AUDIO producer IN the top-k set IS fanned out; a VIDEO producer is ALWAYS fanned out', async () => {
    const room = fakeRoom(new Set(['prod-loud']));
    const a = fakePeer('a'); const b = fakePeer('b');
    room.peers.set('a', a); room.peers.set('b', b);
    const loudAudio = { id: 'prod-loud', kind: 'audio' } as unknown as import('mediasoup').types.Producer;
    const anyVideo = { id: 'prod-vid', kind: 'video' } as unknown as import('mediasoup').types.Producer;

    await notifyNewProducer(room, 'a', loudAudio, logger);
    await notifyNewProducer(room, 'a', anyVideo, logger);

    const types = sentOf(b).filter((m) => m['type'] === 'newProducer').map((m) => m['producerId']);
    expect(types).toContain('prod-loud');
    expect(types).toContain('prod-vid');
  });

  it('when room.audioTopK is undefined, audio is fanned out unconditionally (back-compat / last-N disabled)', async () => {
    const room = fakeRoom(undefined as unknown as Set<string>);
    const a = fakePeer('a'); const b = fakePeer('b');
    room.peers.set('a', a); room.peers.set('b', b);
    const audio = { id: 'prod-x', kind: 'audio' } as unknown as import('mediasoup').types.Producer;
    await notifyNewProducer(room, 'a', audio, logger);
    expect(sentOf(b).filter((m) => m['type'] === 'newProducer')).toHaveLength(1);
  });
});
