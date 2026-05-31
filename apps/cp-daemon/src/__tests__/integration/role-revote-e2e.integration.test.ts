/**
 * F47 Phase 4.3 — FULL role-revote loop, end-to-end against a LIVE localnet
 * (REQ-RV-013, E2E subset).
 *
 * Closes the loop the Phase 4.1 test stopped short of. 4.1 proved idle-detection →
 * mark → revote_eligible_since → cooldown. THIS test carries the same idle relay all
 * the way through a re-vote into a new role:
 *
 *   1. Bootstrap 1 CP + 1 relay via the real on-chain lifecycle, then advance epochs
 *      past the idle threshold (max_idle 30 → advance ≥ 31).
 *   2. The PRODUCTION RevoteWatcher detects the idle relay (scanIdleMiners) and lands
 *      a real `mark_revote_eligible_idle` TX (submitMarkTx → 'submitted'), adding the
 *      relay to the revote_eligible pool.
 *   3. The re-vote target role is derived from the PRODUCTION scarcity logic
 *      (`computeBestRoleForRevote`): with 1 relay / 0 validators the scarcest role is
 *      Validator. Its 0.1-SUI minimum is satisfied by the relay's 0.3-SUI stake, so
 *      the miner-signed apply guard `amount >= minimum_for_role(new_role)` passes.
 *   4. The CP casts `cast_role_vote(relay, Validator)` (1 CP meets the floored quorum)
 *      and the miner applies it (`apply_voted_role`).
 *   5. Assertions (the Phase 4.3 done-criteria):
 *      - the `RoleTransitioned { miner_id, old_role: Relay, new_role: Validator }`
 *        event fires — the ADR-0008 loose-coupling interface for W2/W3/F62 consumers;
 *      - the OLD (relay) registry no longer carries the miner (active relay count
 *        decrements, and the miner is absent from the whole active set);
 *      - the miner is NOT enrolled into the new (validator) registry. apply_voted_role
 *        is CLEANUP-ONLY by design (REQ-RV-016 new-registry re-enrollment is
 *        architecture-decided + DEFERRED post-thesis, ADR-0012) — asserting the
 *        validator count is UNCHANGED pins that boundary so a future RV-016 change
 *        is forced to update this test deliberately.
 *
 * SCOPE (S70 Option A): this is an IN-PROCESS localnet E2E reusing the Phase 4.1
 * fixture + helpers — NOT a docker-compose-stack E2E. The base demo daemons carry no
 * funded keypair on --force-regenesis, so a healthy + ROLE-REGISTERED docker stack
 * needs the seed-bootstrap one-shot (Phase 5.4) + the vitest-driven docker run
 * (Phase 5.5). Those are explicitly deferred; this test closes the Phase 4.3
 * verification surface without pulling that scope forward.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), NEVER `pnpm test` (excluded there). Must still
 * TYPE-CHECK under `pnpm typecheck`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLogger, MinerRole, waitForRoleAssignment, type Logger } from '@dvconf/shared';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { SuiChainStateReader } from '../../sui-chain-state-reader.js';
import { RevoteWatcher, makeMarkSubmitter, MarkReason } from '../../revote-watcher.js';
import { computeBestRoleForRevote } from '../../role-voter.js';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';
import {
  bootstrapCp,
  voteAndApplyRelay,
  waitForEpochAtLeast,
  castRoleVoteFromCp,
  applyVotedRoleAs,
  type RelayResult,
  type BootstrapCpResult,
} from './revote-localnet-helpers.js';

/** Short epoch so we can advance past max_idle (30) quickly (2000ms stable on Windows). */
const EPOCH_DURATION_MS = 2000;

/** max_idle_epochs default = 30; an idle gap must STRICTLY exceed it → advance ≥ 31. */
const IDLE_GAP = 31n;

