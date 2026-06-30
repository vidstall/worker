/**
 * Multi-CP Voting Live (N=5) — Phase C (GĐ2) Task C1: the N=1→N=5 seeding
 * orchestrator. A THIN wrapper over the generalised `seed-bootstrap.ts` helpers
 * (`bootstrapCp` + `voteAndApplyMiner`) — it adds zero new on-chain logic, only
 * the cascade ORDERING + a self-verifying on-chain probe + a multi-CP keys file.
 *
 * THE CASCADE (design spec §3): `staking::determine_role` (staking.move:55) auto-
 * mints only CP/User; every relay/validator/signaling role is created via a CP-
 * quorum vote, and with the Phase A fix `required = ceil(active_cp_count * 2/3)`.
 * So we MUST seed all infra WHILE only 1 CP exists (required=1, a single vote
 * finalizes), THEN register CP#2..#5 to reach active_cp_count=5 (required=4) for
 * the genuine multi-CP demo. Registering 5 CPs first would make every infra seed
 * need 4 votes.
 *
 *   1. bootstrap CP#1 (1.0 SUI → ControlPlaneCap → register_cp; active_cp_count=1).
 *   2. seed ALL infra via the generalised voteAndApplyMiner (each finalizes on
 *      CP#1's lone vote): 4 validators (pairing validator floor=4,
 *      pairing_score.move:93-101) + 2 relays + 1 signaling.
 *   3. scale CPs — bootstrap CP#2..#5 (4 more funded register_cp; no infra needed,
 *      they just lift active_cp_count to 5). 1.0 SUI clears the per-CP dynamic
 *      tiers 0.5..0.9 (constants.move:25-26: base 0.5 + 0.1 × existing-CP-count).
 *   4. write the keys file (one slot per CP + per infra node) C3's launcher reads.
 *   5. self-verify on-chain: HARD-ASSERT active_cp_count==5 AND 4 validators /
 *      2 relays / 1 signaling registered (throws loud on any mismatch).
 *
 * SCOPE: connects to an ALREADY-RUNNING localnet with the `multi-cp-live` package
 * already published (loadNetworkConfig reads PACKAGE_ID + *_REGISTRY_ID / … from
 * env exported by read-publish-output.sh). It does NOT boot `sui start` or publish.
 *
 * Run (from the worktree root, against a staged localnet on :9000):
 *   pnpm exec tsx scripts/demo/seed-multicp.ts
 *
 * Env:
 *   MULTICP_KEYS_PATH  default <worktree>/.run/multicp-keys.json (cwd-independent;
 *                      resolved from this file via import.meta.url).
 *   FAUCET_URL / SUI_NETWORK / the published *_OBJECT_ID set — same levers as
 *   seed-bootstrap.ts (faucet + RPC + object IDs).
 *
 * Fails LOUD: any failed TX or a verification mismatch throws; an uncaught throw
 * in main() exits non-zero.
 *
 * Structured logging only (shared pino Logger). No console.log.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  type NetworkConfig,
  type Logger,
} from '../../packages/shared/src/index.ts'; // relative SOURCE import (scripts/ sits OUTSIDE the pnpm workspace graph → the '@dvconf/shared' bare specifier is unresolvable from root; mirrors seed-bootstrap.ts:61).
import {
  bootstrapCp,
  voteAndApplyMiner,
  type CpHandle,
  type SeededKey,
} from './seed-bootstrap.ts';

const MODULE = 'seed-multicp';

/** Target substrate for the N=5 demo. */
const N_CPS = 5;
const N_VALIDATORS = 4; // pairing validator floor = 4 (pairing_score.move:93-101)
const N_RELAYS = 2;
const N_SIGNALING = 1;

/** Read-only devInspect sender — no gas, no signature (role-assignment.ts:41). */
const DEV_INSPECT_SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // …/scripts/demo
const WORKTREE_ROOT = resolve(SCRIPT_DIR, '..', '..'); // …/dvconf-daemons-multicp
const KEYS_OUTPUT_PATH =
  process.env['MULTICP_KEYS_PATH'] ?? join(WORKTREE_ROOT, '.run', 'multicp-keys.json');

