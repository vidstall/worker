/**
 * REQ-CFA-019 (M2 chunk 2) — live multi-validator discovery, hermetic tests.
 *
 * discoverActiveValidatorMinerIds does a READ-ONLY devInspect of
 * validator_registry::get_active_validators (the SAME getter cp-daemon's
 * SuiChainStateReader uses), decoding the returned vector<ValidatorInfo> with a VERBATIM
 * copy of ValidatorInfoSchema (7-field positional BCS, miner_id = Move `ID` decoded as
 * bcs.Address — both are 32 raw bytes). It projects info_miner_id ONLY (no session wallet,
 * INV-C). On any devInspect error/missing-result it returns [] so the cell-loop union
 * falls back to self-only (crash-safe).
 *
 * THIS TEST IS HERMETIC: it mocks the SuiClient — NO localnet, NO real RPC, NO ports. The
 * BCS round-trip (encode a fixture vector<ValidatorInfo> -> bytes -> decode -> miner_ids)
 * is what PROVES the verbatim schema decodes the deployed getter's output (W-M2-4: the
 * ID-vs-Address 32-byte coupling is checked, not assumed).
 */

import { describe, it, expect } from 'vitest';
import { bcs } from '@mysten/sui/bcs';
import type { SuiClient } from '@mysten/sui/client';
import { createLogger, type NetworkConfig } from '@dvconf/shared';
import { discoverActiveValidatorMinerIds } from '../validator-discovery.js';

const log = createLogger('test/validator-discovery');

/**
 * VERBATIM copy of validator_registry::ValidatorInfo (sources/registry/validator_registry.move:27-35),
 * 7-field positional BCS — mirrors cp-daemon/sui-chain-state-reader.ts:56-64. Used ONLY by
 * the test to ENCODE the fixture bytes the production decoder must round-trip.
 */
const ValidatorInfoSchema = bcs.struct('ValidatorInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  session_count: bcs.u64(),
});

/** A canonical 0x-prefixed 32-byte (66-char) id. */
const id = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

/** Build a fixture ValidatorInfo with a given miner_id (other fields arbitrary). */
const validatorInfo = (minerId: string): Record<string, unknown> => ({
  operator: id(0xaa),
  miner_id: minerId,
  stake_amount: '1000',
  reputation: '50',
  registered_at: '10',
  last_heartbeat: '20',
  session_count: '3',
});

/** Encode a vector<ValidatorInfo> to the raw byte array a devInspect returnValue carries. */
const encodeVector = (infos: Array<Record<string, unknown>>): number[] =>
  Array.from(bcs.vector(ValidatorInfoSchema).serialize(infos as never).toBytes());

/**
 * A minimal SuiClient mock returning a single devInspect result whose first return value
 * is `bytes` — mirroring the SDK's `results[0].returnValues[0][0]` shape.
 */
const mockClient = (result: { error?: string | null; bytes?: number[] }): SuiClient =>
  ({
    devInspectTransactionBlock: async () => ({
      error: result.error ?? null,
      results:
        result.bytes === undefined
          ? null
          : [{ returnValues: [[result.bytes, 'vector<...>::ValidatorInfo']] }],
    }),
  }) as unknown as SuiClient;

/** A throwing client — devInspect rejects (RPC down). */
const throwingClient = (): SuiClient =>
  ({
    devInspectTransactionBlock: async () => {
      throw new Error('RPC unreachable');
    },
  }) as unknown as SuiClient;

const config = {
  packageId: id(0x99),
  validatorRegistryId: id(0x77),
} as unknown as NetworkConfig;

describe('REQ-CFA-019 discoverActiveValidatorMinerIds — read-only validator discovery', () => {
  it('(a) BCS round-trips get_active_validators bytes -> normalized miner_ids (info_miner_id only)', async () => {
    const minerA = id(0x1234);
    const minerB = id(0xbeef);
    const client = mockClient({ bytes: encodeVector([validatorInfo(minerA), validatorInfo(minerB)]) });

    const ids = await discoverActiveValidatorMinerIds(client, config, log);

    expect(ids).toHaveLength(2);
    // Each is a canonical 32-byte (66-char) id — proves the ID-vs-Address coupling decodes.
    for (const v of ids) {
      expect(v).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(ids).toContain(minerA);
    expect(ids).toContain(minerB);
  });

  it('(a) a single-element registry decodes to exactly that one miner_id', async () => {
    const only = id(0x5);
    const client = mockClient({ bytes: encodeVector([validatorInfo(only)]) });
    const ids = await discoverActiveValidatorMinerIds(client, config, log);
    expect(ids).toEqual([only]);
  });

  it('(b) an EMPTY registry (empty vector) decodes to [] (self-only fallback in the loop)', async () => {
    const client = mockClient({ bytes: encodeVector([]) });
    const ids = await discoverActiveValidatorMinerIds(client, config, log);
    expect(ids).toEqual([]);
  });

  it('(b) a devInspect ERROR result -> [] (crash-safe, no throw)', async () => {
    const client = mockClient({ error: 'MoveAbort(...)' });
    const ids = await discoverActiveValidatorMinerIds(client, config, log);
    expect(ids).toEqual([]);
  });

  it('(b) a missing-results devInspect -> [] (crash-safe, no throw)', async () => {
    const client = mockClient({ bytes: undefined });
    const ids = await discoverActiveValidatorMinerIds(client, config, log);
    expect(ids).toEqual([]);
  });

  it('(b) a THROWING devInspect (RPC down) -> [] (crash-safe, never rejects)', async () => {
    const ids = await discoverActiveValidatorMinerIds(throwingClient(), config, log);
    expect(ids).toEqual([]);
  });

  it('(c) the projection carries ONLY miner_ids — no operator/session-wallet leak (INV-C)', async () => {
    const minerA = id(0x1234);
    const client = mockClient({ bytes: encodeVector([validatorInfo(minerA)]) });
    const ids = await discoverActiveValidatorMinerIds(client, config, log);
    // Result is a flat string[] of miner_ids — the operator address (0xaa..) must not appear.
    expect(ids).toEqual([minerA]);
    expect(JSON.stringify(ids)).not.toContain(id(0xaa).slice(2));
  });
});
