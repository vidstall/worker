/**
 * Unit tests for SuiChainStateReader — F47 Phase 4.0 (REQ-RV-013).
 *
 * Pure unit, NO localnet. A mocked SuiClient returns BCS-encoded fixtures that
 * are produced with the SAME `bcs` schemas the reader decodes with, so the test
 * proves the per-registry struct layouts (the #1 correctness risk) round-trip
 * byte-for-byte. Each method's Move `target` + object args are asserted by
 * capturing the built Transaction's serialized commands.
 *
 * Live localnet behaviour is exercised separately by the 4.0 smoke integration
 * test (run by the orchestrator, NOT under `pnpm test`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bcs } from '@mysten/sui/bcs';
import { MinerRole, type NetworkConfig, type Logger } from '@dvconf/shared';
import { SuiChainStateReader } from '../sui-chain-state-reader.js';

// ── BCS schemas mirroring the deployed Move structs (must match the reader) ──
// Field order is load-bearing — BCS is positional, so a wrong order silently
// mis-decodes. These intentionally duplicate the reader's private schemas so a
// drift between the two surfaces as a test failure.
const RelayNodeInfoSchema = bcs.struct('RelayNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  region: bcs.vector(bcs.u8()),
  endpoint_url: bcs.vector(bcs.u8()),
});

const CPNodeInfoSchema = bcs.struct('CPNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  registered_at: bcs.u64(),
  reputation: bcs.u64(),
});

const ADDR_A = '0x' + 'a1'.repeat(32);
const ADDR_B = '0x' + 'b2'.repeat(32);
const ADDR_OP = '0x' + 'cc'.repeat(32);
const ZERO_ID = '0x' + '00'.repeat(32);

/** Wrap raw BCS bytes in the devInspect result envelope the reader reads. */
function devInspectResult(bytes: Uint8Array): unknown {
  return { results: [{ returnValues: [[Array.from(bytes), 'typeTag']] }] };
}

// Object ids must be full 32-byte hex — `tx.getData()` validates them when we
// snapshot the built Transaction to read its moveCall targets.
const PKG = '0x' + '01'.repeat(32);
const ID = (n: string): string => '0x' + n.padStart(64, '0');

