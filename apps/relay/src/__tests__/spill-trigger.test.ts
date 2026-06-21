/**
 * Unit tests for spill-trigger.ts (REQ-RMS-006 — self-observed spill trigger).
 *
 * The relay tracks a per-room forward-path count and fires a `spill-requested`
 * callback ONCE when a room crosses a fraction (SPILL_FRACTION) of the env
 * RMS_C_WORKER_PATHS ceiling — the SAME env var cp-daemon placement reads
 * (cp-daemon/src/event-handler.ts), so both sides calibrate off one env knob
 * (by-convention; config-server wiring out of M2 Task1 scope). RMS_C_WORKER_PATHS is
 * parseInt-from-env (NEVER hardcoded). The single-room M1 path is untouched when no spill fires.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createSpillTrigger } from '../spill-trigger.js';

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('createSpillTrigger (REQ-RMS-006)', () => {
  it('reads RMS_C_WORKER_PATHS from env (never hardcoded) and fires when a room crosses SPILL_FRACTION*C_worker', () => {
    process.env['RMS_C_WORKER_PATHS'] = '100';
    process.env['SPILL_FRACTION_BPS'] = '8000'; // 80%
    const fired: Array<{ roomId: string; paths: number }> = [];
    const trigger = createSpillTrigger({ onSpillRequested: (roomId, paths) => fired.push({ roomId, paths }) });

    // 79 paths < 80 threshold → no fire
    for (let i = 0; i < 79; i++) trigger.recordPath('room-1');
    expect(fired).toHaveLength(0);
    // crossing the 80th path fires exactly once
    trigger.recordPath('room-1');
    expect(fired).toEqual([{ roomId: 'room-1', paths: 80 }]);
    // further paths do NOT re-fire for the same room (de-dup)
    trigger.recordPath('room-1');
    expect(fired).toHaveLength(1);
  });

  it('isolates per-room counts (room-2 does not inherit room-1 paths)', () => {
    process.env['RMS_C_WORKER_PATHS'] = '10';
    process.env['SPILL_FRACTION_BPS'] = '5000'; // 50% → threshold 5
    const fired: string[] = [];
    const trigger = createSpillTrigger({ onSpillRequested: (roomId) => fired.push(roomId) });
    for (let i = 0; i < 4; i++) trigger.recordPath('room-1');
    for (let i = 0; i < 5; i++) trigger.recordPath('room-2'); // room-2 crosses at its own 5th
    expect(fired).toEqual(['room-2']);
  });

  it('defaults RMS_C_WORKER_PATHS sanely (300) when env is unset, and releasePath/clearRoom shrink the count', () => {
    delete process.env['RMS_C_WORKER_PATHS'];
    delete process.env['SPILL_FRACTION_BPS'];
    const fired: string[] = [];
    const trigger = createSpillTrigger({ onSpillRequested: (roomId) => fired.push(roomId) });
    trigger.recordPath('room-1');
    trigger.releasePath('room-1'); // count back to 0
    trigger.clearRoom('room-1');
    expect(trigger.pathCount('room-1')).toBe(0);
    expect(fired).toHaveLength(0); // default ceiling 300 (shared cp knob) → 1 path << 240 threshold, no spurious fire
  });

  it('releasePath decrements without clearRoom, no-ops an unknown room, and clamps at 0 (never negative)', () => {
    delete process.env['RMS_C_WORKER_PATHS'];
    delete process.env['SPILL_FRACTION_BPS'];
    const trigger = createSpillTrigger({ onSpillRequested: () => undefined });

    // decrement is real: record x2, release once → 1 (NOT masked by clearRoom)
    trigger.recordPath('room-1');
    trigger.recordPath('room-1');
    expect(trigger.pathCount('room-1')).toBe(2);
    trigger.releasePath('room-1');
    expect(trigger.pathCount('room-1')).toBe(1); // proves releasePath actually decremented

    // releasePath on a never-recorded room is a safe no-op (early return), stays 0
    trigger.releasePath('never-recorded');
    expect(trigger.pathCount('never-recorded')).toBe(0);

    // over-release on a known room clamps at 0 and never goes negative
    trigger.releasePath('room-1'); // 1 → 0
    trigger.releasePath('room-1'); // 0 → stays 0 (Math.max(0, cur-1))
    expect(trigger.pathCount('room-1')).toBe(0);
  });
});
