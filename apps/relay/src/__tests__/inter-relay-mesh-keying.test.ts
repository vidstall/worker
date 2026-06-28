/**
 * REQ-RMS-008 unit tests — peerRelayId additive frame fields + back-compat guards.
 * Mirrors how producerPeerId? was added (inter-relay.ts:99-102): OPTIONAL, so
 * pre-mesh frames (no peerRelayId) still validate.
 */
import { describe, it, expect, vi } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import {
  isPipeProducerAnnounce,
  buildPipeProducerAnnounce,
  isPipeConnectFrame,
  buildPipeConnectFrame,
  InterRelayProducerRegistry,
  StandbyWarmPipeCoordinator,
  PrimaryPipeCoordinator,
  createInterRelayAnnouncer,
  DEFAULT_PEER_RELAY_ID,
  type InterRelaySender,
  type PipeConnectParams,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';
import {
  createInterRelaySocketMap,
  resolveInterRelayPeerId,
  shouldRecordPath,
} from '../inter-relay-socket-map.js';
import type { RoomTopology } from '@dvconf/inter-relay-client';

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

// ── mediasoup mock factories (inlined verbatim from inter-relay-warmpipe.test.ts
//    so this file compiles standalone — do NOT invent new fakes). ────────────

function makeMockConsumer() {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused: false,
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeMockPipeTransport(consumer: ReturnType<typeof makeMockConsumer>) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    consume: vi.fn().mockResolvedValue(consumer),
    connect: vi.fn().mockResolvedValue(undefined),
    tuple: { localIp: '127.0.0.1', localPort: 40000 },
    close: vi.fn(),
  };
}

function makeMockRouter() {
  const consumers: ReturnType<typeof makeMockConsumer>[] = [];
  const transports: ReturnType<typeof makeMockPipeTransport>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const consumer = makeMockConsumer();
      const transport = makeMockPipeTransport(consumer);
      consumers.push(consumer);
      transports.push(transport);
      return transport;
    }),
    rtpCapabilities: {} as any,
  };
  return { router, consumers, transports };
}

function makeStandbyTopology(roomId = 'room-g1'): RoomTopology {
  return {
    roomId,
    role: 'standby',
    primaryEndpoint: 'ws://primary:4000',
    standbyEndpoint: 'ws://standby:4000',
    pipePort: 40000,
    pipeConsumer: null,
    pipeTransport: null,
  };
}

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

