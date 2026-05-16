/**
 * RED test for the validator latency probe — S23.1.A3.
 *
 * Locks the timed-measureRoom wrapper behaviour. Unlike A1 (relay) and A2
 * (signaling) where the probe pre-existed and only wiring was missing, A3
 * creates the probe + tests + wire-in together.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.1.A3
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const writeCalls: Array<{
    metric: string;
    value_ms: number;
    context: Record<string, unknown> | undefined;
  }> = [];
  let benchEnabled = true;
  return {
    writeCalls,
    getBenchEnabled: () => benchEnabled,
    setBenchEnabled: (v: boolean) => {
      benchEnabled = v;
    },
    resetCalls: () => {
      writeCalls.length = 0;
    },
  };
});

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return {
    ...actual,
    isBenchEnabled: () => harness.getBenchEnabled(),
    LatencyWriter: vi.fn().mockImplementation(() => ({
      traceId: 'test-trace',
      scenario: 'adhoc' as const,
      source: 'validator' as const,
      instance: 'validator-test',
      getFilePath: () => '/tmp/validator-test.jsonl',
      write: (metric: string, value_ms: number, context?: Record<string, unknown>) => {
        harness.writeCalls.push({ metric, value_ms, context });
      },
      close: () => {},
    })),
  };
});

import { timedMeasureRoom, closeValidatorProbe } from '../latency-probe.js';

describe('timedMeasureRoom', () => {
  beforeEach(() => {
    harness.resetCalls();
    harness.setBenchEnabled(true);
    closeValidatorProbe();
  });

  it('records L_validator_check with duration + room/relay context on success', async () => {
    const body = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return 'ok';
    });

    const result = await timedMeasureRoom('room-1', () => 'relay-A', body);

    expect(result).toBe('ok');
    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.metric).toBe('L_validator_check');
    expect(harness.writeCalls[0]!.context).toEqual({
      room_id: 'room-1',
      relay_miner_id: 'relay-A',
    });
    expect(harness.writeCalls[0]!.value_ms).toBeGreaterThanOrEqual(8);
  });

  it('records L_validator_check even when body throws (failure latency observed)', async () => {
    const failure = new Error('measurement-failed');
    const body = vi.fn().mockImplementation(async () => {
      throw failure;
    });

    await expect(timedMeasureRoom('room-1', () => 'relay-A', body)).rejects.toBe(failure);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.metric).toBe('L_validator_check');
    expect(harness.writeCalls[0]!.context).toEqual({
      room_id: 'room-1',
      relay_miner_id: 'relay-A',
    });
  });

  it('records relay_miner_id = null when room is unassigned at completion', async () => {
    await timedMeasureRoom('room-2', () => null, async () => undefined);

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]!.context).toEqual({
      room_id: 'room-2',
      relay_miner_id: null,
    });
  });

  it('captures relay_miner_id at completion time, not entry time (late RoomAssigned)', async () => {
    let assigned: string | null = null;
    const body = vi.fn().mockImplementation(async () => {
      assigned = 'relay-late';
    });

    await timedMeasureRoom('room-3', () => assigned, body);

    expect(harness.writeCalls[0]!.context).toEqual({
      room_id: 'room-3',
      relay_miner_id: 'relay-late',
    });
  });

  it('no-ops when BENCH_LATENCY is unset (body still runs, no write)', async () => {
    harness.setBenchEnabled(false);
    closeValidatorProbe();

    const body = vi.fn().mockResolvedValue('ok');
    const result = await timedMeasureRoom('room-1', () => 'relay-A', body);

    expect(result).toBe('ok');
    expect(body).toHaveBeenCalledOnce();
    expect(harness.writeCalls).toHaveLength(0);
  });

  it('closeValidatorProbe is idempotent', () => {
    closeValidatorProbe();
    closeValidatorProbe();
    expect(true).toBe(true);
  });
});
