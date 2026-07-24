/**
 * Validator-driven liveness enforcement -- FULL E2E against a live localnet.
 *
 * "i expect that job belong to validator" -- closes the gap this whole feature was
 * built for: no role previously checked another node's heartbeat and acted on it.
 * This test drives the REAL on-chain lifecycle end-to-end:
 *
 *   1. Register 1 CP + 2 validators + 1 relay (the relay is the ejection target).
 *   2. Advance epochs past `max_idle_epochs_for_ejection` (default 60) so the
 *      relay's `last_heartbeat` (set at register_relay time) reads as stale.
 *   3. Both validators cast `cast_liveness_vote` against the relay's miner_id. With
 *      2 active validators, `compute_threshold` floors to `ceil(2*6667/10000) = 2`
 *      -- the 2nd vote reaches quorum and the Move module emits
 *      `NodeEjectionApproved` + records the approval.
 *   4. `registration::execute_ejection` is submitted (crank-style, ANY signer --
 *      mirrors economic_layer::distribute_rewards) with the relay's StakePosition.
 *   5. Assertions (the plan's verification bullet):
 *      - the relay is gone from RelayRegistry (active_count decrements, is_registered
 *        false);
 *      - the stake is returned: the relay owner's SUI balance goes back up by (close
 *        to) the original 0.3-SUI stake -- non-punitive removal, not a slash.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), never `pnpm test`. ONE localnet at a time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { createLogger, type Logger } from '@dvconf/shared';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';
import { bootstrapCp, registerRelay, readStakeAmount, type CpResult, type RelayResult } from './canary-localnet-helpers.js';
import {
  registerValidatorFull,
  castLivenessVoteAs,
  executeEjectionAs,
  getApprovedEjection,
  waitForEpochAtLeast,
  type FullValidatorResult,
} from './liveness-localnet-helpers.js';

/**
 * Short epoch so we can advance past max_idle_epochs_for_ejection (60) in reasonable
 * time. 10_000 is the CURRENT `sui start` floor (sui-swarm panics below this --
 * "Epoch duration must be at least 10s" -- as of sui 1.76; the sibling
 * canary-slash-e2e / role-revote-e2e tests' 2000ms literal predates that floor and
 * now hangs the whole suite on this toolchain, a pre-existing repo-wide issue this
 * test does not attempt to fix elsewhere).
 */
const EPOCH_DURATION_MS = 10_000;
/** DEFAULT_MAX_IDLE_EPOCHS_FOR_EJECTION = 60 (liveness_voting.move); idle_gap must STRICTLY
 *  exceed it, so advance >= 61. */
const IDLE_GAP = 61n;

describe('Validator-driven liveness ejection full E2E', () => {
  let handle: LocalnetHandle;
  let cp: CpResult;
  let validatorA: FullValidatorResult;
  let validatorB: FullValidatorResult;
  let relay: RelayResult;
  let baseEpoch: bigint;
  const logger: Logger = createLogger('liveness-ejection-e2e');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    cp = await bootstrapCp(handle.client, handle.config, logger);
    validatorA = await registerValidatorFull(handle.client, cp, handle.config, logger);
    validatorB = await registerValidatorFull(handle.client, cp, handle.config, logger);
    relay = await registerRelay(handle.client, cp, handle.config, logger);

    // Idle baseline AFTER register_relay set last_heartbeat = epoch.
    baseEpoch = BigInt((await handle.client.getLatestSuiSystemState()).epoch);
    // 61 epochs * 10s floor = ~610s alone; give the poll (and the hook) generous headroom.
    await waitForEpochAtLeast(handle.client, baseEpoch + IDLE_GAP, { timeoutMs: 720_000 }, logger);
  }, 900_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('2/3-of-2 validator quorum votes a stale relay ejected, stake returned to owner', async () => {
    // ── Precondition: relay is active + owns its original stake ────────────────
    const activeBefore = await handle.client.getLatestSuiSystemState();
    expect(BigInt(activeBefore.epoch) - baseEpoch).toBeGreaterThan(60n);

    const stakeBefore = await readStakeAmount(handle.client, relay.kp, relay.stakeId, handle.config);
    expect(stakeBefore).toBeGreaterThan(0n);

    const ownerAddress = normalizeSuiAddress(relay.kp.getPublicKey().toSuiAddress());
    const ownerBalanceBefore = BigInt((await handle.client.getBalance({ owner: ownerAddress })).totalBalance);

    // No approval exists yet.
    expect(await getApprovedEjection(handle.client, cp.kp, relay.minerId, handle.config)).toBeNull();

    // ── Step 1: first validator votes -- below quorum (required = 2), no ejection yet ──
    await castLivenessVoteAs(handle.client, validatorA, relay.minerId, handle.config, logger);
    expect(await getApprovedEjection(handle.client, cp.kp, relay.minerId, handle.config)).toBeNull();

    // ── Step 2: second validator votes -- reaches quorum, NodeEjectionApproved fires ──
    await castLivenessVoteAs(handle.client, validatorB, relay.minerId, handle.config, logger);
    const approvedRole = await getApprovedEjection(handle.client, cp.kp, relay.minerId, handle.config);
    expect(approvedRole).not.toBeNull();

    // ── Step 3: crank execute_ejection (signed by an UNRELATED party -- the CP's
    // keypair here, proving this is NOT an owner-gated call; the quorum record is
    // the sole authority, matching economic_layer::distribute_rewards' shape). ──
    await executeEjectionAs(handle.client, cp.kp, relay.stakeId, handle.config, logger);

    // ── Assertions: registry removal + stake returned to the ORIGINAL owner ────
    const tx = new Transaction();
    tx.moveCall({
      target: `${handle.config.packageId}::relay_registry::is_registered`,
      arguments: [tx.object(handle.config.relayRegistryId), tx.pure.id(relay.minerId)],
    });
    const res = await handle.client.devInspectTransactionBlock({
      sender: ownerAddress,
      transactionBlock: tx,
    });
    const bytes = res.results?.[0]?.returnValues?.[0];
    expect(bytes).toBeDefined();
    const stillRegistered = Uint8Array.from(bytes![0])[0] === 1;
    expect(stillRegistered).toBe(false);

    // The approval was CONSUMED (single-use) -- a second execute_ejection would abort.
    expect(await getApprovedEjection(handle.client, cp.kp, relay.minerId, handle.config)).toBeNull();

    // Stake returned: owner's balance increased by close to the original stake
    // (minus this test's own gas spend on relay's earlier registration TXs, which
    // already happened before this balance snapshot -- only execute_ejection's
    // fully-someone-else-paid coin transfer should show up here).
    const ownerBalanceAfter = BigInt((await handle.client.getBalance({ owner: ownerAddress })).totalBalance);
    expect(ownerBalanceAfter - ownerBalanceBefore).toBe(stakeBefore);
  }, 60_000);
});