describe('REQ-RMS-008 — registry keyed per (roomId, peerRelayId) + resolveAll multi-producer', () => {
  it('records + resolves producers ISOLATED per peerRelayId for the same room', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room-1', producerId: 'pA', kind: 'video', peerRelayId: 'relay-B' });
    reg.record({ type: 'pipe-producer', roomId: 'room-1', producerId: 'pB', kind: 'audio', peerRelayId: 'relay-C' });
    // resolveAll for one peer returns ONLY that peer's producers (cascade isolation).
    expect(reg.resolveAll('room-1', 'relay-B').map((p) => p.producerId)).toEqual(['pA']);
    expect(reg.resolveAll('room-1', 'relay-C').map((p) => p.producerId)).toEqual(['pB']);
  });

  it('resolveAll returns ALL producers for a (room, peer) so a >100-user cascade pipes every producer', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room-1', producerId: 'p1', kind: 'video', peerRelayId: 'relay-B' });
    reg.record({ type: 'pipe-producer', roomId: 'room-1', producerId: 'p2', kind: 'video', peerRelayId: 'relay-B' });
    expect(reg.resolveAll('room-1', 'relay-B').map((p) => p.producerId).sort()).toEqual(['p1', 'p2']);
  });

  it('legacy single-peer callers (no peerRelayId) still resolve under the DEFAULT peer key (back-compat)', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room-1', producerId: 'pLegacy', kind: 'video' });
    expect(reg.resolve('room-1')?.producerId).toBe('pLegacy'); // resolve() unchanged signature
  });

  it('registry round-trips rtpParameters on resolveAll (REQ-RMS-026)', () => {
    const reg = new InterRelayProducerRegistry();
    const rtp = { codecs: [{ mimeType: 'video/VP8' }], encodings: [{ ssrc: 1234 }] } as unknown as msTypes.RtpParameters;
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'p1', kind: 'video', peerRelayId: 'relayB', rtpParameters: rtp });
    const out = reg.resolveAll('room1', 'relayB');
    expect(out[0]?.rtpParameters).toBe(rtp);
  });

  it('a legacy announce WITHOUT rtpParameters omits the key on the recorded entry (REQ-RMS-026 back-compat)', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'pLegacy', kind: 'video', peerRelayId: 'relayB' });
    const out = reg.resolveAll('room1', 'relayB');
    expect('rtpParameters' in out[0]!).toBe(false); // key omitted, not undefined-valued
  });

  it('a legacy ensure→onAnnounce cutover (no peerRelayId anywhere) re-consumes the REAL producer end-to-end (not just registry.resolve in isolation)', async () => {
    // Drives the DEFAULT-peer thread through the REAL coordinator path the way the M1
    // single-standby flow does (mirrors inter-relay-warmpipe.test.ts RED-BENCH2-4):
    // ensure() with NO peerRelayId keys its state under DEFAULT_PEER_RELAY_ID; a later
    // record() of a LEGACY frame (NO peerRelayId) lands under the SAME default key; the
    // onAnnounce() re-run must then resolve that producer and re-consume the REAL id. If
    // any re-keyed call site forgot to default peerRelayId, ensure keys under one key and
    // the record/resolve under another → the re-run resolves null → reran is false → this
    // fails. THIS is the key-mismatch regression the default-threading guards against.
    const reg = new InterRelayProducerRegistry();
    const topology = makeStandbyTopology();              // role:'standby', roomId 'room-g1'
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(reg);

    // First join: NOT ready → DEFER (C1, legacy ensure, no peerRelayId). No consume yet.
    const first = await coord.ensure(topology, router as any, 40000);
    expect(first).toBeNull();
    expect(transports[0]!.consume).not.toHaveBeenCalled();

    // Legacy announce arrives (NO peerRelayId) → must land under the DEFAULT key.
    reg.record({ type: 'pipe-producer', roomId: 'room-g1', producerId: 'pReal-legacy', kind: 'video' });
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // The cutover re-consumed the REAL producer the ensure was awaiting (default-key match).
    expect(reran).toBe(true);
    expect(reg.resolve('room-g1')?.producerId).toBe('pReal-legacy'); // 1-arg resolve = DEFAULT peer
    // C3 (cross-relay DEADLOCK fix): the EXISTING bound transport is REUSED (not
    // closed+rebuilt — that would tear down the connected pipe) and consumes the REAL
    // id end-to-end — still ONE transport (the default-key cutover worked).
    expect(transports).toHaveLength(1);
    const reConsume = transports[0]!.consume.mock.calls.at(-1)![0] as { producerId: string };
    expect(reConsume.producerId).toBe('pReal-legacy'); // re-run consumed the REAL id end-to-end
  });
});

