/**
 * m2b/register-actors.ts — CHAIN: register 2 fresh validators with bound session wallets (Approach B)
 * + a fresh relay (Approach (b) / W-E9), and resolve the byzantine divergence proof (single-host
 * self-sign or TRUE 2-host peer co-sign over the claim board). Extracted verbatim from the original
 * single-file m2b-live-bhermetic-slash.ts — pure code movement, no behavior change.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  signAndAssert,
  MinerRole,
  type NetworkConfig,
  type Logger,
  type TxStatusLike,
} from '../../../packages/shared/src/index.ts';
import {
  signSelfAttestation,
  assembleProofFromAttestations,
  distinctAttesterCount,          // proof.ts — Wallet-B pubkey de-dup count (peer co-sign quorum check)
  MIN_ATTESTERS,                  // proof.ts — =2 (>=2 distinct enforced at assembly + on-chain)
  type DivergenceClaim,
  type DivergenceAttestation,
  type DivergenceProof,
} from '../../../apps/validator-daemon/src/canary/proof.ts';
// Track-C GENUINE 2-host co-sign carrier: att2 arrives from the PEER host (vm2) over the /canary/claims
// board instead of being self-signed in-process. HttpClaimBoard = the shipped OQ-7 HTTP client (bearer;
// mTLS-capable); cellKey = the deterministic board key over the claim's 4 identifying fields.
import { HttpClaimBoard } from '../../../apps/validator-daemon/src/canary/claims-client.ts';
import { cellKey } from '../../../apps/validator-daemon/src/canary/claim-board.ts';
// Track-C: env-gated native-boot (no-docker) adapter — lets copyFromVolume skip `docker compose cp`
// when native-bwan-bootstrap.ts pre-placed the file. Default (flag unset) = byte-identical docker path.
import { shouldUsePeerCoSign, peerCoSignQuorumMet } from '../native-artifacts.ts';
import { MOD, need, sleep, withLockRetry, FAUCET_TIMEOUT_MS, FAUCET_POLL_MS, VALIDATOR_STAKE_MIST, HOST_FAUCET_URL } from './common.ts';

/** Pick a created object id whose type contains `substring`, or throw. */
export function createdObjectByType(result: TxStatusLike, substring: string, label: string): string {
  for (const change of result.objectChanges ?? []) {
    if (change.type === 'created' && typeof change.objectId === 'string' &&
        (change.objectType ?? '').includes(substring)) {
      return change.objectId;
    }
  }
  throw new Error(`${label}: no created object matching ${substring}`);
}

/** Faucet-fund an address against the HOST-reachable faucet, polling until the gas coin is indexed. */
export async function fundAddress(client: SuiClient, address: string): Promise<void> {
  await requestSuiFromFaucetV2({ host: HOST_FAUCET_URL, recipient: address });
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) break;
    if (Date.now() > deadline) throw new Error(`${MOD}: faucet gas never indexed for ${address}`);
    await sleep(FAUCET_POLL_MS);
  }
}

export interface ValidatorResult { minerId: string; sessionKp: Ed25519Keypair | null }

/**
 * Full validator lifecycle + session-wallet binding (Approach B), mirroring
 * canary-localnet-helpers::registerValidatorWithSession VERBATIM against the BOOTED localnet:
 *   register (User→MinerCap) → CP votes Validator → apply (flips to Validator) → register_validator
 *   → self_assign_session_wallet (binds a FRESH Wallet-B session keypair's Sui address on-chain).
 * The bound address == sessionKp.toSuiAddress() == blake2b256(0x00||pubkey) — EXACTLY what the slash
 * entry recomputes from each attestation pubkey to resolve the validator_miner_id (INV-C).
 */
