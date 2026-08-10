/**
 * B4 — 4-of-5 RE-vote of an IDLE relay (Relay → Validator), via the PRODUCTION
 * idle-detection + mark path (GD-1).
 *
 * The headline (B2, see multi-cp-voting-quorum.integration.test.ts) proved the
 * POSITIVE 4-of-5 INITIAL quorum; B3 (same file) proved the negative cast
 * guards. B4 closes the hardest live surface: a real RE-vote that carries an
 * idle relay all the way through a role flip, exactly mirroring the F47
 * Phase-4.3 role-revote-e2e loop but with the live 5-CP supermajority
 * (required = ceil(5*6667/10000) = 4) instead of the floored 1-CP quorum.
 *
 * Flow:
 *   1. Seed ONE relay via FOUR CP votes (NOT the 1-CP voteAndApplyRelay — at 5
 *      active CPs a single vote does NOT assign), then register_relay so it is an
 *      active relay with last_heartbeat = epoch.
 *   2. Advance > max_idle (30) → +31 epochs.
 *   3. The PRODUCTION RevoteWatcher (real SuiChainStateReader + makeMarkSubmitter)
 *      detects the idle relay and lands a real mark_revote_eligible_idle TX,
 *      adding it to the revote_eligible pool.
 *   4. Derive the re-vote target from the PRODUCTION scarcity logic
 *      (computeBestRoleForRevote → Validator, scarcest at 1 relay / 0 validators).
 *   5. FOUR distinct CPs cast Validator → the live 4-of-5 quorum assigns; the
 *      miner applies → RoleTransitioned { old: Relay, new: Validator }.
 *
 * PRUNING-SAFETY (W1 durable): this is its OWN describe (own file/localnet) with
 * its OWN fresh localnet. By the end of the sibling quorum file's describe
 * (B2/B3) the chain sits at epoch ~70-100 (2s epochs); a +31 advance from there
 * would risk the 2s-fast-epoch OBJECT-PRUNING footgun (epoch~0 Move package
 * pruned → moveCalls fail RPC-32602). A fresh boot here reaches only ~epoch 40
 * (mirrors role-revote-e2e), safely under the window. The two files run as
 * separate vitest test files (each gets its own localnet lifecycle), so this
 * describe's beforeAll boots only after any prior file's afterAll frees :9000.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), NEVER `pnpm test` (excluded there). Must still
 * TYPE-CHECK under `pnpm typecheck`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLogger, MinerRole, waitForRoleAssignment, type Logger } from '@dvconf/shared';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiChainStateReader } from '../../sui-chain-state-reader.js';
import { RevoteWatcher, makeMarkSubmitter, MarkReason } from '../../revote-watcher.js';
import { computeBestRoleForRevote } from '../../role-voter.js';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';
import {
  bootstrapCp,
  registerMiner,
  createFundedKeypair,
  castRoleVoteFromCp,
  applyVotedRoleAs,
  waitForEpochAtLeast,
  RELAY_STAKE_MIST,
  type BootstrapCpResult,
  type TxStatusLike,
} from './revote-localnet-helpers.js';

/**
 * bootLocalnet requires an epoch duration; 2000ms is stable on Windows (and lets
 * later idle-advance tests progress quickly).
 */
const EPOCH_DURATION_MS = 2000;

/**
 * On a contended Windows host a slow-but-successful boot occasionally crosses
 * the fixture's default 120s `:9000` open cap and is killed at the cap. The
 * fixture exposes `portWaitMs` exactly for this — raise the FAILURE ceiling to
 * 240s. Fast boots are byte-for-byte unchanged (boot returns the instant :9000
 * opens); this only stops a healthy slow boot from being reaped early.
 */
const BOOT_PORT_WAIT_MS = 240_000;

/**
 * max_idle_epochs default = 30; an idle gap must STRICTLY exceed it → advance ≥ 31
 * past the relay's register_relay heartbeat so the production idle scan flags it (B4).
 */
const IDLE_GAP = 31n;

/**
 * Wall-clock budget for the B4 beforeAll epoch-advance (IDLE_GAP at 2s/epoch ≈ 62s,
 * plus RPC poll latency). This is UNRELATED to BOOT_PORT_WAIT_MS despite the equal
 * numeric value — named separately so a reader does not assume they are linked.
 */
const EPOCH_ADVANCE_TIMEOUT_MS = 240_000;

