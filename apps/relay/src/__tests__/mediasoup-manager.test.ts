/**
 * Unit tests for mediasoup-manager — getWorkerExcluding (REQ-RMS-007).
 *
 * These exercise the PURE-LOGIC branches of the tier-2 second-worker selector
 * over a MOCKED `mediasoup` module (no real Worker subprocess), so they run in
 * the hermetic unit suite (not the real-mediasoup relay-integration suite):
 *   - returns a worker DISTINCT from `current` when ≥2 workers exist
 *   - single-worker fallback: returns the lone worker (other ?? workers[0])
 *   - throws 'No mediasoup Workers available' when the worker pool is empty
 *
 * Requirements: REQ-RMS-007 (tier-2 intra-box cross-worker spill — selection half)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import { createLogger } from '@dvconf/shared';

// ── mock the mediasoup module so createWorker mints lightweight fakes ──────
// createMediasoupManager only touches worker.on('died'), worker.pid, and (via
// close()) worker.close(). We mint just those so no real subprocess spawns.

let pidCounter = 0;

function makeFakeWorker(): msTypes.Worker {
  pidCounter += 1;
  return {
    pid: pidCounter,
    on: vi.fn(),
    close: vi.fn(),
    // createRouter unused by getWorkerExcluding's branches but present for shape.
    createRouter: vi.fn().mockResolvedValue({}),
  } as unknown as msTypes.Worker;
}

vi.mock('mediasoup', () => ({
  createWorker: vi.fn(async () => makeFakeWorker()),
}));

// Import AFTER vi.mock so the manager picks up the mocked createWorker.
import { createMediasoupManager } from '../mediasoup-manager.js';

const logger = createLogger('test:rms007-unit');

describe('getWorkerExcluding (REQ-RMS-007)', () => {
  beforeEach(() => {
    pidCounter = 0;
  });

  it('returns a worker DISTINCT from `current` when ≥2 workers exist', async () => {
    process.env['NUM_WORKERS'] = '3';
    const manager = await createMediasoupManager(logger);

    const first = manager.workers[0]!;
    const excluded = manager.getWorkerExcluding(first);

    expect(excluded).not.toBe(first);
    expect(manager.workers).toContain(excluded);

    manager.close();
  });

  it('single-worker fallback: returns the lone worker (no DISTINCT one exists)', async () => {
    process.env['NUM_WORKERS'] = '1';
    const manager = await createMediasoupManager(logger);

    const only = manager.workers[0]!;
    // `current` IS the only worker → other===undefined → falls back to workers[0].
    expect(manager.getWorkerExcluding(only)).toBe(only);

    manager.close();
  });

  it('throws when the worker pool is empty (after close())', async () => {
    process.env['NUM_WORKERS'] = '1';
    const manager = await createMediasoupManager(logger);
    const someWorker = manager.workers[0]!;

    manager.close(); // empties workers[]

    expect(() => manager.getWorkerExcluding(someWorker)).toThrow(
      'No mediasoup Workers available',
    );
  });
});
