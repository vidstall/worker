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

/**
 * bootLocalnet requires an epoch duration; 2000ms is stable on Windows (and lets
 * later idle-advance tests progress quickly).
 */
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

      // required is already 4 as of the FIRST cast (recomputed from active_cp_count=5
      // on every cast — role_voting.move:273-275, not snapshotted) even though only
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
      expect(ra.vote_count).toBe(EXPECTED_VOTE_COUNT); // 4 votes accumulated at finalize
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

  // ──────────────────────────────────────────────────────────────────────────
  // B3 — LIVE abort-code + role-guard negative paths (GD-1).
  //
  // The headline test proved the POSITIVE 4-of-5 quorum. These three exercise the
  // quorum's NEGATIVE guards on the SAME live localnet + SAME 5 CPs, each against
  // its OWN fresh USER miner. The shared RoleVoteBox is keyed by miner_id, so a
  // distinct miner isolates each test, and a reverted cast leaves NO on-chain trace
  // (the aborting voter is not recorded) — order/state never cross-contaminate.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Register a fresh USER-role miner (0.3 SUI → MinerCap, role User). current_role
   * == User means the cast-side re-vote-eligibility guard (708) is skipped — these
   * are INITIAL votes, not re-votes, so the cooldown/revote path (709) is not
   * involved and cannot be tripped accidentally.
   */
  async function freshUserMiner() {
    const minerKp = await createFundedKeypair(logger);
    const reg = await registerMiner(handle.client, minerKp, handle.config, RELAY_STAKE_MIST, logger);
    return { minerId: reg.minerId, minerKp };
  }

  /**
   * Drive one `castRoleVoteFromCp` that is EXPECTED to revert, then assert the
   * on-chain MoveAbort carries EXACTLY `expectedCode`.
   *
   * castRoleVoteFromCp → signAndAssert throws
   *   `cast_role_vote failed on-chain: status=failure error=<effects.status.error>`
   * and Sui formats effects.status.error as
   *   `MoveAbort(MoveLocation { … name: Identifier("role_voting") … }, <code>) in command N`.
   *
   * RIGOR: we EXTRACT the numeric abort code and compare it with `toBe`. The inner
   * `Identifier("…")` / `Some("…")` parens defeat a naive `MoveAbort(.., N)` capture,
   * so — exactly like the proven validator-daemon `expectMoveAbort` helper — we fall
   * back to the `, <code>) in command` tail form. This is STRICTER than
   * `.rejects.toThrow(/704/)`: a different abort (709/711/719/…) cannot satisfy
   * `actual === expectedCode`, and we additionally pin the module to `role_voting`.
   * The real string is logged once so the GREEN evidence records its exact form.
   */
  async function expectCastAbortCode(
    cp: BootstrapCpResult,
    minerId: string,
    role: number,
    expectedCode: number,
    label: string,
  ): Promise<void> {
    let msg: string | null = null;
    try {
      await castRoleVoteFromCp(handle.client, cp, minerId, role, handle.config, logger);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    if (msg === null) {
      throw new Error(
        `[${label}] expected cast_role_vote to abort with Move code ${expectedCode}, but it SUCCEEDED`,
      );
    }
    logger.info(
      { module: 'multi-cp-voting-e2e', action: 'abort_capture', context: { label, expectedCode } },
      `[${label}] cast abort string: ${msg}`,
    );
    const m = msg.match(/MoveAbort\([^)]*?,\s*(\d+)\)/) ?? msg.match(/,\s*(\d+)\)\s*in command/);
    const actual = m && m[1] !== undefined ? Number(m[1]) : null;
    expect(actual).toBe(expectedCode); // EXACT code — cannot pass on a different abort
    expect(msg).toContain('role_voting'); // abort originates in the role_voting module
  }

  it(
    '6a-2: same CP voting twice while the record is open aborts E_ALREADY_VOTED (704)',
    async () => {
      const { minerId } = await freshUserMiner();
      // cps[0] casts once — succeeds (1 of 4; record open, below the 4-of-5 quorum).
      await castRoleVoteFromCp(handle.client, cps[0], minerId, MinerRole.Relay, handle.config, logger);
      // cps[0] casts the SAME role for the SAME miner again → E_ALREADY_VOTED (704).
      // No assignment is pending (711 skipped) and the role matches the record (719
      // skipped), so 704 — the duplicate-voter guard — is precisely what fires.
      await expectCastAbortCode(cps[0], minerId, MinerRole.Relay, 704, '6a-2');
    },
    120_000,
  );

  it(
    '6a-3: a distinct 5th CP voting after finalize aborts E_PRIOR_ASSIGNMENT_PENDING (711)',
    async () => {
      const { minerId } = await freshUserMiner();
      // 4 DISTINCT CPs cast Relay → crosses the 4-of-5 quorum → assigned_roles[miner]
      // is populated (finalized, pending — NOT yet applied by the miner).
      for (let i = 0; i < 4; i++) {
        await castRoleVoteFromCp(handle.client, cps[i], minerId, MinerRole.Relay, handle.config, logger);
      }
      // Confirm the assignment actually landed on-chain before probing the guard.
      const assignedRole = await waitForRoleAssignment(handle.client, handle.config, minerId, logger, 30_000);
      expect(assignedRole).toBe(MinerRole.Relay);
      // cps[4] (a fresh, distinct CP) casts into the pending assignment →
      // E_PRIOR_ASSIGNMENT_PENDING (711). 711 is the FIRST guard reached past the
      // existence/role checks (assigned_roles is populated), so it fires before any
      // duplicate (704) / mismatch (719) check.
      await expectCastAbortCode(cps[4], minerId, MinerRole.Relay, 711, '6a-3');
    },
    120_000,
  );

  it(
    '6a-4: an off-role vote aborts E_ROLE_MISMATCH (719) and does not skew the Relay outcome',
    async () => {
      const { minerId } = await freshUserMiner();
      // 3 CPs cast Relay (record open, first-mover role = Relay; below the quorum).
      for (let i = 0; i < 3; i++) {
        await castRoleVoteFromCp(handle.client, cps[i], minerId, MinerRole.Relay, handle.config, logger);
      }
      // cps[3] casts VALIDATOR (off-role; a VALID role, so 703 is NOT the cause) →
      // E_ROLE_MISMATCH (719) because role != record.role (Relay). The revert leaves
      // no on-chain trace, so it is NOT tallied toward any role.
      await expectCastAbortCode(cps[3], minerId, MinerRole.Validator, 719, '6a-4');
      // cps[4] casts Relay — the 4th DISTINCT *Relay* voter {0,1,2,4} crosses the
      // quorum (cps[3]'s reverted off-role vote left no trace).
      const fourth = await castRoleVoteFromCp(handle.client, cps[4], minerId, MinerRole.Relay, handle.config, logger);
      // Outcome is Relay — the off-role Validator vote was correctly ignored, never counted.
      const assignedRole = await waitForRoleAssignment(handle.client, handle.config, minerId, logger, 30_000);
      expect(assignedRole).toBe(MinerRole.Relay);
      // Extra pin: RoleAssigned on the 4th Relay cast carries threshold==4 (the live
      // 2/3-of-5 quorum) and vote_count==4 (exactly the {0,1,2,4} Relay voters).
      const assigned = findEvent(fourth, '::role_voting::RoleAssigned');
      expect(assigned).toBeDefined();
      const ra = assigned!.parsedJson as { role: number; vote_count: string; threshold: string };
      expect(ra.role).toBe(MinerRole.Relay);
      expect(ra.threshold).toBe(EXPECTED_THRESHOLD); // 4
      expect(ra.vote_count).toBe(EXPECTED_VOTE_COUNT); // 4 distinct Relay voters {0,1,2,4}
    },
    120_000,
  );
});
