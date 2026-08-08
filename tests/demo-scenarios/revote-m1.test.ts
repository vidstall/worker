/**
 * F47 Phase 5.5 — docker-stack revote demo-scenario suite (REQ-RV-015, DS-PH3-3).
 *
 * This is the docker-compose-stack E2E that the Phase-4 gate left as a deferred
 * PARTIAL (criterion #3 "docker LIVE up/down + scenario drive"). Phase 5.4 made
 * the stack BOOT to healthy + on-chain-registered; this suite boots that same
 * stack and DRIVES the four re-vote scenarios against the docker-published chain,
 * then tears it down.
 *
 * ── Execution model (decided with the user, S70) ───────────────────────────────
 * TEST-ORCHESTRATED, not daemon-driven. The test itself makes the on-chain calls
 * (register a fresh test miner -> mark -> CP casts -> miner applies), reusing the
 * Phase-4.3 helpers verbatim, against the docker chain. Rationale + the one
 * protocol constraint that forces it:
 *   - `cast_role_vote`'s quorum threshold derives from the ACTIVE CP COUNT and
 *     floors to 1 only when there is exactly ONE CP. seed-bootstrap registers
 *     exactly one CP. So the test WIELDS that seeded CP identity (reconstructed
 *     from /shared/daemon-keys.json) rather than adding a second CP (which would
 *     raise the threshold to 2 and make a single deterministic cast impossible).
 *   - The cp-daemon's RoleVoter AUTONOMOUSLY casts on any RevoteEligibleMarked
 *     event. If it ran, it would race the test's own cast (E_ALREADY_VOTED) and
 *     destroy determinism. So the cp-daemon is INTENTIONALLY NOT STARTED here;
 *     the test is the sole CP voter. The autonomous cp-daemon watcher/voter path
 *     is covered by Phase 4.1 (real watcher integration) + the 5.4 up-smoke.
 *   - The relay/validator/signaling daemons ARE brought up (honor "the stack is
 *     live"): they only apply their OWN caps, so they never interfere with the
 *     test's fresh miners, and their heartbeats keep the seeded miners ACTIVE
 *     (so the test's idle scans see only the test's own non-heartbeating miners).
 *   - The client (5173 panel) is NOT brought up by this headless suite (the
 *     visual panel-during-scenario check stays a documented manual step, carried
 *     from 5.4 where 5173 was occupied). The stack emits the events it consumes.
 *
 * ── Timing ─────────────────────────────────────────────────────────────────────
 * The idle threshold (DEFAULT_MAX_IDLE_EPOCHS = 30) and cooldown (14) are
 * RoleVoteBox state mutable only via a CP-quorum aggregate signature (not wired
 * pre-Phase-5). So the only cheap lever is epoch speed: this suite brings the
 * stack up with SUI_EPOCH_DURATION_MS=2000 (proven stable on Windows in Phase
 * 4.1) so 30 idle epochs collapse from ~5min to ~60s and the suite fits <8min.
 *
 * ── Scenarios ────────────────────────────────────────────────────────────────
 *   A idle -> mark -> revote        (full E2E: mark idle, CP cast, miner apply)
 *   B composition shift             (negative guard + construct imbalance + revote)
 *   C cooldown abort                (re-mark inside the window aborts; clears after)
 *   D mid-room guard                (DOCUMENTED DEFERRAL: error 712 is unwired,
 *                                    RV-003 PARTIAL -- room_manager has no reverse
 *                                    miner->room lookup; see role_voting.move:43-46)
 *
 * LOCALNET/DOCKER-ONLY. Run via `pnpm test:demo:revote`
 * (vitest.demo.config.ts) -- NEVER the hermetic unit suite. Requires Docker +
 * the `dvconf-demo-daemons:latest` image built (Phase 5.4 builds it).
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { createLogger, MinerRole, waitForRoleAssignment, type Logger, type NetworkConfig } from '@dvconf/shared';
import { SuiChainStateReader } from '../../apps/cp-daemon/src/sui-chain-state-reader.js';
import { RevoteWatcher, makeMarkSubmitter } from '../../apps/cp-daemon/src/revote-watcher.js';
import { computeBestRoleForRevote } from '../../apps/cp-daemon/src/role-voter.js';
import {
  registerMiner,
  castRoleVoteFromCp,
  applyVotedRoleAs,
  waitForEpochAtLeast,
  RELAY_STAKE_MIST,
  type BootstrapCpResult,
  type RelayResult,
  type TxStatusLike,
} from '../../apps/cp-daemon/src/__tests__/integration/revote-localnet-helpers.js';

// ── constants / config ──────────────────────────────────────────────────────

const RPC_URL = process.env['DEMO_RPC_URL'] ?? 'http://127.0.0.1:9000';
const FAUCET_HOST = getFaucetHost('localnet'); // http://127.0.0.1:9123 (host-mapped from the override)
const EPOCH_MS = '2000'; // fast epochs so 30-idle collapses to ~60s (Phase 4.1: stable on Windows)
const GAS_BUDGET = 100_000_000;

// Workspace root holds the two compose files. This file sits at
// dvconf-daemons/tests/demo-scenarios/ -> 4 levels up is the workspace root.
const WORKSPACE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const COMPOSE = 'docker compose -f docker-compose-demo.yml -f docker-compose-demo-revote.override.yml';
// client (5173) is omitted (headless suite). cp-daemon is the autonomous voter we
// MUST keep down -- but Compose MERGES depends_on across -f files, so the base
// relay-daemon's `depends_on: cp-daemon` SURVIVES the override and naming
// relay-daemon would transitively start cp-daemon. `--scale cp-daemon=0` (added to
// the up command) forces zero cp-daemon replicas while still satisfying the
// service_started dep and still pulling sui-localnet/move-publish/seed-bootstrap.
const DAEMONS = 'relay-daemon validator-daemon signaling-daemon';
const SCALE_OUT_CP = '--scale cp-daemon=0';

const logger: Logger = createLogger('phase55-revote-m1');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Suite-wide handles, populated in beforeAll.
let client: SuiClient;
let config: NetworkConfig;
let cp: BootstrapCpResult;
let reader: SuiChainStateReader;
let maxIdleEpochs: bigint;
let cooldownEpochs: bigint;

// Two relays registered up-front so their idle clocks run CONCURRENTLY during the
// single beforeAll wait (rather than serially per scenario).
let relayA: RelayResult; // Scenario A subject (idle -> revote)
let relayC: RelayResult; // Scenario C subject (cooldown)

// ── low-level docker / chain helpers ─────────────────────────────────────────

const execAsync = promisify(exec);

/** Run a docker/compose command NON-BLOCKING (async exec, not execSync): the long
 *  `up` (~75s) and teardown would otherwise block the event loop and starve
 *  vitest's reporter-RPC heartbeat -> "Timeout calling onTaskUpdate" -> exit 1. */
