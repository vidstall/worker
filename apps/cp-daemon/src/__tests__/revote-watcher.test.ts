import { describe, it, expect, vi, beforeEach } from 'vitest';

// executeWithRetry is mocked so makeMarkSubmitter can be exercised without a chain.
// MinerRole + types stay real via importOriginal (watcher decision-logic tests rely on them).
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, executeWithRetry: mockExecuteWithRetry };
});

import { MinerRole, type NetworkConfig } from '@dvconf/shared';
import {
  RevoteWatcher,
  MarkReason,
  computeSurplusRoles,
  makeMarkSubmitter,
  resolveScanIntervalEpochs,
  type ChainStateReader,
  type MinerHeartbeat,
  type RoleCounts,
} from '../revote-watcher.js';

function mockConfig(): NetworkConfig {
  return {
    rpcUrl: 'http://localhost:9000',
    packageId: '0xpkg',
    networkRegistryId: '0xreg',
    minerStoreId: '0xstore',
    cpRegistryId: '0xcp',
    relayRegistryId: '0xrelay',
    validatorRegistryId: '0xval',
    userRegistryId: '0xuser',
    roomManagerId: '0xroom',
    signalingRegistryId: '0xsig',
    roleVoteBoxId: '0xvotebox',
    livenessVoteBoxId: '0xlivenessbox',
  };
}

/** Pino-shaped logger stub (matches the daemon-wide convention). */
function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

/**
 * In-memory ChainStateReader — the seam that lets the watcher's decision logic
 * run fully offline (no SuiClient / devInspect). The live SuiChainStateReader is
 * wired against localnet in Phase 4.1 (RV-013).
 */
class FakeChainStateReader implements ChainStateReader {
  constructor(
    public state: {
      epoch: bigint;
      maxIdle: bigint;
      cooldown: bigint;
      miners: MinerHeartbeat[];
      counts: RoleCounts;
      eligibleSince?: Record<string, bigint>;
    },
  ) {}
  async getCurrentEpoch(): Promise<bigint> { return this.state.epoch; }
  async getMaxIdleEpochs(): Promise<bigint> { return this.state.maxIdle; }
  async getRevoteCooldownEpochs(): Promise<bigint> { return this.state.cooldown; }
  async getActiveMiners(): Promise<MinerHeartbeat[]> { return this.state.miners; }
  async getRoleCounts(): Promise<RoleCounts> { return this.state.counts; }
  async getRevoteEligibleSince(minerId: string): Promise<bigint | null> {
    return this.state.eligibleSince?.[minerId] ?? null;
  }
}

const balancedCounts: RoleCounts = { relay: 5n, validator: 5n, cp: 5n, signaling: 5n };

function reader(over: Partial<FakeChainStateReader['state']> = {}): FakeChainStateReader {
  return new FakeChainStateReader({
    epoch: 100n,
    maxIdle: 30n,
    cooldown: 14n,
    miners: [],
    counts: balancedCounts,
    ...over,
  });
}

// ── scanIdleMiners (done-criterion #1) ────────────────────────────────────────
describe('RevoteWatcher.scanIdleMiners', () => {
  it('returns miners whose idle gap STRICTLY exceeds max_idle (on-chain N2: gap 31 first-eligible at 30)', async () => {
    const r = reader({
      miners: [
        { minerId: '0xidle', role: MinerRole.Relay, lastHeartbeat: 68n },  // gap 32 > 30 → idle
        { minerId: '0xfresh', role: MinerRole.Relay, lastHeartbeat: 95n }, // gap 5 → not idle
        { minerId: '0xedge', role: MinerRole.Relay, lastHeartbeat: 70n },  // gap 30 == max → NOT (strict >)
      ],
    });
    const idle = await new RevoteWatcher(r, vi.fn(), mockLogger()).scanIdleMiners();
    expect(idle).toEqual(['0xidle']);
  });

  it('is underflow-safe when lastHeartbeat is in the future', async () => {
    const r = reader({ miners: [{ minerId: '0xfuture', role: MinerRole.Relay, lastHeartbeat: 200n }] });
    expect(await new RevoteWatcher(r, vi.fn(), mockLogger()).scanIdleMiners()).toEqual([]);
  });
});

