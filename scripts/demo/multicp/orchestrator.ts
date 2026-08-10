/**
 * Multi-CP Voting Live (N=5) — top-level orchestration module, extracted from
 * run-multicp-voting.ts (pure code movement, no behavior change): launchFleet
 * (the 3-wave bringup) and main() (C3 launch + the C4 live-demo seam). See
 * run-multicp-voting.ts for the full launcher-level doc comment.
 */

import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  waitForRoleAssignment,
  type Logger,
  type RoleAssigned,
  type RoleVoteCast,
  type RoomAssigned,
} from '../../../packages/shared/src/index.ts'; // relative SOURCE import — scripts/ sits OUTSIDE the pnpm workspace graph (mirrors seed-multicp.ts:56 / escrow-driver.ts:61).
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { MODULE, KEYS_PATH, WORKTREE_ROOT, EXPECTED_CPS, buildLaunchPlan } from './launch-plan.ts';
import {
  loadKeys,
  provisionUserMiner,
  spawnProcess,
  waitHealthy,
  teardownFleet,
  type ProcessHandle,
} from './process-lifecycle.ts';
import {
  ROLE_VOTE_TIMEOUT_MS,
  EVIDENCE_PATH,
  readActiveCpCount,
  queryMoveEvents,
  waitForRoomAssignment as waitForRoomAssignmentEvent,
  spawnEscrowDriver,
  writeLiveRunEvidence,
} from './live-demo.ts';
import {
  REQUIRED_QUORUM_AT_N5,
  assertRoleQuorum,
  assertPairingQuorum,
  summarizeRetryTails,
  type ProposalSubmittedJson,
} from './quorum-asserters.ts';

/**
 * Bring up the whole fleet in the 3 ordered waves with per-wave gates:
 *   1. all 5 CPs → wait healthy (every role-vote loop live before the miner votes)
 *   2. infra (4 val + 2 relay + 1 sig) in parallel → wait healthy
 *   3. user-miner LAST → spawn, then gate on the ROLE VOTE FINALIZING
 *      (waitForRoleAssignment), NOT on the user-miner's /healthz.
 * On any failure, tears down whatever was already spawned and rethrows (no orphans).
 *
 * WHY wave-3 gates on the role vote, not healthz: the user-miner's /healthz only
 * comes up AFTER register→vote→apply→register (validator-daemon ensureRegistered
 * BLOCKS on its own ≤120s waitForRoleAssignment before startHealthzServer). Gating
 * launch on healthz would couple success to that apply-side + 120s budget. Gating on
 * the vote finalizing instead proves #6 DIRECTLY and the LAUNCHER's wait is robust to
 * whatever scarce role the CPs derive. (The user-miner DAEMON, by contrast, is NOT
 * robust to a non-validator role or a 120-180s-tail vote — it can exit(1) AFTER #6;
 * that is benign and does not affect the proofs, which read on-chain events — see
 * main() step d.) Returns the user-miner ADDRESS (== its role-vote miner_id) so main()
 * observes #6/#7 without parsing a registration event.
 *
 * `handles` is caller-owned and pushed-into as each child spawns, so a SIGINT/
 * SIGTERM handler installed by main() can see + tear down the fleet even mid-wave.
 */