export async function registerFreshValidatorWithSession(
  client: SuiClient,
  cp: { kp: Ed25519Keypair; cpCapId: string },
  config: NetworkConfig,
  logger: Logger,
  boundSessionAddr?: string, // Track-C self-custody: bind the PEER host (vm2)'s session address; vm1 never holds its key
): Promise<ValidatorResult> {
  const minerKp = Ed25519Keypair.generate();
  await fundAddress(client, minerKp.getPublicKey().toSuiAddress());
  await sleep(500);
  const minerId = normalizeSuiAddress(minerKp.getPublicKey().toSuiAddress());

  // register (User → MinerCap) + 0.3 SUI stake.
  const reg = await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(VALIDATOR_STAKE_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register',
    logger,
  );
  const minerCapId = createdObjectByType(reg, '::caps::MinerCap', 'registerValidator');
  const stakeId = createdObjectByType(reg, '::staking::StakePosition', 'registerValidator');

  // CP casts Validator role (cp_reg first — role_voting.move:197). withLockRetry: the seed CP key is
  // shared with the live cp-daemon, so its gas coin can transiently lock.
  // Package split (see services/contract/role-voting): role_voting now lives in its
  // own package, not config.packageId. Signature no longer takes a signaling_reg --
  // the standalone signaling node type was removed from the contract.
  await withLockRetry('cast_role_vote (validator)', () => signAndAssert(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.roleVotingPackageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.cpRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(minerId),
          tx.pure.u8(MinerRole.Validator),
        ],
      });
    },
    'cast_role_vote',
    logger,
  ));

  // miner applies the voted role (registration.move:113). apply_voted_role no longer
  // takes the RoleVoteBox (or a signaling_reg) directly -- consume the pending
  // assignment via role_voting::consume_voted_assignment in the SAME PTB and feed
  // its u8 return into apply_voted_role's new_role param (mirrors
  // packages/shared/src/chain/role-assignment.ts applyVotedRole).
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [newRole] = tx.moveCall({
        target: `${config.roleVotingPackageId}::role_voting::consume_voted_assignment`,
        arguments: [
          tx.object(config.roleVoteBoxId),
          tx.object(minerCapId),
        ],
      });
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          newRole,
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'apply_voted_role',
    logger,
  );

  // enroll in the ValidatorRegistry (validator_registry.move:91).
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::register_validator`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'register_validator',
    logger,
  );

  // bind a Wallet-B session keypair (validator_registry.move:143 self_assign_session_wallet). Track-C
  // self-custody: when `boundSessionAddr` is supplied (the PEER host vm2's session Sui address), bind
  // THAT — vm1 never holds vm2's signing key (sessionKp stays null; vm2 signs att2 itself, over its OWN
  // captured bytes). Default (no arg) generates a fresh session keypair in-process (byte-identical).
  const sessionKp = boundSessionAddr ? null : Ed25519Keypair.generate();
  const sessionAddr = boundSessionAddr ?? sessionKp!.getPublicKey().toSuiAddress();
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(minerCapId),
          tx.pure.address(sessionAddr),
        ],
      });
    },
    'self_assign_session_wallet',
    logger,
  );

  logger.info({ module: MOD, action: 'register_validator', context: { minerId } },
    'fresh validator registered + session-wallet bound');
  return { minerId, sessionKp };
}

/**
 * Track-C proof resolver — the GENUINE 2-host co-sign seam.
 *
 * DEFAULT (CLAIM_BOARD_URL unset) = BYTE-IDENTICAL to the shipped single-host path: v2 self-signs its
 * attestation in-process and we assemble [att1, att2] directly. The single-host slash run is unchanged.
 *
 * PEER mode (CLAIM_BOARD_URL set) = the TRUE 2-host run: host-A (vm1) posts its OWN att1 to the
 * `/canary/claims` board, then POLLS until the PEER host (vm2) — which independently captured the SAME
 * forwarded media over the F1 pipe and signed with its OWN Wallet-B — posts a DISTINCT att2. Once the
 * cell carries >= MIN_ATTESTERS distinct Wallet-B pubkeys we assemble the proof from the BOARD's
 * attestations (not from a single-process dual-sign). vm1 cannot forge att2: it never held vm2's key.
 */
export async function resolveDivergenceProof(
  claim: DivergenceClaim,
  msg: Uint8Array,
  att1: DivergenceAttestation,
  v2: ValidatorResult,
  logLine: (s: string) => void,
): Promise<DivergenceProof> {
  const claimBoardUrl = process.env['CLAIM_BOARD_URL'];
  if (!shouldUsePeerCoSign(claimBoardUrl)) {
    const att2 = await signSelfAttestation(msg, need(v2.sessionKp, 'v2.sessionKp (single-host self-sign path)'));
    return assembleProofFromAttestations(claim, [att1, att2]); // >=2-distinct enforced at assembly + on-chain
  }
  // TRUE 2-host: publish att1, await vm2's distinct att2 over the board.
  const token = need(process.env['CLAIM_BOARD_AUTH_TOKEN'], 'CLAIM_BOARD_AUTH_TOKEN (peer co-sign bearer)');
  const board = new HttpClaimBoard({ baseUrl: claimBoardUrl!, token });
  await board.post(claim, att1, 0);
  logLine(`[byzantine] posted host-A att1 → claim board ${claimBoardUrl}; awaiting peer host (vm2) att2…`);
  const key = cellKey(claim);
  const deadlineMs = Number(process.env['CANARY_COSIGN_TIMEOUT_MS'] ?? '120000');
  const start = Date.now();
  for (;;) {
    const cell = await board.get(key);
    const distinct = cell ? distinctAttesterCount(cell.attestations) : 0;
    if (cell && peerCoSignQuorumMet(distinct, MIN_ATTESTERS)) {
      logLine(`[byzantine] peer co-sign quorum: ${distinct} distinct Wallet-B attesters (host-A + vm2).`);
      return assembleProofFromAttestations(claim, cell.attestations);
    }
    if (Date.now() - start >= deadlineMs) {
      throw new Error(`${MOD}: peer co-sign TIMEOUT ${deadlineMs}ms — vm2 never posted a distinct att2 (check vm2 capture/verify + board reachability at ${claimBoardUrl})`);
    }
    await sleep(1000);
  }
}

export interface RelayResult { minerId: string; kp: Ed25519Keypair; stakeId: string }

/**
 * Full relay lifecycle (Approach (b) / W-E9 — the relay OWNS its bond and self-signs the slash),
 * mirroring canary-localnet-helpers::registerRelay VERBATIM against the BOOTED localnet:
 *   register (User→MinerCap, 0.3 SUI) → CP votes Relay → apply → register_relay.
 *
 * WHY a FRESH relay (not the seed daemon-keys relay): the booted stack's two validators auto-slash the
 * SEED relay's bond on the SEED room every CANARY_VERIFY_INTERVAL_MS, so reusing the seed relay's bond
 * (a) RACES those concurrent slashes → "object already locked by a different transaction", and (b) makes
 * queryLatestSlash(seedRoom) ambiguous (it could return the LIVE stack's slash, not THIS orchestrator's).
 * A fresh relay's bond + a fresh room are touched by NOTHING else → no contention + an unambiguous query.
 */
export async function registerFreshRelay(
  client: SuiClient,
  cp: { kp: Ed25519Keypair; cpCapId: string },
  config: NetworkConfig,
  logger: Logger,
): Promise<RelayResult> {
  const minerKp = Ed25519Keypair.generate();
  await fundAddress(client, minerKp.getPublicKey().toSuiAddress());
  await sleep(500);
  const minerId = normalizeSuiAddress(minerKp.getPublicKey().toSuiAddress());

  const reg = await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(VALIDATOR_STAKE_MIST)]); // 0.3 SUI clears relay min 0.25
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register_relay_miner',
    logger,
  );
  const minerCapId = createdObjectByType(reg, '::caps::MinerCap', 'registerFreshRelay');
  const stakeId = createdObjectByType(reg, '::staking::StakePosition', 'registerFreshRelay');

  // Package split (see services/contract/role-voting): role_voting now lives in its
  // own package, not config.packageId. Signature no longer takes a signaling_reg --
  // the standalone signaling node type was removed from the contract.
  await withLockRetry('cast_role_vote (relay)', () => signAndAssert(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.roleVotingPackageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.cpRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(minerId),
          tx.pure.u8(MinerRole.Relay),
        ],
      });
    },
    'cast_role_vote_relay',
    logger,
  ));
  // apply_voted_role no longer takes the RoleVoteBox (or a signaling_reg) directly --
  // consume the pending assignment via role_voting::consume_voted_assignment in the
  // SAME PTB and feed its u8 return into apply_voted_role's new_role param.
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [newRole] = tx.moveCall({
        target: `${config.roleVotingPackageId}::role_voting::consume_voted_assignment`,
        arguments: [
          tx.object(config.roleVoteBoxId),
          tx.object(minerCapId),
        ],
      });
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          newRole,
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'apply_voted_role_relay',
    logger,
  );
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::relay_registry::register_relay`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
          tx.pure.vector('u8', [1, 2, 3, 4]), // region
          tx.pure.vector('u8', [1, 2, 3, 4]), // endpoint_url
        ],
      });
    },
    'register_relay',
    logger,
  );
  logger.info({ module: MOD, action: 'register_relay', context: { minerId } }, 'fresh relay registered (owns its bond — W-E9)');
  return { minerId, kp: minerKp, stakeId };
}