/** Number of distinct CPs stood up — the active-CP count that fixes the quorum. */
const CP_COUNT = 5;

/**
 * 1.0 SUI per CP register (> DEFAULT_CP_THRESHOLD 0.5 → determine_role = CP).
 * Headroom over the 0.6-SUI default so each CP clears the tier with margin.
 */
const CP_STAKE_HEADROOM_MIST = 1_000_000_000n;

/**
 * required = ceil(active_cp_count * 6667 / 10000), floor 1.
 *   N=5 → ceil(33335/10000) = 4   (the proof this test pins)
 *   N=4 → ceil(26668/10000) = 3   (so threshold==4 ⇒ 5 CPs were active, not 4)
 */
const EXPECTED_THRESHOLD = '4';

/**
 * Votes accumulated at finalize == required here (4 distinct CPs crossed the
 * 4-of-5 quorum). vote_count and threshold are DISTINCT concepts that only
 * coincide at the assignment boundary, so they get separate consts.
 */
const EXPECTED_VOTE_COUNT = '4';

/**
 * Negative-assertion wait. The 8000ms deadline bounds the poll loop;
 * waitForRoleAssignment polls every 3000ms, so it stops after the first poll
 * past the deadline. Observed wall-time is ~12s (devInspect RPC latency stacks
 * on top of each 3000ms sleep) — the bound is the deadline, not the wall-time.
 */
const NEGATIVE_WAIT_MS = 8_000;

/** find a single emitted event whose fully-qualified type contains `suffix`. */
function findEvent(result: TxStatusLike, suffix: string): { type?: string; parsedJson?: unknown } | undefined {
  return (result.events ?? []).find((e) => (e.type ?? '').includes(suffix));
}