function makeConfig(): NetworkConfig {
  return {
    rpcUrl: 'http://127.0.0.1:9000',
    packageId: PKG,
    networkRegistryId: ID('11'),
    minerStoreId: ID('05'),
    cpRegistryId: ID('0c'),
    relayRegistryId: ID('0e'),
    validatorRegistryId: ID('0a'),
    userRegistryId: ID('06'),
    roomManagerId: ID('07'),
    signalingRegistryId: ID('5a'),
    roleVoteBoxId: ID('b0'),
    livenessVoteBoxId: ID('b1'),
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

/**
 * Extract the moveCall target strings from a built Transaction by serializing
 * it to its JSON IR. The reader builds a Transaction per devInspect call; the
 * mock captures it so we can assert the target without a live chain.
 */
function targetsOf(tx: { getData: () => { commands: unknown[] } }): string[] {
  const data = tx.getData();
  const targets: string[] = [];
  for (const cmd of data.commands) {
    const mv = (cmd as { MoveCall?: { package: string; module: string; function: string } }).MoveCall;
    if (mv) targets.push(`${mv.package}::${mv.module}::${mv.function}`);
  }
  return targets;
}

describe('SuiChainStateReader', () => {
  let config: NetworkConfig;
  let logger: Logger;

  beforeEach(() => {
    config = makeConfig();
    logger = makeLogger();
  });

  it('getCurrentEpoch reads getLatestSuiSystemState().epoch', async () => {
    const client = {
      getLatestSuiSystemState: vi.fn().mockResolvedValue({ epoch: '123' }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getCurrentEpoch()).toBe(123n);
  });

  it('getMaxIdleEpochs devInspects role_voting::max_idle_epochs → u64 bigint', async () => {
    let capturedTargets: string[] = [];
    const client = {
      devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
        capturedTargets = targetsOf(transactionBlock as never);
        return Promise.resolve(devInspectResult(bcs.u64().serialize('30').toBytes()));
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getMaxIdleEpochs()).toBe(30n);
    expect(capturedTargets).toContain(`${PKG}::role_voting::max_idle_epochs`);
  });

  it('getRevoteCooldownEpochs devInspects role_voting::revote_cooldown_epochs → u64 bigint', async () => {
    let capturedTargets: string[] = [];
    const client = {
      devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
        capturedTargets = targetsOf(transactionBlock as never);
        return Promise.resolve(devInspectResult(bcs.u64().serialize('14').toBytes()));
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getRevoteCooldownEpochs()).toBe(14n);
    expect(capturedTargets).toContain(`${PKG}::role_voting::revote_cooldown_epochs`);
  });

  it('getRoleCounts maps the 4 active_count u64s to {relay,validator,cp,signaling}', async () => {
    const byTarget: Record<string, string> = {
      [`${PKG}::relay_registry::active_count`]: '5',
      [`${PKG}::validator_registry::active_count`]: '3',
      [`${PKG}::control_plane_registry::active_cp_count`]: '2',
      [`${PKG}::signaling_registry::active_signaling_count`]: '7',
    };
    const client = {
      devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
        const [target] = targetsOf(transactionBlock as never);
        const value = byTarget[target!];
        if (value === undefined) throw new Error(`unexpected target ${target}`);
        return Promise.resolve(devInspectResult(bcs.u64().serialize(value).toBytes()));
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getRoleCounts()).toEqual({ relay: 5n, validator: 3n, cp: 2n, signaling: 7n });
  });

  it('getActiveMiners decodes a 2-entry vector<RelayNodeInfo> → 2 MinerHeartbeat (role=Relay)', async () => {
    const relays = [
      { operator: ADDR_OP, miner_id: ADDR_A, stake_amount: '1000', reputation: '10', registered_at: '1', last_heartbeat: '42', region: [1], endpoint_url: [2] },
      { operator: ADDR_OP, miner_id: ADDR_B, stake_amount: '2000', reputation: '20', registered_at: '2', last_heartbeat: '99', region: [3], endpoint_url: [4] },
    ];
    const relayBytes = bcs.vector(RelayNodeInfoSchema).serialize(relays).toBytes();
    const empty = bcs.vector(RelayNodeInfoSchema).serialize([]).toBytes();
    const client = {
      devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
        const [target] = targetsOf(transactionBlock as never);
        // relay registry returns 2 entries; all other registries empty.
        if (target === `${PKG}::relay_registry::get_active_relays`) {
          return Promise.resolve(devInspectResult(relayBytes));
        }
        return Promise.resolve(devInspectResult(empty));
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    const miners = await reader.getActiveMiners();
    const relayMiners = miners.filter((m) => m.role === MinerRole.Relay);
    expect(relayMiners).toHaveLength(2);
    expect(relayMiners[0]!.minerId).toBe(ADDR_A);
    expect(relayMiners[0]!.role).toBe(MinerRole.Relay);
    expect(relayMiners[0]!.lastHeartbeat).toBe(42n);
    expect(relayMiners[1]!.minerId).toBe(ADDR_B);
    expect(relayMiners[1]!.lastHeartbeat).toBe(99n);
  });

  it('getActiveMiners decodes the CP layout (different field order) → role=CP', async () => {
    const cps = [
      { operator: ADDR_OP, miner_id: ADDR_A, stake_amount: '5000', last_heartbeat: '7', is_active: true, registered_at: '1', reputation: '3' },
    ];
    const cpBytes = bcs.vector(CPNodeInfoSchema).serialize(cps).toBytes();
    const emptyRelay = bcs.vector(RelayNodeInfoSchema).serialize([]).toBytes();
    const client = {
      devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
        const [target] = targetsOf(transactionBlock as never);
        if (target === `${PKG}::control_plane_registry::get_active_cps`) {
          return Promise.resolve(devInspectResult(cpBytes));
        }
        return Promise.resolve(devInspectResult(emptyRelay));
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    const miners = await reader.getActiveMiners();
    const cpMiners = miners.filter((m) => m.role === MinerRole.CP);
    expect(cpMiners).toHaveLength(1);
    expect(cpMiners[0]!.minerId).toBe(ADDR_A);
    expect(cpMiners[0]!.role).toBe(MinerRole.CP);
    expect(cpMiners[0]!.lastHeartbeat).toBe(7n);
  });

  it('getActiveMiners issues one get_active_* call per registry', async () => {
    const seen: string[] = [];
    const empty = bcs.vector(RelayNodeInfoSchema).serialize([]).toBytes();
    const client = {
      devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
        seen.push(...targetsOf(transactionBlock as never));
        return Promise.resolve(devInspectResult(empty));
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    await reader.getActiveMiners();
    expect(seen).toContain(`${PKG}::relay_registry::get_active_relays`);
    expect(seen).toContain(`${PKG}::validator_registry::get_active_validators`);
    expect(seen).toContain(`${PKG}::control_plane_registry::get_active_cps`);
    expect(seen).toContain(`${PKG}::signaling_registry::get_active_nodes`);
  });

  it('getRevoteEligibleSince returns null when the dynamic field is not found (error)', async () => {
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { revote_eligible_since: { fields: { id: { id: '0xtable' } } } } } },
      }),
      getDynamicFieldObject: vi.fn().mockResolvedValue({ error: { code: 'dynamicFieldNotFound' }, data: null }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getRevoteEligibleSince(ADDR_A)).toBeNull();
  });

  it('getRevoteEligibleSince returns null when data is null', async () => {
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { revote_eligible_since: { fields: { id: { id: '0xtable' } } } } } },
      }),
      getDynamicFieldObject: vi.fn().mockResolvedValue({ data: null }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getRevoteEligibleSince(ADDR_A)).toBeNull();
  });

  it('getRevoteEligibleSince returns the u64 when the dynamic field is present', async () => {
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { revote_eligible_since: { fields: { id: { id: '0xtable' } } } } } },
      }),
      getDynamicFieldObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { value: '88' } } },
      }),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getRevoteEligibleSince(ADDR_A)).toBe(88n);
  });

  it('getRevoteEligibleSince returns null when the box content shape is unexpected', async () => {
    const client = {
      getObject: vi.fn().mockResolvedValue({ data: { content: { fields: {} } } }),
      getDynamicFieldObject: vi.fn(),
    } as never;
    const reader = new SuiChainStateReader(client, config, logger);
    expect(await reader.getRevoteEligibleSince(ZERO_ID)).toBeNull();
  });

  // ── Leg 1 (multi-cp-quorum): discovery reads ──────────────────────────────
  // Additive, read-only projections used by the G2 quorum assembler + the G5
  // off-chain threshold. NO schema change; NO Move change.

  describe('getActiveCpOperators (G2 operator-address discovery)', () => {
    it('surfaces {minerId, operator} via a BCS round-trip of get_active_cps', async () => {
      // Two CPs with DISTINCT operator addresses — the column toHeartbeat drops.
      const cps = [
        { operator: ADDR_A, miner_id: ADDR_OP, stake_amount: '5000', last_heartbeat: '7', is_active: true, registered_at: '1', reputation: '3' },
        { operator: ADDR_B, miner_id: ADDR_A, stake_amount: '6000', last_heartbeat: '9', is_active: true, registered_at: '2', reputation: '4' },
      ];
      const cpBytes = bcs.vector(CPNodeInfoSchema).serialize(cps).toBytes();
      let capturedTargets: string[] = [];
      const client = {
        devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
          capturedTargets = targetsOf(transactionBlock as never);
          return Promise.resolve(devInspectResult(cpBytes));
        }),
      } as never;
      const reader = new SuiChainStateReader(client, config, logger);
      const ops = await reader.getActiveCpOperators();
      // operator ADDRESS is surfaced (NOT discarded like toHeartbeat does).
      expect(ops).toEqual([
        { minerId: ADDR_OP, operator: ADDR_A },
        { minerId: ADDR_A, operator: ADDR_B },
      ]);
      // Reuses the EXISTING get_active_cps getter against the CP registry.
      expect(capturedTargets).toContain(`${PKG}::control_plane_registry::get_active_cps`);
    });

    it('returns [] for an empty CP registry', async () => {
      const empty = bcs.vector(CPNodeInfoSchema).serialize([]).toBytes();
      const client = {
        devInspectTransactionBlock: vi.fn().mockResolvedValue(devInspectResult(empty)),
      } as never;
      const reader = new SuiChainStateReader(client, config, logger);
      expect(await reader.getActiveCpOperators()).toEqual([]);
    });
  });

  describe('readMinQuorum (G5 on-chain threshold, per-round, fail-closed)', () => {
    const QSTATE = ID('99');

    it('devInspects cp_quorum_sig::min_quorum against the QuorumConfigState id → u64 bigint', async () => {
      let capturedTargets: string[] = [];
      const client = {
        devInspectTransactionBlock: vi.fn().mockImplementation(({ transactionBlock }) => {
          capturedTargets = targetsOf(transactionBlock as never);
          return Promise.resolve(devInspectResult(bcs.u64().serialize('3').toBytes()));
        }),
      } as never;
      const reader = new SuiChainStateReader(client, config, logger);
      expect(await reader.readMinQuorum(QSTATE)).toBe(3n);
      expect(capturedTargets).toContain(`${PKG}::cp_quorum_sig::min_quorum`);
    });

    it('reads PER-ROUND (no cache) — a mutated threshold is observed on the next call', async () => {
      const values = ['2', '4'];
      let i = 0;
      const devInspect = vi.fn().mockImplementation(() =>
        Promise.resolve(devInspectResult(bcs.u64().serialize(values[i++]!).toBytes())),
      );
      const client = { devInspectTransactionBlock: devInspect } as never;
      const reader = new SuiChainStateReader(client, config, logger);
      expect(await reader.readMinQuorum(QSTATE)).toBe(2n);
      expect(await reader.readMinQuorum(QSTATE)).toBe(4n); // update_threshold observed
      expect(devInspect).toHaveBeenCalledTimes(2);
    });

    it('FAIL-CLOSED: throws (no devInspect) when the QuorumConfigState id is empty', async () => {
      const devInspect = vi.fn();
      const client = { devInspectTransactionBlock: devInspect } as never;
      const reader = new SuiChainStateReader(client, config, logger);
      await expect(reader.readMinQuorum('')).rejects.toThrow(/QUORUM_STATE_OBJECT_ID|quorum.*state.*id|unset/i);
      expect(devInspect).not.toHaveBeenCalled();
    });
  });
});
