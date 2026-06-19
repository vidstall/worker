/**
 * REQ-CFA-019 / D-CFA-14 (M2 chunk 2) — live multi-validator discovery (validator-daemon).
 *
 * Reads the EXISTING on-chain validator set via a READ-ONLY `devInspect` of
 * `validator_registry::get_active_validators` — the SAME getter cp-daemon's
 * {@link SuiChainStateReader} uses for node discovery. NO Move change, NO TX signed/
 * submitted, NO gas. The decoded `miner_id`s (Wallet-A identities) widen the canary
 * cell-loop validator pool so a relay's cell can reach the >=2-distinct coverage floor
 * LIVE (not only in the localnet E2E) — closing M1 gate partial P6.
 *
 * DECOUPLED-READER CONVENTION: this module COPIES the 7-field positional `ValidatorInfo`
 * BCS schema (VERBATIM from sui-chain-state-reader.ts:56-64) rather than importing
 * cp-daemon internals — the same convention the cp-daemon reader follows. BCS struct field
 * order is LOAD-BEARING (positional); a wrong order silently mis-decodes, so the order
 * mirrors `validator_registry.move:27-35` EXACTLY and the hermetic round-trip test
 * (REQ-CFA-019) proves it (W-M2-4: the `miner_id` Move `ID` vs `bcs.Address` 32-byte
 * coupling is PROVEN, not assumed).
 *
 * CRASH-SAFE (INV / M1 mechanism-floor): ANY failure (devInspect error, missing result,
 * RPC reject, decode error) resolves to `[]` (warn-logged) so the cell loop falls back to
 * self-only — discovery can NEVER crash the daemon or the cell loop.
 *
 * INV-C: projects `info_miner_id` ONLY. The getter returns `ValidatorInfo` WITHOUT the
 * session wallet (the `session_wallets` Table is separate and untouched), so discovery
 * learns Wallet-A identities only — never a Wallet-B / session address.
 *
 * LOGGING (HARD-GATE): structured `createLogger` only — no console.*, no key material
 * (this module handles only public miner_ids).
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { createLogger, type NetworkConfig, type Logger } from '@dvconf/shared';

const MOD = 'canary/validator-discovery';

/** Sender used for read-only devInspect calls (no gas, no signature). */
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * VERBATIM copy of `validator_registry::ValidatorInfo`
 * (sources/registry/validator_registry.move:27-35), 7-field positional BCS — identical to
 * cp-daemon/sui-chain-state-reader.ts:56-64. `miner_id` is Move type `ID`, decoded as
 * `bcs.Address` (both serialize as 32 raw bytes). Field ORDER is load-bearing.
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

/** Minimal shape of a devInspect result we read (avoids importing the SDK type). */
interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

/**
 * Discover the active validator set's `miner_id`s via a read-only devInspect of
 * `validator_registry::get_active_validators`. Returns a flat `string[]` of normalized
 * (canonical 0x-prefixed 32-byte) miner_ids — the `info_miner_id` projection ONLY.
 *
 * CRASH-SAFE: returns `[]` on ANY failure (the caller UNIONs with the self-entry, so an
 * empty result degrades coverage to self-only rather than crashing).
 */
export async function discoverActiveValidatorMinerIds(
  client: SuiClient,
  config: NetworkConfig,
  logger?: Logger,
): Promise<string[]> {
  const log = logger ?? createLogger(MOD);
  const target = `${config.packageId}::validator_registry::get_active_validators`;
  try {
    // Mirror SuiChainStateReader.devInspectBytes: single moveCall, sender ZERO.
    const tx = new Transaction();
    tx.moveCall({ target, arguments: [tx.object(config.validatorRegistryId)] });
    const r = (await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;

    if (r.error) {
      log.warn({ target, err: r.error }, 'validator discovery devInspect error — falling back to self-only');
      return [];
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) {
      log.warn({ target }, 'validator discovery devInspect returned no values — falling back to self-only');
      return [];
    }

    const infos = bcs.vector(ValidatorInfoSchema).parse(Uint8Array.from(bytes));
    // INV-C: project the miner_id ONLY — never the operator/session wallet.
    const minerIds = infos.map((i) => i.miner_id);
    log.debug({ count: minerIds.length }, 'validator discovery resolved active validators');
    return minerIds;
  } catch (err) {
    // Defense-in-depth: an RPC reject / decode error must never escape (self-only fallback).
    log.warn({ target, err }, 'validator discovery failed — falling back to self-only');
    return [];
  }
}
