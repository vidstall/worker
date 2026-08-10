/**
 * Dispatch-2 room-lifecycle orchestration + submit_session_proof measurement.
 * Pure extraction from the original measure-onchain-cost.ts — no behavior
 * changes.
 */

import { bcs } from '@mysten/bcs';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { type NetworkConfig, type Logger, type TxResult } from '../../../packages/shared/src/index.ts';
import { type CpHandle, type SeededKey } from '../../demo/seed-bootstrap.ts';
import { serializeProofBcs, dualKeySign } from '../../../apps/validator-daemon/src/session-proof.ts';
import { type K2ProofContext } from '../cost-k2-evidence.ts';
import { buildReadyValidator, buildSecondRelay, type ReadyValidator } from './actor-bootstrap.ts';
import {
  MODULE,
  K,
  N,
  FAUCET_URL,
  fundAndWait,
  measureCapture,
  signAndCapture,
  type CostRow,
} from './tx-cost-helpers.ts';

/** Read the RoomCreated event's room_id off a create_room TxResult (typed for the
 *  shared TxResult, unlike the shared extractRoomId which wants TxStatusLike). */
function extractRoomIdFromResult(result: TxResult): string {
  const evt = (result.events ?? []).find((e) => String((e as { type?: string }).type ?? '').includes('::room_manager::RoomCreated'));
  const roomId = (evt as { parsedJson?: { room_id?: unknown } } | undefined)?.parsedJson?.room_id;
  if (typeof roomId !== 'string') {
    throw new Error('extractRoomIdFromResult: RoomCreated event missing or malformed');
  }
  return normalizeSuiAddress(roomId);
}

/** Read the EscrowCreated event's escrow_id off a create_escrow TxResult. */
function extractEscrowId(result: TxResult): string {
  const evt = (result.events ?? []).find((e) => String((e as { type?: string }).type ?? '').includes('::economic_layer::EscrowCreated'));
  const escrowId = (evt as { parsedJson?: { escrow_id?: unknown } } | undefined)?.parsedJson?.escrow_id;
  if (typeof escrowId !== 'string') {
    throw new Error('extractEscrowId: EscrowCreated event missing or malformed');
  }
  return normalizeSuiAddress(escrowId);
}

/**
 * The whole Dispatch-2 room-lifecycle + hard-function measurement block.
 * Preconditions satisfied inline (see module-header comment). Reuses the already-
 * seeded CP / primary relay / primary validator from Block A.
 */