describe('REQ-RMS-029 — resolveByProducerId: producerId-keyed cross-bucket lookup (consume-response on the mesh)', () => {
  it('resolveByProducerId finds a per-peer-bucketed producer that resolve(DEFAULT) misses (REQ-RMS-029 mesh)', () => {
    const reg = new InterRelayProducerRegistry();
    // mesh announce recorded under a NON-default per-peer bucket, WITH a publisher id:
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'piped-X', kind: 'video', producerPeerId: 'alice-original', peerRelayId: 'relayB' });
    // the DEFAULT-bucket resolve (what handleConsume used to call) MISSES it:
    expect(reg.resolve('room1')).toBeNull();
    // producerId-keyed resolve FINDS it with the right publisher:
    const got = reg.resolveByProducerId('room1', 'piped-X');
    expect(got?.producerPeerId).toBe('alice-original');
  });

  it('resolveByProducerId is producerId-specific across 2 publishers in distinct per-peer buckets', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'piped-A', kind: 'video', producerPeerId: 'alice', peerRelayId: 'relayB' });
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'piped-C', kind: 'video', producerPeerId: 'carol', peerRelayId: 'relayC' });
    expect(reg.resolveByProducerId('room1', 'piped-A')?.producerPeerId).toBe('alice');
    expect(reg.resolveByProducerId('room1', 'piped-C')?.producerPeerId).toBe('carol');
    expect(reg.resolveByProducerId('room1', 'nope')).toBeNull();
  });

  it('resolveByProducerId is room-scoped — a same-producerId entry in ANOTHER room never false-matches', () => {
    // The room-scope guard (exact first-segment compare) must not bleed across rooms even
    // if two rooms held the same producerId (mediasoup ids are globally unique so this is
    // synthetic — it pins the room-scoping behaviour regardless).
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'roomA', producerId: 'shared-id', kind: 'video', producerPeerId: 'a-pub', peerRelayId: 'relayB' });
    reg.record({ type: 'pipe-producer', roomId: 'roomB', producerId: 'shared-id', kind: 'video', producerPeerId: 'b-pub', peerRelayId: 'relayB' });
    expect(reg.resolveByProducerId('roomA', 'shared-id')?.producerPeerId).toBe('a-pub');
    expect(reg.resolveByProducerId('roomB', 'shared-id')?.producerPeerId).toBe('b-pub');
  });

  it('resolveByProducerId keeps PREFIX-ADJACENT rooms isolated — "room" never bleeds into "room1"', () => {
    // Adjacency pin: 'room' is a string-prefix of 'room1'. (This holds under the old
    // `${roomId}::` prefix AND the lastIndexOf('::') segment compare, since the `::`
    // boundary already disambiguates 'room::…' from 'room1::…' — a baseline isolation
    // guard, not the sharp edge; the trailing-colon case below is the one that genuinely
    // fails under the old startsWith.)
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room', producerId: 'adj-id', kind: 'video', producerPeerId: 'short-pub', peerRelayId: 'relayB' });
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'adj-id', kind: 'video', producerPeerId: 'long-pub', peerRelayId: 'relayB' });
    expect(reg.resolveByProducerId('room', 'adj-id')?.producerPeerId).toBe('short-pub');
    expect(reg.resolveByProducerId('room1', 'adj-id')?.producerPeerId).toBe('long-pub');
  });

  it('resolveByProducerId rejects the trailing-colon false-match ("room1:" vs "room1") — TEETH for the lastIndexOf separator fix', () => {
    // The PRECISE edge (review FIX #1): roomId 'room1:' contains no '::' (valid per the
    // meshKey invariant) → bucket key 'room1:::relayB'. This case FAILS under BOTH naive
    // splits and PASSES only with lastIndexOf('::'):
    //   - startsWith: 'room1:::relayB'.startsWith('room1::') is TRUE → query 'room1' wrongly
    //     matches 'room1:'s producer.
    //   - indexOf('::')=5 → segment 'room1' === query 'room1' → SAME false-match (the FIRST
    //     '::' sits on the roomId's trailing colon), and it can't find 'room1:'s own record.
    //   - lastIndexOf('::')=6 (the true separator; peerRelayId 'relayB' is '::'-free) →
    //     segment 'room1:' !== 'room1' → no false-match, and 'room1:' resolves its own record.
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room1:', producerId: 'colon-id', kind: 'video', producerPeerId: 'colon-pub', peerRelayId: 'relayB' });
    expect(reg.resolveByProducerId('room1', 'colon-id')).toBeNull();              // no false-match
    expect(reg.resolveByProducerId('room1:', 'colon-id')?.producerPeerId).toBe('colon-pub'); // own room resolves
  });

  it('resolveByProducerId also finds a DEFAULT-bucket (legacy single-standby) producer', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'room1', producerId: 'piped-legacy', kind: 'video', producerPeerId: 'leg-pub' });
    expect(reg.resolveByProducerId('room1', 'piped-legacy')?.producerPeerId).toBe('leg-pub');
  });
});

