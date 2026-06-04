/**
 * Unit tests for relay-worker-recovery.ts (REQ-RO-007).
 *
 * TDD contract — RED cases:
 *   1. worker.died → full topology rebuilt (Router + transports + pipe + paused consumer).
 *   2. Idempotent: rebuild called twice from the same snapshot — no duplicate-pipe throw.
 *   3. Producer-ID aliasing: after worker.died a previously used producerId must NOT
 *      cause a duplicate-pipe error (discrimination key guards re-pipe).
 *   4. Primary relay rebuild: creates Router only, no pipe consumer.
 *   5. Standby relay rebuild: creates Router + paused pipe consumer.
 *
 * Requirements: REQ-RO-007
 */

import { describe, it, expect, vi } from 'vitest';
import {
  rebuildFromRegistry,
  type RegistrySnapshot,
  type MediasoupManager,
} from '../relay-worker-recovery.js';

// ── Mock factory ───────────────────────────────────────────────────────

function makeMockConsumer() {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused: false,
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeMockPipeTransport() {
  const consumer = makeMockConsumer();
  return {
    id: `pipe-${Math.random().toString(36).slice(2)}`,
    consume: vi.fn().mockResolvedValue(consumer),
    connect: vi.fn().mockResolvedValue(undefined),
    tuple: { localIp: '127.0.0.1', localPort: 40000 },
    close: vi.fn(),
    _consumer: consumer,
  };
}

function makeMockRouter() {
  const pipeTransport = makeMockPipeTransport();
  return {
    id: `router-${Math.random().toString(36).slice(2)}`,
    rtpCapabilities: {} as any,
    createPipeTransport: vi.fn().mockResolvedValue(pipeTransport),
    close: vi.fn(),
    _pipeTransport: pipeTransport,
  };
}

function makeMockManager(): {
  manager: MediasoupManager;
  createdRouters: ReturnType<typeof makeMockRouter>[];
} {
  const createdRouters: ReturnType<typeof makeMockRouter>[] = [];

  const manager: MediasoupManager = {
    getNextWorker: vi.fn().mockReturnValue({ pid: 1234 } as any),
    createRouter: vi.fn().mockImplementation(async () => {
      const router = makeMockRouter();
      createdRouters.push(router);
      return router;
    }),
  };

  return { manager, createdRouters };
}

// ── Snapshot helpers ───────────────────────────────────────────────────

function primarySnapshot(): RegistrySnapshot {
  return {
    roomId: 'room-1',
    role: 'primary',
    primaryEndpoint: 'ws://primary:4000',
    standbyEndpoint: 'ws://standby:4000',
    pipePort: 40000,
  };
}

function standbySnapshot(): RegistrySnapshot {
  return {
    roomId: 'room-1',
    role: 'standby',
    primaryEndpoint: 'ws://primary:4000',
    standbyEndpoint: 'ws://standby:4000',
    pipePort: 40000,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('rebuildFromRegistry (REQ-RO-007)', () => {
  it('RED-RO-007-1a: primary rebuild — creates a new Router', async () => {
    const { manager, createdRouters } = makeMockManager();

    const result = await rebuildFromRegistry(manager, primarySnapshot());

    expect(result.router).toBeDefined();
    expect(createdRouters).toHaveLength(1);
    expect(manager.createRouter).toHaveBeenCalledOnce();
  });

  it('RED-RO-007-1b: primary rebuild — no pipe consumer (primary does not pipe)', async () => {
    const { manager, createdRouters } = makeMockManager();

    const result = await rebuildFromRegistry(manager, primarySnapshot());

    expect(result.consumer).toBeUndefined();
    // createPipeTransport never called on the primary's router
    expect(createdRouters[0]?.createPipeTransport).not.toHaveBeenCalled();
  });

  it('RED-RO-007-2a: standby rebuild — creates Router + paused pipe Consumer', async () => {
    const { manager, createdRouters } = makeMockManager();

    const result = await rebuildFromRegistry(manager, standbySnapshot());

    expect(result.router).toBeDefined();
    expect(result.consumer).toBeDefined();
    // Router was created
    expect(createdRouters).toHaveLength(1);
    // Pipe transport established on the new router
    expect(createdRouters[0]?.createPipeTransport).toHaveBeenCalledOnce();
    // Consumer immediately paused (REQ-RO-005)
    expect(result.consumer?.pause).toHaveBeenCalledOnce();
  });

  it('RED-RO-007-2b: idempotent — second rebuild from same snapshot does not throw', async () => {
    const { manager } = makeMockManager();

    const first = await rebuildFromRegistry(manager, standbySnapshot());
    // Simulate worker.died again by passing the same snapshot
    const second = await rebuildFromRegistry(manager, standbySnapshot());

    // Both calls succeed (no throw)
    expect(first.router).toBeDefined();
    expect(second.router).toBeDefined();
  });

  it('RED-RO-007-3: producer-ID aliasing — snapshot with prevProducerId does not throw on re-pipe', async () => {
    const { manager } = makeMockManager();

    // After worker.died, the caller passes the same snapshot — previously used
    // producerIds would alias on a naive re-pipe. rebuildFromRegistry must use
    // a discrimination key to guard against duplicate-pipe throws.
    const snapshot: RegistrySnapshot = {
      ...standbySnapshot(),
      // Discrimination key: if present, prevents re-pipe with same ID
      prevPipeProducerId: 'producer-stale-from-dead-worker',
    };

    // Should not throw even though prevPipeProducerId is "already used"
    await expect(rebuildFromRegistry(manager, snapshot)).resolves.toBeDefined();
  });

  it('RED-RO-007-4: worker.died simulation — rebuild reads registry snapshot, not stale in-memory', async () => {
    const { manager, createdRouters } = makeMockManager();

    // The snapshot represents the freshly-read registry state (pipePort from env)
    const snapshot: RegistrySnapshot = {
      ...standbySnapshot(),
      pipePort: 40001, // Different port — from fresh registry read
    };

    await rebuildFromRegistry(manager, snapshot);

    // The new pipe transport must use the port from the snapshot
    const pipeTransportCall = createdRouters[0]?.createPipeTransport.mock.calls[0]?.[0] as {
      port?: number;
    };
    expect(pipeTransportCall?.port).toBe(40001);
  });
});
