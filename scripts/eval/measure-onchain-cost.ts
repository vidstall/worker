/**
 * Phase E3-A — REAL on-chain gas measurement fixture.
 *
 * Boots a fresh Sui localnet from the pinned framework rev, publishes the
 * dvconf-contracts package, bootstraps the minimum on-chain state (1 CP + 2 relays
 * + 4 validators + 1 signaling via the register -> cast_role_vote -> apply_voted_role
 * -> <role>_registry::register lifecycle), then captures the REAL
 * `effects.gasUsed` (all 4 fields: computationCost, storageCost, storageRebate,
 * nonRefundableStorageFee) for EVERY measurable on-chain function + the publish tx.
 *
 * WHY localnet (not devnet): Sui gas-UNITS are deterministic per protocol-version +
 * framework rev; localnet from the pinned rev yields the same gas-units as devnet
 * (only reference_gas_price differs, applied after). No faucet needed beyond the
 * self-spawned localnet's built-in faucet.
 *
 * ── SCOPE (Dispatch-1, retained VERBATIM at the head of the run) ──
 *   publish + the 9 NO-SIGNATURE ("trivial") functions:
 *     cast_role_vote, apply_voted_role, register_relay, control_plane_registry::heartbeat,
 *     signaling_registry::heartbeat, validator_registry::heartbeat, relay_heartbeat,
 *     update_load, report_degradation.
 *   These 9 rows + publish are captured FIRST, in the EXACT same order/args as
 *   Dispatch-1, so their gas fields are byte-for-byte reproducible (determinism cross-check).
 *
 * ── SCOPE (Dispatch-2, appended AFTER the trivial rows, sharing the same publish + RGP) ──
 *   The two HARD ed25519-dual-key functions + a full room lifecycle:
 *     economic_layer::submit_session_proof   (the §5.3 DOMINANT cost term)
 *     economic_layer::distribute_rewards
 *   plus the room-lifecycle "bonus" rows that round out a full-session cost picture:
 *     registration::register, control_plane_registry::register_cp,
 *     validator_registry::register_validator, signaling_registry::register_signaling,
 *     validator_registry::self_assign_session_wallet, user_registry::register_user,
 *     room_manager::create_room, room_manager::submit_pairing_proposal,
 *     economic_layer::create_escrow, room_manager::close_room.
 *
 * ON-CHAIN PRECONDITIONS the Dispatch-2 block satisfies (asserts read from
 * economic_layer.move + room_manager.move + validator_registry.move):
 *   - `required_validators(expected_participants)` = max(4, ep/3) capped 5 → the pairing
 *     ballot needs FOUR registered validators (constants DEFAULT_MIN_VALIDATORS_PER_ROOM=4).
 *   - `min_relay` = 2 → ballot needs TWO registered relays.
 *   - A validator is put into `room.assigned_validators` ONLY via a winning pairing
 *     proposal (submit_pairing_proposal) or the dispute finalize path — AdminCap
 *     assign_relay_and_signaling does NOT assign validators. With 1 active CP,
 *     `required = ceil(1 * 2/3) = 1`, so ONE CP proposal finalizes the room immediately
 *     (PENDING → READY) and writes assigned_validators.
 *   - submit_session_proof: sender = session wallet B (self_assign_session_wallet-bound);
 *     pubkey_public = validator MAIN wallet A (= registered operator; blake2b256(0x00||pk)
 *     must equal info_operator); pubkey_session = wallet B (blake2b256 must equal sender).
 *   - distribute_rewards: room must be CLOSED and `num_proofs >= min_proofs_for_distribution`
 *     (=2), AND per RO-023c a relay needs >= 2 DISTINCT-validator proofs to be "covered".
 *     So TWO distinct validators each submit a proof for the SAME relay (only the FIRST is
 *     measured; the 2nd just satisfies the coverage threshold).
 *
 * Run:
 *   pnpm exec tsx scripts/eval/measure-onchain-cost.ts
 *     (or: npx tsx scripts/eval/measure-onchain-cost.ts)
 *
 * Output:
 *   docs/80-research/evaluation/raw/cost-onchain-localnet-2026-07-13.jsonl
 *   (one JSON line per captured fn + one provenance meta line, all from ONE run)
 *
 * NO git add / commit — measurement fixture only.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bcs } from '@mysten/bcs';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { bootLocalnet, type LocalnetHandle } from '../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts';
import {
  createLogger,
  executeWithRetry,
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
  type TxResult,
} from '../../packages/shared/src/index.ts';
import {
  bootstrapCp,
  voteAndApplyMiner,
  type CpHandle,
  type SeededKey,
} from '../demo/seed-bootstrap.ts';
import {
  serializeProofBcs,
  dualKeySign,
} from '../../apps/validator-daemon/src/session-proof.ts';

const MODULE = 'measure-onchain-cost';

// ── output path (repo-relative, no hardcoded absolute) ───────────────────
const __filename = fileURLToPath(import.meta.url);
const HERE = resolve(__filename, '..'); // scripts/eval
const WORKSPACE_ROOT = resolve(HERE, '..', '..', '..'); // scripts/eval -> scripts -> dvconf-daemons -> workspace root
const OUT_PATH = resolve(
  WORKSPACE_ROOT,
  'docs',
  '80-research',
  'evaluation',
  'raw',
  'cost-onchain-localnet-2026-07-13.jsonl',
);

const FRAMEWORK_REV = '8fc60f1';
const CLI_VERSION = '1.66.2';

// ── raw JSONL row shapes ──────────────────────────────────────────────────

interface GasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee: string;
}

interface CostRow {
  fn: string;
  module: string;
  gasUsed: GasUsed;
  digest: string;
  timestamp: string;
}

interface ProvenanceRow {
  meta: true;
  protocolVersion: string;
  referenceGasPrice: string;
  frameworkRev: string;
  cliVersion: string;
  network: 'localnet';
  timestamp: string;
}

/**
 * Pull the 4-field gasUsed off a TxResult's effects. `effects` is a
 * Record<string, unknown> off the shared TxResult; gasUsed is nested.
 * Coerces every field to string (BCS returns strings; be defensive on numbers).
 */
