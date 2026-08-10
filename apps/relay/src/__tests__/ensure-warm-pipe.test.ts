/**
 * Unit tests for relay-role-manager (REQ-RO-004 + REQ-RO-005) — ensureWarmPipe
 * standby pre-first-join, primary role, and G1 producerId resolution.
 *
 * RED cases (TDD contract):
 *   - Standby has NO active consumer pre first-peer-join (pipeConsumer is null)
 *   - Standby has a PAUSED consumer after first peer join (consumer.pause() was called)
 *   - ensureWarmPipe is idempotent (second call does NOT open a second pipe)
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ensureWarmPipe, type RoomTopology } from '@dvconf/inter-relay-client';
import { makeMockConsumer, makeMockPipeTransport, makeMockRouter } from './relay-role-manager.testUtils.js';

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
