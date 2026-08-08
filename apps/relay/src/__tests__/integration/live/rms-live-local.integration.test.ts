/**
 * RMS-live LOCAL — L3.3 CAPSTONE headline, ON-CHAIN half (REQ-RMS-031).
 *
 * SPLIT NOTE: this is the ON-CHAIN (LIVE localnet) half of the L3.3 headline. The
 * cross-relay-MEDIA half (Assertion B — in-process real mediasoup, REQ-RMS-032)
 * lives in `../rms-live-local-media.integration.test.ts`. They are SEPARATE files
 * because real mediasoup Workers and a `sui start` localnet CANNOT co-reside in one
 * vitest fork, and `vitest.integration.config.ts` runs `singleFork:true` (so two
 * localnet tests never boot sui concurrently on :9000) — putting mediasoup in the
 * same fork starves the `sui start` port-bind (empirically: `waitForPort 9000 not
 * reachable`). This on-chain file therefore stays under `vitest.integration.config.ts`
 * (localnet-booting tests); the media file runs under `vitest.relay-integration.config.ts`.
 *
 *   ── Assertion A (REQ-RMS-031) — ON-CHAIN K_r>=3 distinct ACTIVE relays ──
 *   A LIVE localnet, the PRODUCTION cp `handleEvent`, RMS_KR_MIN=3 → the room's
 *   on-chain `RoomAssigned.relay_ids` spans >= 3 DISTINCT ACTIVE relay miner_ids.
 *   This is `rms-kr3-placement` lifted verbatim. The validator-floor blocker that
 *   `rms-kr3`'s header once flagged is RESOLVED on this branch — `cp-daemon/src/
 *   event-handler.ts` floors the emitted validators to MIN_VALIDATORS_PER_ROOM (4)
 *   (`Math.max(1, Math.min(rankedValidators.length, 4))`), so with 4 validators
 *   pre-registered the ballot passes `submit_pairing_proposal` and `RoomAssigned`
 *   lands → this goes GREEN on a machine with a `sui` localnet.
 *   LOCALNET-BOOTING: runs ONLY via `pnpm test:integration` (vitest.integration.
 *   config.ts); with no `sui` on :9000 it fails fast at boot (EXPECTED headless).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { createLogger, MinerRole, type Logger, type EscrowCreated } from '@dvconf/shared';

// ── cp-daemon PRODUCTION handler + localnet fixtures (cross-app, SAME repo).
//    The relative depth reaches `apps/` (5 ups from this `live/` dir): live → integration →
//    __tests__ → src → relay → apps. esbuild/vite resolves the `.js`→`.ts` at runtime under
//    vitest.integration.config.ts (root = dvconf-daemons). Same pattern as the EXISTING
//    cross-app relay tests (canary-forward imports validator-daemon source).
import { handleEvent, DEFAULT_WEIGHTS } from '../../../../../cp-daemon/src/event-handler.js';
import { PVR_DEFAULT_HISTORY, type NodeCandidate } from '../../../../../cp-daemon/src/scoring.js';
import { bootLocalnet, type LocalnetHandle } from '../../../../../cp-daemon/src/__tests__/integration/localnet-fixture.js';
import {
  bootstrapCp,
  voteAndApplyRelay,
  registerMiner,
  createFundedKeypair,
  castRoleVoteFromCp,
  applyVotedRoleAs,
  RELAY_STAKE_MIST,
  type BootstrapCpResult,
} from '../../../../../cp-daemon/src/__tests__/integration/revote-localnet-helpers.js';

const GAS_BUDGET = 100_000_000;

/** Local sign+execute+assert-success helper. */
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

/** Full lifecycle for ONE non-relay role node (register 0.3-SUI miner → CP-vote → apply → enroll). */
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
    id: { txDigest: 'rms-live-local-digest', eventSeq: '0' },
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

// ════════════════════════════════════════════════════════════════════════════
// Assertion A — ON-CHAIN K_r>=3 distinct ACTIVE relays (REQ-RMS-031)
// ════════════════════════════════════════════════════════════════════════════

describe('Assertion A — on-chain K_r>=3 distinct ACTIVE relays (REQ-RMS-031, LIVE localnet)', () => {
  let handle: LocalnetHandle;
  let cp: BootstrapCpResult;
  let relayIds: string[];
  let validatorIds: string[];
  let roomId: string;
  let userKp: Ed25519Keypair;
  const logger: Logger = createLogger('rms-live-local-assertionA');
  const priorKrMin = process.env['RMS_KR_MIN'];

  beforeAll(async () => {
    // portWaitMs 180_000 (not the default 120_000): sui boot port-open time sits near the
    // 120s cap on a contended Windows host and intermittently crossed it → de-flake the headline.
    // Upper bound: hookTimeout(300s) − rpcDeadline(60s) − publish/register(~55s) ≈ 185s, so 180s is safe.
    handle = await bootLocalnet({ epochDurationMs: 2000, portWaitMs: 180_000 });

    // 1 CP (floored quorum = 1 for every cast below).
    cp = await bootstrapCp(handle.client, handle.config, logger);

    // 3 ACTIVE relays — the K_r=3 placement target.
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
              tx.object(handle.config.networkRegistryId),
              tx.object(handle.config.validatorRegistryId),
              tx.object(capId),
              tx.object(stakeId),
            ],
          });
        },
        'register_validator',
        logger,
      );
      validatorIds.push(id);
    }

    // A registered USER creates a PENDING room. expected_participants=2 -> required_validators floors to 4.
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
    process.env['RMS_KR_MIN'] = '3';

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

    const assignedRelays = await pollRoomAssignedRelays(handle.client, handle.config.packageId, roomId, 90_000);
    expect(assignedRelays, 'RoomAssigned event for the room must land on-chain').not.toBeNull();

    const distinct = new Set(assignedRelays!);
    expect(distinct.size).toBeGreaterThanOrEqual(3); // >= 3 ACTIVE relays
    for (const id of assignedRelays!) {
      expect(relayIds).toContain(id); // every assigned id is one of the registered relays
    }
  }, 300_000);
});