function gasUsedFromEffects(effects: Record<string, unknown>, label: string): GasUsed {
  const gu = effects['gasUsed'];
  if (gu === undefined || gu === null || typeof gu !== 'object') {
    throw new Error(`${label}: effects.gasUsed missing (effects keys: ${Object.keys(effects).join(',')})`);
  }
  const g = gu as Record<string, unknown>;
  const field = (k: string): string => {
    const v = g[k];
    if (v === undefined || v === null) {
      throw new Error(`${label}: effects.gasUsed.${k} missing`);
    }
    return String(v);
  };
  return {
    computationCost: field('computationCost'),
    storageCost: field('storageCost'),
    storageRebate: field('storageRebate'),
    nonRefundableStorageFee: field('nonRefundableStorageFee'),
  };
}

/** net cost helper for the report table (computation + storage - rebate). */
function netCost(g: GasUsed): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

function makeRow(fn: string, module: string, result: TxResult): CostRow {
  return {
    fn,
    module,
    gasUsed: gasUsedFromEffects(result.effects, fn),
    digest: result.digest,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run one measured moveCall through executeWithRetry (which already requests
 * showEffects:true), and return a CostRow. Fails LOUD on a null result.
 */
async function measure(
  client: SuiClient,
  signer: Ed25519Keypair,
  fn: string,
  module: string,
  build: (tx: Transaction) => void,
  logger: Logger,
): Promise<CostRow> {
  const result = await executeWithRetry(client, signer, build, fn, logger);
  if (result === null) {
    throw new Error(`measure(${fn}): transaction failed after retries`);
  }
  return makeRow(fn, module, result);
}

/**
 * Effects-capturing SINGLE-ATTEMPT execution that asserts on-chain success and
 * surfaces the Move abort string LOUD (unlike executeWithRetry, which blindly
 * retries a deterministic abort 5× then returns null). Used for the
 * Dispatch-2 hard/lifecycle functions where a precondition abort must be
 * diagnosable, and where we need the real `effects` back (for gasUsed + events).
 * Mirrors shared `signAndAssert` but returns a full TxResult-shaped object.
 */
async function signAndCapture(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<TxResult> {
  const tx = new Transaction();
  build(tx);
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: result.digest });
  const effects = (result.effects ?? {}) as Record<string, unknown>;
  const status = (effects['status'] as { status?: string; error?: string } | undefined);
  if (status?.status !== 'success') {
    throw new Error(`${label} failed on-chain: status=${status?.status ?? 'unknown'} error=${status?.error ?? '(none)'}`);
  }
  logger.info({ module: MODULE, action: label, digest: result.digest }, `${label} succeeded on-chain`);
  return {
    digest: result.digest,
    effects,
    events: (result.events ?? []) as Record<string, unknown>[],
    objectChanges: (result.objectChanges ?? []) as Record<string, unknown>[],
  };
}

/** Measured variant of signAndCapture: returns a CostRow AND the raw result. */
async function measureCapture(
  client: SuiClient,
  signer: Ed25519Keypair,
  fn: string,
  module: string,
  build: (tx: Transaction) => void,
  logger: Logger,
): Promise<{ row: CostRow; result: TxResult }> {
  const result = await signAndCapture(client, signer, build, fn, logger);
  return { row: makeRow(fn, module, result), result };
}

/**
 * Fetch the publish tx's gasUsed. bootLocalnet() publishes internally but does not
 * return the publish digest, so we recover it from the package object's
 * previousTransaction, then read that tx block's effects.gasUsed.
 */
async function measurePublish(client: SuiClient, packageId: string, logger: Logger): Promise<CostRow> {
  const pkgObj = await client.getObject({
    id: packageId,
    options: { showPreviousTransaction: true },
  });
  const prevTx = pkgObj.data?.previousTransaction;
  if (typeof prevTx !== 'string') {
    throw new Error(`measurePublish: package ${packageId} has no previousTransaction`);
  }
  const txBlock = await client.getTransactionBlock({
    digest: prevTx,
    options: { showEffects: true },
  });
  const effects = (txBlock.effects ?? {}) as unknown as Record<string, unknown>;
  logger.info({ module: MODULE, action: 'measure_publish', digest: prevTx }, 'captured publish gasUsed');
  return {
    fn: 'publish',
    module: 'package',
    gasUsed: gasUsedFromEffects(effects, 'publish'),
    digest: prevTx,
    timestamp: new Date().toISOString(),
  };
}

// ── faucet helpers (localnet built-in; async → poll for the gas coin) ─────

const FAUCET_URL = getFaucetHost('localnet');
const MINER_STAKE_MIST = 300_000_000n;

/** Fund a fresh keypair and wait for its first gas coin to be indexed. */
async function fundAndWait(client: SuiClient, address: string, timeoutMs = 90_000): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) return;
    if (Date.now() > deadline) throw new Error(`faucet gas never indexed for ${address}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  const rows: CostRow[] = [];

  logger.info({ module: MODULE, action: 'boot' }, 'booting localnet + publishing package (1-3 min)...');
  let handle: LocalnetHandle | null = null;
  try {
    // Generous port-wait headroom for a contended Windows host.
    handle = await bootLocalnet({ portWaitMs: 240_000 });
    const { client, config } = handle;

    logger.info({ module: MODULE, action: 'booted', packageId: config.packageId }, 'localnet up + package published');

    // ── provenance (protocol version + RGP) ──────────────────────────────
    const protocolConfig = await client.getProtocolConfig();
    const referenceGasPrice = await client.getReferenceGasPrice();
    const provenance: ProvenanceRow = {
      meta: true,
      protocolVersion: String(protocolConfig.protocolVersion),
      referenceGasPrice: String(referenceGasPrice),
      frameworkRev: FRAMEWORK_REV,
      cliVersion: CLI_VERSION,
      network: 'localnet',
      timestamp: new Date().toISOString(),
    };
    logger.info(
      { module: MODULE, action: 'provenance', protocolVersion: provenance.protocolVersion, rgp: provenance.referenceGasPrice },
      'captured provenance',
    );

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCK A — DISPATCH-1 (VERBATIM): publish + the 9 trivial fns.
    // Order/args here are FROZEN — they reproduce cost-onchain-localnet-2026-07-12.jsonl
    // byte-for-byte on the gas fields (gas-unit determinism cross-check).
    // ═══════════════════════════════════════════════════════════════════════

    // ── 1. publish tx ────────────────────────────────────────────────────
    rows.push(await measurePublish(client, config.packageId, logger));

    // ── bootstrap the CP (the voter) ─────────────────────────────────────
    logger.info({ module: MODULE, action: 'bootstrap_cp' }, 'bootstrapping CP...');
    const cp: CpHandle = await bootstrapCp(client, config, logger);

    // ── measure the CP-voted lifecycle for ONE relay, capturing each step ──
    const relay = await measureRelayLifecycle(client, cp, config, rows, logger);

    // ── register a validator + signaling via the sealed helper (state only) ──
    logger.info({ module: MODULE, action: 'seed_validator' }, 'seeding validator...');
    const validator: SeededKey = await voteAndApplyMiner(client, cp, 'validator', config, logger);
    const validatorKp = Ed25519Keypair.fromSecretKey(validator.secretKey);
    logger.info({ module: MODULE, action: 'seed_signaling' }, 'seeding signaling...');
    const signaling: SeededKey = await voteAndApplyMiner(client, cp, 'signaling', config, logger);
    const signalingKp = Ed25519Keypair.fromSecretKey(signaling.secretKey);

    // ── 5. control_plane_registry::heartbeat (signed by CP main wallet) ───
    rows.push(
      await measure(
        client,
        cp.kp,
        'heartbeat',
        'control_plane_registry',
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::control_plane_registry::heartbeat`,
            arguments: [
              tx.object(config.networkRegistryId),
              tx.object(config.cpRegistryId),
              tx.object(cp.cpCapId),
            ],
          });
        },
        logger,
      ),
    );

    // ── 6. signaling_registry::heartbeat (signed by signaling miner) ─────
    rows.push(
      await measure(
        client,
        signalingKp,
        'heartbeat',
        'signaling_registry',
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::signaling_registry::heartbeat`,
            arguments: [
              tx.object(config.networkRegistryId),
              tx.object(config.signalingRegistryId),
              tx.object(signaling.capId),
            ],
          });
        },
        logger,
      ),
    );

    // ── 7. validator_registry::heartbeat (signed by validator miner) ────
    rows.push(
      await measure(
        client,
        validatorKp,
        'heartbeat',
        'validator_registry',
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::validator_registry::heartbeat`,
            arguments: [
              tx.object(config.networkRegistryId),
              tx.object(config.validatorRegistryId),
              tx.object(validator.capId),
            ],
          });
        },
        logger,
      ),
    );

    // ── 8. relay_registry::relay_heartbeat (signed by relay miner) ──────
    rows.push(
      await measure(
        client,
        relay.kp,
        'relay_heartbeat',
        'relay_registry',
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::relay_registry::relay_heartbeat`,
            arguments: [
              tx.object(config.networkRegistryId),
              tx.object(config.relayRegistryId),
              tx.object(relay.capId),
            ],
          });
        },
        logger,
      ),
    );

    // ── 9. relay_registry::update_load (signed by relay miner) ──────────
    rows.push(
      await measure(
        client,
        relay.kp,
        'update_load',
        'relay_registry',
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::relay_registry::update_load`,
            arguments: [
              tx.object(config.networkRegistryId),
              tx.object(config.relayRegistryId),
              tx.object(relay.capId),
              tx.pure.u64(1),
            ],
          });
        },
        logger,
      ),
    );

    // ── 10. relay_registry::report_degradation (ad-hoc PTB) ─────────────
    const dummyRoomId = normalizeSuiAddress('0x1'); // ID = 32-byte address; unchecked by the fn
    rows.push(
      await measure(
        client,
        relay.kp,
        'report_degradation',
        'relay_registry',
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::relay_registry::report_degradation`,
            arguments: [
              tx.object(config.relayRegistryId), // registry: &RelayRegistry
              tx.pure.id(dummyRoomId), // room_id: ID (unchecked)
              tx.pure.id(relay.minerId), // relay_miner_id: ID (must be registered)
              tx.pure.u64(120), // rtt: u64
              tx.pure.u64(3), // load: u64
            ],
          });
        },
        logger,
      ),
    );

    // Snapshot the count of Dispatch-1 rows for the determinism report.
    const dispatch1RowCount = rows.length; // publish + 9 = 10

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCK B — DISPATCH-2: hard ed25519 fns + full room lifecycle + bonus rows.
    // Appended AFTER Block A so the 10 trivial rows above are untouched.
    // ═══════════════════════════════════════════════════════════════════════
    await measureDispatch2(client, config, cp, relay, validator, validatorKp, signaling, rows, logger);

    // ── write raw JSONL (provenance line first, then one line per fn) ────
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    const lines: string[] = [JSON.stringify(provenance)];
    for (const r of rows) {
      lines.push(JSON.stringify(r));
    }
    writeFileSync(OUT_PATH, `${lines.join('\n')}\n`, 'utf8');

    // ── console report table ────────────────────────────────────────────
    logger.info({ module: MODULE, action: 'write', outPath: OUT_PATH, rowCount: rows.length, dispatch1RowCount }, 'raw JSONL written');
    process.stdout.write('\n=== ON-CHAIN GAS (localnet, REAL effects.gasUsed) ===\n');
    process.stdout.write('| fn | module | computationCost | storageCost | storageRebate | nonRefundableStorageFee | net | digest |\n');
    process.stdout.write('|----|--------|-----------------|-------------|---------------|-------------------------|-----|--------|\n');
    for (const r of rows) {
      process.stdout.write(
        `| ${r.fn} | ${r.module} | ${r.gasUsed.computationCost} | ${r.gasUsed.storageCost} | ${r.gasUsed.storageRebate} | ${r.gasUsed.nonRefundableStorageFee} | ${netCost(r.gasUsed).toString()} | ${r.digest} |\n`,
      );
    }
    process.stdout.write('\n=== PROVENANCE ===\n');
    process.stdout.write(`${JSON.stringify(provenance)}\n`);
    process.stdout.write(`\nOUT: ${OUT_PATH}\n`);
  } finally {
    if (handle !== null) {
      logger.info({ module: MODULE, action: 'teardown' }, 'tearing down localnet...');
      await handle.teardown();
    }
  }
}

/**
 * The full CP-voted relay lifecycle with PER-STEP gasUsed capture. Mirrors
 * seed-bootstrap.ts voteAndApplyMiner but measures cast_role_vote /
 * apply_voted_role / register_relay individually (and reaches the relay's
 * MinerCap + StakePosition so its heartbeat/update_load/report_degradation are
 * measurable).
 *
 * Returns { kp, capId, minerId, stakeId } so the caller can measure relay
 * heartbeats AND (Dispatch-2) use this relay as a ballot member + proof target.
 */
async function measureRelayLifecycle(
  client: SuiClient,
  cp: CpHandle,
  config: NetworkConfig,
  rows: CostRow[],
  logger: Logger,
): Promise<{ kp: Ed25519Keypair; capId: string; minerId: string; stakeId: string }> {
  const ROLE_RELAY = 2;

  // fund a fresh relay keypair
  const relayKp = Ed25519Keypair.generate();
  const relayAddr = relayKp.getPublicKey().toSuiAddress();
  await fundAndWait(client, relayAddr);
  const minerId = normalizeSuiAddress(relayAddr);

  // step 1: registration::register (0.3 SUI -> MinerCap) — executed, not measured this dispatch
  const regResult = await executeWithRetry(
    client,
    relayKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(MINER_STAKE_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register(relay)',
    logger,
  );
  if (regResult === null) throw new Error('measureRelayLifecycle: register failed');
  const minerCapId = extractCreatedObjectByType(regResult, '::caps::MinerCap');
  const stakeId = extractCreatedObjectByType(regResult, '::staking::StakePosition');
  if (minerCapId === null) throw new Error('measureRelayLifecycle: no MinerCap');
  if (stakeId === null) throw new Error('measureRelayLifecycle: no StakePosition');

  // step 2: role_voting::cast_role_vote (signed by CP) — MEASURED
  rows.push(
    await measure(
      client,
      cp.kp,
      'cast_role_vote',
      'role_voting',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::role_voting::cast_role_vote`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roleVoteBoxId),
            tx.object(config.minerStoreId),
            tx.object(config.cpRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(config.signalingRegistryId),
            tx.object(cp.cpCapId),
            tx.pure.id(minerId),
            tx.pure.u8(ROLE_RELAY),
          ],
        });
      },
      logger,
    ),
  );

  // step 3: registration::apply_voted_role (signed by relay miner) — MEASURED
  rows.push(
    await measure(
      client,
      relayKp,
      'apply_voted_role',
      'registration',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::registration::apply_voted_role`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.minerStoreId),
            tx.object(config.roleVoteBoxId),
            tx.object(config.signalingRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(config.cpRegistryId),
            tx.object(minerCapId),
            tx.object(stakeId),
          ],
        });
      },
      logger,
    ),
  );

  // step 4: relay_registry::register_relay (signed by relay miner) — MEASURED
  const REGION = Array.from(new TextEncoder().encode('local'));
  const endpoint = Array.from(new TextEncoder().encode('ws://relay-eval:4000'));
  rows.push(
    await measure(
      client,
      relayKp,
      'register_relay',
      'relay_registry',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(minerCapId),
            tx.object(stakeId),
            tx.pure.vector('u8', REGION),
            tx.pure.vector('u8', endpoint),
          ],
        });
      },
      logger,
    ),
  );

  logger.info({ module: MODULE, action: 'relay_lifecycle_done', minerId }, 'relay registered + 3 steps measured');
  return { kp: relayKp, capId: minerCapId, minerId, stakeId };
}

// ══════════════════════════════════════════════════════════════════════════
// DISPATCH-2 — the hard ed25519 functions + full room lifecycle.
// ══════════════════════════════════════════════════════════════════════════

/** A validator that has registered, applied its role, enrolled, and bound a
 *  session wallet — i.e. is fully ready to submit_session_proof. */
interface ReadyValidator {
  mainKp: Ed25519Keypair;   // wallet A = registered operator; signs the proof bytes
  sessionKp: Ed25519Keypair; // wallet B = self_assign_session_wallet-bound; TX sender
  minerId: string;
  capId: string;
  stakeId: string;
}

/**
 * A raw "register a fresh miner as a User" (registration::register) that RETURNS
 * the created cap + stake + the TxResult, so the FIRST call can be MEASURED as the
 * `registration::register` bonus row. Mirrors seed-bootstrap.registerMiner but
 * surfaces the result.
 */
async function registerFreshMiner(
  client: SuiClient,
  kp: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<{ minerId: string; minerCapId: string; stakeId: string; result: TxResult }> {
  const result = await signAndCapture(
    client,
    kp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(MINER_STAKE_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register',
    logger,
  );
  const minerCapId = extractCreatedObjectByType(result, '::caps::MinerCap');
  const stakeId = extractCreatedObjectByType(result, '::staking::StakePosition');
  if (minerCapId === null) throw new Error('registerFreshMiner: no MinerCap');
  if (stakeId === null) throw new Error('registerFreshMiner: no StakePosition');
  return { minerId: normalizeSuiAddress(kp.getPublicKey().toSuiAddress()), minerCapId, stakeId, result };
}

/**
 * Register + vote + apply + enroll a validator, then bind a fresh session wallet.
 * `measureIdx`: when 0, MEASURE register / register_validator / self_assign_session_wallet
 * (the bonus rows). For subsequent validators these steps are executed but not measured.
 */
async function buildReadyValidator(
  client: SuiClient,
  cp: CpHandle,
  config: NetworkConfig,
  measureIdx: number,
  rows: CostRow[],
  logger: Logger,
): Promise<ReadyValidator> {
  const ROLE_VALIDATOR = 1;
  const mainKp = Ed25519Keypair.generate();
  await fundAndWait(client, mainKp.getPublicKey().toSuiAddress());

  // registration::register — MEASURED on the first validator (bonus row).
  const reg = await registerFreshMiner(client, mainKp, config, logger);
  if (measureIdx === 0) {
    rows.push(makeRow('register', 'registration', reg.result));
  }

  // CP casts the role vote (already measured in the relay lifecycle; here executed only).
  await signAndCapture(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.cpRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.signalingRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(reg.minerId),
          tx.pure.u8(ROLE_VALIDATOR),
        ],
      });
    },
    'cast_role_vote(validator)',
    logger,
  );

  // miner applies the voted role.
  await signAndCapture(
    client,
    mainKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.signalingRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(reg.minerCapId),
          tx.object(reg.stakeId),
        ],
      });
    },
    'apply_voted_role(validator)',
    logger,
  );

  // validator_registry::register_validator — MEASURED on the first validator (bonus row).
  const buildRegisterValidator = (tx: Transaction): void => {
    tx.moveCall({
      target: `${config.packageId}::validator_registry::register_validator`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(reg.minerCapId),
        tx.object(reg.stakeId),
      ],
    });
  };
  if (measureIdx === 0) {
    const { row } = await measureCapture(client, mainKp, 'register_validator', 'validator_registry', buildRegisterValidator, logger);
    rows.push(row);
  } else {
    await signAndCapture(client, mainKp, buildRegisterValidator, 'register_validator', logger);
  }

  // Bind a fresh session wallet (B). The operator (wallet A) authorises via its MinerCap.
  // blake2b256(0x00 || pubkey_B) == sessionKp address is what submit_session_proof checks.
  const sessionKp = Ed25519Keypair.generate();
  const sessionAddr = sessionKp.getPublicKey().toSuiAddress();
  // Fund the session wallet — it is the TX SENDER of submit_session_proof (needs gas).
  await fundAndWait(client, sessionAddr);

  const buildSelfAssign = (tx: Transaction): void => {
    tx.moveCall({
      target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(reg.minerCapId),
        tx.pure.address(sessionAddr),
      ],
    });
  };
  if (measureIdx === 0) {
    const { row } = await measureCapture(client, mainKp, 'self_assign_session_wallet', 'validator_registry', buildSelfAssign, logger);
    rows.push(row);
  } else {
    await signAndCapture(client, mainKp, buildSelfAssign, 'self_assign_session_wallet', logger);
  }

  logger.info({ module: MODULE, action: 'ready_validator', minerId: reg.minerId, sessionAddr }, 'validator ready (registered + session wallet bound)');
  return { mainKp, sessionKp, minerId: reg.minerId, capId: reg.minerCapId, stakeId: reg.stakeId };
}

/**
 * Register + vote + apply + enroll a SECOND relay (needed only to satisfy the
 * `relay_ids.length() >= min_relay(=2)` ballot check). Returns its minerId.
 * register_relay here is executed (already measured in the primary lifecycle).
 */
async function buildSecondRelay(
  client: SuiClient,
  cp: CpHandle,
  config: NetworkConfig,
  logger: Logger,
): Promise<string> {
  const ROLE_RELAY = 2;
  const kp = Ed25519Keypair.generate();
  await fundAndWait(client, kp.getPublicKey().toSuiAddress());
  const reg = await registerFreshMiner(client, kp, config, logger);

  await signAndCapture(client, cp.kp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::role_voting::cast_role_vote`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roleVoteBoxId),
        tx.object(config.minerStoreId),
        tx.object(config.cpRegistryId),
        tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(config.signalingRegistryId),
        tx.object(cp.cpCapId),
        tx.pure.id(reg.minerId),
        tx.pure.u8(ROLE_RELAY),
      ],
    });
  }, 'cast_role_vote(relay2)', logger);

  await signAndCapture(client, kp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::registration::apply_voted_role`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.minerStoreId),
        tx.object(config.roleVoteBoxId),
        tx.object(config.signalingRegistryId),
        tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(config.cpRegistryId),
        tx.object(reg.minerCapId),
        tx.object(reg.stakeId),
      ],
    });
  }, 'apply_voted_role(relay2)', logger);

  const REGION = Array.from(new TextEncoder().encode('local'));
  const endpoint = Array.from(new TextEncoder().encode('ws://relay-eval-2:4000'));
  await signAndCapture(client, kp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::relay_registry::register_relay`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.relayRegistryId),
        tx.object(reg.minerCapId),
        tx.object(reg.stakeId),
        tx.pure.vector('u8', REGION),
        tx.pure.vector('u8', endpoint),
      ],
    });
  }, 'register_relay(relay2)', logger);

  logger.info({ module: MODULE, action: 'second_relay_done', minerId: reg.minerId }, 'second relay registered (ballot filler)');
  return reg.minerId;
}

