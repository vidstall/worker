/**
 * Multi-CP voting — HEADLINE live proof (GD-1 / "CP vote ran only 1 CP" gap).
 *
 * Stands up a REAL localnet with FIVE distinct faucet-funded CP keypairs and
 * drives a genuine on-chain role-voting quorum to closure. Closes the
 * defense-honesty gap that every prior live role-vote ran with a SINGLE CP, so
 * the floored quorum (=1) made one vote enough — never exercising the real
 * 2/3-of-active-CP supermajority on a live chain.
 *
 * Phase A (contracts `multi-cp-live`) re-based the cast threshold to
 *   required = max(1, ceil(active_cp_count * 6667 / 10000))
 * (role_voting::compute_threshold). With 5 active CPs that is 4. The
 * discriminating assertion is that **3 of 5 votes do NOT assign** — on the OLD
 * floor-1 contract the very first vote already crossed quorum, so a passing
 * "3-votes-not-assigned" check is only possible under the fixed contract.
 *
 * RED/GREEN honesty: the localnet fixture publishes `dvconf-contracts` from its
 * CURRENT branch (`multi-cp-live` = the Phase-A-fixed package), so this test
 * passes GREEN directly — there is no separate "RED against the old package" run
 * here (checking out the pre-fix contracts would disturb the repo). The RED for
 * this on-chain SEMANTICS was already proven at the Move-unit level in Phase A
 * (the 9 migrated quorum tests, e.g. test_threshold_flat_two_thirds_n5). THIS
 * test is the LIVE confirmation with 5 real, distinct keypairs: a true 4-of-5
 * on-chain quorum, threshold==4 read off the RoleAssigned event, 4 distinct
 * voter addresses.
 *
 * SCOPE: an IN-PROCESS localnet E2E reusing the F47 Phase 4.0/4.1 fixture +
 * helpers (NOT a docker-stack E2E). Boots ONE `sui start` on :9000.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), NEVER `pnpm test` (excluded there). Must still
 * TYPE-CHECK under `pnpm typecheck`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLogger, MinerRole, waitForRoleAssignment, type Logger } from '@dvconf/shared';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';
import {
  bootstrapCp,
  registerMiner,
  createFundedKeypair,
  castRoleVoteFromCp,
  RELAY_STAKE_MIST,
  type BootstrapCpResult,
  type TxStatusLike,
} from './revote-localnet-helpers.js';

/** Short epoch (2000ms stable on Windows); shared with B3/B4 which advance epochs. */
const EPOCH_DURATION_MS = 2000;

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
 * Negative-assertion wait. waitForRoleAssignment polls every 3000ms, so this
 * rejects after ~3 polls (~9s) once it confirms NO assignment is written.
 */
const NEGATIVE_WAIT_MS = 8_000;

/** find a single emitted event whose fully-qualified type ends with `suffix`. */
function findEvent(result: TxStatusLike, suffix: string): { type?: string; parsedJson?: unknown } | undefined {
  return (result.events ?? []).find((e) => (e.type ?? '').includes(suffix));
}