export async function measureDispatch2(
  client: SuiClient,
  config: NetworkConfig,
  cp: CpHandle,
  primaryRelay: { minerId: string },
  primaryValidator: SeededKey,
  primaryValidatorKp: Ed25519Keypair,
  rows: CostRow[],
  logger: Logger,
  graphqlClient: SuiGraphQLClient,
): Promise<void> {
  logger.info({ module: MODULE, action: 'dispatch2_start' }, 'Dispatch-2: building room-lifecycle preconditions...');

  // ── (a) A second relay so the pairing ballot has >= min_relay(=2) relays. ──
  const relay2MinerId = await buildSecondRelay(client, cp, config, logger);

  // ── (b) FOUR ready validators (required_validators for a small room = 4).
  //     Two of them (V0,V1) will each attest the SAME relay → distinct-coverage=2.
  //     V0 is the "measure" validator: its register / register_validator /
  //     self_assign_session_wallet are the measured bonus rows, and its
  //     submit_session_proof is the DOMINANT §5.3 measurement. ──
  const validators: ReadyValidator[] = [];
  for (let i = 0; i < 4; i++) {
    validators.push(await buildReadyValidator(client, cp, config, i, rows, logger));
  }
  const validatorIds = validators.map((v) => v.minerId);

  // ── (c) A fresh registered USER who creates + funds + closes the room. ──
  const userKp = Ed25519Keypair.generate();
  await fundAndWait(client, userKp.getPublicKey().toSuiAddress());
  // top up: room lifecycle = register_user + create_room + create_escrow(1 SUI) + close_room
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: userKp.getPublicKey().toSuiAddress() });
  await new Promise((r) => setTimeout(r, 1500));

  // user_registry::register_user — MEASURED (bonus row).
  {
    const { row } = await measureCapture(
      client,
      userKp,
      'register_user',
      'user_registry',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::user_registry::register_user`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.userRegistryId),
            tx.pure.vector('u8', [99]),
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }

  // room_manager::create_room (SFU, expected_participants=2, room_class_hint=0) — MEASURED.
  let roomId = '';
  {
    const { row, result } = await measureCapture(
      client,
      userKp,
      'create_room',
      'room_manager',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::create_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.userRegistryId),
            tx.pure.u8(0), // relay_mode SFU
            tx.pure.u64(2), // expected_participants (required_validators = max(4, 2/3) = 4)
            tx.pure.u8(0), // room_class_hint = small
          ],
        });
      },
      logger,
      graphqlClient,
    );
    rows.push(row);
    roomId = extractRoomIdFromResult(result);
  }
  logger.info({ module: MODULE, action: 'room_created', roomId }, 'room created');

  // economic_layer::create_escrow (user-signed, 1 SUI) — MEASURED. Emits EscrowCreated.
  // ORDER-CRITICAL: create_escrow asserts the room is PENDING (E_ROOM_NOT_PENDING=653),
  // so it MUST run BEFORE submit_pairing_proposal (which finalizes PENDING → READY).
  let escrowId = '';
  const ESCROW_AMOUNT_MIST = 1_000_000_000n;
  {
    const { row, result } = await measureCapture(
      client,
      userKp,
      'create_escrow',
      'economic_layer',
      (tx) => {
        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(ESCROW_AMOUNT_MIST)]);
        tx.moveCall({
          target: `${config.packageId}::economic_layer::create_escrow`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.pure.id(roomId),
            payment!,
          ],
        });
      },
      logger,
      graphqlClient,
    );
    rows.push(row);
    escrowId = extractEscrowId(result);
  }
  logger.info({ module: MODULE, action: 'escrow_created', escrowId }, 'escrow created');

  // room_manager::submit_pairing_proposal (CP-signed) — MEASURED. relay-only:
  // the standalone signaling node type (and its registry-liveness gate) was
  // removed from the contract, and this entry now also takes a
  // health_validator_ids ballot argument (all four ready validators, here).
  // With 1 active CP, required = ceil(1 * 2/3) = 1 → this single proposal FINALIZES the
  // room (PENDING → READY) and writes assigned_relays + assigned_validators.
  // Runs AFTER create_escrow (see ORDER-CRITICAL note above) but BEFORE the proofs
  // (submit_session_proof asserts the validator IS assigned).
  // Ballot: [relay1, relay2] (>= min_relay 2), [v0..v3] (>= required_validators 4).
  const relayIds = [primaryRelay.minerId, relay2MinerId];
  {
    const { row } = await measureCapture(
      client,
      cp.kp,
      'submit_pairing_proposal',
      'room_manager',
      (tx) => {
        tx.moveCall({
          // submit_pairing_proposal is defined in the room_manager_pairing
          // satellite module (pairing.move), not room_manager itself.
          target: `${config.packageId}::room_manager_pairing::submit_pairing_proposal`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.cpRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(cp.cpCapId),
            tx.pure.id(roomId),
            tx.pure.vector('id', relayIds),
            tx.pure.vector('id', validatorIds),
            tx.pure.u64(1000), // submitted_score (arbitrary; contract does NOT recompute)
            tx.pure.vector('id', validatorIds), // health_validator_ids (all four are healthy)
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }
  logger.info({ module: MODULE, action: 'room_finalized', roomId }, 'room finalized via pairing proposal (validators assigned)');

  // ── (d) submit_session_proof — measure the shipped K×N state exactly:
  //     all four assigned validators attest both assigned relays (8 tx rows). ──
  let proofOrdinal = 0;
  for (let validatorIndex = 0; validatorIndex < validators.length; validatorIndex += 1) {
    for (let relaySlot = 0; relaySlot < relayIds.length; relaySlot += 1) {
      proofOrdinal += 1;
      const relayMinerId = relayIds[relaySlot]!;
      const measuredProofRow = await measureSubmitSessionProof(
        client,
        config,
        escrowId,
        roomId,
        relayMinerId,
        validators[validatorIndex]!,
        logger,
      );
      const context: K2ProofContext = {
        validator_index: validatorIndex,
        relay_slot: relaySlot,
        relay_miner_id: relayMinerId,
        proof_ordinal: proofOrdinal,
        K,
        N,
      };
      const contextualRow: CostRow & { context: K2ProofContext } = {
        ...measuredProofRow,
        context,
      };
      rows.push(contextualRow);
    }
  }
  logger.info(
    { module: MODULE, action: 'proofs_submitted', proofCount: proofOrdinal, K, N },
    'all K x N proof transactions submitted and measured',
  );

  // ── (e) room_manager::close_room (user-signed) — MEASURED (bonus row).
  //     distribute_rewards asserts the room is CLOSED. ──
  {
    const { row } = await measureCapture(
      client,
      userKp,
      'close_room',
      'room_manager',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::close_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.pure.id(roomId),
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }
  logger.info({ module: MODULE, action: 'room_closed', roomId }, 'room closed');

  // ── (f) economic_layer::distribute_rewards — MEASURED only after all eight
  //     K=2/N=4 proofs and close_room succeed. Crank pattern (any signer). ──
  {
    const { row } = await measureCapture(
      client,
      userKp,
      'distribute_rewards',
      'economic_layer',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::economic_layer::distribute_rewards`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(escrowId),
            tx.object(config.roomManagerId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(config.cpRegistryId),
          ],
        });
      },
      logger,
    );
    rows.push(row);
  }
  logger.info({ module: MODULE, action: 'dispatch2_done' }, 'Dispatch-2 complete: submit_session_proof + distribute_rewards measured');
}