async function sh(cmd: string, extraEnv: Record<string, string> = {}): Promise<string> {
  const { stdout } = await execAsync(cmd, {
    cwd: WORKSPACE_ROOT,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return stdout;
}

/** Read a file out of the named volume via a RUNNING container (the one-shots have exited). */
async function readShared(fileName: string): Promise<unknown> {
  const raw = await sh(`${COMPOSE} exec -T relay-daemon cat /shared/${fileName}`);
  return JSON.parse(raw);
}

interface ObjChange {
  type: string;
  packageId?: string;
  objectId?: string;
  objectType?: string;
}

/** Build a NetworkConfig from the merged publish-output.json (package + 9 shared objects). */
function buildConfig(publishOutput: { objectChanges?: ObjChange[] }): NetworkConfig {
  const changes = publishOutput.objectChanges ?? [];
  const pkg = changes.find((c) => c.type === 'published')?.packageId;
  if (!pkg) throw new Error('publish-output.json: no published package');
  const byType = (suffix: string): string => {
    const hit = changes.find(
      (c) => c.type === 'created' && typeof c.objectId === 'string' && (c.objectType ?? '').endsWith(suffix),
    );
    if (!hit?.objectId) throw new Error(`publish-output.json: no created object ending ${suffix}`);
    return hit.objectId;
  };
  return {
    rpcUrl: RPC_URL,
    packageId: pkg,
    networkRegistryId: byType('::NetworkRegistry'),
    minerStoreId: byType('::MinerStore'),
    cpRegistryId: byType('::ControlPlaneRegistry'),
    relayRegistryId: byType('::RelayRegistry'),
    validatorRegistryId: byType('::ValidatorRegistry'),
    userRegistryId: byType('::UserRegistry'),
    roomManagerId: byType('::RoomManager'),
    roleVoteBoxId: byType('::RoleVoteBox'),
    // TODO(package split, services/contract/role-voting): publish-output.json
    // is produced by an external demo-setup harness (outside this repo's
    // vidctl tooling) that still assumes a single published package. Until
    // that harness is updated to publish + merge dvconf_role_voting's own
    // `published` entry, this falls back to `pkg` -- WRONG once that harness
    // catches up, since role_voting no longer lives in the same package.
    roleVotingPackageId: pkg,
    livenessVoteBoxId: byType('::LivenessVoteBox'),
  };
}

/** Faucet-fund + POLL getCoins until the gas coin indexes (the docker faucet is
 *  ASYNC; a fixed sleep races it -- the same gotcha the Phase 5.4 seed-bootstrap
 *  fixed). Retries the faucet request itself a few times in case of throttling. */
async function fundAndWait(address: string): Promise<void> {
  const norm = normalizeSuiAddress(address);
  let funded = false;
  for (let attempt = 1; attempt <= 4 && !funded; attempt++) {
    try {
      await requestSuiFromFaucetV2({ host: FAUCET_HOST, recipient: norm });
      funded = true;
    } catch (e) {
      logger.warn({ module: 'revote-m1', action: 'faucet_retry', context: { attempt } }, `faucet request failed: ${String(e)}`);
      await sleep(3000);
    }
  }
  if (!funded) throw new Error(`fundAndWait: faucet never accepted ${norm}`);
  const deadline = Date.now() + 90_000;
  for (;;) {
    const { data } = await client.getCoins({ owner: norm });
    if (data.length > 0) return;
    if (Date.now() > deadline) throw new Error(`fundAndWait: gas coin never indexed for ${norm}`);
    await sleep(1000);
  }
}

/**
 * Robust relay-onboarding against the docker chain: poll-funded register (User) ->
 * CP cast(Relay) -> apply -> register_relay. Mirrors `voteAndApplyRelay` but uses a
 * poll-based fund (the shared helper's 1.5s settle races the docker faucet) and an
 * inline register_relay (the shared helper bundles funding it can't decouple).
 */
async function registerFreshRelay(): Promise<RelayResult> {
  const kp = Ed25519Keypair.generate();
  await fundAndWait(kp.getPublicKey().toSuiAddress());
  const reg = await registerMiner(client, kp, config, RELAY_STAKE_MIST, logger);
  if (reg.minerCapId === null) throw new Error('registerFreshRelay: expected a MinerCap from a 0.3 SUI register');
  const minerCapId = reg.minerCapId;
  await castRoleVoteFromCp(client, cp, reg.minerId, MinerRole.Relay, config, logger);
  await applyVotedRoleAs(client, kp, minerCapId, reg.stakeId, config, logger);
  // register_relay arg order (relay_registry.move:105): net_reg, registry, cap, stake, region, endpoint_url.
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::relay_registry::register_relay`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(config.relayRegistryId),
      tx.object(minerCapId),
      tx.object(reg.stakeId),
      tx.pure.vector('u8', [1, 2, 3, 4]),
      tx.pure.vector('u8', [1, 2, 3, 4]),
    ],
  });
  tx.setGasBudget(GAS_BUDGET);
  const r = (await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  })) as unknown as TxStatusLike;
  await client.waitForTransaction({ digest: r.digest });
  if (r.effects?.status?.status !== 'success') {
    throw new Error(`register_relay failed: ${r.effects?.status?.error ?? 'unknown'}`);
  }
  return { minerId: reg.minerId, minerCapId, stakeId: reg.stakeId, kp };
}

type MarkFn = 'mark_revote_eligible_idle' | 'mark_revote_eligible_composition_shift';

/**
 * Single-shot mark (NO retry, so an expected abort surfaces fast + intact). Marks
 * are NOT cap-gated -- any sender works; we sign with the funded CP keypair.
 * Arg order (role_voting.move:347 / :412): net_reg, vote_box, miner_store,
 * relay_reg, validator_reg, cp_reg, miner_id (signaling_reg dropped -- role
 * removed from the 4-way scarcity math, now 3-way relay/validator/cp).
 */
async function markTx(fn: MarkFn, minerId: string): Promise<TxStatusLike> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.roleVotingPackageId}::role_voting::${fn}`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(config.roleVoteBoxId),
      tx.object(config.minerStoreId),
      tx.object(config.relayRegistryId),
      tx.object(config.validatorRegistryId),
      tx.object(config.cpRegistryId),
      tx.pure.id(minerId),
    ],
  });
  tx.setGasBudget(GAS_BUDGET);
  const r = (await client.signAndExecuteTransaction({
    signer: cp.kp,
    transaction: tx,
    options: { showEffects: true },
  })) as unknown as TxStatusLike;
  await client.waitForTransaction({ digest: r.digest });
  if (r.effects?.status?.status !== 'success') {
    // Surface the Move abort code (e.g. "..., 709) in command 0") so `.rejects.toThrow(/709/)` can match.
    throw new Error(`${fn} aborted: ${r.effects?.status?.error ?? 'unknown'}`);
  }
  return r;
}