export async function launchFleet(
  logger: Logger,
  handles: ProcessHandle[] = [],
): Promise<{ handles: ProcessHandle[]; userMinerAddress: string }> {
  const config = loadNetworkConfig(); // also validates the published-config env is present
  const client = createSuiClient(config.rpcUrl);

  const keys = loadKeys(KEYS_PATH);
  const { secretKey: userMinerSecretKey, address: userMinerAddress } = await provisionUserMiner(client, logger);
  const plan = buildLaunchPlan(keys, userMinerSecretKey, process.env);

  const cpSpecs = plan.filter((s) => s.order === 'cp');
  const infraSpecs = plan.filter((s) => s.order === 'infra');
  const userMinerSpec = plan.find((s) => s.order === 'user-miner')!;

  try {
    // wave 1 — CPs first.
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'cp', count: cpSpecs.length } }, 'wave 1: spawning 5 cp-daemons');
    const cpHandles = cpSpecs.map((s) => spawnProcess(s, logger));
    handles.push(...cpHandles);
    await Promise.all(cpHandles.map((h) => waitHealthy(h)));

    // wave 2 — infra in parallel.
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'infra', count: infraSpecs.length } }, 'wave 2: spawning 4 validators + 2 relays');
    const infraHandles = infraSpecs.map((s) => spawnProcess(s, logger));
    handles.push(...infraHandles);
    await Promise.all(infraHandles.map((h) => waitHealthy(h)));

    // wave 3 — user-miner last, then gate on the ROLE VOTE finalizing (proves #6
    // directly). The user-miner registers as a User-role miner in voting mode; the
    // 5 CPs' role-voting loops discover it (MinerRegistered) and cast — the 4th
    // DISTINCT cast crosses the live 4-of-5 quorum and assigns. We do NOT wait on
    // its /healthz (which would couple launch to the apply-side + 120s budget).
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'user-miner', userMinerAddress } }, 'wave 3: spawning user-miner (voting mode)');
    const umHandle = spawnProcess(userMinerSpec, logger);
    handles.push(umHandle);
    logger.info({ module: MODULE, action: 'wait_role_vote', context: { userMinerAddress, timeoutMs: ROLE_VOTE_TIMEOUT_MS } }, 'wave 3 gate: awaiting the 4-of-5 role vote to finalize');
    await waitForRoleAssignment(client, config, userMinerAddress, logger, ROLE_VOTE_TIMEOUT_MS);

    return { handles, userMinerAddress };
  } catch (err) {
    logger.error({ module: MODULE, action: 'launch_failed', context: { spawned: handles.length } }, 'fleet launch failed — tearing down');
    await teardownFleet(handles, logger);
    throw err;
  }
}

