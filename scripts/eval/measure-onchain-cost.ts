/**
 * Phase E3-A — REAL on-chain gas measurement fixture.
 *
 * Boots a fresh Sui localnet from the pinned framework rev, publishes the
 * dvconf-contracts package, bootstraps the minimum on-chain state (1 CP + 2 relays
 * + 4 validators via the register -> cast_role_vote -> apply_voted_role
 * -> <role>_registry::register lifecycle), then captures the REAL
 * `effects.gasUsed` (all 4 fields: computationCost, storageCost, storageRebate,
 * nonRefundableStorageFee) for EVERY measurable on-chain function + the publish tx.
 *
 * WHY localnet (not devnet): Sui gas-UNITS are deterministic per protocol-version +
 * framework rev; localnet from the pinned rev yields the same gas-units as devnet
 * (only reference_gas_price differs, applied after). No faucet needed beyond the
 * self-spawned localnet's built-in faucet.
 *
 * ── SCOPE (Dispatch-1, retained VERBATIM at the head of the run where the contract
 *    still allows it -- the standalone signaling node type + its registry were
 *    removed from the contract, so the signaling_registry::heartbeat row is gone) ──
 *   publish + the 8 NO-SIGNATURE ("trivial") functions:
 *     cast_role_vote, apply_voted_role, register_relay, control_plane_registry::heartbeat,
 *     validator_registry::heartbeat, relay_heartbeat, update_load, report_degradation.
 *   These 8 rows + publish are captured FIRST, in the same relative order as
 *   Dispatch-1, so their gas fields stay directly comparable (determinism cross-check;
 *   NOT byte-for-byte reproducible against the pre-removal 2026-07-12 baseline, since
 *   apply_voted_role's on-chain shape changed along with the signaling removal).
 *
 * ── SCOPE (Dispatch-2, appended AFTER the trivial rows, sharing the same publish + RGP) ──
 *   The two HARD ed25519-dual-key functions + a full room lifecycle:
 *     economic_layer::submit_session_proof   (the §5.3 DOMINANT cost term)
 *     economic_layer::distribute_rewards
 *   plus the room-lifecycle "bonus" rows that round out a full-session cost picture:
 *     registration::register, control_plane_registry::register_cp,
 *     validator_registry::register_validator,
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
 *     assign_relay (renamed from assign_relay_and_signaling) does NOT assign validators.
 *     With 1 active CP, `required = ceil(1 * 2/3) = 1`, so ONE CP proposal finalizes the
 *     room immediately (PENDING → READY) and writes assigned_validators.
 *   - submit_session_proof: sender = session wallet B (self_assign_session_wallet-bound);
 *     pubkey_public = validator MAIN wallet A (= registered operator; blake2b256(0x00||pk)
 *     must equal info_operator); pubkey_session = wallet B (blake2b256 must equal sender).
 *   - distribute_rewards: room must be CLOSED and `num_proofs >= min_proofs_for_distribution`
 *     (=2), AND per RO-023c a relay needs >= 2 DISTINCT-validator proofs to be "covered".
 *     This K=2/N=4 closure run retains all EIGHT assigned validator×relay proofs,
 *     giving each relay four distinct-validator attestations before distribution.
 *
 * Run:
 *   pnpm exec tsx scripts/eval/measure-onchain-cost.ts \
 *     --contracts-dir <isolated-17e1fce-snapshot> --run-id <id> [--out <new.jsonl>]
 *
 * Output:
 *   A caller-supplied or run-id-derived, write-once K=2/N=4 JSONL artifact.
 *   The legacy 2026-07-13 evidence path is explicitly rejected.
 *
 * NO git add / commit — measurement fixture only.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { LocalnetHandle } from '../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts';
import {
  createGraphQLClient,
  createLogger,
} from '../../packages/shared/src/index.ts';
import {
  bootstrapCp,
  voteAndApplyMiner,
  type CpHandle,
  type SeededKey,
} from '../demo/seed-bootstrap.ts';
import { validateK2ProofRows } from './cost-k2-evidence.ts';
import {
  assertLocalnetPortsFree,
  captureActiveSuiEnvironment,
  parseCostRunOptions,
  readFrameworkRevision,
  readGitState,
  readSuiCliVersion,
  resolveGitRef,
  restoreSuiEnvironment,
  writeTextExclusive,
} from './cost-run-safety.ts';
import {
  MODULE,
  K,
  N,
  type CostRow,
  type K2ProvenanceRow,
  netCost,
  measurePublish,
  measure,
} from './onchain-cost/tx-cost-helpers.ts';
import { measureRelayLifecycle } from './onchain-cost/measure-relay-lifecycle.ts';
import { measureDispatch2 } from './onchain-cost/measure-dispatch-proof.ts';

// ── output path (repo-relative, no hardcoded absolute) ───────────────────
const __filename = fileURLToPath(import.meta.url);
const HERE = resolve(__filename, '..'); // scripts/eval
const WORKSPACE_ROOT = resolve(HERE, '..', '..', '..'); // scripts/eval -> scripts -> dvconf-daemons -> workspace root
const DAEMONS_ROOT = resolve(HERE, '..', '..');
const CONTRACTS_SOURCE_ROOT = resolve(WORKSPACE_ROOT, 'dvconf-contracts');
const FRAMEWORK_REV = '94ad8ccd0ed6c089a9fe072ff80c918b5ab44943';
const CLI_VERSION = '1.66.2';

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  const rows: CostRow[] = [];
  const runOptions = parseCostRunOptions(process.argv.slice(2), WORKSPACE_ROOT);
  await assertLocalnetPortsFree();

  const frameworkRev = readFrameworkRevision(runOptions.contractsDir);
  if (frameworkRev !== FRAMEWORK_REV) {
    throw new Error(
      `contracts snapshot framework mismatch: expected ${FRAMEWORK_REV}, got ${frameworkRev}`,
    );
  }
  const suiCliVersion = readSuiCliVersion();
  if (!suiCliVersion.includes(CLI_VERSION)) {
    throw new Error(`Sui CLI mismatch: expected ${CLI_VERSION}, got ${suiCliVersion}`);
  }
  const workspaceGit = readGitState(WORKSPACE_ROOT);
  const daemonGit = readGitState(DAEMONS_ROOT);
  const contractsSourceGit = readGitState(CONTRACTS_SOURCE_ROOT);
  const contractCommit = resolveGitRef(CONTRACTS_SOURCE_ROOT, runOptions.contractRef);
  const previousSuiEnvironment = captureActiveSuiEnvironment();
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  // The fixture module reads these at module initialization, so import it only
  // after the isolated snapshot and keep-lock policy are set.
  process.env['DVCONF_CONTRACTS_DIR'] = runOptions.contractsDir;
  process.env['DVCONF_KEEP_MOVE_LOCK'] = '1';

  logger.info(
    {
      module: MODULE,
      action: 'boot',
      runId: runOptions.runId,
      outputPath: runOptions.outputPath,
      contractsDir: runOptions.contractsDir,
      contractCommit,
    },
    'booting localnet + publishing pinned contracts snapshot (1-3 min)...',
  );
  let handle: LocalnetHandle | null = null;
  try {
    const { bootLocalnet } = await import('../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts');
    // Generous port-wait headroom for a contended Windows host.
    handle = await bootLocalnet({ portWaitMs: 240_000 });
    const { client, config } = handle;
    // Event queries only (RoomCreated/EscrowCreated lookups below) -- no-op
    // on localnet's JSON-RPC (which already returns events populated), but
    // matches the same client shape devnet callers need.
    const graphqlClient = createGraphQLClient('localnet');

    logger.info({ module: MODULE, action: 'booted', packageId: config.packageId }, 'localnet up + package published');

    // ── provenance (protocol version + RGP) ──────────────────────────────
    const protocolConfig = await client.getProtocolConfig();
    const referenceGasPrice = await client.getReferenceGasPrice();
    logger.info(
      {
        module: MODULE,
        action: 'provenance',
        protocolVersion: String(protocolConfig.protocolVersion),
        rgp: String(referenceGasPrice),
        frameworkRev,
      },
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

    // ── register a validator via the sealed helper (state only) ──
    logger.info({ module: MODULE, action: 'seed_validator' }, 'seeding validator...');
    const validator: SeededKey = await voteAndApplyMiner(client, cp, 'validator', config, logger);
    const validatorKp = Ed25519Keypair.fromSecretKey(validator.secretKey);

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

    // ── 6. validator_registry::heartbeat (signed by validator miner) ────
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

    // ── 7. relay_registry::relay_heartbeat (signed by relay miner) ──────
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

    // ── 8. relay_registry::update_load (signed by relay miner) ──────────
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

    // ── 9. relay_registry::report_degradation (ad-hoc PTB) ─────────────
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
    await measureDispatch2(client, config, cp, relay, validator, validatorKp, rows, logger, graphqlClient);

    // ── write raw JSONL (provenance line first, then one line per fn) ────
    const proofRows = validateK2ProofRows(rows);
    const postPublishFrameworkRev = readFrameworkRevision(runOptions.contractsDir);
    if (postPublishFrameworkRev !== frameworkRev) {
      throw new Error(
        `pinned Move.lock changed during publish: before=${frameworkRev}, after=${postPublishFrameworkRev}`,
      );
    }
    const endedAtMs = Date.now();
    const endedAt = new Date(endedAtMs).toISOString();
    const provenance: K2ProvenanceRow = {
      meta: true,
      schema: 'dvconf-cost-k2/1.0',
      complete: true,
      K,
      N,
      proofCount: 8,
      runId: runOptions.runId,
      protocolVersion: String(protocolConfig.protocolVersion),
      referenceGasPrice: String(referenceGasPrice),
      frameworkRev,
      cliVersion: suiCliVersion,
      network: 'localnet',
      timestamp: endedAt,
      startedAt,
      endedAt,
      durationMs: endedAtMs - startedAtMs,
      workspaceCommit: workspaceGit.commit,
      workspaceDirty: workspaceGit.dirty,
      workspaceDirtyFingerprint: workspaceGit.dirtyFingerprint,
      contractCommit,
      contractsSourceDirty: contractsSourceGit.dirty,
      contractsSourceDirtyFingerprint: contractsSourceGit.dirtyFingerprint,
      contractsSnapshotDir: runOptions.contractsDir.replace(/\\/g, '/'),
      daemonCommit: daemonGit.commit,
      daemonDirty: daemonGit.dirty,
      daemonDirtyFingerprint: daemonGit.dirtyFingerprint,
    };

    const lines: string[] = [JSON.stringify(provenance)];
    for (const r of rows) {
      lines.push(JSON.stringify(r));
    }
    writeTextExclusive(runOptions.outputPath, `${lines.join('\n')}\n`);

    // ── console report table ────────────────────────────────────────────
    logger.info(
      {
        module: MODULE,
        action: 'write',
        outPath: runOptions.outputPath,
        rowCount: rows.length,
        proofCount: proofRows.length,
        dispatch1RowCount,
      },
      'write-once raw JSONL written',
    );
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
    process.stdout.write(`\nOUT: ${runOptions.outputPath}\n`);
  } finally {
    if (handle !== null) {
      logger.info({ module: MODULE, action: 'teardown' }, 'tearing down localnet...');
      await handle.teardown();
    }
    try {
      restoreSuiEnvironment(previousSuiEnvironment);
    } catch (error) {
      logger.error(
        { module: MODULE, action: 'restore_sui_env', error: error instanceof Error ? error.message : String(error) },
        'failed to restore pre-run Sui client environment',
      );
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${MODULE}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