describe('Multi-CP role voting — 4-of-5 live quorum (GD-1)', () => {
  let handle: LocalnetHandle;
  const cps: BootstrapCpResult[] = [];
  const logger: Logger = createLogger('multi-cp-voting-e2e');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    // Stand up 5 distinct CPs SEQUENTIALLY — each createFundedKeypair faucet-funds
    // a fresh keypair and settles before the next, so the localnet faucet is not
    // hammered concurrently. After this loop active_cp_count == 5.
    for (let i = 0; i < CP_COUNT; i++) {
      cps.push(await bootstrapCp(handle.client, handle.config, logger, CP_STAKE_HEADROOM_MIST));
    }
    expect(cps.length).toBe(CP_COUNT);
  }, 600_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it(
    'initial vote: 3 of 5 NOT enough, 4 of 5 assigns with threshold==4 from 4 distinct voters',
    async () => {
      // ── Setup: a fresh USER-role miner (0.3 SUI → MinerCap), votable into Relay.
      // current_role == User means the cast-side re-vote-eligibility guard is
      // skipped (this is an INITIAL vote, not a re-vote).
      const minerKp = await createFundedKeypair(logger);
      const reg = await registerMiner(handle.client, minerKp, handle.config, RELAY_STAKE_MIST, logger);
      const minerId = reg.minerId;

      // ── Votes 1-3: below the 4-of-5 quorum. Capture each result so we can read
      // the on-chain RoleVoteCast voters back off the return value.
      const castResults: TxStatusLike[] = [];
      for (let i = 0; i < 3; i++) {
        castResults.push(
          await castRoleVoteFromCp(handle.client, cps[i], minerId, MinerRole.Relay, handle.config, logger),
        );
      }

      // On-chain threshold is fixed from the FIRST cast: required==4 even though only
      // 1 vote is present. This is the live read of the 5-active-CP quorum.
      const firstCast = findEvent(castResults[0], '::role_voting::RoleVoteCast');
      expect(firstCast).toBeDefined();
      const fc = firstCast!.parsedJson as { required: string; current_votes: string };
      expect(fc.required).toBe(EXPECTED_THRESHOLD); // 4 — the quorum at active_cp=5
      expect(fc.current_votes).toBe('1');

      // ── DISCRIMINATOR: with only 3 of 5 votes the role is NOT assigned. On the
      // OLD floor-1 contract one vote would already have assigned, so this REJECT
      // is what proves the Phase-A fix is live. waitForRoleAssignment throws a
      // "Role assignment timeout after <ms>ms for miner <id>" Error on timeout.
      await expect(
        waitForRoleAssignment(handle.client, handle.config, minerId, logger, NEGATIVE_WAIT_MS),
      ).rejects.toThrow(/Role assignment timeout/);

      // ── Vote 4: the 4th DISTINCT CP crosses the quorum (current_votes 4 >= required 4).
      const fourth = await castRoleVoteFromCp(
        handle.client,
        cps[3],
        minerId,
        MinerRole.Relay,
        handle.config,
        logger,
      );
      castResults.push(fourth);

      // The assignment is now written on-chain; this resolves on the first poll.
      const assignedRole = await waitForRoleAssignment(handle.client, handle.config, minerId, logger, 30_000);
      expect(assignedRole).toBe(MinerRole.Relay);

      // ── Proof A: RoleAssigned fired with the THRESHOLD number ==4 (u64 → string).
      // threshold==4 is the load-bearing assertion: it is only 4 when 5 CPs are
      // active (at active_cp=4 the same ceil math yields 3).
      const assigned = findEvent(fourth, '::role_voting::RoleAssigned');
      expect(assigned).toBeDefined();
      const ra = assigned!.parsedJson as {
        miner_id: string;
        role: number;
        vote_count: string;
        threshold: string;
      };
      expect(normalizeSuiAddress(ra.miner_id)).toBe(minerId);
      expect(ra.vote_count).toBe(EXPECTED_THRESHOLD); // 4 votes accumulated
      expect(ra.threshold).toBe(EXPECTED_THRESHOLD); // 4 = the live 2/3-of-5 quorum
      // role is a Move u8 → BCS-decoded as a JS number (no string coercion).
      expect(ra.role).toBe(MinerRole.Relay);

      // ── Proof B: the 4 votes came from 4 DISTINCT voter addresses, read off the
      // RoleVoteCast event in each cast's RETURN value (no separate queryEvents
      // round-trip). Set size 4 ⇒ no double-count of a single CP toward quorum.
      const voters = new Set(
        castResults.map((r) => {
          const cast = findEvent(r, '::role_voting::RoleVoteCast');
          expect(cast).toBeDefined();
          return normalizeSuiAddress((cast!.parsedJson as { voter: string }).voter);
        }),
      );
      expect(voters.size).toBe(4);
      // Stronger: those 4 voters are EXACTLY the first 4 CP keypairs.
      const expectedVoters = new Set(
        cps.slice(0, 4).map((c) => normalizeSuiAddress(c.kp.getPublicKey().toSuiAddress())),
      );
      expect(voters).toEqual(expectedVoters);
    },
    120_000,
  );
});
