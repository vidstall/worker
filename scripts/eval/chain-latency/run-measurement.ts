/**
 * Top-level orchestration for the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import type { LocalnetHandle } from '../../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts';
import {
  createLogger,
  EventPoller,
} from '../../../packages/shared/src/index.ts';
import {
  assertLocalnetPortsFree,
  captureActiveSuiEnvironment,
  readFrameworkRevision,
  readGitState,
  readSuiCliVersion,
  restoreSuiEnvironment,
} from '../cost-run-safety.ts';
import {
  parseChainLatencyEvidence,
  validateChainLatencyBundle,
} from '../chain-latency-evidence.ts';

import {
  CLIENT_ROOT,
  CONTRACTS_SOURCE_ROOT,
  DAEMONS_ROOT,
  EVENT_TIMEOUT_MS,
  MODULE,
  PINNED_CONTRACT_REF,
  PINNED_FRAMEWORK_REV,
  PINNED_SUI_CLI,
  POLL_INTERVAL_MS,
  PROOFS_PER_ROOM,
  SCHEMA_VERSION,
  WORKSPACE_ROOT,
  ESCROW_AMOUNT_MIST,
  EXPECTED_RELAYS,
  EXPECTED_VALIDATORS,
} from './constants.ts';
import { measureCreate } from './create-phase.ts';
import {
  activeSuiAddress,
  activeSuiEnvironment,
  assertLocalCliEnvironment,
  assertOfficialHarnessScopeClean,
  gitStatus,
  sha256File,
  switchToCheckedLocalEnvironment,
  verifyContractsSnapshot,
  waitForPortsClosed,
  writeExclusive,
} from './env-checks.ts';
import { ExactEventMatcher, ExclusiveJsonlWriter, RunLog } from './event-matcher.ts';
import { measureSettlement } from './settle-phase.ts';
import { assertEscrowState, buildRoster, closeRoom, createEscrow, submitAllProofs, submitPairing } from './tx-helpers.ts';
import type { ChainLatencyOptions, SampleRecord } from './types.ts';
import { asError, nowPair, sleep } from './util.ts';

export async function runMeasurement(options: ChainLatencyOptions): Promise<void> {
  mkdirSync(options.outputRoot, { recursive: true });
  mkdirSync(options.runDir, { recursive: false });
  mkdirSync(resolve(options.runDir, 'cursors'), { recursive: false });

  const rawPath = resolve(options.runDir, 'chain-latency.jsonl');
  const eventsPath = resolve(options.runDir, 'observed-events.jsonl');
  const runLogPath = resolve(options.runDir, 'run.log');
  const gitStatusPath = resolve(options.runDir, 'git-status.txt');
  const manifestPath = resolve(options.runDir, 'manifest.json');
  const failurePath = resolve(options.runDir, 'failure.json');
  let rawWriter: ExclusiveJsonlWriter | null = null;
  const eventWriter = new ExclusiveJsonlWriter(eventsPath);
  const runLog = new RunLog(runLogPath);
  const logger = createLogger(MODULE);

  const previousSuiEnvironment = captureActiveSuiEnvironment();
  const previousSuiAddress = activeSuiAddress();
  let handle: LocalnetHandle | null = null;
  let roomPoller: EventPoller | null = null;
  let economicPoller: EventPoller | null = null;
  let primaryFailure: Error | null = null;
  let completed = false;
  let suiEnvironmentRestored = false;
  const sampleRecords: SampleRecord[] = [];

  try {
    runLog.write('preflight-start', { mode: options.mode, samples: options.samples });
    if (options.mode === 'official') assertOfficialHarnessScopeClean();
    await assertLocalnetPortsFree();
    if (previousSuiEnvironment === null) {
      throw new Error('refusing run without a restorable active Sui environment');
    }
    const checkedLocalEnvironment = switchToCheckedLocalEnvironment();

    const snapshot = verifyContractsSnapshot(options.contractsDir, options.contractRef);
    if (snapshot.commit !== PINNED_CONTRACT_REF) {
      throw new Error(`contract commit mismatch: expected ${PINNED_CONTRACT_REF}, got ${snapshot.commit}`);
    }
    const frameworkRev = readFrameworkRevision(options.contractsDir);
    if (frameworkRev !== PINNED_FRAMEWORK_REV) {
      throw new Error(`framework pin mismatch: expected ${PINNED_FRAMEWORK_REV}, got ${frameworkRev}`);
    }
    const suiCliVersion = readSuiCliVersion();
    if (!suiCliVersion.includes(PINNED_SUI_CLI)) {
      throw new Error(`Sui CLI mismatch: expected ${PINNED_SUI_CLI}, got ${suiCliVersion}`);
    }

    const statusText = [
      '=== root ===',
      gitStatus(WORKSPACE_ROOT),
      '=== daemons ===',
      gitStatus(DAEMONS_ROOT),
      '=== contracts-source ===',
      gitStatus(CONTRACTS_SOURCE_ROOT),
      '=== client ===',
      gitStatus(CLIENT_ROOT),
      '',
    ].join('\n');
    writeExclusive(gitStatusPath, statusText);

    const rootGit = readGitState(WORKSPACE_ROOT);
    const daemonGit = readGitState(DAEMONS_ROOT);
    const contractSourceGit = readGitState(CONTRACTS_SOURCE_ROOT);
    const clientGit = readGitState(CLIENT_ROOT);
    const startedAt = nowPair();

    process.env['DVCONF_CONTRACTS_DIR'] = options.contractsDir;
    process.env['DVCONF_KEEP_MOVE_LOCK'] = '1';
    const { bootLocalnet } = await import(
      '../../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts'
    );
    runLog.write('localnet-boot-start');
    handle = await bootLocalnet({ epochDurationMs: 86_400_000, portWaitMs: 240_000 });
    const activeLocalAlias = assertLocalCliEnvironment(handle);
    const { client, config } = handle;
    const chainIdentifier = await client.getChainIdentifier();
    const protocolConfig = await client.getProtocolConfig();
    const referenceGasPrice = await client.getReferenceGasPrice();
    runLog.write('localnet-boot-complete', {
      activeLocalAlias,
      chainIdentifier,
      packageId: config.packageId,
    });

    const roster = await buildRoster(client, config, logger);
    runLog.write('roster-complete', {
      relays: roster.relayIds.length,
      validators: roster.validators.length,
      proofsPerRoom: PROOFS_PER_ROOM,
    });

    const roomCreatedType = `${config.packageId}::room_manager::RoomCreated`;
    const rewardsDistributedType = `${config.packageId}::economic_layer::RewardsDistributed`;
    const matcher = new ExactEventMatcher(
      new Set([roomCreatedType, rewardsDistributedType]),
      eventWriter,
      options.runId,
      options.traceId,
    );
    roomPoller = new EventPoller({
      client,
      packageId: config.packageId,
      module: 'room_manager',
      pollingIntervalMs: POLL_INTERVAL_MS,
      cursorPath: resolve(options.runDir, 'cursors', 'room-manager.json'),
      logger,
    });
    economicPoller = new EventPoller({
      client,
      packageId: config.packageId,
      module: 'economic_layer',
      pollingIntervalMs: POLL_INTERVAL_MS,
      cursorPath: resolve(options.runDir, 'cursors', 'economic-layer.json'),
      logger,
    });
    await Promise.all([
      roomPoller.start(async (event) => matcher.observe(event)),
      economicPoller.start(async (event) => matcher.observe(event)),
    ]);

    const metaRecord = {
      schema_version: SCHEMA_VERSION,
      record_type: 'meta',
      complete: true,
      run_id: options.runId,
      trace_id: options.traceId,
      mode: options.mode,
      network: 'localnet',
      sample_target: options.samples,
      expected_samples_per_metric: options.samples,
      poll_interval_ms: POLL_INTERVAL_MS,
      event_timeout_ms: EVENT_TIMEOUT_MS,
      observer_path: 'production_event_poller',
      execution_order: 'sequential',
      lifecycle_order: 'create -> escrow -> pairing -> eight proofs -> close -> distribute',
      shared_state_disclosure: 'one persistent localnet, one shared roster, one registered user, and shared registries across all samples',
      warm_cache_disclosure: 'sample order is fixed and later samples may observe warm RPC, object, and process caches plus growing shared state',
      independence_boundary: 'repeated transactions on one persistent localnet; not independent sessions',
      submit_boundary: 'immediately before SuiClient.signAndExecuteTransaction call; includes SDK transaction build/sign and RPC execution',
      availability_boundary: 'finality_return_* records waitForTransaction/getTransactionBlock availability, NOT consensus/mainnet finality',
      started_at: startedAt.wallIso,
      completed_at: null as string | null,
      performance_time_origin_ms: performance.timeOrigin,
      command_argv: process.argv,
      canonical_invocation: `pnpm.cmd exec tsx scripts/eval/measure-chain-latency.ts --contracts-dir ${options.contractsDir.replace(/\\/g, '/')} --contract-ref ${options.contractRef} --run-id ${options.runId} --trace-id ${options.traceId} --samples ${options.samples} --output-root ${options.outputRoot.replace(/\\/g, '/')}`,
      package_id: config.packageId,
      framework_rev: frameworkRev,
      sui_cli_version: suiCliVersion,
      daemon_commit: daemonGit.commit,
      contract_commit: snapshot.commit,
      pins: {
        root: rootGit,
        daemons: daemonGit,
        contracts_source: contractSourceGit,
        client: clientGit,
        contract_commit: snapshot.commit,
        framework_revision: frameworkRev,
        sui_cli_version: suiCliVersion,
      },
      contracts_snapshot: {
        path: options.contractsDir.replace(/\\/g, '/'),
        tracked_file_count: snapshot.trackedFileCount,
        tree_sha256: snapshot.treeSha256,
      },
      chain: {
        identifier: chainIdentifier,
        protocol_version: String(protocolConfig.protocolVersion),
        reference_gas_price: String(referenceGasPrice),
        rpc_url: config.rpcUrl,
        package_id: config.packageId,
        network_registry_id: config.networkRegistryId,
        miner_store_id: config.minerStoreId,
        role_vote_box_id: config.roleVoteBoxId,
        user_registry_id: config.userRegistryId,
        room_manager_id: config.roomManagerId,
        relay_registry_id: config.relayRegistryId,
        cp_registry_id: config.cpRegistryId,
        validator_registry_id: config.validatorRegistryId,
      },
      topology: {
        cp: 1,
        relays: EXPECTED_RELAYS,
        validators: EXPECTED_VALIDATORS,
        registered_users: 1,
        proofs_per_room: PROOFS_PER_ROOM,
        escrow_amount_mist: ESCROW_AMOUNT_MIST.toString(),
      },
      sui_environment: {
        before_alias: previousSuiEnvironment,
        before_address: previousSuiAddress,
        checked_preboot_alias: checkedLocalEnvironment.alias,
        checked_preboot_rpc: checkedLocalEnvironment.rpc,
        local_alias: activeLocalAlias,
        local_address: activeSuiAddress(),
      },
    };

    const seenDigests = new Set<string>();
    const seenRooms = new Set<string>();
    const seenEscrows = new Set<string>();
    for (let sampleIndex = 1; sampleIndex <= options.samples; sampleIndex += 1) {
      runLog.write('sample-start', { sampleIndex });
      const create = await measureCreate(
        client,
        config,
        roster,
        matcher,
        options,
        sampleIndex,
      );
      if (seenDigests.has(create.record.tx_digest)) {
        throw new Error(`duplicate measured digest: ${create.record.tx_digest}`);
      }
      if (seenRooms.has(create.roomId)) throw new Error(`duplicate room id: ${create.roomId}`);
      seenDigests.add(create.record.tx_digest);
      seenRooms.add(create.roomId);
      sampleRecords.push(create.record);

      const escrowId = await createEscrow(client, config, roster.userKp, create.roomId);
      if (seenEscrows.has(escrowId)) throw new Error(`duplicate escrow id: ${escrowId}`);
      seenEscrows.add(escrowId);
      await assertEscrowState(client, escrowId, create.roomId, false);
      await submitPairing(client, config, roster, create.roomId);
      await submitAllProofs(client, config, roster, escrowId, create.roomId);
      await closeRoom(client, config, roster.userKp, create.roomId);
      const settle = await measureSettlement(
        client,
        config,
        roster,
        matcher,
        options,
        sampleIndex,
        create.roomId,
        escrowId,
      );
      if (seenDigests.has(settle.tx_digest)) {
        throw new Error(`duplicate measured digest: ${settle.tx_digest}`);
      }
      seenDigests.add(settle.tx_digest);
      sampleRecords.push(settle);
      await assertEscrowState(client, escrowId, create.roomId, true);
      runLog.write('sample-complete', {
        sampleIndex,
        roomId: create.roomId,
        escrowId,
        createMs: create.record.value_ms,
        settleMs: settle.value_ms,
      });
    }

    matcher.assertDrained();
    const matcherStats = matcher.stats();
    const expectedTargetEvents = options.samples * 2;
    if (matcherStats.targetEventCount !== expectedTargetEvents) {
      throw new Error(
        `target event coverage mismatch: got ${matcherStats.targetEventCount}, expected ${expectedTargetEvents}`,
      );
    }
    if (seenRooms.size !== options.samples || seenEscrows.size !== options.samples) {
      throw new Error(
        `identity coverage mismatch: rooms=${seenRooms.size}, escrows=${seenEscrows.size}, expected=${options.samples}`,
      );
    }
    if (seenDigests.size !== options.samples * 2) {
      throw new Error(
        `measured digest coverage mismatch: got ${seenDigests.size}, expected ${options.samples * 2}`,
      );
    }

    roomPoller.stop();
    economicPoller.stop();
    roomPoller = null;
    economicPoller = null;
    await sleep(100);
    eventWriter.close();
    const endedAt = nowPair();

    if (handle === null) throw new Error('localnet handle missing before teardown');
    await handle.teardown();
    await waitForPortsClosed();
    handle = null;
    restoreSuiEnvironment(previousSuiEnvironment);
    const restoredEnvironment = activeSuiEnvironment();
    if (restoredEnvironment !== previousSuiEnvironment) {
      throw new Error(
        `Sui environment restore mismatch: expected ${previousSuiEnvironment}, got ${restoredEnvironment ?? '(none)'}`,
      );
    }
    const restoredAddress = activeSuiAddress();
    if (previousSuiAddress !== null && restoredAddress !== previousSuiAddress) {
      throw new Error(
        `Sui address restore mismatch: expected ${previousSuiAddress}, got ${restoredAddress ?? '(none)'}`,
      );
    }
    suiEnvironmentRestored = true;

    // Persist publishable evidence only after teardown and Sui-client restoration
    // both succeed. A cleanup failure therefore leaves diagnostics + failure.json,
    // but no self-declared complete raw distribution or manifest.
    rawWriter = new ExclusiveJsonlWriter(rawPath);
    rawWriter.write({ ...metaRecord, completed_at: endedAt.wallIso });
    for (const record of sampleRecords) rawWriter.write(record);
    rawWriter.close();
    rawWriter = null;
    runLog.write('measurement-data-complete', {
      sampleRecords: sampleRecords.length,
      rawSha256: sha256File(rawPath),
      restoredSuiEnvironment: restoredEnvironment,
      restoredSuiAddress: restoredAddress,
    });
    runLog.close();
    const rawText = readFileSync(rawPath, 'utf8');
    parseChainLatencyEvidence(rawText);
    const manifest = {
      schema_version: SCHEMA_VERSION,
      run_id: options.runId,
      trace_id: options.traceId,
      complete: true,
      publishable: options.mode === 'official',
      mode: options.mode,
      started_at: startedAt.wallIso,
      ended_at: endedAt.wallIso,
      duration_ms: endedAt.monoMs - startedAt.monoMs,
      samples: {
        L_chain_create: options.samples,
        L_chain_settle: options.samples,
      },
      malformed_count: 0,
      excluded_count: 0,
      matcher: matcherStats,
      cleanup: {
        localnet_ports_closed: true,
        restored_sui_environment: restoredEnvironment,
        restored_sui_address: restoredAddress,
      },
      poll_interval_ms: POLL_INTERVAL_MS,
      event_timeout_ms: EVENT_TIMEOUT_MS,
      artifact_sha256: {
        'chain-latency.jsonl': sha256File(rawPath),
        'observed-events.jsonl': sha256File(eventsPath),
        'git-status.txt': sha256File(gitStatusPath),
        'run.log': sha256File(runLogPath),
      },
      limitations: [
        'One persistent single-host Sui localnet; no mainnet or WAN finality claim.',
        'Sequential warm-state transactions share registries, process, RPC, caches, and execution order.',
        'The unchanged shared EventPoller is exercised at 5000 ms; this is not the React browser hook or UI latency.',
        'The distribution includes the configured client polling cadence.',
        'finality_return_* records waitForTransaction/getTransactionBlock availability on this localnet, not consensus or mainnet finality.',
        'RewardsDistributed carries room_id but no escrow_id; escrow identity is retained from the submitted PTB and checked against the on-chain RoomEscrow before and after distribution.',
        'Create and settlement are reported separately and do not imply join, revocation, failover recovery, or a sub-second guarantee.',
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    validateChainLatencyBundle({
      'chain-latency.jsonl': rawText,
      'observed-events.jsonl': readFileSync(eventsPath, 'utf8'),
      'manifest.json': manifestText,
      'git-status.txt': readFileSync(gitStatusPath, 'utf8'),
      'run.log': readFileSync(runLogPath, 'utf8'),
    });
    writeExclusive(manifestPath, manifestText);
    completed = true;
  } catch (error) {
    primaryFailure = asError(error);
    runLog.write('measurement-failed', { error: primaryFailure.stack ?? primaryFailure.message });
    throw primaryFailure;
  } finally {
    try {
      roomPoller?.stop();
      economicPoller?.stop();
    } catch (error) {
      primaryFailure ??= asError(error);
    }
    try {
      rawWriter?.close();
    } catch (error) {
      primaryFailure ??= asError(error);
    }
    try {
      eventWriter.close();
    } catch (error) {
      primaryFailure ??= asError(error);
    }
    if (handle !== null) {
      try {
        await handle.teardown();
        await waitForPortsClosed();
      } catch (error) {
        primaryFailure ??= new Error(`localnet teardown failed: ${asError(error).message}`);
      }
    }
    if (!suiEnvironmentRestored) {
      try {
        restoreSuiEnvironment(previousSuiEnvironment);
        const restored = activeSuiEnvironment();
        if (previousSuiEnvironment !== null && restored !== previousSuiEnvironment) {
          throw new Error(
            `Sui environment restore mismatch: expected ${previousSuiEnvironment}, got ${restored ?? '(none)'}`,
          );
        }
        suiEnvironmentRestored = true;
      } catch (error) {
        primaryFailure ??= new Error(`Sui environment restore failed: ${asError(error).message}`);
      }
    }
    if (!completed && !existsSync(failurePath)) {
      try {
        writeExclusive(failurePath, `${JSON.stringify({
          schema_version: SCHEMA_VERSION,
          run_id: options.runId,
          trace_id: options.traceId,
          complete: false,
          failed_at: new Date().toISOString(),
          error: primaryFailure?.stack ?? primaryFailure?.message ?? 'unknown failure',
          command_argv: process.argv,
          previous_sui_environment: previousSuiEnvironment,
          restored_sui_environment: activeSuiEnvironment(),
        }, null, 2)}\n`);
      } catch {
        // The exclusive run directory and console error remain as the failure trace.
      }
    }
    runLog.close();
    if (primaryFailure !== null && completed) throw primaryFailure;
  }
}