/**
 * Build the exact submit_session_proof PTB (reusing the daemon's serializeProofBcs +
 * dualKeySign crypto) and MEASURE its gasUsed. Returns the CostRow.
 *
 * Signing/identity contract (economic_layer.move:280-307):
 *   - TX sender      = session wallet B  (validator.sessionKp)
 *   - pubkey_public  = wallet A pubkey   (validator.mainKp)   → blake2b256(0x00||pk_A) == operator
 *   - pubkey_session = wallet B pubkey   (validator.sessionKp) → blake2b256(0x00||pk_B) == sender
 *   - msg (IC-2)     = serializeProofBcs(...) signed by BOTH A and B (dualKeySign).
 */
async function measureSubmitSessionProof(
  client: SuiClient,
  config: NetworkConfig,
  escrowId: string,
  roomId: string,
  relayMinerId: string,
  v: ReadyValidator,
  logger: Logger,
): Promise<CostRow> {
  const proof = buildProofFields();
  const bcsMessage = serializeProofBcs(
    roomId,
    relayMinerId,
    proof.packetsForwarded,
    proof.bytesTransferred,
    proof.uniquePeers,
    proof.durationSeconds,
    proof.avgLatencyMs,
    proof.packetLossBps,
    proof.jitterMs,
  );
  const { signatureA: sigPublic, signatureB: sigSession } = await dualKeySign(bcsMessage, v.mainKp, v.sessionKp);
  const pubkeyPublic = v.mainKp.getPublicKey().toRawBytes();
  const pubkeySession = v.sessionKp.getPublicKey().toRawBytes();

  const build = (tx: Transaction): void => {
    tx.moveCall({
      target: `${config.packageId}::economic_layer::submit_session_proof`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(escrowId),
        tx.object(config.roomManagerId),
        tx.object(config.validatorRegistryId),
        tx.object(config.relayRegistryId),
        tx.pure.id(roomId),
        tx.pure.id(relayMinerId),
        tx.pure.u64(proof.packetsForwarded),
        tx.pure.u64(proof.bytesTransferred),
        tx.pure.u64(proof.uniquePeers),
        tx.pure.u64(proof.durationSeconds),
        tx.pure.u64(proof.avgLatencyMs),
        tx.pure.u64(proof.packetLossBps),
        tx.pure.u64(proof.jitterMs),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeyPublic))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeySession))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigPublic))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigSession))),
      ],
    });
  };
  // TX signed by the SESSION wallet (B).
  const { row } = await measureCapture(client, v.sessionKp, 'submit_session_proof', 'economic_layer', build, logger);
  return row;
}

/** Execute (unmeasured) a 2nd distinct-validator proof for the SAME relay. */
async function submitSessionProofExec(
  client: SuiClient,
  config: NetworkConfig,
  escrowId: string,
  roomId: string,
  relayMinerId: string,
  v: ReadyValidator,
  logger: Logger,
): Promise<void> {
  const proof = buildProofFields();
  const bcsMessage = serializeProofBcs(
    roomId,
    relayMinerId,
    proof.packetsForwarded,
    proof.bytesTransferred,
    proof.uniquePeers,
    proof.durationSeconds,
    proof.avgLatencyMs,
    proof.packetLossBps,
    proof.jitterMs,
  );
  const { signatureA: sigPublic, signatureB: sigSession } = await dualKeySign(bcsMessage, v.mainKp, v.sessionKp);
  const pubkeyPublic = v.mainKp.getPublicKey().toRawBytes();
  const pubkeySession = v.sessionKp.getPublicKey().toRawBytes();
  await signAndCapture(
    client,
    v.sessionKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::economic_layer::submit_session_proof`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(escrowId),
          tx.object(config.roomManagerId),
          tx.object(config.validatorRegistryId),
          tx.object(config.relayRegistryId),
          tx.pure.id(roomId),
          tx.pure.id(relayMinerId),
          tx.pure.u64(proof.packetsForwarded),
          tx.pure.u64(proof.bytesTransferred),
          tx.pure.u64(proof.uniquePeers),
          tx.pure.u64(proof.durationSeconds),
          tx.pure.u64(proof.avgLatencyMs),
          tx.pure.u64(proof.packetLossBps),
          tx.pure.u64(proof.jitterMs),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeyPublic))),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeySession))),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigPublic))),
          tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigSession))),
        ],
      });
    },
    'submit_session_proof(v2-coverage)',
    logger,
  );
}

/**
 * Deterministic, valid proof-field values. Loss = 100 bps (1% < 2% "excellent")
 * so the relay's per-relay quality > 0 (qualifies, not slashed). duration=30s > 0
 * so a standby-liveness gate would pass; bytes > 0 so the reward pool is non-zero.
 */
function buildProofFields(): {
  packetsForwarded: bigint;
  bytesTransferred: bigint;
  uniquePeers: bigint;
  durationSeconds: bigint;
  avgLatencyMs: bigint;
  packetLossBps: bigint;
  jitterMs: bigint;
} {
  return {
    packetsForwarded: 10_000n,
    bytesTransferred: 1_000_000n,
    uniquePeers: 2n,
    durationSeconds: 30n,
    avgLatencyMs: 50n,
    packetLossBps: 100n, // 1% → "excellent" quality (> 0), relay qualifies
    jitterMs: 5n,
  };
}
