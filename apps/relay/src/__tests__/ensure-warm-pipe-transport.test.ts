/**
 * Unit tests for relay-role-manager (REQ-RO-004 + REQ-RO-005) — G3.1
 * ANNOUNCED_IP externalize + N2/N3 pipe-transport leak fix, the per-room pipe
 * port allocator, createStandbyPipeTransport, and ensureWarmPipe consuming
 * onto a PASSED-IN transport.
 *
 * Requirements: REQ-RO-004, REQ-RO-005, REQ-RO-009, REQ-G3, REQ-MLW-B-11
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureWarmPipe,
  createPipePortAllocator,
  createStandbyPipeTransport,
  type RoomTopology,
} from '@dvconf/inter-relay-client';
import { makeMockConsumer, makeMockPipeTransport, makeMockRouter } from './relay-role-manager.testUtils.js';

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