// ── scanCompositionShift (done-criterion #2) ──────────────────────────────────
describe('RevoteWatcher.scanCompositionShift', () => {
  it('returns miners of a surplus role (raw pre-clamp ratio < floor) — mirrors on-chain raw math', async () => {
    // relay surplus: 50 relays vs 2 each → raw_relay ratio 117bps < 500 floor
    const r = reader({
      counts: { relay: 50n, validator: 2n, cp: 2n, signaling: 2n },
      miners: [
        { minerId: '0xr1', role: MinerRole.Relay, lastHeartbeat: 99n },
        { minerId: '0xr2', role: MinerRole.Relay, lastHeartbeat: 99n },
        { minerId: '0xv1', role: MinerRole.Validator, lastHeartbeat: 99n },
      ],
    });
    const excess = await new RevoteWatcher(r, vi.fn(), mockLogger()).scanCompositionShift();
    expect([...excess].sort()).toEqual(['0xr1', '0xr2']);
  });

  it('returns empty when composition is balanced', async () => {
    const r = reader({ miners: [{ minerId: '0xr', role: MinerRole.Relay, lastHeartbeat: 99n }] });
    expect(await new RevoteWatcher(r, vi.fn(), mockLogger()).scanCompositionShift()).toEqual([]);
  });
});

// ── submitMarkTx cooldown-aware skip (done-criterion #3) ───────────────────────
describe('RevoteWatcher.submitMarkTx', () => {
  it('skips a miner still inside the cooldown window (epoch < since + cooldown)', async () => {
    const submitter = vi.fn().mockResolvedValue(undefined);
    const r = reader({ eligibleSince: { '0xcool': 95n } }); // 100 < 95+14=109 → skip
    const result = await new RevoteWatcher(r, submitter, mockLogger()).submitMarkTx('0xcool', MarkReason.Idle);
    expect(result).toBe('skipped-cooldown');
    expect(submitter).not.toHaveBeenCalled();
  });

  it('submits a miner past the cooldown window (epoch >= since + cooldown)', async () => {
    const submitter = vi.fn().mockResolvedValue(undefined);
    const r = reader({ eligibleSince: { '0xold': 80n } }); // 100 >= 80+14=94 → submit
    const result = await new RevoteWatcher(r, submitter, mockLogger()).submitMarkTx('0xold', MarkReason.Idle);
    expect(result).toBe('submitted');
    expect(submitter).toHaveBeenCalledWith('0xold', MarkReason.Idle, expect.any(String));
  });

  it('submits a never-marked miner', async () => {
    const submitter = vi.fn().mockResolvedValue(undefined);
    const watcher = new RevoteWatcher(reader(), submitter, mockLogger());
    expect(await watcher.submitMarkTx('0xnew', MarkReason.CompositionShift)).toBe('submitted');
    expect(submitter).toHaveBeenCalledTimes(1);
  });

  it('honours the local eligibleSince mirror over a re-read (trackEligibleSince)', async () => {
    const submitter = vi.fn().mockResolvedValue(undefined);
    const watcher = new RevoteWatcher(reader(), submitter, mockLogger());
    watcher.trackEligibleSince('0xm', 95n); // mirror: 100 < 95+14 → cooldown
    expect(await watcher.submitMarkTx('0xm', MarkReason.Idle)).toBe('skipped-cooldown');
    expect(submitter).not.toHaveBeenCalled();
  });
});

// ── structured logging (done-criterion #4) ────────────────────────────────────
describe('RevoteWatcher structured logging', () => {
  it('scanIdleMiners emits {trace_id, module: revote-watcher, action: scan_idle} with a candidateCount context', async () => {
    const logger = mockLogger();
    const r = reader({ miners: [{ minerId: '0xidle', role: MinerRole.Relay, lastHeartbeat: 60n }] }); // gap 40 > 30
    await new RevoteWatcher(r, vi.fn(), logger).scanIdleMiners();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: expect.any(String),
        module: 'revote-watcher',
        action: 'scan_idle',
        context: expect.objectContaining({ candidateCount: 1 }),
      }),
      expect.any(String),
    );
  });

  it('scanCompositionShift emits action: scan_composition with a trace_id', async () => {
    const logger = mockLogger();
    await new RevoteWatcher(reader(), vi.fn(), logger).scanCompositionShift();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: expect.any(String), module: 'revote-watcher', action: 'scan_composition' }),
      expect.any(String),
    );
  });

  it('submitMarkTx emits action: mark_tx with a trace_id', async () => {
    const logger = mockLogger();
    await new RevoteWatcher(reader(), vi.fn().mockResolvedValue(undefined), logger).submitMarkTx('0xz', MarkReason.Idle);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: expect.any(String), module: 'revote-watcher', action: 'mark_tx' }),
      expect.any(String),
    );
  });
});