describe('Role-revote full E2E (RV-013, Phase 4.3)', () => {
  let handle: LocalnetHandle;
  let cp: BootstrapCpResult;
  let relay: RelayResult;
  let baseEpoch: bigint;
  const logger: Logger = createLogger('phase43-role-revote-e2e');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    // 1 CP + 1 relay via the full on-chain lifecycle (register → vote → apply →
    // register_relay). The single relay is the re-vote subject.
    cp = await bootstrapCp(handle.client, handle.config, logger);
    relay = await voteAndApplyRelay(handle.client, cp, handle.config, logger);

    // Idle baseline AFTER register_relay set last_heartbeat = epoch.
    baseEpoch = BigInt((await handle.client.getLatestSuiSystemState()).epoch);
    await waitForEpochAtLeast(handle.client, baseEpoch + IDLE_GAP, { timeoutMs: 240_000 }, logger);
  }, 300_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('idle relay → watcher marks → CP re-votes → miner applies → role flipped + old registry empty', async () => {
    const reader = new SuiChainStateReader(handle.client, handle.config, logger);
    const submitter = makeMarkSubmitter(handle.client, handle.signer, handle.config, logger);
    const watcher = new RevoteWatcher(reader, submitter, logger);

    // ── Precondition: the miner is an active relay ────────────────────────────
    const before = await reader.getRoleCounts();
    expect(before.relay).toBeGreaterThanOrEqual(1n);
    const activeBefore = await reader.getActiveMiners();
    const relayBefore = activeBefore.find((m) => normalizeSuiAddress(m.minerId) === relay.minerId);
    expect(relayBefore).toBeDefined();
    expect(relayBefore!.role).toBe(MinerRole.Relay);

    // ── Step 1: the production watcher detects idle and lands a real mark TX ───
    const idle = await watcher.scanIdleMiners();
    expect(idle).toContain(relay.minerId);
    expect(await watcher.submitMarkTx(relay.minerId, MarkReason.Idle)).toBe('submitted');
    // The mark added the relay to the revote_eligible pool (gates the re-vote cast).
    const since = await reader.getRevoteEligibleSince(relay.minerId);
    expect(since).not.toBeNull();
    expect(since! >= baseEpoch).toBe(true);

    // ── Step 2: derive the re-vote target from the PRODUCTION scarcity logic ───
    // This is a hermetic localnet (only 1 CP + 1 relay run), so role counts are
    // stable from `before` through the cast — the idle mark does not change them.
    // computeBestRoleForRevote picks the scarcest role: validator & signaling are
    // both 0, broken by the documented validator > signaling priority (relies on
    // ES2019 stable Array.sort, guaranteed on Node >= 11). Validator's 0.1-SUI min
    // is ≤ the relay's 0.3-SUI stake, so the apply-side stake guard passes.
    const targetRole = computeBestRoleForRevote(before);
    expect(targetRole).toBe(MinerRole.Validator);

    // ── Step 3: CP casts the re-vote, then CONFIRM the assignment was written ──
    // With 1 active CP the cast threshold floors to 1, so this single vote meets
    // quorum and writes assigned_roles[minerId] = targetRole. Confirm via the
    // PRODUCTION waitForRoleAssignment (reads get_assigned_role) rather than a loose
    // event-presence check: this asserts the assignment ACTUALLY landed with the
    // right role. If a future governance change raised the CP quorum above 1 this
    // would time out (a loud failure) instead of passing spuriously — and the
    // downstream apply also aborts without a written assignment, so the flip is
    // doubly guarded.
    await castRoleVoteFromCp(handle.client, cp, relay.minerId, targetRole, handle.config, logger);
    const assignedRole = await waitForRoleAssignment(handle.client, handle.config, relay.minerId, logger, 30_000);
    expect(assignedRole).toBe(targetRole);

    // ── Step 4: miner applies the voted role (stake guard passes) ──────────────
    const applyResult = await applyVotedRoleAs(
      handle.client,
      relay.kp,
      relay.minerCapId,
      relay.stakeId,
      handle.config,
      logger,
    );

    // ── Assertion A: the RoleTransitioned event contract fired (Relay → Validator)
    const transitioned = (applyResult.events ?? []).find((e) =>
      (e.type ?? '').includes('::registration::RoleTransitioned'),
    );
    expect(transitioned).toBeDefined();
    const rt = transitioned!.parsedJson as { miner_id: string; old_role: number; new_role: number };
    expect(normalizeSuiAddress(rt.miner_id)).toBe(relay.minerId);
    // old_role/new_role are Move u8 → BCS-decoded as JS numbers; compare directly (no
    // Number() coercion, so a shape drift to string would fail loudly rather than mask).
    expect(rt.old_role).toBe(MinerRole.Relay);
    expect(rt.new_role).toBe(MinerRole.Validator);

    // ── Assertion B: the OLD (relay) registry no longer carries the miner ──────
    // The authoritative per-miner proof is the miner's ABSENCE from the active set
    // (getActiveMiners reads get_active_relays etc.); the count delta is a
    // supplementary network-level check. With exactly 1 relay both hold (1 → 0). The
    // RoleTransitioned event above already pinned that it is THIS miner that flipped.
    const after = await reader.getRoleCounts();
    const activeAfter = await reader.getActiveMiners();
    expect(activeAfter.find((m) => normalizeSuiAddress(m.minerId) === relay.minerId)).toBeUndefined();
    expect(after.relay).toBe(before.relay - 1n);

    // ── Assertion C: NOT re-enrolled into the new (validator) registry ─────────
    // apply_voted_role is CLEANUP-ONLY by design — RV-016 new-registry enrollment is
    // a daemon-side follow-up, architecture-decided + DEFERRED post-thesis (ADR-0012).
    // Pinning validator-count == unchanged forces any future RV-016 wiring to update
    // this assertion deliberately rather than silently.
    expect(after.validator).toBe(before.validator);
  });
});
