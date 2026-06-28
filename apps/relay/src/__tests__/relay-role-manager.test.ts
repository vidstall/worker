/**
 * Unit tests for relay-role-manager (REQ-RO-004 + REQ-RO-005).
 *
 * RED cases (TDD contract):
 *   - Standby has NO active consumer pre first-peer-join (pipeConsumer is null)
 *   - Standby has a PAUSED consumer after first peer join (consumer.pause() was called)
 *   - determineRole: own ID at index 0 → primary; at index 1 → standby; not in list → throws
 *   - parsePipePortRange: parses "40000-40100" → {min:40000, max:40100}
 *   - ensureWarmPipe is idempotent (second call does NOT open a second pipe)
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  determineRole,
  parsePipePortRange,
  ensureWarmPipe,
  createPipePortAllocator,
  createStandbyPipeTransport,
  createPipeLivenessObserver,
  pipeRoomToSecondWorker,
  type RoomTopology,
} from '@dvconf/inter-relay-client';

// ── mediasoup mock factories ──────────────────────────────────────────

function makeMockConsumer(paused = false) {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused,
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

function makeMockRouter(pipeTransport: ReturnType<typeof makeMockPipeTransport>) {
  return {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockResolvedValue(pipeTransport),
    rtpCapabilities: {} as any,
  };
}

// ── determineRole ──────────────────────────────────────────────────────

describe('determineRole', () => {
  it('returns "primary" when ownRelayId is assigned_relays[0]', () => {
    expect(determineRole(['relay-A', 'relay-B'], 'relay-A')).toBe('primary');
  });

  it('returns "standby" when ownRelayId is assigned_relays[1]', () => {
    expect(determineRole(['relay-A', 'relay-B'], 'relay-B')).toBe('standby');
  });

  it('returns "standby" for any index > 0 (future-proof)', () => {
    expect(determineRole(['relay-A', 'relay-B', 'relay-C'], 'relay-C')).toBe('standby');
  });

  it('throws when own ID is not in assignedRelays', () => {
    expect(() => determineRole(['relay-A', 'relay-B'], 'relay-X')).toThrow();
  });

  it('reads assigned_relays.length, never hardcodes 2', () => {
    // Single relay (edge/degraded) — own ID at 0 → primary
    expect(determineRole(['relay-solo'], 'relay-solo')).toBe('primary');
  });
});

// ── parsePipePortRange ─────────────────────────────────────────────────

describe('parsePipePortRange', () => {
  it('parses "40000-40100" correctly', () => {
    const range = parsePipePortRange('40000-40100');
    expect(range.min).toBe(40000);
    expect(range.max).toBe(40100);
  });

  it('uses default range when env is undefined', () => {
    const range = parsePipePortRange(undefined);
    expect(range.min).toBe(40000);
    expect(range.max).toBe(40100);
  });

  it('throws on malformed range string', () => {
    expect(() => parsePipePortRange('not-a-range')).toThrow();
  });
});

// ── ensureWarmPipe (REQ-RO-004 + REQ-RO-005) ─────────────────────────

describe('ensureWarmPipe — standby pre-first-join', () => {
  let topology: RoomTopology;

  beforeEach(() => {
    topology = {
      roomId: 'room-1',
      role: 'standby',
      primaryEndpoint: 'ws://primary:4000',
      standbyEndpoint: 'ws://standby:4000',
      pipePort: 40000,
      pipeConsumer: null,    // REQ-RO-004: no consumer yet pre-join
      pipeTransport: null,
    };
  });

  it('RED-RO-004: pipeConsumer is null before first peer join', () => {
    // This is the pre-condition — standby has NO active consumer.
    expect(topology.pipeConsumer).toBeNull();
  });

  it('RED-RO-005: after ensureWarmPipe with a REAL producerId, consumer is paused (consumer.pause() called)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    // C1: the keepalive consumer is minted once the REAL producerId is known
    // (post-announce). The no-producerId pre-join call now DEFERS (see DEFER test).
    const result = await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL');

    // Consumer must exist and pause() must have been called
    expect(result).not.toBeNull();
    expect(consumer.pause).toHaveBeenCalledOnce();
    // The consumer should be stored on topology
    expect(topology.pipeConsumer).toBe(result);
  });

  it('RED-RO-005: consumer created with paused=true semantics (not active RTP)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL');

    // The pipe transport was created (pipe established)
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    // consume() was called on the pipe transport
    expect(pipeTransport.consume).toHaveBeenCalledOnce();
    // pause() was called to keep consumer in RTCP-only state
    expect(consumer.pause).toHaveBeenCalledOnce();
  });

  it('C1 DEFER: with NO producerId, ensureWarmPipe binds the transport but does NOT consume — returns null', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const result = await ensureWarmPipe(topology, router as any, 40000);

    // No real producer announced yet → defer. Consuming a `pipe-producer-pending`
    // sentinel throws "Producer not found" on real mediasoup; the transport is still
    // bound + retained so the standby can announce its {ip,port} UP, and onAnnounce
    // re-runs with the real id.
    expect(result).toBeNull();
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    expect(pipeTransport.consume).not.toHaveBeenCalled();
    expect(consumer.pause).not.toHaveBeenCalled();
    expect(topology.pipeConsumer).toBeNull();
    expect(topology.pipeTransport).toBe(pipeTransport);
  });

  it('idempotent: second call (real producerId) returns same consumer, does not open second pipe', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const first = await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL');
    const second = await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL');

    expect(first).toBe(second);
    // createPipeTransport called only ONCE
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
  });
});

// ── primary relay: no pipe consumer ───────────────────────────────────

describe('ensureWarmPipe — primary role', () => {
  it('returns null for primary relay (primary does not call pipeToRouter)', async () => {
    const topology: RoomTopology = {
      roomId: 'room-2',
      role: 'primary',
      primaryEndpoint: 'ws://primary:4000',
      standbyEndpoint: 'ws://standby:4000',
      pipePort: 40000,
      pipeConsumer: null,
      pipeTransport: null,
    };
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const result = await ensureWarmPipe(topology, router as any, 40000);

    // Primary relay should NOT set up a pipe consumer
    expect(result).toBeNull();
    expect(router.createPipeTransport).not.toHaveBeenCalled();
  });
});

// ── G1 integration wiring: real producerId resolution ─────────────────
// The standby resolves the PRIMARY's real pipe-producer ID (from the
// inter-relay announce, see inter-relay.ts) and passes it into ensureWarmPipe,
// replacing the `pipe-producer-${roomId}` placeholder.

describe('ensureWarmPipe — G1 producerId resolution', () => {
  let topology: RoomTopology;

  beforeEach(() => {
    topology = {
      roomId: 'room-g1',
      role: 'standby',
      primaryEndpoint: 'ws://primary:4000',
      standbyEndpoint: 'ws://standby:4000',
      pipePort: 40000,
      pipeConsumer: null,
      pipeTransport: null,
    };
  });

  it('RED-G1: when a real producerId is provided, consume() uses it (not the placeholder)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL-from-primary');

    expect(pipeTransport.consume).toHaveBeenCalledOnce();
    const consumeArg = pipeTransport.consume.mock.calls[0]![0] as { producerId: string };
    expect(consumeArg.producerId).toBe('producer-REAL-from-primary');
  });

  it('C1: DEFERS (no consume) when no producerId is provided — the placeholder sentinel is never consumed', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const result = await ensureWarmPipe(topology, router as any, 40000);

    // No real producer announced yet → defer. The `pipe-producer-pending-<roomId>`
    // sentinel is NEVER consumed (it throws "Producer not found" on real mediasoup);
    // onAnnounce re-runs with the real id once it arrives.
    expect(result).toBeNull();
    expect(pipeTransport.consume).not.toHaveBeenCalled();
  });

  it('RED-G1: still pauses the consumer when a real producerId is used (REQ-RO-005 preserved)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL');

    expect(consumer.pause).toHaveBeenCalledOnce();
  });
});

// ── G3.1: ANNOUNCED_IP externalize + N2/N3 pipe-transport leak fix ─────
// REQ-G3 (M2 carry-in). The standby pipe transport must announce a
// deploy-routable IP (ANNOUNCED_IP env) instead of the hardcoded loopback, and
// ensureWarmPipe must RETAIN the PipeTransport it creates on
// topology.pipeTransport so a teardown / coordinator re-run can close it —
// closing the N2 idle-leak (transport never returned) and N3 re-run leak (the
// not-ready re-run leaks the stale transport and risks EADDRINUSE on a fixed
// pipePort). Pattern mirrors room-handler.ts:84.

describe('ensureWarmPipe — G3.1 ANNOUNCED_IP + pipeTransport retention', () => {
  let topology: RoomTopology;

  beforeEach(() => {
    topology = {
      roomId: 'room-g3',
      role: 'standby',
      primaryEndpoint: 'ws://primary:4000',
      standbyEndpoint: 'ws://standby:4000',
      pipePort: 40000,
      pipeConsumer: null,
      pipeTransport: null,
    };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('RED-G3.1: createPipeTransport announces ANNOUNCED_IP from env (not hardcoded 127.0.0.1)', async () => {
    vi.stubEnv('ANNOUNCED_IP', '10.0.0.7');
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000);

    expect(router.createPipeTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        listenIp: { ip: '0.0.0.0', announcedIp: '10.0.0.7' },
      }),
    );
  });

  it('RED-G3.1: defaults announcedIp to 127.0.0.1 when ANNOUNCED_IP is unset', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000);

    expect(router.createPipeTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        listenIp: { ip: '0.0.0.0', announcedIp: '127.0.0.1' },
      }),
    );
  });

  it('RED-N2: retains the created PipeTransport on topology.pipeTransport (closable for teardown)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000);

    expect(topology.pipeTransport).toBe(pipeTransport);
    expect(typeof topology.pipeTransport?.close).toBe('function');
  });

  it('RED-N3: a re-run (consumer reset, stale transport) closes the stale transport before rebinding', async () => {
    const consumer1 = makeMockConsumer();
    const transport1 = makeMockPipeTransport(consumer1);
    const consumer2 = makeMockConsumer();
    const transport2 = makeMockPipeTransport(consumer2);
    const router = {
      id: 'router-rerun',
      createPipeTransport: vi
        .fn()
        .mockResolvedValueOnce(transport1)
        .mockResolvedValueOnce(transport2),
      rtpCapabilities: {} as any,
    };

    // first run establishes transport1
    await ensureWarmPipe(topology, router as any, 40000);
    expect(topology.pipeTransport).toBe(transport1);

    // coordinator not-ready re-run: pipeConsumer reset to null but the stale
    // transport lingers (the N3 leak scenario).
    topology.pipeConsumer = null;

    await ensureWarmPipe(topology, router as any, 40000);

    // the stale transport1 must have been closed before transport2 was bound.
    expect(transport1.close).toHaveBeenCalledOnce();
    expect(topology.pipeTransport).toBe(transport2);
  });
});

// ── createPipePortAllocator (REQ-RO-009) ──────────────────────────────
// Per-room + per-role PIPE_PORT allocator. Replaces the single hardcoded
// pipePortRange.min so >1 room never collides (EADDRINUSE). Idempotent per key
// (preserves the N3 re-run invariant). Released on room close / coordinator.clear.

describe('createPipePortAllocator', () => {
  it('RED-RO-009-1: allocate returns distinct ports for distinct keys', () => {
    const alloc = createPipePortAllocator({ min: 40000, max: 40100 });
    const a = alloc.allocate('room-1');
    const b = alloc.allocate('room-2');
    const c = alloc.allocate('room-1:primary');

    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
    // all within range
    for (const p of [a, b, c]) {
      expect(p).toBeGreaterThanOrEqual(40000);
      expect(p).toBeLessThanOrEqual(40100);
    }
    expect(alloc.size()).toBe(3);
  });

  it('RED-RO-009-2: allocate is idempotent per key (re-run returns the SAME port, N3 invariant)', () => {
    const alloc = createPipePortAllocator({ min: 40000, max: 40100 });
    const first = alloc.allocate('room-g3');
    const again = alloc.allocate('room-g3');

    expect(again).toBe(first);
    // a re-run must NOT consume a second slot
    expect(alloc.size()).toBe(1);
  });

  it('RED-RO-009-3: keys a room standby and its :primary distinctly (same-host no collision)', () => {
    const alloc = createPipePortAllocator({ min: 40000, max: 40100 });
    const standby = alloc.allocate('room-x');
    const primary = alloc.allocate('room-x:primary');

    expect(standby).not.toBe(primary);
    expect(alloc.size()).toBe(2);
  });

  it('RED-RO-009-4: release frees a key, lowering size and recycling the port', () => {
    const alloc = createPipePortAllocator({ min: 40000, max: 40001 });
    const a = alloc.allocate('room-1');
    const b = alloc.allocate('room-2');
    expect(alloc.size()).toBe(2);

    alloc.release('room-1');
    expect(alloc.size()).toBe(1);

    // the freed port is recyclable on a new key (exhausted otherwise: range holds 2)
    const c = alloc.allocate('room-3');
    expect(c).toBe(a);
    expect(b).not.toBe(c);
    expect(alloc.size()).toBe(2);
  });

  it('RED-RO-009-5: release of an unknown key is a no-op (no throw, size unchanged)', () => {
    const alloc = createPipePortAllocator({ min: 40000, max: 40100 });
    alloc.allocate('room-1');
    expect(() => alloc.release('never-allocated')).not.toThrow();
    expect(alloc.size()).toBe(1);
  });

  it('RED-RO-009-6: throws on exhaustion when every port in the range is taken', () => {
    // range [40000..40002] = 3 ports
    const alloc = createPipePortAllocator({ min: 40000, max: 40002 });
    alloc.allocate('a');
    alloc.allocate('b');
    alloc.allocate('c');
    expect(alloc.size()).toBe(3);

    expect(() => alloc.allocate('d')).toThrow(/exhausted/i);
  });
});

// ── createStandbyPipeTransport + ensureWarmPipe(passed-in transport) (REQ-RO-005) ──
// F1 live handshake needs the standby's PipeTransport handle BEFORE consuming
// (to read tuple.localPort, announce it, connect() it). createStandbyPipeTransport
// mints it (mirrors createPrimaryPipeTransport); ensureWarmPipe then consumes onto
// the PASSED-IN transport (still paused, retained for teardown) instead of minting
// its own — preserving the 4-arg create-own contract for every existing caller.

describe('createStandbyPipeTransport (REQ-RO-005)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('mints a PipeTransport on the router with ANNOUNCED_IP + enableSrtp:false', async () => {
    vi.stubEnv('ANNOUNCED_IP', '10.0.0.9');
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const result = await createStandbyPipeTransport(router as any, 40005);

    expect(result).toBe(pipeTransport);
    expect(router.createPipeTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        listenIp: { ip: '0.0.0.0', announcedIp: '10.0.0.9' },
        port: 40005,
        enableRtx: false,
        enableSrtp: false,
      }),
    );
  });

  it('defaults announcedIp to 127.0.0.1 when ANNOUNCED_IP is unset', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await createStandbyPipeTransport(router as any, 40006);

    expect(router.createPipeTransport).toHaveBeenCalledWith(
      expect.objectContaining({ listenIp: { ip: '0.0.0.0', announcedIp: '127.0.0.1' } }),
    );
  });

  it('routes enableSrtp:false when PIPE_SRTP is unset (default-OFF byte-identical)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await createStandbyPipeTransport(router as any, 40007);

    expect(router.createPipeTransport).toHaveBeenCalledWith(
      expect.objectContaining({ enableSrtp: false }),
    );
  });

  it('routes enableSrtp:true when PIPE_SRTP=1 (B1 flag-ON, REQ-MLW-B-11)', async () => {
    vi.stubEnv('PIPE_SRTP', '1');
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await createStandbyPipeTransport(router as any, 40008);

    expect(router.createPipeTransport).toHaveBeenCalledWith(
      expect.objectContaining({ enableSrtp: true }),
    );
  });
});

describe('ensureWarmPipe — consume onto a PASSED-IN transport (REQ-RO-005)', () => {
  let topology: RoomTopology;

  beforeEach(() => {
    topology = {
      roomId: 'room-passed',
      role: 'standby',
      primaryEndpoint: 'ws://primary:4000',
      standbyEndpoint: 'ws://standby:4000',
      pipePort: 40000,
      pipeConsumer: null,
      pipeTransport: null,
    };
  });

  it('consumes onto the passed-in transport (does NOT create its own) and still pauses', async () => {
    const consumer = makeMockConsumer();
    const passedTransport = makeMockPipeTransport(consumer);
    // router must NOT be asked to create a transport when one is passed in.
    const router = makeMockRouter(makeMockPipeTransport(makeMockConsumer()));

    const result = await ensureWarmPipe(
      topology,
      router as any,
      40000,
      'producer-REAL',
      passedTransport as any,
    );

    expect(router.createPipeTransport).not.toHaveBeenCalled();
    expect(passedTransport.consume).toHaveBeenCalledOnce();
    const consumeArg = passedTransport.consume.mock.calls[0]![0] as { producerId: string };
    expect(consumeArg.producerId).toBe('producer-REAL');
    expect(consumer.pause).toHaveBeenCalledOnce(); // REQ-RO-005 preserved
    expect(result).toBe(consumer);
  });

  it('retains the passed-in transport on topology.pipeTransport (teardown / N2)', async () => {
    const consumer = makeMockConsumer();
    const passedTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(makeMockPipeTransport(makeMockConsumer()));

    await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL', passedTransport as any);

    expect(topology.pipeTransport).toBe(passedTransport);
  });

  it('falls back to create-own (4-arg, unchanged) when no transport is passed', async () => {
    const consumer = makeMockConsumer();
    const ownTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(ownTransport);

    const result = await ensureWarmPipe(topology, router as any, 40000, 'producer-REAL');

    expect(router.createPipeTransport).toHaveBeenCalledOnce(); // create-own path
    expect(ownTransport.consume).toHaveBeenCalledOnce();
    expect(consumer.pause).toHaveBeenCalledOnce();
    expect(topology.pipeTransport).toBe(ownTransport);
    expect(result).toBe(consumer);
  });
});

// ── createPipeLivenessObserver (REQ-RO-010 + REQ-RO-011) ──────────────
// Honest probe flip: pipeConsumerAlive on consumer existence (not closed);
// rtcpAlive ONLY on a non-zero counter ADVANCE across >=2 getStats() samples
// (NEVER set-on-create); BOTH cleared false on null/closed. Writes via the
// injected setLiveness closure (index.ts wires it to the probeLiveness box).
// Uses fake timers to drive the poll deterministically (no real wall-clock).

describe('createPipeLivenessObserver — honest probe flip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /** A mock pipe consumer whose getStats() returns a controllable counter. */
  function makeStatConsumer(initial = 0) {
    let packetCount = initial;
    return {
      consumer: {
        closed: false,
        getStats: vi.fn(async () => [
          { type: 'outbound-rtp', packetCount, byteCount: 0, nackCount: 0, pliCount: 0, firCount: 0 },
        ]),
      },
      advanceBy: (n: number) => {
        packetCount += n;
      },
    };
  }

  /** Drive N poll ticks, awaiting the async getStats() each tick settles. */
  async function pump(ticks: number, intervalMs: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs);
    }
  }

  it('RED-RO-010: NEVER set-on-create — rtcpAlive false after the first sample (no prior to compare)', async () => {
    const { consumer } = makeStatConsumer(500); // non-zero ABSOLUTE counter
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100); // exactly ONE sample taken
    obs.stop();

    const last = calls.at(-1)!;
    expect(last.pipeConsumerAlive).toBe(true); // consumer exists
    expect(last.rtcpAlive).toBe(false); // no ADVANCE yet — never set-on-create
  });

  it('RED-RO-010: flips rtcpAlive true after a non-zero ADVANCE across >=2 samples', async () => {
    const sc = makeStatConsumer(100);
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => sc.consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100); // sample #1 (baseline)
    expect(calls.at(-1)!.rtcpAlive).toBe(false);
    sc.advanceBy(7); // real RTP/RTCP moved the counter
    await pump(1, 100); // sample #2 — advance detected
    obs.stop();

    expect(calls.at(-1)!.rtcpAlive).toBe(true);
    expect(calls.at(-1)!.pipeConsumerAlive).toBe(true);
  });

  it('RED-RO-011: STATIC counters never flip rtcpAlive (paused-unpaid honesty — no over-claim)', async () => {
    const sc = makeStatConsumer(900); // big but NEVER advances
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => sc.consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(5, 100); // 5 samples, counter frozen
    obs.stop();

    expect(calls.every((c) => c.rtcpAlive === false)).toBe(true);
    expect(calls.at(-1)!.pipeConsumerAlive).toBe(true);
  });

  it('RED-RO-010: clears BOTH false when getPipeConsumer returns null', async () => {
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => null,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100);
    obs.stop();

    expect(calls.at(-1)!).toEqual({ pipeConsumerAlive: false, rtcpAlive: false });
  });

  it('RED-RO-010: clears BOTH false when the consumer is closed', async () => {
    const closedConsumer = {
      closed: true,
      getStats: vi.fn(async () => []),
    };
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => closedConsumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100);
    obs.stop();

    expect(calls.at(-1)!).toEqual({ pipeConsumerAlive: false, rtcpAlive: false });
    expect(closedConsumer.getStats).not.toHaveBeenCalled(); // short-circuit on closed
  });

  it('RED-RO-010: a previously-live rtcpAlive RESETS to false if the consumer disappears (no stale true)', async () => {
    const sc = makeStatConsumer(0);
    let present: typeof sc.consumer | null = sc.consumer;
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => present as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100); // baseline
    sc.advanceBy(10);
    await pump(1, 100); // rtcpAlive -> true
    expect(calls.at(-1)!.rtcpAlive).toBe(true);
    present = null; // pipe consumer gone (worker.died / cutover teardown)
    await pump(1, 100);
    obs.stop();

    expect(calls.at(-1)!).toEqual({ pipeConsumerAlive: false, rtcpAlive: false });
  });

  it('RED-RO-010: stop() halts polling (no further setLiveness calls)', async () => {
    const sc = makeStatConsumer(0);
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => sc.consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(2, 100);
    const countAtStop = calls.length;
    obs.stop();
    sc.advanceBy(50);
    await pump(5, 100);

    expect(calls.length).toBe(countAtStop); // no polls after stop
  });

  it('RED-RO-010: a rejected getStats() leaves liveness flags untouched (does not crash the loop)', async () => {
    const flakyConsumer = {
      closed: false,
      getStats: vi.fn(async () => {
        throw new Error('getStats on a transient transport');
      }),
    };
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => flakyConsumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(2, 100); // both ticks: getStats rejects
    obs.stop();

    // consumer EXISTS + not closed -> pipeConsumerAlive true; rtcpAlive stays
    // false (no usable sample); loop survived the rejection.
    expect(calls.at(-1)!.pipeConsumerAlive).toBe(true);
    expect(calls.at(-1)!.rtcpAlive).toBe(false);
  });
});