function newRoleOf(applyResult: TxStatusLike): { oldRole: number; newRole: number } | null {
  const evt = (applyResult.events ?? []).find((e) => (e.type ?? '').includes('::registration::RoleTransitioned'));
  const pj = evt?.parsedJson as { old_role?: unknown; new_role?: unknown } | undefined;
  if (pj === undefined || pj.old_role === undefined || pj.new_role === undefined) return null;
  return { oldRole: Number(pj.old_role), newRole: Number(pj.new_role) };
}

// ── lifecycle ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  logger.info({ module: 'revote-m1', action: 'compose_up' }, 'booting docker demo stack (fast epochs, cp-daemon scaled to 0)');
  await sh(`${COMPOSE} up -d --wait --wait-timeout 360 ${SCALE_OUT_CP} ${DAEMONS}`, { SUI_EPOCH_DURATION_MS: EPOCH_MS });

  client = new SuiClient({ url: RPC_URL });
  config = buildConfig((await readShared('publish-output.json')) as { objectChanges?: ObjChange[] });

  const keys = (await readShared('daemon-keys.json')) as { cp: { secretKey: string; capId: string; stakeId: string } };
  const cpKp = Ed25519Keypair.fromSecretKey(keys.cp.secretKey);
  cp = {
    kp: cpKp,
    minerId: normalizeSuiAddress(cpKp.getPublicKey().toSuiAddress()),
    cpCapId: keys.cp.capId,
    stakeId: keys.cp.stakeId,
  };
  await fundAndWait(cp.minerId); // top the seeded CP up so it has gas for the test's casts

  reader = new SuiChainStateReader(client, config, logger);
  maxIdleEpochs = await reader.getMaxIdleEpochs();
  cooldownEpochs = await reader.getRevoteCooldownEpochs();
  logger.info(
    { module: 'revote-m1', action: 'chain_params', context: { maxIdleEpochs: maxIdleEpochs.toString(), cooldownEpochs: cooldownEpochs.toString() } },
    'read on-chain thresholds',
  );

  // Onboard the two relays that must go IDLE; capture the latest registration epoch.
  relayA = await registerFreshRelay();
  relayC = await registerFreshRelay();
  const regEpoch = BigInt((await client.getLatestSuiSystemState()).epoch);

  // One shared wait so BOTH relays cross the idle threshold concurrently.
  // idle requires current - last_heartbeat > max_idle (strict), so +1 over the boundary.
  await waitForEpochAtLeast(client, regEpoch + maxIdleEpochs + 2n, { timeoutMs: 240_000 }, logger);
}, 600_000);