describe('REQ-RMS-008 — StandbyWarmPipeCoordinator.currentPipeConsumer per-(room,peer) disambiguation', () => {
  it('explicit (roomId, peerRelayId) returns THAT peer-leg consumer; the no-arg single-room path is byte-stable', async () => {
    // M1 byte-stable invariant: one tracked leg → the no-arg convenience accessor
    // (index.ts:556 liveness poller) returns that single leg's consumer unchanged.
    const reg = new InterRelayProducerRegistry();
    const coord = new StandbyWarmPipeCoordinator(reg);
    const { router, transports } = makeMockRouter();
    const topo = makeStandbyTopology('room-solo');

    reg.record({ type: 'pipe-producer', roomId: 'room-solo', producerId: 'pSolo', kind: 'video' });
    await coord.ensure(topo, router as any, 40000); // DEFAULT peer, single leg

    const soloConsumer = transports.at(-1)!.consume.mock.results.at(-1)!.value;
    expect(await coord.currentPipeConsumer()).toBe(await soloConsumer); // no-arg single-room unchanged
    // Explicit DEFAULT-peer accessor resolves the same single leg.
    expect(await coord.currentPipeConsumer('room-solo')).toBe(await soloConsumer);
  });

  it('a multi-leg room makes the no-arg accessor WARN (ambiguous leg) instead of silently polling an arbitrary peer', async () => {
    // The reviewer-flagged footgun: with >1 (room,peer) legs, currentPipeConsumer()
    // with no peerRelayId silently returned states.values().next() — an ARBITRARY
    // leg. Hardening: it must WARN via the injected logger so an M2 cascade caller
    // that forgot to pass peerRelayId is diagnosable, not silent. (Still returns a
    // consumer — must NOT throw and crash the index.ts:556 liveness poller.)
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    const reg = new InterRelayProducerRegistry();
    const coord = new StandbyWarmPipeCoordinator(reg, logger as any);

    // Two distinct peer legs in the SAME room.
    reg.record({ type: 'pipe-producer', roomId: 'room-multi', producerId: 'pB', kind: 'video', peerRelayId: 'relay-B' });
    reg.record({ type: 'pipe-producer', roomId: 'room-multi', producerId: 'pC', kind: 'video', peerRelayId: 'relay-C' });
    await coord.ensure(makeStandbyTopology('room-multi'), makeMockRouter().router as any, 40000, 'relay-B');
    await coord.ensure(makeStandbyTopology('room-multi'), makeMockRouter().router as any, 40001, 'relay-C');

    warn.mockClear();
    const got = coord.currentPipeConsumer(); // NO peerRelayId on a 2-leg room
    expect(got).not.toBeNull();               // non-throwing: still returns a consumer
    expect(warn).toHaveBeenCalledTimes(1);     // RED today: silent, never warns
  });

  it('explicit per-peer accessor on a multi-leg room never warns (the unambiguous path stays quiet)', async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    const reg = new InterRelayProducerRegistry();
    const coord = new StandbyWarmPipeCoordinator(reg, logger as any);
    const { router: rB, transports: tB } = makeMockRouter();
    const { router: rC, transports: tC } = makeMockRouter();

    reg.record({ type: 'pipe-producer', roomId: 'room-multi', producerId: 'pB', kind: 'video', peerRelayId: 'relay-B' });
    reg.record({ type: 'pipe-producer', roomId: 'room-multi', producerId: 'pC', kind: 'video', peerRelayId: 'relay-C' });
    await coord.ensure(makeStandbyTopology('room-multi'), rB as any, 40000, 'relay-B');
    await coord.ensure(makeStandbyTopology('room-multi'), rC as any, 40001, 'relay-C');

    warn.mockClear();
    const cB = await coord.currentPipeConsumer('room-multi', 'relay-B');
    const cC = await coord.currentPipeConsumer('room-multi', 'relay-C');
    expect(cB).toBe(await tB.at(-1)!.consume.mock.results.at(-1)!.value); // relay-B's leg
    expect(cC).toBe(await tC.at(-1)!.consume.mock.results.at(-1)!.value); // relay-C's leg
    expect(cB).not.toBe(cC);                   // distinct legs disambiguated
    expect(warn).not.toHaveBeenCalled();       // explicit path is unambiguous → quiet
  });
});

// ── mediasoup mock factories for the PRIMARY drain path (mirror
//    inter-relay-primary-coordinator.test.ts: a fresh PIPED consumer per
//    consume() call so the announced id is the PIPED id, not the source). ──────

function makePrimaryPipedConsumer(id = `piped-${Math.random().toString(36).slice(2)}`) {
  return { id, kind: 'video' as const, close: vi.fn() };
}

function makePrimaryPipeTransport(
  pipedSink: ReturnType<typeof makePrimaryPipedConsumer>[],
  localPort = 41000,
) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    tuple: { localIp: '127.0.0.1', localPort },
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation(async () => {
      const c = makePrimaryPipedConsumer();
      pipedSink.push(c);
      return c;
    }),
    close: vi.fn(),
  };
}

function makePrimaryMockRouter() {
  const transports: ReturnType<typeof makePrimaryPipeTransport>[] = [];
  const piped: ReturnType<typeof makePrimaryPipedConsumer>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const t = makePrimaryPipeTransport(piped, 41000 + transports.length);
      transports.push(t);
      return t;
    }),
  };
  return { router, transports, piped };
}

function makePrimaryStubAllocator(port = 41000): PipePortAllocatorLike {
  const held = new Set<string>();
  return {
    allocate: vi.fn((key: string) => { held.add(key); return port; }),
    release: vi.fn((key: string) => { held.delete(key); }),
    size: () => held.size,
  };
}

