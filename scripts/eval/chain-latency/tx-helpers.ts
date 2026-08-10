/**
 * Transaction execution, roster bootstrap, and sample-record helpers for
 * the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import { bcs } from '@mysten/sui/bcs';
import type {
  SuiClient,
  SuiEvent,
  SuiTransactionBlockResponse,
} from '@mysten/sui/client';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  dualKeySign,
  serializeProofBcs,
} from '../../../apps/validator-daemon/src/session-proof.ts';
import {
  fetchEventsForDigest,
  type Logger,
  type NetworkConfig,
} from '../../../packages/shared/src/index.ts';
import {
  bootstrapCp,
  voteAndApplyMiner,
  type SeededKey,
} from '../../demo/seed-bootstrap.ts';

import {
  ESCROW_AMOUNT_MIST,
  EXPECTED_VALIDATORS,
  FAUCET_URL,
  GAS_BUDGET_MIST,
  GRAPHQL_CLIENT,
  PROOFS_PER_ROOM,
  SCHEMA_VERSION,
} from './constants.ts';
import type {
  ChainLatencyOptions,
  FinalityReturn,
  Metric,
  ObservedTargetEvent,
  ReadyValidator,
  Roster,
  SampleRecord,
  TimedExecution,
} from './types.ts';
import { nowPair, sleep } from './util.ts';

export async function fundAndWait(client: SuiClient, address: string, timeoutMs = 90_000): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const coins = await client.getCoins({ owner: address });
    if (coins.data.length > 0) return;
    if (Date.now() >= deadline) throw new Error(`faucet gas not indexed for ${address}`);
    await sleep(1_000);
  }
}

export function assertTxSuccess(result: SuiTransactionBlockResponse, label: string): void {
  const status = result.effects?.status;
  if (status?.status !== 'success') {
    throw new Error(
      `${label} failed on-chain: status=${status?.status ?? 'missing'} error=${status?.error ?? '(none)'}`,
    );
  }
}

export async function executeUnmeasured(
  client: SuiClient,
  signer: Ed25519Keypair,
  label: string,
  build: (tx: Transaction) => void,
): Promise<SuiTransactionBlockResponse> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(GAS_BUDGET_MIST);
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  assertTxSuccess(result, label);
  const finality = await client.waitForTransaction({
    digest: result.digest,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  assertTxSuccess(finality, `${label} finality`);
  if (!result.events || result.events.length === 0) {
    result.events = await fetchEventsForDigest(GRAPHQL_CLIENT, result.digest);
  }
  return result;
}

export async function executeTimed(
  client: SuiClient,
  signer: Ed25519Keypair,
  label: string,
  build: (tx: Transaction) => void,
): Promise<TimedExecution> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(GAS_BUDGET_MIST);
  const submit = nowPair();
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  const rpcReturn = nowPair();
  assertTxSuccess(result, label);
  if (!result.events || result.events.length === 0) {
    result.events = await fetchEventsForDigest(GRAPHQL_CLIENT, result.digest);
  }
  return { result, digest: result.digest, submit, rpcReturn };
}

export async function awaitFinality(
  client: SuiClient,
  digest: string,
  label: string,
): Promise<FinalityReturn> {
  const result = await client.waitForTransaction({
    digest,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  const time = nowPair();
  assertTxSuccess(result, `${label} finality`);
  return { result, time };
}

export function exactEvent(
  result: SuiTransactionBlockResponse,
  eventType: string,
  label: string,
): SuiEvent {
  const matches = (result.events ?? []).filter((event) => event.type === eventType);
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one ${eventType} receipt event, got ${matches.length}`);
  }
  return matches[0]!;
}

export function eventRoomId(event: SuiEvent, label: string): string {
  const value = (event.parsedJson as { room_id?: unknown } | null)?.room_id;
  if (typeof value !== 'string') throw new Error(`${label}: event room_id missing or malformed`);
  return normalizeSuiAddress(value);
}

export function eventEscrowId(event: SuiEvent, label: string): string {
  const value = (event.parsedJson as { escrow_id?: unknown } | null)?.escrow_id;
  if (typeof value !== 'string') throw new Error(`${label}: event escrow_id missing or malformed`);
  return normalizeSuiAddress(value);
}

export async function buildRoster(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<Roster> {
  const cp = await bootstrapCp(client, config, logger);
  const relay = await voteAndApplyMiner(client, cp, 'relay', config, logger);
  const relayStandby = await voteAndApplyMiner(client, cp, 'relay-standby', config, logger);

  const validators: ReadyValidator[] = [];
  for (let index = 0; index < EXPECTED_VALIDATORS; index += 1) {
    const seeded = await voteAndApplyMiner(client, cp, 'validator', config, logger);
    const mainKp = Ed25519Keypair.fromSecretKey(seeded.secretKey);
    const sessionKp = Ed25519Keypair.generate();
    const sessionAddress = sessionKp.getPublicKey().toSuiAddress();
    await fundAndWait(client, sessionAddress);
    await executeUnmeasured(client, mainKp, `self_assign_session_wallet(v${index})`, (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(seeded.capId),
          tx.pure.address(sessionAddress),
        ],
      });
    });
    validators.push({
      mainKp,
      sessionKp,
      minerId: normalizeSuiAddress(seeded.minerId),
    });
  }
  if (validators.length !== EXPECTED_VALIDATORS) throw new Error('validator roster incomplete');

  const userKp = Ed25519Keypair.generate();
  const userAddress = userKp.getPublicKey().toSuiAddress();
  await fundAndWait(client, userAddress);
  await executeUnmeasured(client, userKp, 'register_user(p3)', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::user_registry::register_user`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.userRegistryId),
        tx.pure.vector('u8', Array.from(new TextEncoder().encode('p3-chain-latency'))),
      ],
    });
  });

  return {
    cp,
    relayIds: [
      normalizeSuiAddress(relay.minerId),
      normalizeSuiAddress(relayStandby.minerId),
    ],
    validators: validators as Roster['validators'],
    userKp,
  };
}

export async function createEscrow(
  client: SuiClient,
  config: NetworkConfig,
  userKp: Ed25519Keypair,
  roomId: string,
): Promise<string> {
  const result = await executeUnmeasured(client, userKp, 'create_escrow', (tx) => {
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
  });
  const eventType = `${config.packageId}::economic_layer::EscrowCreated`;
  const event = exactEvent(result, eventType, 'create_escrow');
  const eventRoom = eventRoomId(event, 'create_escrow');
  if (eventRoom !== roomId) {
    throw new Error(`EscrowCreated room mismatch: expected ${roomId}, got ${eventRoom}`);
  }
  return eventEscrowId(event, 'create_escrow');
}

export async function assertEscrowState(
  client: SuiClient,
  escrowId: string,
  roomId: string,
  expectedDistributed: boolean,
): Promise<void> {
  const object = await client.getObject({ id: escrowId, options: { showContent: true } });
  const content = object.data?.content;
  if (content?.dataType !== 'moveObject') {
    throw new Error(`escrow object content missing: ${escrowId}`);
  }
  const fields = content.fields as { room_id?: unknown; distributed?: unknown };
  if (typeof fields.room_id !== 'string' || normalizeSuiAddress(fields.room_id) !== roomId) {
    throw new Error(`escrow ${escrowId} does not bind expected room ${roomId}`);
  }
  if (fields.distributed !== expectedDistributed) {
    throw new Error(
      `escrow ${escrowId} distributed mismatch: expected ${expectedDistributed}, got ${String(fields.distributed)}`,
    );
  }
}

export async function submitPairing(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  roomId: string,
): Promise<void> {
  // relay-only: the standalone signaling node type (and its registry-liveness gate)
  // was removed from the contract, and this entry now also takes a
  // health_validator_ids ballot argument (all four roster validators, here).
  const validatorIds = roster.validators.map((validator) => validator.minerId);
  await executeUnmeasured(client, roster.cp.kp, 'submit_pairing_proposal', (tx) => {
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
        tx.object(roster.cp.cpCapId),
        tx.pure.id(roomId),
        tx.pure.vector('id', roster.relayIds),
        tx.pure.vector('id', validatorIds),
        tx.pure.u64(1_000),
        tx.pure.vector('id', validatorIds), // health_validator_ids (all four are healthy)
      ],
    });
  });
}

export async function submitProof(
  client: SuiClient,
  config: NetworkConfig,
  validator: ReadyValidator,
  escrowId: string,
  roomId: string,
  relayId: string,
  ordinal: number,
): Promise<void> {
  const packetsForwarded = 10_000n + BigInt(ordinal);
  const bytesTransferred = 1_000_000n + BigInt(ordinal);
  const uniquePeers = 2n;
  const durationSeconds = 30n;
  const avgLatencyMs = 50n;
  const packetLossBps = 100n;
  const jitterMs = 5n;
  const proofBytes = serializeProofBcs(
    roomId,
    relayId,
    packetsForwarded,
    bytesTransferred,
    uniquePeers,
    durationSeconds,
    avgLatencyMs,
    packetLossBps,
    jitterMs,
  );
  const { signatureA, signatureB } = await dualKeySign(
    proofBytes,
    validator.mainKp,
    validator.sessionKp,
  );
  const publicKey = validator.mainKp.getPublicKey().toRawBytes();
  const sessionKey = validator.sessionKp.getPublicKey().toRawBytes();

  await executeUnmeasured(client, validator.sessionKp, `submit_session_proof(${ordinal})`, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::economic_layer::submit_session_proof`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(escrowId),
        tx.object(config.roomManagerId),
        tx.object(config.validatorRegistryId),
        tx.object(config.relayRegistryId),
        tx.pure.id(roomId),
        tx.pure.id(relayId),
        tx.pure.u64(packetsForwarded),
        tx.pure.u64(bytesTransferred),
        tx.pure.u64(uniquePeers),
        tx.pure.u64(durationSeconds),
        tx.pure.u64(avgLatencyMs),
        tx.pure.u64(packetLossBps),
        tx.pure.u64(jitterMs),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(publicKey))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sessionKey))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(signatureA))),
        tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(signatureB))),
      ],
    });
  });
}

export async function submitAllProofs(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  escrowId: string,
  roomId: string,
): Promise<void> {
  let ordinal = 0;
  for (const validator of roster.validators) {
    for (const relayId of roster.relayIds) {
      ordinal += 1;
      await submitProof(client, config, validator, escrowId, roomId, relayId, ordinal);
    }
  }
  if (ordinal !== PROOFS_PER_ROOM) {
    throw new Error(`proof pre-state incomplete: expected ${PROOFS_PER_ROOM}, got ${ordinal}`);
  }
}

export async function closeRoom(
  client: SuiClient,
  config: NetworkConfig,
  userKp: Ed25519Keypair,
  roomId: string,
): Promise<void> {
  await executeUnmeasured(client, userKp, 'close_room', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::room_manager::close_room`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roomManagerId),
        tx.pure.id(roomId),
      ],
    });
  });
}

export function makeSampleRecord(
  options: ChainLatencyOptions,
  metric: Metric,
  sampleIndex: number,
  roomId: string,
  escrowId: string | null,
  execution: TimedExecution,
  finality: FinalityReturn,
  observation: ObservedTargetEvent,
): SampleRecord {
  if (observation.txDigest !== execution.digest) {
    throw new Error(`observation digest mismatch: ${observation.txDigest} != ${execution.digest}`);
  }
  if (observation.roomId !== roomId) {
    throw new Error(`observation room mismatch: ${observation.roomId} != ${roomId}`);
  }
  const valueMs = observation.monoMs - execution.submit.monoMs;
  const rpcReturnMs = execution.rpcReturn.monoMs - execution.submit.monoMs;
  const returnToEventMs = observation.monoMs - execution.rpcReturn.monoMs;
  const finalityReturnMs = finality.time.monoMs - execution.submit.monoMs;
  for (const [label, value] of [
    ['value_ms', valueMs],
    ['rpc_return_ms', rpcReturnMs],
    ['finality_return_ms', finalityReturnMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} is invalid for ${execution.digest}: ${value}`);
    }
  }
  if (!Number.isFinite(returnToEventMs)) {
    throw new Error(`return_to_event_ms is invalid for ${execution.digest}: ${returnToEventMs}`);
  }
  return {
    schema_version: SCHEMA_VERSION,
    record_type: 'sample',
    run_id: options.runId,
    trace_id: options.traceId,
    metric,
    sample_index: sampleIndex,
    tx_digest: execution.digest,
    event_type: observation.eventType,
    event_seq: observation.eventSeq,
    room_id: roomId,
    escrow_id: escrowId,
    submit_wall_iso: execution.submit.wallIso,
    submit_mono_ms: execution.submit.monoMs,
    rpc_return_wall_iso: execution.rpcReturn.wallIso,
    rpc_return_mono_ms: execution.rpcReturn.monoMs,
    finality_return_wall_iso: finality.time.wallIso,
    finality_return_mono_ms: finality.time.monoMs,
    observed_wall_iso: observation.wallIso,
    observed_mono_ms: observation.monoMs,
    value_ms: valueMs,
    rpc_return_ms: rpcReturnMs,
    return_to_event_ms: returnToEventMs,
    finality_return_ms: finalityReturnMs,
    success: true,
    exact_match: true,
  };
}