export async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  logger.info(
    { module: MODULE, action: 'start', context: { keysPath: KEYS_PATH, worktreeRoot: WORKTREE_ROOT } },
    'run-multicp-voting starting — launching the 12-process N=5 fleet',
  );

  // main OWNS the handles so a Ctrl-C during the (up to 3×120s) bringup — or under
  // KEEP_ALIVE — can tear the fleet down instead of orphaning 13 children. The
  // array is threaded INTO launchFleet, which pushes each child as it spawns, so
  // the handler sees the fleet even mid-wave.
  const handles: ProcessHandle[] = [];
  let tearingDown = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (tearingDown) return; // de-dup a DIFFERENT signal mid-teardown (e.g. SIGTERM after SIGINT); handlers are `once`, so a repeat of the SAME signal isn't redelivered here → it hits Node's default = force-quit (the conventional double-Ctrl-C escape hatch)
    tearingDown = true;
    logger.warn({ module: MODULE, action: 'signal', context: { signal: sig, count: handles.length } }, `${sig} received — tearing down fleet`);
    void teardownFleet(handles, logger).finally(() => process.exit(130)); // 130 = terminated by signal (non-zero)
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const { userMinerAddress } = await launchFleet(logger, handles);
  logger.info(
    { module: MODULE, action: 'all_healthy', context: { count: handles.length, userMinerAddress } },
    `fleet up + role vote finalized — ${handles.length} processes (5 cp + 4 val + 2 relay + 1 sig + 1 user-miner)`,
  );

  // ───────────────────────── C4 SEAM ─────────────────────────
  // The live demo flows (between launch and teardown):
  //   (a) precondition  active_cp_count == 5 (fail-closed; canary-OFF determinism)
  //   (b) #6 role-vote  HARD-ASSERT the live 4-of-5 quorum on the user-miner
  //   (c) #7 pairing    escrow-driver → HARD-ASSERT the live 4-of-5 pairing quorum
  //   (d) benign-abort  every daemon still alive (fact G: retried-then-swallowed)
  //   (e) evidence      write the finalize digests + distinct sets (guarded)
  // On any failure the fleet is torn down before rethrow (no orphans).
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  try {
    // (a) precondition — the genuine N=5 substrate on-chain (fact E). Fail-closed.
    const activeCpCount = await readActiveCpCount(client, config);
    if (activeCpCount !== EXPECTED_CPS) {
      throw new Error(`C4 precondition: active_cp_count=${activeCpCount}, expected ${EXPECTED_CPS} — substrate is not the genuine N=5`);
    }
    // (fact F) The infeasible "all 5 CPs' relayState/validatorState equal" assert is
    // replaced by STRUCTURAL determinism: canary is off UNLESS a CANARY_* var is present
    // in the launching environment (buildLaunchPlan sets none, and mergeChildEnv scrubs
    // only IDENTITY_ENV_KEYS — NOT CANARY_* — so children inherit any exported CANARY_*),
    // and every CP reads the SAME on-chain state under this active_cp_count==5
    // precondition, so all 5 derive identical scores. No fake equality assert is made.
    logger.info({ module: MODULE, action: 'precondition', context: { activeCpCount } }, `precondition OK: active_cp_count=${activeCpCount}`);

    // (b) #6 — the vote already finalized during wave 3; re-confirm, then read the
    // events the DAEMONS submitted (queryEvents, not our own TX) and HARD-ASSERT.
    await waitForRoleAssignment(client, config, userMinerAddress, logger, 30_000);
    const assignedEvents = await queryMoveEvents(client, config, 'role_voting::RoleAssigned');
    const assignedEvent = assignedEvents.find(
      (e) => e.parsedJson != null && normalizeSuiAddress((e.parsedJson as RoleAssigned).miner_id) === normalizeSuiAddress(userMinerAddress),
    );
    if (!assignedEvent) {
      throw new Error(`C4 #6: no RoleAssigned event found for user-miner ${userMinerAddress}`);
    }
    const castEvents = await queryMoveEvents(client, config, 'role_voting::RoleVoteCast');
    const casts = castEvents.filter((e) => e.parsedJson != null).map((e) => e.parsedJson as RoleVoteCast);
    const role = assertRoleQuorum(assignedEvent.parsedJson as RoleAssigned, casts, userMinerAddress, REQUIRED_QUORUM_AT_N5);
    const roleTxDigest = assignedEvent.id.txDigest;
    logger.info(
      { module: MODULE, action: 'role_quorum', context: { role: role.role, voteCount: role.voteCount, threshold: role.threshold, voters: role.voters, txDigest: roleTxDigest } },
      `#6 PASS: live 4-of-5 role vote — vote_count=${role.voteCount}, threshold=${role.threshold}, ${role.voters.length} distinct voters`,
    );

    // (c) #7 — drive the escrow → CP pairing vote, wait for RoomAssigned, HARD-ASSERT.
    const roomId = await spawnEscrowDriver(logger);
    const roomEvent = await waitForRoomAssignmentEvent(client, config, roomId, logger);
    const proposalEvents = await queryMoveEvents(client, config, 'room_manager::ProposalSubmitted');
    const proposals = proposalEvents
      .filter((e) => e.parsedJson != null)
      .map((e) => e.parsedJson as ProposalSubmittedJson)
      .filter((p) => normalizeSuiAddress(p.room_id) === normalizeSuiAddress(roomId));
    const pairing = assertPairingQuorum(roomEvent.parsedJson as RoomAssigned, proposals, REQUIRED_QUORUM_AT_N5);
    const roomTxDigest = roomEvent.id.txDigest;
    logger.info(
      { module: MODULE, action: 'pairing_quorum', context: { winningCp: pairing.winningCp, winningScore: pairing.winningScore, agreeingCpIds: pairing.agreeingCpIds, txDigest: roomTxDigest } },
      `#7 PASS: live 4-of-5 pairing — ${pairing.agreeingCpIds.length} distinct CPs share score ${pairing.winningScore}`,
    );

    // (d) benign-abort (fact G, honest) — a deterministic Move abort (704/711/719/508)
    // is RETRIED 5× then SWALLOWED by executeWithRetry (null, no throw), so NO CP-FLEET
    // daemon should have crashed. The gate EXCLUDES the user-miner: it is the vote
    // SUBJECT, not part of the swallowing fleet, and can legitimately exit(1) AFTER #6
    // — (a) its ensureRegistered uses the DEFAULT 120s waitForRoleAssignment
    // (auto-register.ts:123) vs the launcher's 180s gate, so a vote landing in the
    // 120-180s tail times out the daemon's wait; (b) it stakes a FIXED 0.1 SUI
    // (auto-register.ts:59), so a role whose floor > 0.1 (relay 0.25 / cp 0.5) aborts
    // apply_voted_role(713) / the follow-on register. NONE of that affects #6/#7, which
    // are proven by the on-chain events, NOT by the subject daemon staying up. So we GATE
    // on the CP fleet, and LOG (not fail on) the user-miner's post-vote exit. The tail
    // retry summary is diagnostic only, NOT a gate.
    const fleet = handles.filter((h) => h.spec.order !== 'user-miner');
    const crashed = fleet.filter((h) => h.proc.exitCode !== null);
    if (crashed.length > 0) {
      throw new Error(
        `C4 benign-abort: ${crashed.map((h) => `${h.spec.name}(exit=${h.proc.exitCode})`).join(', ')} exited during the demo`,
      );
    }
    const userMinerExit = handles.find((h) => h.spec.order === 'user-miner')?.proc.exitCode ?? null;
    if (userMinerExit !== null) {
      logger.warn(
        { module: MODULE, action: 'benign_abort', context: { userMinerExit } },
        `user-miner (vote SUBJECT) exited post-#6 with code=${userMinerExit} — EXPECTED when the vote lands in the 120-180s tail or the assigned role's stake floor > 0.1 SUI; does NOT affect the #6/#7 proofs (read from on-chain events)`,
      );
    }
    const retries = summarizeRetryTails(handles.map((h) => h.tail));
    logger.info(
      { module: MODULE, action: 'benign_abort', context: { fleetAlive: fleet.length, userMinerExit, retries } },
      `benign-abort OK: all ${fleet.length} CP-fleet daemons alive (user-miner exit=${userMinerExit ?? 'alive'}; retry traces: retrying=${retries.retrying}, exhausted=${retries.exhausted})`,
    );

    // (e) evidence — guarded so a write failure does not void the passing asserts.
    try {
      writeLiveRunEvidence({
        activeCpCount,
        role,
        roleTxDigest,
        pairing,
        roomTxDigest,
        roomId,
        userMinerAddress,
        fleetCount: fleet.length,
        userMinerExit,
        retries,
      });
      logger.info({ module: MODULE, action: 'evidence', context: { path: EVIDENCE_PATH } }, `live-run evidence written → ${EVIDENCE_PATH}`);
    } catch (err) {
      logger.warn(
        { module: MODULE, action: 'evidence', context: { path: EVIDENCE_PATH, err: err instanceof Error ? err.message : String(err) } },
        'live-run evidence write failed (non-fatal — the asserts above already passed)',
      );
    }

    logger.info({ module: MODULE, action: 'demos_passed' }, 'C4 live demos PASSED (#6 role-vote 4-of-5 + #7 pairing 4-of-5)');
  } catch (err) {
    logger.error({ module: MODULE, action: 'demo_failed' }, 'C4 live demo failed — tearing down fleet');
    await teardownFleet(handles, logger);
    throw err;
  }
  // ────────────────────────────────────────────────────────────

  if (process.env['KEEP_ALIVE'] === '1') {
    // The SIGINT/SIGTERM handler installed above stays armed → "SIGINT to stop"
    // actually tears the fleet down. The piped child stdio keeps the event loop alive.
    logger.info({ module: MODULE, action: 'keep_alive' }, 'KEEP_ALIVE=1 — demos passed; leaving the fleet running (SIGINT to tear down)');
    return;
  }
  await teardownFleet(handles, logger);
  logger.info({ module: MODULE, action: 'done', context: { count: handles.length } }, 'fleet torn down — C4 live demo run complete');
}
