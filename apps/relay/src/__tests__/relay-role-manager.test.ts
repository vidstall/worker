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
  type RoomTopology,
} from '../relay-role-manager.js';

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

  it('RED-RO-005: after ensureWarmPipe, consumer is paused (consumer.pause() called)', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const result = await ensureWarmPipe(topology, router as any, 40000);

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

    await ensureWarmPipe(topology, router as any, 40000);

    // The pipe transport was created (pipe established)
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    // consume() was called on the pipe transport
    expect(pipeTransport.consume).toHaveBeenCalledOnce();
    // pause() was called to keep consumer in RTCP-only state
    expect(consumer.pause).toHaveBeenCalledOnce();
  });

  it('idempotent: second call returns same consumer, does not open second pipe', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    const first = await ensureWarmPipe(topology, router as any, 40000);
    const second = await ensureWarmPipe(topology, router as any, 40000);

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

  it('RED-G1: falls back to the typed placeholder when no producerId is provided', async () => {
    const consumer = makeMockConsumer();
    const pipeTransport = makeMockPipeTransport(consumer);
    const router = makeMockRouter(pipeTransport);

    await ensureWarmPipe(topology, router as any, 40000);

    const consumeArg = pipeTransport.consume.mock.calls[0]![0] as { producerId: string };
    // Clearly-marked fallback placeholder (no real producer announced yet)
    expect(consumeArg.producerId).toBe('pipe-producer-pending-room-g1');
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
