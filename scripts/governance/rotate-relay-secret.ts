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
import type { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  loadKeypair,
  executeWithRetry,
  type NetworkConfig,
  // relative SOURCE import (NOT bare '@dvconf/shared'): scripts/ is outside the pnpm
  // workspace graph -> bare name unresolvable from root under tsx. See seed-bootstrap.ts:61.
} from '../../packages/shared/src/index.ts';

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

/** Parse `<flag> <value>` from an argv slice. Returns null when absent/empty. */
function parseFlag(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) return next;
    }
  }
  return null;
}

/** Like {@link parseFlag} but throws when the flag is missing. */
function required(argv: string[], flag: string): string {
  const v = parseFlag(argv, flag);
  if (v === null) throw new Error(`rotate-relay-secret: missing required flag ${flag}`);
  return v;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const logger = createLogger(MODULE);
  const config = loadNetworkConfig();
  // createSuiClient takes the network/url, NOT the whole config (sibling idiom:
  // request-revote.ts / revoke-cap-token.ts both pass config.rpcUrl).
  const client = createSuiClient(config.rpcUrl);
  // Sibling idiom: SUI_PRIVATE_KEY is loaded via the shared loadKeypair helper, NOT
  // Ed25519Keypair.fromSecretKey directly. Here it MUST be the AdminCap owner key.
  const signer = loadKeypair('SUI_PRIVATE_KEY');

  const args: RotateRelaySecretArgs = {
    adminCapId: required(argv, '--admin-cap'),
    cpMinerId: required(argv, '--cp-miner-id'),
    oldSecretId: BigInt(required(argv, '--old-secret-id')),
    newSecretId: BigInt(required(argv, '--new-secret-id')),
    reason: Number(parseFlag(argv, '--reason') ?? '2'),
  };

  // executeWithRetry returns TxResult | null (null = retries exhausted). Its events
  // are an untyped Record<string, unknown>[] (showEvents:true is set inside it).
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => buildRotateRelaySecretTx(tx, config, args),
    'emergency-rotate-relay-secret',
    logger,
  );
  if (result === null) {
    throw new Error('rotate-relay-secret: tx submission failed (retries exhausted)');
  }

  const rotated = result.events.some(
    (e: Record<string, unknown>) =>
      typeof e['type'] === 'string' && (e['type'] as string).endsWith('::turn_credential::SecretRotated'),
  );
  logger.info(
    { module: MODULE, digest: result.digest, secret_rotated_event: rotated, cp_miner_id: args.cpMinerId },
    'emergency_rotate_relay_secret submitted',
  );
  if (!rotated) throw new Error('rotate-relay-secret: SecretRotated event NOT found in tx effects');
  process.stdout.write(`SecretRotated digest=${result.digest}\n`);
}

// Only run when executed directly (`tsx rotate-relay-secret.ts …`); stays inert on
// import so the unit test can exercise the builder without firing the CLI. Matches
// the sibling pathToFileURL guard (NOT the raw `file://${process.argv[1]}` template).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`rotate-relay-secret: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
