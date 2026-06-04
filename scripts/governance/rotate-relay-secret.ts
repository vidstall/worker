/**
 * F8 — emergency relay TURN-secret rotation CLI (AdminCap, no quorum).
 *
 * Lets the AdminCap holder rotate a CP/relay miner's TURN secret id on-chain by
 * submitting the `turn_credential::emergency_rotate_relay_secret` entry. This is the
 * D12 KILL-SWITCH for a leaked/compromised TURN secret (orthogonal to D-009 cap-token
 * revoke — it rotates the TURN secret, NOT a RoomCapability). A single AdminCap-gated
 * moveCall; no QuorumSig, no peer-CP collection.
 *
 * Guards (client-side mirror of the Move asserts, fail-fast before submit):
 *   E_INVALID_ROTATION_REASON=803 — reason must be 0|1|2 (turn_credential.move).
 *   E_SAME_SECRET_ID=804         — old_secret_id != new_secret_id.
 * (E_PAUSED=800 is a chain-state guard, not client-checkable — surfaces as an abort.)
 *
 * On success the entry emits `SecretRotated{cp_miner_id, old_secret_id, new_secret_id,
 * reason, rotated_at_epoch}`; main() asserts that event landed in the TX effects.
 *
 * Run (single-CP demo):
 *   pnpm --dir dvconf-daemons exec tsx scripts/governance/rotate-relay-secret.ts \
 *     --admin-cap <objectId> --cp-miner-id <objectId> \
 *     --old-secret-id <u64> --new-secret-id <u64> [--reason 0|1|2]
 * Env (same as the daemons): PACKAGE_ID, NETWORK_REGISTRY_ID, …, RPC_URL,
 *   SUI_PRIVATE_KEY (the AdminCap owner key).
 */

import { pathToFileURL } from 'node:url';
import { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  loadKeypair,
  executeWithRetry,
  type NetworkConfig,
} from '@dvconf/shared';

const MODULE = 'rotate-relay-secret';

export interface RotateRelaySecretArgs {
  adminCapId: string;
  cpMinerId: string;
  oldSecretId: bigint;
  newSecretId: bigint;
  reason: number; // 0=leakage, 1=compromise, 2=admin
}

/** Client-side mirror of the Move guards (803 reason-bound, 804 same-secret). Fails fast before submit. */
export function assertValidRotation(args: RotateRelaySecretArgs): void {
  if (!Number.isInteger(args.reason) || args.reason < 0 || args.reason > 2) {
    throw new Error(`rotate-relay-secret: invalid reason ${args.reason} (expected 0|1|2)`);
  }
  if (args.oldSecretId === args.newSecretId) {
    throw new Error(`rotate-relay-secret: old and new secret ids are the same (${args.oldSecretId})`);
  }
}

/** Builds the single AdminCap-gated moveCall. Pure — no I/O. */
export function buildRotateRelaySecretTx(
  tx: Transaction,
  config: Pick<NetworkConfig, 'packageId' | 'networkRegistryId'>,
  args: RotateRelaySecretArgs,
): void {
  assertValidRotation(args);
  tx.moveCall({
    target: `${config.packageId}::turn_credential::emergency_rotate_relay_secret`,
    arguments: [
      tx.object(args.adminCapId), // _admin: &AdminCap
      tx.object(config.networkRegistryId), // net: &NetworkRegistry
      tx.pure.id(args.cpMinerId), // cp_miner_id: ID
      tx.pure.u64(args.oldSecretId), // old_secret_id: u64
      tx.pure.u64(args.newSecretId), // new_secret_id: u64
      tx.pure.u8(args.reason), // reason: u8
    ],
  });
}