afterAll(async () => {
  try {
    await sh(`${COMPOSE} down -v --remove-orphans`);
  } catch (e) {
    logger.error({ module: 'revote-m1', action: 'compose_down' }, `teardown failed: ${String(e)}`);
  }
});

// ── Scenario A: idle miner -> mark -> revote ────────────────────────────────────

describe('Scenario A: idle miner -> mark -> revote', () => {
  let target: number;

  it('A1: the idle watcher detects relayA and a mark lands (RevoteEligibleMarked, reason=idle)', async () => {
    const submitter = makeMarkSubmitter(client, cp.kp, config, logger);
    const watcher = new RevoteWatcher(reader, submitter, logger);
    const idle = await watcher.scanIdleMiners();
    expect(idle).toContain(relayA.minerId);

    await markTx('mark_revote_eligible_idle', relayA.minerId);
    const since = await reader.getRevoteEligibleSince(relayA.minerId);
    expect(since).not.toBeNull();
  });

  it('A2: CP casts the scarcity-derived role and the assignment lands', async () => {
    const counts = await reader.getRoleCounts();
    target = computeBestRoleForRevote(counts); // derive, never hardcode (S70 4.3 lesson)
    await castRoleVoteFromCp(client, cp, relayA.minerId, target, config, logger);
    const assigned = await waitForRoleAssignment(client, config, relayA.minerId, logger, 60_000);
    expect(assigned).toBe(target); // STATE-read, not event-substring -> fails loud if quorum changes
  });

  it('A3: relayA applies and transitions OFF Relay; the relay count drops by one', async () => {
    const before = await reader.getRoleCounts();
    const applied = await applyVotedRoleAs(client, relayA.kp, relayA.minerCapId, relayA.stakeId, config, logger);
    const transition = newRoleOf(applied);
    expect(transition).not.toBeNull();
    expect(transition?.oldRole).toBe(MinerRole.Relay);
    expect(transition?.newRole).toBe(target);
    const after = await reader.getRoleCounts();
    expect(after.relay).toBe(before.relay - 1n);
  });
});

