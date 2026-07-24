/**
 * Room health sweep -- FULL E2E against a live localnet.
 *
 * Proves the room-level auto-heal gap this feature closes: a validator-quorum
 * liveness ejection (execute_ejection) removes a dead node from its registry
 * but never touches RoomManager, so a room's assignment can dangle forever.
 * This test drives the REAL on-chain lifecycle end-to-end:
 *
 *   1. Register 1 CP + 2 validators + 1 relay + 2 signaling nodes.
 *   2. Create a room and directly assign relay + the FIRST signaling node
 *      (AdminCap-gated assign_relay_and_signaling -- the plan's own room-
 *      creation shortcut, not the full PVR consensus path).
 *   3. Advance epochs past max_idle_epochs_for_ejection so the first signaling
 *      node's last_heartbeat reads as stale.
 *   4. Both validators cast_liveness_vote against the signaling node's
 *      miner_id -> quorum -> NodeEjectionApproved.
 *   5. execute_ejection removes it from SignalingRegistry (mirrors the exact
 *      live-devnet incident that motivated this feature: a room left pointing
 *      at a signaling node that no longer exists anywhere on-chain).
 *   6. Run RoomHealthSweep.scanOnce() ONCE against the live chain (real
 *      LiveRoomHealthChainStateReader + real submitters, CP-signed).
 *   7. Assert: the room's assigned_signaling now points at the SECOND
 *      signaling node -- reassign_signaling actually healed it.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), never `pnpm test`. ONE localnet at a time.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { createLogger, type Logger } from '@dvconf/shared';
import { signAndAssert, extractRoomId } from '@dvconf/shared';
import { bootLocalnet, fundAddress, type LocalnetHandle } from '../../../../validator-daemon/src/__tests__/integration/localnet-fixture.js';
import {
  bootstrapCp,
  registerRelay,
  registerSignaling,
  type CpResult,
  type RelayResult,
  type SignalingResult,
} from '../../../../validator-daemon/src/__tests__/integration/canary-localnet-helpers.js';
import {
  registerValidatorFull,
  castLivenessVoteAs,
  executeEjectionAs,
  getApprovedEjection,
  waitForEpochAtLeast,
  type FullValidatorResult,
} from '../../../../validator-daemon/src/__tests__/integration/liveness-localnet-helpers.js';
import { RoomHealthSweep, makePromoteAfterEjectionSubmitter, makeSpillRelaySubmitter, makeReassignSignalingSubmitter } from '../../room-health-sweep.js';
import { LiveRoomHealthChainStateReader } from '../../room-health-chain-state-reader.js';

const EPOCH_DURATION_MS = 10_000;
/** DEFAULT_MAX_IDLE_EPOCHS_FOR_EJECTION = 60 (liveness_voting.move); idle_gap must STRICTLY exceed it. */
const IDLE_GAP = 61n;