describe('Multi-CP revote — 4-of-5 idle-relay Relay→Validator (GD-1)', () => {
  let handle: LocalnetHandle;
  const cps: BootstrapCpResult[] = [];
  const logger: Logger = createLogger('multi-cp-revote-e2e');

  /** The seeded relay miner — the re-vote subject. */
  interface SeededRelay {
    minerId: string;
    /** The miner's funded keypair — signs apply_voted_role + register_relay. */
    minerKp: Ed25519Keypair;
    minerCapId: string;
    stakeId: string;
  }
  let relay: SeededRelay;
  /** Epoch AFTER register_relay set last_heartbeat — the idle baseline. */
  let baseEpoch: bigint;

  /**
   * Sign + execute a built TX with the given keypair, wait for finality, and
   * assert success. A test-file-local mirror of the helper's private
   * `signAndAssert` (not exported) — keeps the shared helper byte-for-byte
   * untouched. Used here only for the `register_relay` step of the seed.
   */
  async function execAssert(
    signer: Ed25519Keypair,
    build: (tx: Transaction) => void,
    label: string,
  ): Promise<TxStatusLike> {
    const tx = new Transaction();
    build(tx);
    tx.setGasBudget(100_000_000);
    const result = (await handle.client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    })) as unknown as TxStatusLike;
    await handle.client.waitForTransaction({
      digest: result.digest,
      options: { showEffects: true, showObjectChanges: true },
    });
    const status = result.effects?.status?.status;
    if (status !== 'success') {
      const err = result.effects?.status?.error ?? '(no error string)';
      throw new Error(`${label} failed on-chain: status=${status ?? 'unknown'} error=${err}`);
    }
    return result;
  }

  /**
   * Seed ONE relay via a real 4-of-5 quorum (NOT the shared 1-CP
   * `voteAndApplyRelay`): register a fresh USER miner (0.3 SUI → MinerCap), have
   * FOUR distinct CPs cast Relay (required=4 at active_cp=5 → assigns), the miner
   * applies the Relay role, then registers into the RelayRegistry (last_heartbeat
   * = epoch). The 0.3-SUI stake exceeds the relay min (0.25) AND the later
   * validator min (0.1), so the eventual Relay→Validator apply guard also passes.
   */
  async function seedRelayVia4Cps(): Promise<SeededRelay> {
    // 1. register a fresh USER-role miner (0.3 SUI → MinerCap; current_role User so
    //    the initial cast skips the re-vote-eligibility guard).
    const minerKp = await createFundedKeypair(logger);
    const reg = await registerMiner(handle.client, minerKp, handle.config, RELAY_STAKE_MIST, logger);
    if (reg.minerCapId === null) {
      throw new Error('seedRelayVia4Cps: expected a MinerCap from a 0.3 SUI register, got none');
    }
    const minerCapId = reg.minerCapId;
    const minerId = reg.minerId;

    // 2. FOUR distinct CPs cast Relay — the live 4-of-5 quorum (a single vote does
    //    NOT assign at active_cp=5; the 4th crosses required=4).
    for (let i = 0; i < 4; i++) {
      await castRoleVoteFromCp(handle.client, cps[i], minerId, MinerRole.Relay, handle.config, logger);
    }
    const assigned = await waitForRoleAssignment(handle.client, handle.config, minerId, logger, 30_000);
    if (assigned !== MinerRole.Relay) {
      throw new Error(`seedRelayVia4Cps: expected a Relay assignment after 4 votes, got ${assigned}`);
    }

    // 3. miner applies the voted role (stake 0.3 ≥ relay min 0.25; binding miner_id).
    await applyVotedRoleAs(handle.client, minerKp, minerCapId, reg.stakeId, handle.config, logger);

    // 4. miner enters the RelayRegistry → last_heartbeat = epoch (idle baseline).
    //    register_relay arg order (relay_registry.move:105): net_reg, registry, cap,
    //    stake, region, endpoint_url — mirrors voteAndApplyRelay step 4 exactly.
    await execAssert(
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${handle.config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(handle.config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(handle.config.relayRegistryId), // registry: &mut RelayRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(reg.stakeId), // stake: &StakePosition
            tx.pure.vector('u8', [1, 2, 3, 4]), // region
            tx.pure.vector('u8', [1, 2, 3, 4]), // endpoint_url
          ],
        });
      },
      'register_relay',
    );

    logger.info(
      { module: 'multi-cp-revote-e2e', action: 'seed_relay_via_4cps', context: { minerId } },
      'seeded a registered relay via a real 4-of-5 quorum',
    );
    return { minerId, minerKp, minerCapId, stakeId: reg.stakeId };
  }

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS, portWaitMs: BOOT_PORT_WAIT_MS });

    // Stand up the SAME 5 distinct CPs as the sibling quorum file (sequential faucet-funds).
    for (let i = 0; i < CP_COUNT; i++) {
      cps.push(await bootstrapCp(handle.client, handle.config, logger, CP_STAKE_HEADROOM_MIST));
    }
    expect(cps.length).toBe(CP_COUNT);

    // Seed the idle-relay subject via a real 4-of-5 quorum, then advance past
    // max_idle (30). baseEpoch is captured AFTER register_relay set last_heartbeat.
    relay = await seedRelayVia4Cps();
    baseEpoch = BigInt((await handle.client.getLatestSuiSystemState()).epoch);
    await waitForEpochAtLeast(handle.client, baseEpoch + IDLE_GAP, { timeoutMs: EPOCH_ADVANCE_TIMEOUT_MS }, logger);
  }, 600_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it(
    'idle relay is re-voted Relay→Validator by 4 of 5 CPs',
    async () => {
      const reader = new SuiChainStateReader(handle.client, handle.config, logger);
      const submitter = makeMarkSubmitter(handle.client, handle.signer, handle.config, logger);
      const watcher = new RevoteWatcher(reader, submitter, logger);

      // ── Precondition: the seeded miner is an active relay (1 relay / 0 validators).
      const before = await reader.getRoleCounts();
      expect(before.relay).toBeGreaterThanOrEqual(1n);
      const activeBefore = await reader.getActiveMiners();
      const relayBefore = activeBefore.find((m) => normalizeSuiAddress(m.minerId) === relay.minerId);
      expect(relayBefore).toBeDefined();
      expect(relayBefore!.role).toBe(MinerRole.Relay);

      // ── Step 1: the PRODUCTION watcher detects the idle relay + lands a real mark.
      // (The 5 CPs also went idle on the +31 advance, so the scan may include them;
      // `toContain` is non-exclusive and we mark ONLY the relay.)
      const idle = await watcher.scanIdleMiners();
      expect(idle).toContain(relay.minerId);
      expect(await watcher.submitMarkTx(relay.minerId, MarkReason.Idle)).toBe('submitted');
      // The mark added the relay to the revote_eligible pool (gates the re-vote cast).
      const since = await reader.getRevoteEligibleSince(relay.minerId);
      expect(since).not.toBeNull();
      expect(since! >= baseEpoch).toBe(true);

      // ── Step 2: derive the re-vote target from the PRODUCTION scarcity logic.
      // 1 relay / 0 validators / 5 CPs → scarcest is Validator (0), tie-broken over
      // Signaling (0) by the documented validator>signaling priority. Validator's
      // 0.1-SUI min ≤ the relay's 0.3 stake → the apply-side stake guard passes.
      const targetRole = computeBestRoleForRevote(before);
      expect(targetRole).toBe(MinerRole.Validator);

      // ── Step 3: 4-of-5 RE-vote. The mark added the relay to the revote_eligible
      // pool, so the cast-side eligibility guard (708) passes on every cast (pool
      // membership persists across the 4 votes — it is cleared on RoleTransitioned,
      // not on cast). Below the quorum (required=4) nothing assigns; the 4th
      // distinct CP crosses it. On the OLD floor-1 contract one re-vote would have
      // assigned, so a 4-vote-to-assign here is only possible under the Phase-A fix.
      let fourthCast: TxStatusLike | undefined;
      for (let i = 0; i < 4; i++) {
        fourthCast = await castRoleVoteFromCp(
          handle.client,
          cps[i],
          relay.minerId,
          targetRole,
          handle.config,
          logger,
        );
        // ── DISCRIMINATOR (mirrors B2): after the first 3 of 4 votes the role is
        // NOT yet assigned — 3 < required=4. On the OLD floor-1 contract the very
        // first re-vote would already have assigned, so this REJECT proves the
        // 4-of-5 quorum DIRECTLY for the revote (not only via the event field).
        if (i === 2) {
          await expect(
            waitForRoleAssignment(handle.client, handle.config, relay.minerId, logger, NEGATIVE_WAIT_MS),
          ).rejects.toThrow(/timeout/i);
        }
      }
      const assignedRole = await waitForRoleAssignment(handle.client, handle.config, relay.minerId, logger, 30_000);
      expect(assignedRole).toBe(MinerRole.Validator);

      // Hard-pin: the 4th cast's RoleAssigned carries threshold==4 (the live 2/3-of-5
      // quorum) — only 4 when 5 CPs are active (at active_cp=4 the ceil math is 3).
      const assignedEvt = findEvent(fourthCast!, '::role_voting::RoleAssigned');
      expect(assignedEvt).toBeDefined();
      const ra = assignedEvt!.parsedJson as { miner_id: string; role: number; vote_count: string; threshold: string };
      expect(normalizeSuiAddress(ra.miner_id)).toBe(relay.minerId);
      expect(ra.role).toBe(MinerRole.Validator);
      expect(ra.threshold).toBe(EXPECTED_THRESHOLD); // 4 = the live 2/3-of-5 quorum
      expect(ra.vote_count).toBe(EXPECTED_VOTE_COUNT); // 4 distinct Validator voters

      // ── Step 4: miner applies the voted role → RoleTransitioned Relay→Validator.
      const applyResult = await applyVotedRoleAs(
        handle.client,
        relay.minerKp,
        relay.minerCapId,
        relay.stakeId,
        handle.config,
        logger,
      );
      const transitioned = findEvent(applyResult, '::registration::RoleTransitioned');
      expect(transitioned).toBeDefined();
      const rt = transitioned!.parsedJson as { miner_id: string; old_role: number; new_role: number };
      expect(normalizeSuiAddress(rt.miner_id)).toBe(relay.minerId);
      // old_role/new_role are Move u8 → BCS-decoded as JS numbers; compare directly.
      expect(rt.old_role).toBe(MinerRole.Relay);
      expect(rt.new_role).toBe(MinerRole.Validator);

      // ── Cleanup-only boundary: the OLD (relay) registry no longer carries the
      // miner (active relay 1 → 0; miner absent from the active set), and the
      // validator registry is UNCHANGED — apply_voted_role is cleanup-only (RV-016
      // new-registry enrollment deferred post-thesis, ADR-0012). Pinning the
      // validator count unchanged forces a future RV-016 change to update this.
      const after = await reader.getRoleCounts();
      const activeAfter = await reader.getActiveMiners();
      expect(activeAfter.find((m) => normalizeSuiAddress(m.minerId) === relay.minerId)).toBeUndefined();
      expect(after.relay).toBe(before.relay - 1n);
      expect(after.validator).toBe(before.validator);
    },
    600_000,
  );
});