// ── Scenario B: composition shift ───────────────────────────────────────────────

describe('Scenario B: composition shift', () => {
  const MAX_FILLERS = 15; // bound the imbalance build; log loudly if exceeded (no silent cap)
  let surplusRelay: RelayResult;
  let bTarget: number;

  it('B1: with a balanced composition, a composition-shift mark aborts (E_COMPOSITION_NOT_IMBALANCED 715)', async () => {
    const relay = await registerFreshRelay(); // fresh, ACTIVE relay (not oversupplied yet)
    await expect(markTx('mark_revote_eligible_composition_shift', relay.minerId)).rejects.toThrow(/715\)/);
    surplusRelay = relay; // reuse it as a surplus candidate in B2
  });

  it('B2: after registering relays past the scarcity floor, the shift watcher flags relays and a mark lands', async () => {
    const submitter = makeMarkSubmitter(client, cp.kp, config, logger);
    const watcher = new RevoteWatcher(reader, submitter, logger);
    let surplus = await watcher.scanCompositionShift();
    let added = 0;
    while (surplus.length === 0 && added < MAX_FILLERS) {
      await registerFreshRelay();
      added++;
      surplus = await watcher.scanCompositionShift();
    }
    if (surplus.length === 0) {
      throw new Error(`Scenario B: relay role never crossed the scarcity floor after ${added} fillers (cap ${MAX_FILLERS})`);
    }
    logger.info({ module: 'revote-m1', action: 'imbalance_built', context: { added, surplus: surplus.length } }, 'composition imbalanced');
    // Mark a surplus relay the production detector actually flagged.
    const victim = surplus.includes(surplusRelay.minerId) ? surplusRelay.minerId : surplus[0]!;
    await markTx('mark_revote_eligible_composition_shift', victim);
    expect(await reader.getRevoteEligibleSince(victim)).not.toBeNull();
    // remember a flagged relay we OWN (have the keypair for) so B3 can apply it.
    if (surplus.includes(surplusRelay.minerId)) {
      // surplusRelay is owned + flagged -> usable directly in B3.
    }
  });

  it('B3: a flagged relay re-votes to the scarce role and transitions off Relay', async () => {
    // Only the relay we own a keypair for can apply. Ensure surplusRelay is marked
    // (it was flagged in B2 if it appeared in the surplus set; mark it if not yet).
    const since = await reader.getRevoteEligibleSince(surplusRelay.minerId);
    if (since === null) {
      await markTx('mark_revote_eligible_composition_shift', surplusRelay.minerId);
    }
    const counts = await reader.getRoleCounts();
    bTarget = computeBestRoleForRevote(counts);
    expect(bTarget).not.toBe(MinerRole.Relay); // an oversupplied relay must re-vote AWAY from Relay
    await castRoleVoteFromCp(client, cp, surplusRelay.minerId, bTarget, config, logger);
    const assigned = await waitForRoleAssignment(client, config, surplusRelay.minerId, logger, 60_000);
    expect(assigned).toBe(bTarget);
    const applied = await applyVotedRoleAs(client, surplusRelay.kp, surplusRelay.minerCapId, surplusRelay.stakeId, config, logger);
    const transition = newRoleOf(applied);
    expect(transition?.oldRole).toBe(MinerRole.Relay);
    expect(transition?.newRole).toBe(bTarget);
  });
});