describe('Room health sweep — signaling reassignment full E2E', () => {
  let handle: LocalnetHandle;
  let cp: CpResult;
  let validatorA: FullValidatorResult;
  let validatorB: FullValidatorResult;
  let relay: RelayResult;
  let signalingOld: SignalingResult;
  let signalingNew: SignalingResult;
  let roomId: string;
  let baseEpoch: bigint;
  const logger: Logger = createLogger('room-health-sweep-e2e');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    cp = await bootstrapCp(handle.client, handle.config, logger);
    validatorA = await registerValidatorFull(handle.client, cp, handle.config, logger);
    validatorB = await registerValidatorFull(handle.client, cp, handle.config, logger);
    relay = await registerRelay(handle.client, cp, handle.config, logger);
    signalingOld = await registerSignaling(handle.client, cp, handle.config, logger);
    signalingNew = await registerSignaling(handle.client, cp, handle.config, logger);

    // Room creation + direct assignment (AdminCap-gated), using the REAL old
    // signaling node's id (not a placeholder).
    const userKp = await (async () => {
      const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
      const kp = Ed25519Keypair.generate();
      await fundAddress(kp.getPublicKey().toSuiAddress());
      await new Promise((r) => setTimeout(r, 1500));
      return kp;
    })();

    await signAndAssert(handle.client, userKp, (tx) => {
      tx.moveCall({
        target: `${handle.config.packageId}::user_registry::register_user`,
        arguments: [tx.object(handle.config.networkRegistryId), tx.object(handle.config.userRegistryId), tx.pure.vector('u8', [99])],
      });
    }, 'register_user', logger);

    const roomResult = await signAndAssert(handle.client, userKp, (tx) => {
      tx.moveCall({
        target: `${handle.config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(handle.config.networkRegistryId),
          tx.object(handle.config.roomManagerId),
          tx.object(handle.config.userRegistryId),
          tx.pure.u8(0), // relay_mode SFU
          tx.pure.u64(2),
          tx.pure.u8(0),
        ],
      });
    }, 'create_room', logger);
    roomId = extractRoomId(roomResult);

    await signAndAssert(handle.client, handle.deployer, (tx) => {
      tx.moveCall({
        target: `${handle.config.packageId}::room_manager::assign_relay_and_signaling`,
        arguments: [
          tx.object(handle.config.networkRegistryId),
          tx.object(handle.config.roomManagerId),
          tx.object(handle.adminCapId),
          tx.pure.id(roomId),
          tx.pure.id(relay.minerId),
          tx.pure.id(signalingOld.minerId),
        ],
      });
    }, 'assign_relay_and_signaling', logger);

    // Idle baseline AFTER register_signaling set last_heartbeat = epoch.
    baseEpoch = BigInt((await handle.client.getLatestSuiSystemState()).epoch);
    await waitForEpochAtLeast(handle.client, baseEpoch + IDLE_GAP, { timeoutMs: 720_000 }, logger);
  }, 900_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('room-health sweep reassigns the room off a fully-ejected signaling node', async () => {
    // ── Vote + eject the old signaling node ─────────────────────────────────
    expect(await getApprovedEjection(handle.client, cp.kp, signalingOld.minerId, handle.config)).toBeNull();
    await castLivenessVoteAs(handle.client, validatorA, signalingOld.minerId, handle.config, logger);
    await castLivenessVoteAs(handle.client, validatorB, signalingOld.minerId, handle.config, logger);
    expect(await getApprovedEjection(handle.client, cp.kp, signalingOld.minerId, handle.config)).not.toBeNull();
    await executeEjectionAs(handle.client, cp.kp, signalingOld.stakeId, handle.config, logger);

    // Confirm it's really gone from the registry (this is the exact dangling-
    // assignment state that motivated this feature).
    const regTx = new Transaction();
    regTx.moveCall({
      target: `${handle.config.packageId}::signaling_registry::is_registered`,
      arguments: [regTx.object(handle.config.signalingRegistryId), regTx.pure.id(signalingOld.minerId)],
    });
    const regRes = await handle.client.devInspectTransactionBlock({ sender: cp.kp.getPublicKey().toSuiAddress(), transactionBlock: regTx });
    const stillRegistered = Uint8Array.from(regRes.results![0]!.returnValues![0]![0])[0] === 1;
    expect(stillRegistered).toBe(false);

    // ── Run the room-health sweep ONCE against the live chain ───────────────
    const reader = new LiveRoomHealthChainStateReader(handle.client, handle.config, logger);
    const sweep = new RoomHealthSweep(
      reader,
      {
        promoteAfterEjection: makePromoteAfterEjectionSubmitter(handle.client, cp.kp, handle.config, logger),
        spillRelay: makeSpillRelaySubmitter(handle.client, cp.kp, handle.config, cp.cpCapId, logger),
        reassignSignaling: makeReassignSignalingSubmitter(handle.client, cp.kp, handle.config, logger),
      },
      logger,
    );
    const actions = await sweep.scanOnce();

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roomId,
          kind: 'reassign_signaling',
          oldNodeId: normalizeSuiAddress(signalingOld.minerId),
          newNodeId: normalizeSuiAddress(signalingNew.minerId),
        }),
      ]),
    );

    // ── Assert the room's assignment actually changed on-chain ─────────────
    const postTx = new Transaction();
    postTx.moveCall({
      target: `${handle.config.packageId}::room_manager::get_room_assignment`,
      arguments: [postTx.object(handle.config.roomManagerId), postTx.pure.id(roomId)],
    });
    const postRes = await handle.client.devInspectTransactionBlock({ sender: cp.kp.getPublicKey().toSuiAddress(), transactionBlock: postTx });
    const sigOptBytes = postRes.results![0]!.returnValues![1]![0];
    // BCS Option<ID>: byte 0 = 0 (None) / 1 (Some), remaining 32 bytes = the address.
    expect(sigOptBytes[0]).toBe(1);
    const newSigAddr = normalizeSuiAddress('0x' + Buffer.from(sigOptBytes.slice(1)).toString('hex'));
    expect(newSigAddr).toBe(normalizeSuiAddress(signalingNew.minerId));
  }, 60_000);
});