/**
 * The multi-CP keys file C3's launcher reads. One slot per seeded daemon, grouped
 * by role as arrays so N-of-each is expressible (extends seed-bootstrap.ts's flat
 * `Record<DaemonRole, SeededKey>` to N CPs / N validators / N relays). `cps[0]` is
 * CP#1 (the seeder/voter); each `SeededKey` carries secretKey + capId + stakeId +
 * minerId (same shape every other reader already understands).
 */
export interface MultiCpKeysFile {
  cps: SeededKey[];
  validators: SeededKey[];
  relays: SeededKey[];
  signaling: SeededKey[];
}

/** A bootstrapped CP's handle → the persisted keys-file slot (mirrors seed-bootstrap.ts:541). */
function cpHandleToKey(cp: CpHandle): SeededKey {
  return { secretKey: cp.kp.getSecretKey(), capId: cp.cpCapId, stakeId: cp.stakeId, minerId: cp.minerId };
}

/**
 * devInspect a `public fun <module>::<fn>(&Registry): u64` count getter and decode
 * the 8-byte little-endian BCS u64. Unlike the daemons' fail-OPEN reads, this
 * THROWS on any RPC/decode failure — a self-verifying seed must fail loud, never
 * silently pass on an unreadable count.
 */
async function readU64Count(
  client: SuiClient,
  packageId: string,
  moduleName: string,
  fn: string,
  registryId: string,
): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::${moduleName}::${fn}`,
    arguments: [tx.object(registryId)],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx as never,
    sender: DEV_INSPECT_SENDER,
  });
  if (result.error) {
    throw new Error(`devInspect ${moduleName}::${fn} failed: ${result.error}`);
  }
  const returnValues = result.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length === 0) {
    throw new Error(`devInspect ${moduleName}::${fn} returned no value`);
  }
  const bytes = new Uint8Array(returnValues[0][0] as number[]); // BCS u64: 8 bytes LE
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i] ?? 0);
  }
  return Number(v);
}

/**
 * HARD-ASSERT the genuine N=5 substrate on-chain: active_cp_count==5 AND exactly
 * 4 validators / 2 relays / 1 signaling registered. Throws with all four actual-
 * vs-expected counts on any mismatch.
 */
async function verifyOnChain(client: SuiClient, config: NetworkConfig, logger: Logger): Promise<void> {
  const cpCount = await readU64Count(client, config.packageId, 'control_plane_registry', 'active_cp_count', config.cpRegistryId);
  const validatorCount = await readU64Count(client, config.packageId, 'validator_registry', 'active_count', config.validatorRegistryId);
  const relayCount = await readU64Count(client, config.packageId, 'relay_registry', 'active_count', config.relayRegistryId);
  const signalingCount = await readU64Count(client, config.packageId, 'signaling_registry', 'active_signaling_count', config.signalingRegistryId);

  const mismatches: string[] = [];
  if (cpCount !== N_CPS) mismatches.push(`active_cp_count=${cpCount} (expected ${N_CPS})`);
  if (validatorCount !== N_VALIDATORS) mismatches.push(`validators=${validatorCount} (expected ${N_VALIDATORS})`);
  if (relayCount !== N_RELAYS) mismatches.push(`relays=${relayCount} (expected ${N_RELAYS})`);
  if (signalingCount !== N_SIGNALING) mismatches.push(`signaling=${signalingCount} (expected ${N_SIGNALING})`);

  if (mismatches.length > 0) {
    throw new Error(`seed-multicp on-chain verification FAILED: ${mismatches.join('; ')}`);
  }

  logger.info(
    { module: MODULE, action: 'verify', context: { cpCount, validatorCount, relayCount, signalingCount } },
    'on-chain substrate verified: 5 CPs, 4 validators, 2 relays, 1 signaling',
  );
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  // Same wiring as seed-bootstrap.ts main(): loadNetworkConfig() reads PACKAGE_ID +
  // all *_REGISTRY_ID / MINER_STORE_ID / ROLE_VOTE_BOX_ID from env and derives
  // config.rpcUrl from SUI_NETWORK; the client is built EXACTLY like every daemon.
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  logger.info(
    { module: MODULE, action: 'start', context: { rpcUrl: config.rpcUrl, keysOut: KEYS_OUTPUT_PATH, packageId: config.packageId } },
    'seed-multicp starting (cascade: seed infra @ N=1, then scale to N=5)',
  );

  // 1. CP#1 — the sole voter while infra is seeded (active_cp_count=1 → required=1).
  //    seed-bootstrap.ts bootstrapCp registers at 1.0 SUI, which clears the first-CP
  //    threshold (0.5 SUI) AND every later tier up to 0.9 SUI (constants.move:25-26).
  const cp1 = await bootstrapCp(client, config, logger);

  // 2. Seed ALL infra at N=1 — each finalizes on CP#1's lone vote (required=1).
  //    voteAndApplyMiner mints a FRESH funded keypair per call (seed-bootstrap.ts:499
  //    createFundedKeypair) → every node below is a DISTINCT miner_id, so calling
  //    'validator'/'relay' repeatedly yields distinct on-chain registrations.
  const validators: SeededKey[] = [];
  for (let i = 0; i < N_VALIDATORS; i++) {
    validators.push(await voteAndApplyMiner(client, cp1, 'validator', config, logger));
  }
  // 2 relays. relay_registry dedups by miner_id (relay_registry.move:118), NOT by
  // endpoint_url — two 'relay' calls (each a fresh keypair) are two distinct relay
  // entries even though the seeded endpoint_url metadata matches; C3 assigns the
  // real per-process ports at launch.
  const relays: SeededKey[] = [];
  relays.push(await voteAndApplyMiner(client, cp1, 'relay', config, logger));
  relays.push(await voteAndApplyMiner(client, cp1, 'relay', config, logger));
  const signaling: SeededKey[] = [];
  signaling.push(await voteAndApplyMiner(client, cp1, 'signaling', config, logger));

  // 3. Scale CPs to N=5 — CP#2..#5 only register (no infra needed). After this,
  //    required = ceil(5 * 2/3) = 4, so the demo's role-vote/pairing are a genuine
  //    multi-CP quorum. 1.0 SUI clears each dynamic CP tier (0.6/0.7/0.8/0.9).
  const cps: SeededKey[] = [cpHandleToKey(cp1)];
  for (let i = 1; i < N_CPS; i++) {
    const cp = await bootstrapCp(client, config, logger);
    cps.push(cpHandleToKey(cp));
  }

  // 4. Write the keys file the launcher (C3) reads.
  const keys: MultiCpKeysFile = { cps, validators, relays, signaling };
  mkdirSync(dirname(KEYS_OUTPUT_PATH), { recursive: true });
  writeFileSync(KEYS_OUTPUT_PATH, `${JSON.stringify(keys, null, 2)}\n`, 'utf8');
  logger.info(
    { module: MODULE, action: 'write_keys', context: { keysOut: KEYS_OUTPUT_PATH, cps: cps.length, validators: validators.length, relays: relays.length, signaling: signaling.length } },
    'keys file written',
  );

  // 5. Self-verify the substrate on-chain (HARD-ASSERT — throws on mismatch).
  await verifyOnChain(client, config, logger);

  logger.info(
    {
      module: MODULE,
      action: 'done',
      context: {
        keysOut: KEYS_OUTPUT_PATH,
        counts: { cps: N_CPS, validators: N_VALIDATORS, relays: N_RELAYS, signaling: N_SIGNALING },
      },
    },
    `seed-multicp complete — substrate ready (N=5 CPs, ${N_VALIDATORS} validators, ${N_RELAYS} relays, ${N_SIGNALING} signaling); keys → ${KEYS_OUTPUT_PATH}`,
  );
}

main().catch((err) => {
  // Fail LOUD: a non-zero exit lets the controller's live run gate on this one-shot.
  process.stderr.write(`seed-multicp: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