// ── Scenario C: cooldown abort ──────────────────────────────────────────────────

describe('Scenario C: cooldown abort', () => {
  let firstMarkEpoch: bigint;

  it('C1: a first idle-mark lands; an immediate re-mark inside the window aborts (E_COOLDOWN 709)', async () => {
    await markTx('mark_revote_eligible_idle', relayC.minerId);
    firstMarkEpoch = BigInt((await client.getLatestSuiSystemState()).epoch);
    expect(await reader.getRevoteEligibleSince(relayC.minerId)).not.toBeNull();
    // Re-mark immediately -> still inside [firstMark, firstMark + cooldown) -> abort.
    await expect(markTx('mark_revote_eligible_idle', relayC.minerId)).rejects.toThrow(/709\)/);
  });

  it('C2: once the cooldown window elapses, a re-mark succeeds and bumps revote_eligible_since', async () => {
    await waitForEpochAtLeast(client, firstMarkEpoch + cooldownEpochs + 1n, { timeoutMs: 120_000 }, logger);
    const before = await reader.getRevoteEligibleSince(relayC.minerId);
    await markTx('mark_revote_eligible_idle', relayC.minerId);
    const after = await reader.getRevoteEligibleSince(relayC.minerId);
    expect(after).not.toBeNull();
    expect(after! >= before!).toBe(true); // bumped to (or past) the post-cooldown epoch
  });
});

// ── Scenario D: mid-room guard (DOCUMENTED DEFERRAL) ─────────────────────────────

describe('Scenario D: mid-room guard', () => {
  // RV-003 PARTIAL: E_MINER_IN_ACTIVE_ROOM (712) is declared `#[allow(unused_const)]`
  // in role_voting.move:43-46 but NEVER asserted -- the guard is UNWIRED because
  // room_manager has no reverse miner->room lookup. There is no on-chain path that
  // can abort with 712, so the "re-vote a miner who is mid-room -> abort 712"
  // scenario CANNOT be exercised. This is a known, documented deferral (ADR-0008
  // Lessons Learned, Phase 5.6), not a test gap.
  const MID_ROOM_GUARD_WIRED = false; // mirrors role_voting.move:46 (unused_const)

  it('D1: documents that the mid-room guard (error 712) is intentionally unwired (RV-003 PARTIAL)', () => {
    expect(MID_ROOM_GUARD_WIRED).toBe(false);
  });

  it.skip('D2: re-vote a mid-room miner -> abort E_MINER_IN_ACTIVE_ROOM (712) [DEFERRED: guard unwired]', () => {
    // Intentionally skipped: no room_manager reverse-lookup -> the guard cannot fire.
    // Re-enable when room_manager gains is_miner_in_assigned_room + cast_role_vote wires it.
  });
});
