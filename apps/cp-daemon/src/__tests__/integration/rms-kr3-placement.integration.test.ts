/**
 * RMS-live LOCAL — K_r>1 ACTIVE-relay placement, end-to-end against a LIVE localnet
 * (REQ-RMS-021).
 *
 * The headline this asserts: with `RMS_KR_MIN=3` set, driving a real `EscrowCreated`
 * through the PRODUCTION cp event handler makes the room's on-chain `assigned_relays`
 * span >= 3 DISTINCT ACTIVE relays (vs the M1 single-relay path that records a
 * MIN_RELAY-padded ballot where only relay[0] actively serves).
 *
 * Flow (mirrors role-revote-e2e.integration.test.ts, the authoritative live driver):
 *   1. Boot the localnet fixture (bootLocalnet) + publish.
 *   2. Bootstrap 1 CP, register 3 relays (voteAndApplyRelay x3 — the fixture's
 *      relay-registration helper, looped with distinct funded keypairs), register 4
 *      validators (the on-chain ballot's liveness requirements), and register a
 *      USER + create a PENDING room.
 *   3. Set process.env.RMS_KR_MIN = '3' (restored in afterEach so it can't leak), then
 *      drive a synthesized `EscrowCreated` for that room through the PRODUCTION
 *      `handleEvent` with a real txContext (CP signer + cpCapId). The K_r>1 branch
 *      routes to `selectActiveRelays`, which emits 3 distinct ACTIVE relay ids; the
 *      handler's fire-and-forget `submitProposal` lands them via
 *      `room_manager::submit_pairing_proposal`.
 *   4. Poll the on-chain `RoomAssigned` event for the room and assert its `relay_ids`
 *      vector has >= 3 DISTINCT entries, all in the registered-relay set.
 *
 * LOCALNET-BOOTING / LIVE-GATED: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), never `pnpm test`. With no `sui` on :9000 it fails
 * fast at boot (`sui ... exited 1` / ECONNREFUSED) — EXPECTED in headless CI; this is
 * an artifact to green-run on the user's machine, exactly like role-revote-e2e.
 *
 * ⚠️ KNOWN PRE-EXISTING BLOCKER (orthogonal to REQ-RMS-021 / the K_r change):
 * `room_manager::submit_pairing_proposal` asserts `validator_ids.length >=
 * required_validators(expected_participants)`, and `pairing_score::required_validators`
 * FLOORS at `DEFAULT_MIN_VALIDATORS_PER_ROOM = 4` (constants.move) — so the ballot
 * needs >= 4 validators. The production `handleEvent` emits at most 3 validators
 * (`rankedValidators.slice(0, Math.max(1, Math.min(3, len)))`), so the on-chain submit
 * reverts with E_INVALID_BALLOT *before* it ever checks the relay liveness or
 * emits `RoomAssigned`. The 4 validators are pre-registered here so the ONLY remaining
 * gap to a green run is lifting the handler's `Math.min(3, …)` validator cap to the
 * contract floor (a one-line follow-up, out of scope for the K_r placement task). Until
 * then the poll below times out and the assertion fails — by design, this test goes
 * green the moment that ballot-floor mismatch is resolved.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { createLogger, MinerRole, type Logger, type NetworkConfig, type EscrowCreated } from '@dvconf/shared';
import { handleEvent, DEFAULT_WEIGHTS } from '../../event-handler.js';
import { PVR_DEFAULT_HISTORY, type NodeCandidate } from '../../scoring.js';
import { bootLocalnet, fundAddress, type LocalnetHandle } from './localnet-fixture.js';
import {
  bootstrapCp,
  voteAndApplyRelay,
  registerMiner,
  createFundedKeypair,
  castRoleVoteFromCp,
  applyVotedRoleAs,
  RELAY_STAKE_MIST,
  type BootstrapCpResult,
} from './revote-localnet-helpers.js';

const GAS_BUDGET = 100_000_000;

/** Local sign+execute+assert-success helper (mirrors revote-localnet-helpers' private one). */
async function signAndAssertLocal(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<{ digest: string; events?: Array<{ type?: string; parsedJson?: unknown }> }> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(GAS_BUDGET);
  const result = (await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  })) as unknown as {
    digest: string;
    effects?: { status?: { status?: string; error?: string } };
    events?: Array<{ type?: string; parsedJson?: unknown }>;
  };
  await client.waitForTransaction({ digest: result.digest, options: { showEffects: true } });
  const status = result.effects?.status?.status;
  if (status !== 'success') {
    throw new Error(`${label} failed on-chain: status=${status ?? 'unknown'} error=${result.effects?.status?.error ?? '(none)'}`);
  }
  logger.info({ action: label, context: { digest: result.digest } }, `${label} succeeded on-chain`);
  return result;
}