/** Read the RoomCreated event's room_id off a create_room TxResult (typed for the
 *  shared TxResult, unlike the shared extractRoomId which wants TxStatusLike). */
function extractRoomIdFromResult(result: TxResult): string {
  const evt = (result.events ?? []).find((e) => String((e as { type?: string }).type ?? '').includes('::room_manager::RoomCreated'));
  const roomId = (evt as { parsedJson?: { room_id?: unknown } } | undefined)?.parsedJson?.room_id;
  if (typeof roomId !== 'string') {
    throw new Error('extractRoomIdFromResult: RoomCreated event missing or malformed');
  }
  return normalizeSuiAddress(roomId);
}

/** Read the EscrowCreated event's escrow_id off a create_escrow TxResult. */
function extractEscrowId(result: TxResult): string {
  const evt = (result.events ?? []).find((e) => String((e as { type?: string }).type ?? '').includes('::economic_layer::EscrowCreated'));
  const escrowId = (evt as { parsedJson?: { escrow_id?: unknown } } | undefined)?.parsedJson?.escrow_id;
  if (typeof escrowId !== 'string') {
    throw new Error('extractEscrowId: EscrowCreated event missing or malformed');
  }
  return normalizeSuiAddress(escrowId);
}

/**
 * The whole Dispatch-2 room-lifecycle + hard-function measurement block.
 * Preconditions satisfied inline (see module-header comment). Reuses the already-
 * seeded CP / primary relay / primary validator / signaling from Block A.
 */