// ── pipeRoomToSecondWorker (REQ-RMS-007 — tier-2 intra-box cross-worker spill) ──
// Pure-logic branches over a mocked sourceRouter.pipeToRouter (no real mediasoup):
//   - happy path: returns the minted pipeConsumer
//   - defensive throw when mediasoup returns no pipeConsumer (optional-narrow)

describe('pipeRoomToSecondWorker (REQ-RMS-007)', () => {
  it('returns { pipeProducer, pipeConsumer } — pipeConsumer minted on the source router (kind mirrors producer)', async () => {
    const pipeConsumer = { id: 'pipe-consumer-1', kind: 'video' };
    const pipeProducer = { id: 'pipe-producer-1', kind: 'video' };
    const sourceRouter = { pipeToRouter: vi.fn().mockResolvedValue({ pipeProducer, pipeConsumer }) };
    const secondRouter = { id: 'router-second' };

    const result = await pipeRoomToSecondWorker(
      sourceRouter as any,
      secondRouter as any,
      'producer-REAL',
    );

    // Task-10 (REQ-RMS-011): the helper now RETURNS both legs of the hop so a
    // caller can witness the downstream producer's surviving simulcast ladder.
    expect(result.pipeConsumer).toBe(pipeConsumer);
    expect(result.pipeProducer).toBe(pipeProducer);
    // No-cast call shape: { producerId, router } passed straight through.
    expect(sourceRouter.pipeToRouter).toHaveBeenCalledWith({
      producerId: 'producer-REAL',
      router: secondRouter,
    });
  });

  it('throws (producerId-bearing) when pipeToRouter returns no pipeConsumer', async () => {
    // mediasoup types pipeConsumer as optional; the helper must fail loud.
    const sourceRouter = {
      pipeToRouter: vi.fn().mockResolvedValue({ pipeProducer: { id: 'p' }, pipeConsumer: undefined }),
    };
    const secondRouter = { id: 'router-second' };

    await expect(
      pipeRoomToSecondWorker(sourceRouter as any, secondRouter as any, 'producer-MISSING'),
    ).rejects.toThrow('producer-MISSING');
  });

  it('throws (producerId-bearing) when pipeToRouter returns no pipeProducer', async () => {
    // pipeProducer is likewise optional in mediasoup's types; the helper must
    // fail loud rather than return a half-formed hop result.
    const sourceRouter = {
      pipeToRouter: vi.fn().mockResolvedValue({ pipeProducer: undefined, pipeConsumer: { id: 'c' } }),
    };
    const secondRouter = { id: 'router-second' };

    await expect(
      pipeRoomToSecondWorker(sourceRouter as any, secondRouter as any, 'producer-NOPROD'),
    ).rejects.toThrow('producer-NOPROD');
  });
});