/**
 * Full lifecycle for ONE non-relay role node: register a 0.3-SUI miner (role User ->
 * MinerCap), CP-vote it into `role` (1 CP meets the floored quorum), apply, then enroll
 * into the role registry. Returns the miner id. Stake 0.3 SUI clears every role floor
 * (signaling 0.05 / validator 0.1) while staying below the CP threshold (0.5 -> User).
 */
async function registerRoleNode(
  handle: LocalnetHandle,
  cp: BootstrapCpResult,
  role: number,
  enroll: (tx: Transaction, minerCapId: string, stakeId: string) => void,
  label: string,
  logger: Logger,
): Promise<string> {
  const kp = await createFundedKeypair(logger);
  const reg = await registerMiner(handle.client, kp, handle.config, RELAY_STAKE_MIST, logger);
  if (reg.minerCapId === null) throw new Error(`${label}: expected a MinerCap from a 0.3 SUI register`);
  const minerCapId = reg.minerCapId;
  await castRoleVoteFromCp(handle.client, cp, reg.minerId, role, handle.config, logger);
  await applyVotedRoleAs(handle.client, kp, minerCapId, reg.stakeId, handle.config, logger);
  await signAndAssertLocal(handle.client, kp, (tx) => enroll(tx, minerCapId, reg.stakeId), label, logger);
  return reg.minerId;
}

/** Synthesize a minimal SuiEvent (only `type` + `parsedJson` are read by handleEvent). */
function makeSuiEvent(packageId: string, module: string, eventName: string, parsedJson: Record<string, unknown>): SuiEvent {
  return {
    id: { txDigest: 'rms-kr3-digest', eventSeq: '0' },
    packageId,
    transactionModule: module,
    sender: '0x0',
    type: `${packageId}::${module}::${eventName}`,
    parsedJson,
    bcs: '',
    timestampMs: '1000',
  } as SuiEvent;
}

/** A healthy, high-capacity relay candidate keyed by its registered miner id. */
function healthyRelay(minerId: string): NodeCandidate {
  return { minerId, rtt: 0n, load: 0n, stakeAmount: RELAY_STAKE_MIST, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY };
}