const PRIMARY_STANDBY_PARAMS: PipeConnectParams = { ip: '127.0.0.1', port: 40000 };

describe('REQ-RMS-008 — createInterRelayAnnouncer forwards peerRelayId into the announce frame (LIVE backing for PrimaryPipeCoordinator.deps.announcer)', () => {
  it('forwards a 4th positional peerRelayId arg into the emitted frame peerRelayId field; legacy 3rd-arg producerPeerId path is unchanged', () => {
    const sent: string[] = [];
    const sender: InterRelaySender = { send: (d) => sent.push(d) };
    const announce = createInterRelayAnnouncer(sender);

    // Legacy producerPeerId path (3rd arg) — peerRelayId omitted (legacy frame).
    announce('room-L', { id: 'piped-L', kind: 'video' }, 'pub-peer-L');
    const legacy = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(legacy['producerPeerId']).toBe('pub-peer-L');
    expect('peerRelayId' in legacy).toBe(false);

    // Cascade path: a real peerRelayId (4th arg) MUST land in the peerRelayId field,
    // NOT in producerPeerId. Today the closure only accepts 3 params → this FAILS.
    announce('room-C', { id: 'piped-C', kind: 'video' }, undefined, 'relay-B');
    const cascade = JSON.parse(sent[1]!) as Record<string, unknown>;
    expect(cascade['peerRelayId']).toBe('relay-B');
    expect('producerPeerId' in cascade).toBe(false); // peerRelayId did NOT bleed into producerPeerId
  });

  it('a REAL PrimaryPipeCoordinator backed by the REAL createInterRelayAnnouncer (index.ts adapter shape) emits a cascade frame carrying peerRelayId — the latent non-forward bug', async () => {
    // index.ts wires (REQ-RMS-029 arg order): announcer:
    //   (roomId, producer, producerPeerId, peerRelayId) =>
    //   pushAnnounce(roomId, producer, producerPeerId, peerRelayId). A non-forwarding
    // createInterRelayAnnouncer (3 params) would drop the 4th arg → the cascade
    // frame OMITS peerRelayId → this fails. The coordinator drain passes peerRelayId
    // as its 4th positional announcer arg (producerPeerId is the 3rd — undefined here
    // since onProducer is driven without a publisher id).
    const sent: string[] = [];
    const sender: InterRelaySender = { send: (d) => sent.push(d) };
    const pushAnnounce = createInterRelayAnnouncer(sender);

    const coord = new PrimaryPipeCoordinator({
      announcer: (roomId, producer, producerPeerId, peerRelayId) =>
        pushAnnounce(roomId, producer, producerPeerId, peerRelayId),
      portAllocator: makePrimaryStubAllocator(41000),
      paramSender: vi.fn(),
    });

    const { router } = makePrimaryMockRouter();
    // Cascade leg: a REAL peerRelayId threaded end-to-end through the coordinator.
    await coord.onStandbyConnectParams('room-C', PRIMARY_STANDBY_PARAMS, 'relay-B');
    await coord.onProducer('room-C', router as any, { id: 'producer-REAL', kind: 'video' }, 'relay-B');

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame['type']).toBe('pipe-producer');
    expect(frame['roomId']).toBe('room-C');
    expect(frame['peerRelayId']).toBe('relay-B'); // the cascade peer rode the wire
  });

  it('the DEFAULT/legacy coordinator leg (no peerRelayId) emits a frame with peerRelayId OMITTED (byte-stable legacy frame)', async () => {
    const sent: string[] = [];
    const sender: InterRelaySender = { send: (d) => sent.push(d) };
    const pushAnnounce = createInterRelayAnnouncer(sender);

    const coord = new PrimaryPipeCoordinator({
      announcer: (roomId, producer, producerPeerId, peerRelayId) =>
        pushAnnounce(roomId, producer, producerPeerId, peerRelayId),
      portAllocator: makePrimaryStubAllocator(41000),
      paramSender: vi.fn(),
    });

    const { router } = makePrimaryMockRouter();
    // Legacy single-standby leg: NO peerRelayId (defaults to DEFAULT_PEER_RELAY_ID).
    await coord.onStandbyConnectParams('room-D', PRIMARY_STANDBY_PARAMS);
    await coord.onProducer('room-D', router as any, { id: 'producer-REAL-D', kind: 'video' });

    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame['roomId']).toBe('room-D');
    expect('peerRelayId' in frame).toBe(false); // legacy frame — peerRelayId omitted
  });
});