// ── computeSurplusRoles (exported helper, mirrors economic_layer raw math) ──────
describe('computeSurplusRoles', () => {
  it('flags the over-supplied role', () => {
    expect(computeSurplusRoles({ relay: 50n, validator: 2n, cp: 2n, signaling: 2n }, 500n)).toEqual(
      new Set([MinerRole.Relay]),
    );
  });
  it('empty network → no surplus (matches on-chain "balanced" branch)', () => {
    expect(computeSurplusRoles({ relay: 0n, validator: 0n, cp: 0n, signaling: 0n }, 500n)).toEqual(new Set());
  });
  it('never flags a zero-count role as surplus (exact Move parity, raw = total is maximal)', () => {
    // relay surplus (50); validator zero-count must NOT be flagged.
    expect(computeSurplusRoles({ relay: 50n, validator: 0n, cp: 2n, signaling: 2n }, 500n)).toEqual(
      new Set([MinerRole.Relay]),
    );
  });
});

// ── makeMarkSubmitter — locks the PTB shape against role_voting.move (signature fidelity) ──
describe('makeMarkSubmitter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds mark_revote_eligible_idle with the 8 Move args in exact order', async () => {
    let captured: any;
    mockExecuteWithRetry.mockImplementation(async (_c: unknown, _s: unknown, builder: (tx: any) => void) => {
      const calls: any[] = [];
      const tx = {
        object: (x: string) => ({ kind: 'object', x }),
        pure: { id: (x: string) => ({ kind: 'id', x }) },
        moveCall: (a: any) => calls.push(a),
      };
      builder(tx);
      captured = calls[0];
    });
    const submit = makeMarkSubmitter({} as any, {} as any, mockConfig(), mockLogger());
    await submit('0xminer', MarkReason.Idle, 'trace-1');

    expect(captured.target).toBe('0xpkg::role_voting::mark_revote_eligible_idle');
    expect(captured.arguments).toHaveLength(8);
    expect(captured.arguments[0]).toEqual({ kind: 'object', x: '0xreg' });      // net_reg
    expect(captured.arguments[1]).toEqual({ kind: 'object', x: '0xvotebox' });  // vote_box
    expect(captured.arguments[2]).toEqual({ kind: 'object', x: '0xstore' });    // miner_store
    expect(captured.arguments[3]).toEqual({ kind: 'object', x: '0xrelay' });    // relay_reg
    expect(captured.arguments[4]).toEqual({ kind: 'object', x: '0xval' });      // validator_reg
    expect(captured.arguments[5]).toEqual({ kind: 'object', x: '0xcp' });       // cp_reg
    expect(captured.arguments[6]).toEqual({ kind: 'object', x: '0xsig' });      // signaling_reg
    expect(captured.arguments[7]).toEqual({ kind: 'id', x: '0xminer' });        // miner_id: ID
  });

  it('targets mark_revote_eligible_composition_shift for CompositionShift', async () => {
    let target: string | undefined;
    mockExecuteWithRetry.mockImplementation(async (_c: unknown, _s: unknown, builder: (tx: any) => void) => {
      const tx = { object: (x: string) => x, pure: { id: (x: string) => x }, moveCall: (a: any) => { target = a.target; } };
      builder(tx);
    });
    const submit = makeMarkSubmitter({} as any, {} as any, mockConfig(), mockLogger());
    await submit('0xm', MarkReason.CompositionShift, 't');
    expect(target).toBe('0xpkg::role_voting::mark_revote_eligible_composition_shift');
  });

  it('throws for MinerRequest (operator-driven, not watcher-submittable) without submitting', async () => {
    const submit = makeMarkSubmitter({} as any, {} as any, mockConfig(), mockLogger());
    await expect(submit('0xm', MarkReason.MinerRequest, 't')).rejects.toThrow(/miner-request/);
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });
});

// ── resolveScanIntervalEpochs — REVOTE_SCAN_INTERVAL_EPOCHS wiring ─────────────
describe('resolveScanIntervalEpochs', () => {
  it('defaults to 5 when the env var is unset', () => {
    expect(resolveScanIntervalEpochs({})).toBe(5);
  });
  it('reads REVOTE_SCAN_INTERVAL_EPOCHS when set', () => {
    expect(resolveScanIntervalEpochs({ REVOTE_SCAN_INTERVAL_EPOCHS: '12' })).toBe(12);
  });
  it('falls back to default on invalid / non-positive / blank', () => {
    expect(resolveScanIntervalEpochs({ REVOTE_SCAN_INTERVAL_EPOCHS: 'abc' })).toBe(5);
    expect(resolveScanIntervalEpochs({ REVOTE_SCAN_INTERVAL_EPOCHS: '0' })).toBe(5);
    expect(resolveScanIntervalEpochs({ REVOTE_SCAN_INTERVAL_EPOCHS: '   ' })).toBe(5);
  });
});
