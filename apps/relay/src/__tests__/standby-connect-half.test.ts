/**
 * F1 (CONSISTENCY-FIX HIGH#3 + F6 MEDIUM) — the standby connect-half.
 *   (1) handleInboundInterRelayFrame routes an inbound pipe-connect frame to
 *       InboundInterRelayContext.onConnectParams(roomId, params).
 *   (2) StandbyWarmPipeCoordinator.onPrimaryConnectParams(roomId, params) calls
 *       topology.pipeTransport.connect({ip,port}) on the already-bound transport.
 *   (3) currentPipeConsumer(roomId?) returns the live standby pipe consumer (or null).
 * Requirements: REQ-RO-003 / REQ-RO-006 (standby connect half) / REQ-RO-010 (accessor for F6).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleInboundInterRelayFrame,
  StandbyWarmPipeCoordinator,
  InterRelayProducerRegistry,
  buildPipeConnectFrame,
  type PipeConnectParams,
} from '../inter-relay.js';

describe('handleInboundInterRelayFrame — inbound pipe-connect (REQ-RO-006 standby half)', () => {
  it('routes an inbound pipe-connect frame to onConnectParams(roomId, params)', async () => {
    const onConnectParams = vi.fn();
    const raw = JSON.stringify(buildPipeConnectFrame('room-S', { ip: '127.0.0.1', port: 41999 }));
    const handled = await handleInboundInterRelayFrame(raw, {
      registry: new InterRelayProducerRegistry(),
      onConnectParams,
    });
    expect(handled).toBe(true);
    expect(onConnectParams).toHaveBeenCalledOnce();
    expect(onConnectParams.mock.calls[0]![0]).toBe('room-S');
    expect(onConnectParams.mock.calls[0]![1]).toMatchObject({ ip: '127.0.0.1', port: 41999 });
  });

  it('still routes a pipe-producer announce (back-compat) and ignores junk', async () => {
    const onAnnounce = vi.fn();
    const reg = new InterRelayProducerRegistry();
    const announce = JSON.stringify({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video' });
    expect(await handleInboundInterRelayFrame(announce, { registry: reg, onAnnounce })).toBe(true);
    expect(onAnnounce).toHaveBeenCalledWith('r');
    expect(await handleInboundInterRelayFrame('not json', { registry: reg })).toBe(false);
    expect(await handleInboundInterRelayFrame(JSON.stringify({ type: 'nope' }), { registry: reg })).toBe(false);
  });
});

describe('StandbyWarmPipeCoordinator.onPrimaryConnectParams (REQ-RO-003 step 5)', () => {
  it('connect()s the already-bound standby PipeTransport to the primary reply params', async () => {
    const reg = new InterRelayProducerRegistry();
    const coord = new StandbyWarmPipeCoordinator(reg);
    // Seed a room state with a bound (mock) PipeTransport on the topology.
    const connect = vi.fn().mockResolvedValue(undefined);
    const pipeTransport = { connect, tuple: { localPort: 40000 }, close: vi.fn() } as any;
    // ensure() is the real entry, but for a unit test we set the state via a bound
    // transport: drive a minimal ensure so states.get(roomId) exists, OR expose the
    // topology. Simplest: call ensure with a router whose createPipeTransport returns
    // our mock, then onPrimaryConnectParams.
    const router = { createPipeTransport: vi.fn().mockResolvedValue(pipeTransport) } as any;
    const topology = {
      roomId: 'room-S', role: 'standby' as const,
      primaryEndpoint: '', standbyEndpoint: '',
      pipePort: 40000, pipeConsumer: null, pipeTransport: null,
    };
    // bind the transport onto topology via ensure (consume is also on the mock):
    (pipeTransport as any).consume = vi.fn().mockResolvedValue({ id: 'c', kind: 'video', pause: vi.fn(), paused: true, close: vi.fn() });
    await coord.ensure(topology as any, router, 40000);
    const params: PipeConnectParams = { ip: '127.0.0.1', port: 50050 };
    await coord.onPrimaryConnectParams('room-S', params);
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ ip: '127.0.0.1', port: 50050 }));
  });

  it('is a safe no-op when the room has no bound transport yet (no throw)', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry());
    await expect(coord.onPrimaryConnectParams('never', { ip: '1.2.3.4', port: 9 })).resolves.toBeUndefined();
  });
});

describe('StandbyWarmPipeCoordinator.currentPipeConsumer (F6 accessor)', () => {
  it('returns the live pipe consumer after ensure, null before / for an unknown room', async () => {
    const reg = new InterRelayProducerRegistry();
    const coord = new StandbyWarmPipeCoordinator(reg);
    expect(coord.currentPipeConsumer('unknown')).toBeNull();
    const consumer = { id: 'c', kind: 'video', pause: vi.fn(), paused: true, close: vi.fn() } as any;
    const pipeTransport = { consume: vi.fn().mockResolvedValue(consumer), connect: vi.fn(), tuple: { localPort: 1 }, close: vi.fn() } as any;
    const router = { createPipeTransport: vi.fn().mockResolvedValue(pipeTransport) } as any;
    const topology = { roomId: 'room-S', role: 'standby' as const, primaryEndpoint: '', standbyEndpoint: '', pipePort: 1, pipeConsumer: null, pipeTransport: null };
    await coord.ensure(topology as any, router, 1);
    expect(coord.currentPipeConsumer('room-S')).toBe(consumer);
    expect(coord.currentPipeConsumer()).toBe(consumer); // no-arg: single-room convenience
  });
});