/** Poll the on-chain RoomAssigned event for `roomId`; return its (normalized) relay_ids or null on timeout. */
async function pollRoomAssignedRelays(
  client: SuiClient,
  packageId: string,
  roomId: string,
  deadlineMs: number,
): Promise<string[] | null> {
  const target = normalizeSuiAddress(roomId);
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await client.queryEvents({
      query: { MoveEventType: `${packageId}::room_manager::RoomAssigned` },
      limit: 50,
      order: 'descending',
    });
    for (const ev of res.data) {
      const pj = ev.parsedJson as { room_id?: unknown; relay_ids?: unknown };
      if (typeof pj?.room_id === 'string' && normalizeSuiAddress(pj.room_id) === target && Array.isArray(pj.relay_ids)) {
        return (pj.relay_ids as string[]).map((id) => normalizeSuiAddress(id));
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

describe('RMS-live K_r=3 ACTIVE-relay placement (REQ-RMS-021)', () => {
  let handle: LocalnetHandle;
  let cp: BootstrapCpResult;
  let relayIds: string[];
  let validatorIds: string[];
  let roomId: string;
  let userKp: Ed25519Keypair;
  const logger: Logger = createLogger('rms-kr3-placement-e2e');
  const priorKrMin = process.env['RMS_KR_MIN'];

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: 2000 });

    // 1 CP (floored quorum = 1 for every cast below).
    cp = await bootstrapCp(handle.client, handle.config, logger);

    // 3 ACTIVE relays — the K_r=3 placement target. voteAndApplyRelay registers each into
    // RelayRegistry; loop it with distinct funded keypairs.
    relayIds = [];
    for (let i = 0; i < 3; i++) {
      const relay = await voteAndApplyRelay(handle.client, cp, handle.config, logger);
      relayIds.push(relay.minerId);
    }

    // 4 validators — satisfies submit_pairing_proposal's required_validators floor (>= 4).
    validatorIds = [];
    for (let i = 0; i < 4; i++) {
      const id = await registerRoleNode(
        handle,
        cp,
        MinerRole.Validator,
        (tx, capId, stakeId) => {
          tx.moveCall({
            target: `${handle.config.packageId}::validator_registry::register_validator`,
            arguments: [
              tx.object(handle.config.networkRegistryId), // net_reg: &NetworkRegistry
              tx.object(handle.config.validatorRegistryId), // registry: &mut ValidatorRegistry
              tx.object(capId), // cap: &MinerCap (role Validator)
              tx.object(stakeId), // stake: &StakePosition
            ],
          });
        },
        'register_validator',
        logger,
      );
      validatorIds.push(id);
    }

    // A registered USER creates a PENDING room (NOT admin-assigned, so status stays PENDING
    // for submit_pairing_proposal). expected_participants=2 -> required_validators floors to 4.
    userKp = await createFundedKeypair(logger);
    await signAndAssertLocal(handle.client, userKp, (tx) => {
      tx.moveCall({
        target: `${handle.config.packageId}::user_registry::register_user`,
        arguments: [tx.object(handle.config.networkRegistryId), tx.object(handle.config.userRegistryId), tx.pure.vector('u8', [99])],
      });
    }, 'register_user', logger);
    const roomResult = await signAndAssertLocal(handle.client, userKp, (tx) => {
      tx.moveCall({
        target: `${handle.config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(handle.config.networkRegistryId),
          tx.object(handle.config.roomManagerId),
          tx.object(handle.config.userRegistryId),
          tx.pure.u8(0), // relay_mode SFU
          tx.pure.u64(2), // expected_participants
          tx.pure.u8(0), // room_class_hint = small
        ],
      });
    }, 'create_room', logger);
    const roomEvt = (roomResult.events ?? []).find((e) => (e.type ?? '').includes('::room_manager::RoomCreated'));
    const rawRoomId = (roomEvt?.parsedJson as { room_id?: unknown })?.room_id;
    if (typeof rawRoomId !== 'string') throw new Error('create_room: RoomCreated event missing room_id');
    roomId = normalizeSuiAddress(rawRoomId);
  }, 300_000);

  afterEach(() => {
    // Never leak the K_r override into sibling tests.
    if (priorKrMin === undefined) delete process.env['RMS_KR_MIN'];
    else process.env['RMS_KR_MIN'] = priorKrMin;
  });

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('RMS_KR_MIN=3 -> room assigned_relays spans >= 3 distinct ACTIVE relays on-chain', async () => {
    // Force the K_r>1 placement branch.
    process.env['RMS_KR_MIN'] = '3';

    // In-memory cp state mirroring the on-chain registrations.
    const relayState = new Map<string, NodeCandidate>(relayIds.map((id) => [id, healthyRelay(id)]));
    const validatorState = new Map<string, NodeCandidate>(validatorIds.map((id) => [id, healthyRelay(id)]));
    const pendingRooms = new Map([[roomId, { room_id: roomId, creator: userKp.getPublicKey().toSuiAddress(), relay_mode: 0, room_class_hint: 0 }]]);
    const pendingEscrows = new Map<string, EscrowCreated>();

    const txContext = {
      client: handle.client,
      signer: cp.kp,
      config: handle.config,
      cpCapId: cp.cpCapId,
    };

    // Drive the PRODUCTION handler. handleEvent is sync and fires submitProposal
    // (executeWithRetry) without awaiting — the TX settles asynchronously, polled below.
    const escrow = makeSuiEvent(handle.config.packageId, 'economic_layer', 'EscrowCreated', {
      escrow_id: '0x000000000000000000000000000000000000000000000000000000000000e5c0',
      room_id: roomId,
      creator: userKp.getPublicKey().toSuiAddress(),
      amount: '1000',
    });
    handleEvent(
      escrow,
      relayState,
      pendingRooms,
      logger,
      DEFAULT_WEIGHTS,
      txContext,
      pendingEscrows,
      validatorState,
    );

    // Read the on-chain headline: RoomAssigned.relay_ids for this room.
    const assignedRelays = await pollRoomAssignedRelays(handle.client, handle.config.packageId, roomId, 90_000);
    expect(assignedRelays, 'RoomAssigned event for the room must land on-chain (see header: ballot-floor blocker)').not.toBeNull();

    const distinct = new Set(assignedRelays!);
    expect(distinct.size).toBeGreaterThanOrEqual(3); // >= 3 ACTIVE relays
    for (const id of assignedRelays!) {
      expect(relayIds).toContain(id); // every assigned id is one of the registered relays
    }
  }, 300_000);
});