async function measureDispatch2(
  client: SuiClient,
  config: NetworkConfig,
  cp: CpHandle,
  primaryRelay: { minerId: string },
  primaryValidator: SeededKey,
  primaryValidatorKp: Ed25519Keypair,
  signaling: SeededKey,
  rows: CostRow[],
  logger: Logger,
): Promise<void> {
  logger.info({ module: MODULE, action: 'dispatch2_start' }, 'Dispatch-2: building room-lifecycle preconditions...');

  // ── (a) A second relay so the pairing ballot has >= min_relay(=2) relays. ──
  const relay2MinerId = await buildSecondRelay(client, cp, config, logger);

  // ── (b) FOUR ready validators (required_validators for a small room = 4).
  //     Two of them (V0,V1) will each attest the SAME relay → distinct-coverage=2.
  //     V0 is the "measure" validator: its register / register_validator /
  //     self_assign_session_wallet are the measured bonus rows, and its
  //     submit_session_proof is the DOMINANT §5.3 measurement. ──
  const validators: ReadyValidator[] = [];
  for (let i = 0; i < 4; i++) {
    validators.push(await buildReadyValidator(client, cp, config, i, rows, logger));
  }
  const validatorIds = validators.map((v) => v.minerId);

  // ── (c) A fresh registered USER who creates + funds + closes the room. ──
  const userKp = Ed25519Keypair.generate();
  await fundAndWait(client, userKp.getPublicKey().toSuiAddress());
  // top up: room lifecycle = register_user + create_room + create_escrow(1 SUI) + close_room
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: userKp.getPublicKey().toSuiAddress() });
  await new Promise((r) => setTimeout(r, 1500));

  // user_registry::register_user — MEASURED (bonus row).
  {
    const { row } = await measureCapture(
      client,
      userKp,
      'register_user',
      'user_registry',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::user_registry::register_user`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.userRegistryId),
            tx.pure.vector('u8', [99]),
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }

  // room_manager::create_room (SFU, expected_participants=2, room_class_hint=0) — MEASURED.
  let roomId = '';
  {
    const { row, result } = await measureCapture(
      client,
      userKp,
      'create_room',
      'room_manager',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::create_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.userRegistryId),
            tx.pure.u8(0), // relay_mode SFU
            tx.pure.u64(2), // expected_participants (required_validators = max(4, 2/3) = 4)
            tx.pure.u8(0), // room_class_hint = small
          ],
        });
      },
      logger,
    );
    rows.push(row);
    roomId = extractRoomIdFromResult(result);
  }
  logger.info({ module: MODULE, action: 'room_created', roomId }, 'room created');

  // economic_layer::create_escrow (user-signed, 1 SUI) — MEASURED. Emits EscrowCreated.
  // ORDER-CRITICAL: create_escrow asserts the room is PENDING (E_ROOM_NOT_PENDING=653),
  // so it MUST run BEFORE submit_pairing_proposal (which finalizes PENDING → READY).
  let escrowId = '';
  const ESCROW_AMOUNT_MIST = 1_000_000_000n;
  {
    const { row, result } = await measureCapture(
      client,
      userKp,
      'create_escrow',
      'economic_layer',
      (tx) => {
        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(ESCROW_AMOUNT_MIST)]);
        tx.moveCall({
          target: `${config.packageId}::economic_layer::create_escrow`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.pure.id(roomId),
            payment!,
          ],
        });
      },
      logger,
    );
    rows.push(row);
    escrowId = extractEscrowId(result);
  }
  logger.info({ module: MODULE, action: 'escrow_created', escrowId }, 'escrow created');

  // room_manager::submit_pairing_proposal (CP-signed) — MEASURED.
  // With 1 active CP, required = ceil(1 * 2/3) = 1 → this single proposal FINALIZES the
  // room (PENDING → READY) and writes assigned_relays + assigned_validators.
  // Runs AFTER create_escrow (see ORDER-CRITICAL note above) but BEFORE the proofs
  // (submit_session_proof asserts the validator IS assigned).
  // Ballot: [relay1, relay2] (>= min_relay 2), [v0..v3] (>= required_validators 4), signaling.
  {
    const relayIds = [primaryRelay.minerId, relay2MinerId];
    const { row } = await measureCapture(
      client,
      cp.kp,
      'submit_pairing_proposal',
      'room_manager',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::submit_pairing_proposal`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.cpRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(config.signalingRegistryId),
            tx.object(cp.cpCapId),
            tx.pure.id(roomId),
            tx.pure.vector('id', relayIds),
            tx.pure.vector('id', validatorIds),
            tx.pure.id(signaling.minerId),
            tx.pure.u64(1000), // submitted_score (arbitrary; contract does NOT recompute)
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }
  logger.info({ module: MODULE, action: 'room_finalized', roomId }, 'room finalized via pairing proposal (validators assigned)');

  // ── (d) submit_session_proof — the DOMINANT §5.3 term. MEASURED on V0.
  //     V1 also submits a proof for the SAME relay (distinct validator) so the
  //     relay reaches distinct-coverage = 2 for distribute_rewards. ──
  const proofRelayId = primaryRelay.minerId; // both proofs attest the SAME relay → coverage=2

  // The measured proof (V0). Reuses serializeProofBcs + dualKeySign from the daemon module.
  const measuredProofRow = await measureSubmitSessionProof(
    client,
    config,
    escrowId,
    roomId,
    proofRelayId,
    validators[0]!,
    logger,
  );
  rows.push(measuredProofRow);

  // A second DISTINCT-validator proof for the same relay (executed, not measured) —
  // needed so distribute_rewards sees >= 2 distinct validators covering this relay.
  await submitSessionProofExec(
    client,
    config,
    escrowId,
    roomId,
    proofRelayId,
    validators[1]!,
    logger,
  );
  logger.info({ module: MODULE, action: 'proofs_submitted' }, 'two distinct-validator proofs submitted (relay covered)');

  // ── (e) room_manager::close_room (user-signed) — MEASURED (bonus row).
  //     distribute_rewards asserts the room is CLOSED. ──
  {
    const { row } = await measureCapture(
      client,
      userKp,
      'close_room',
      'room_manager',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::close_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.pure.id(roomId),
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }
  logger.info({ module: MODULE, action: 'room_closed', roomId }, 'room closed');

  // ── (f) economic_layer::distribute_rewards — MEASURED. Crank pattern (any signer);
  //     we use the user. Room CLOSED + 2 distinct proofs on the covered relay. ──
  {
    const { row } = await measureCapture(
      client,
      userKp,
      'distribute_rewards',
      'economic_layer',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::economic_layer::distribute_rewards`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(escrowId),
            tx.object(config.roomManagerId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(config.cpRegistryId),
            tx.object(config.signalingRegistryId),
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }
  logger.info({ module: MODULE, action: 'dispatch2_done' }, 'Dispatch-2 complete: submit_session_proof + distribute_rewards measured');
}

/**
 * Build the exact submit_session_proof PTB (reusing the daemon's serializeProofBcs +
 * dualKeySign crypto) and MEASURE its gasUsed. Returns the CostRow.
 *
 * Signing/identity contract (economic_layer.move:280-307):
 *   - TX sender      = session wallet B  (validator.sessionKp)
 *   - pubkey_public  = wallet A pubkey   (validator.mainKp)   → blake2b256(0x00||pk_A) == operator
 *   - pubkey_session = wallet B pubkey   (validator.sessionKp) → blake2b256(0x00||pk_B) == sender
 *   - msg (IC-2)     = serializeProofBcs(...) signed by BOTH A and B (dualKeySign).
 */
async function measureSubmitSessionProof(
  client: SuiClient,
  config: NetworkConfig,
  escrowId: string,
  roomId: string,
  relayMinerId: string,
  v: ReadyValidator,
  logger: Logger,
): Promise<CostRow> {
  const proof = buildProofFields();
  const bcsMessage = serializeProofBcs(
    roomId,
    relayMinerId,
    proof.packetsForwarded,
    proof.bytesTransferred,
    proof.uniquePeers,
    proof.durationSeconds,
    proof.avgLatencyMs,
    proof.packetLossBps,
    proof.jitterMs,
  );
  const { signatureA: sigPublic, signatureB: sigSession } = await dualKeySign(bcsMessage, v.mainKp, v.sessionKp);
  const pubkeyPublic = v.mainKp.getPublicKey().toRawBytes();
  const pubkeySession = v.sessionKp.getPublicKey().toRawBytes();

  const build = (tx: Transaction): void => {
    tx.moveCall({
      target: `${config.packageId}::economic_layer::submit_session_proof`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(escrowId),
        tx.object(config.roomManagerId),
        tx.object(config.validatorRegistryId),
        tx.object(config.relayRegistryId),
        tx.pure.id(roomId),
        tx.pure.id(relayMinerId),
        tx.pure.u64(proof.packetsForwarded),
        tx.pure.u64(proof.bytesTransferred),
        tx.pure.u64(proof.uniquePeers),
        tx.pure.u64(proof.durationSeconds),
        tx.pure.u64(proof.avgLatencyMs),
        tx.pure.u64(proof.packetLossBps),
        tx.pure.u64(proof.jitterMs),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeyPublic))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeySession))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigPublic))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigSession))),
      ],
    });
  };
  // TX signed by the SESSION wallet (B).
  const { row } = await measureCapture(client, v.sessionKp, 'submit_session_proof', 'economic_layer', build, logger);
  return row;
}

/** Execute (unmeasured) a 2nd distinct-validator proof for the SAME relay. */
async function submitSessionProofExec(
  client: SuiClient,
  config: NetworkConfig,
  escrowId: string,
  roomId: string,
  relayMinerId: string,
  v: ReadyValidator,
  logger: Logger,
): Promise<void> {
  const proof = buildProofFields();
  const bcsMessage = serializeProofBcs(
    roomId,
    relayMinerId,
    proof.packetsForwarded,
    proof.bytesTransferred,
    proof.uniquePeers,
    proof.durationSeconds,
    proof.avgLatencyMs,
    proof.packetLossBps,
    proof.jitterMs,
  );
  const { signatureA: sigPublic, signatureB: sigSession } = await dualKeySign(bcsMessage, v.mainKp, v.sessionKp);
  const pubkeyPublic = v.mainKp.getPublicKey().toRawBytes();
  const pubkeySession = v.sessionKp.getPublicKey().toRawBytes();
  await signAndCapture(
    client,
    v.sessionKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::economic_layer::submit_session_proof`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(escrowId),
          tx.object(config.roomManagerId),
          tx.object(config.validatorRegistryId),
          tx.object(config.relayRegistryId),
          tx.pure.id(roomId),
          tx.pure.id(relayMinerId),
          tx.pure.u64(proof.packetsForwarded),
          tx.pure.u64(proof.bytesTransferred),
          tx.pure.u64(proof.uniquePeers),
          tx.pure.u64(proof.durationSeconds),
          tx.pure.u64(proof.avgLatencyMs),
          tx.pure.u64(proof.packetLossBps),
          tx.pure.u64(proof.jitterMs),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeyPublic))),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeySession))),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigPublic))),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigSession))),
        ],
      });
    },
    'submit_session_proof(v2-coverage)',
    logger,
  );
}

/**
 * Deterministic, valid proof-field values. Loss = 100 bps (1% < 2% "excellent")
 * so the relay's per-relay quality > 0 (qualifies, not slashed). duration=30s > 0
 * so a standby-liveness gate would pass; bytes > 0 so the reward pool is non-zero.
 */
function buildProofFields(): {
  packetsForwarded: bigint;
  bytesTransferred: bigint;
  uniquePeers: bigint;
  durationSeconds: bigint;
  avgLatencyMs: bigint;
  packetLossBps: bigint;
  jitterMs: bigint;
} {
  return {
    packetsForwarded: 10_000n,
    bytesTransferred: 1_000_000n,
    uniquePeers: 2n,
    durationSeconds: 30n,
    avgLatencyMs: 50n,
    packetLossBps: 100n, // 1% → "excellent" quality (> 0), relay qualifies
    jitterMs: 5n,
  };
}

main().catch((err) => {
  process.stderr.write(`${MODULE}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
