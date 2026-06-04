/**
 * F47 Phase 5.4 (REQ-RV-013 infra / REQ-RV-015 demo orchestration) — docker
 * seed-bootstrap one-shot.
 *
 * Brings a fresh `--force-regenesis` localnet from "published but empty" to
 * "4 daemons funded + on-chain registered", then hands each daemon its keypair +
 * CAP_ID via /shared/daemon-keys.json so the daemons SKIP their own
 * auto-registration (each `auto-register.ts` early-returns when its CAP_ID env is
 * set: CP_CAP_ID / MINER_CAP_ID / VALIDATOR_CAP_ID / MINER_CAP_ID) and just run
 * their loop. This is what lets `up -d --wait` reach healthy+registered fast so the
 * client RoleRevotePanel (Phase 5.3) shows live revote data.
 *
 * LIFECYCLE: the exact register -> cast_role_vote -> apply_voted_role ->
 * <role>_registry::register lifecycle is the one proven + tested in
 * apps/cp-daemon/src/__tests__/integration/revote-localnet-helpers.ts. That file is
 * __tests__-gated (cannot be imported from a standalone script), so its logic is
 * REPLICATED here. Every moveCall target + arg order below is cross-checked against
 * BOTH that helper AND the .move source (see the per-call comments citing
 * file:line).
 *
 * Run (matches the miner-cli-test one-shot: working_dir /work/dvconf-daemons):
 *   pnpm exec tsx scripts/demo/seed-bootstrap.ts
 *
 * Env (no hardcoded hosts — all defaulted):
 *   SUI_NETWORK       the lever loadNetworkConfig() resolves the RPC URL from; a URL
 *                     value is treated as a custom node (in docker: http://sui-localnet:9000).
 *                     NOTE: packages/shared/chain/client.ts honours ONLY SUI_NETWORK --
 *                     SUI_RPC_URL is dead config there (kept in compose for readability).
 *   FAUCET_URL        default = SDK getFaucetHost('localnet') (standalone); docker: http://sui-localnet:9123/gas
 *   KEYS_OUTPUT_PATH  default /shared/daemon-keys.json
 *   PLUS the published object IDs (PACKAGE_ID, *_REGISTRY_ID, MINER_STORE_ID,
 *   ROLE_VOTE_BOX_ID, ...) exported by read-publish-output.sh, which runs as this
 *   container's entrypoint BEFORE the command.
 *
 * Fails LOUD: any missing cap/stake or failed TX throws, and an uncaught throw in
 * main() calls process.exit(1) so `depends_on: service_completed_successfully`
 * gates the daemons correctly (a non-zero one-shot blocks them).
 *
 * Structured logging only (shared pino Logger). No console.log.
 *
 * SCOPE (Phase 5.4): seeds the 1 CP + 1 relay + 1 validator + 1 signaling base
 * daemons. The `--profile scaled` replicas (Phase 5.5) are NOT seeded here.
 */

import { writeFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  executeWithRetry,
  extractCreatedObjectByType,
  MinerRole,
  type NetworkConfig,
  type Logger,
  type TxResult,
} from '../../packages/shared/src/index.ts'; // relative SOURCE import, not the '@dvconf/shared' bare specifier: scripts/ sits OUTSIDE the pnpm workspace package graph, so the bare name is unresolvable from root node_modules (only apps/* carry the symlink). @mysten/sui above stays bare (it IS a root devDependency); shared's own transitive deps resolve from packages/shared/node_modules. Verified under tsx.

const MODULE = 'seed-bootstrap';

/**
 * Stake tiers (MIST). CP gets 1.0 SUI (>= the dynamic CP threshold for the FIRST
 * CP = base 0.5 SUI; mirrors cp-daemon/auto-register.ts CP_STAKE). Each voted
 * miner gets 0.3 SUI: role User at register, then clears every apply-side
 * minimum_for_role guard — relay 0.25 / validator 0.1 / signaling 0.05 SUI
 * (constants.move:28-30 DEFAULT_*_THRESHOLD).
 */
const CP_STAKE_MIST = 1_000_000_000n;
const MINER_STAKE_MIST = 300_000_000n;

/** Faucet gas-coin poll. The sui faucet is ASYNC ("up to 1 minute"), so poll getCoins
 *  rather than a fixed sleep (revote-localnet-helpers' 1.5s sleep only worked against a fast
 *  standalone faucet; the docker faucet races it -- see the Phase 5.4 gate). */
const FAUCET_POLL_MS = 1000;
const FAUCET_TIMEOUT_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** No hardcoded hosts — env with localhost defaults (HARD constraint #2). */
// Default to the SDK's canonical localnet faucet (what the proven Phase-4.1 fixture uses);
// docker overrides via FAUCET_URL env (sui-localnet:9123). getFaucetHost('localnet') ->
// http://127.0.0.1:9123/gas; requestSuiFromFaucetV2 uses only its origin (drops the path).
const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const KEYS_OUTPUT_PATH = process.env['KEYS_OUTPUT_PATH'] ?? '/shared/daemon-keys.json';

/** A seeded node's persisted secret + on-chain handles (one entry per daemon). */
interface SeededKey {
  secretKey: string;
  capId: string;
  stakeId: string;
}

type DaemonRole = 'cp' | 'relay' | 'relay-standby' | 'validator' | 'signaling';

/**
 * Faucet-fund an address then settle for gas-coin indexing. FAUCET_URL is env-
 * driven; `requestSuiFromFaucetV2` builds `new URL('/v2/gas', host)`, so only the
 * host ORIGIN (scheme+host+port) of FAUCET_URL is used (any path suffix like
 * `/gas` is discarded by URL resolution) — the port is what matters.
 */
async function fundAddress(client: SuiClient, address: string, logger: Logger): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  // The sui faucet is ASYNC; poll until the gas coin is indexed so the first register TX
  // has a coin to split from gas. A fixed sleep races the faucet (P5.4 gate finding).
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) break;
    if (Date.now() > deadline) {
      throw new Error(`faucet gas never indexed for ${address} within ${FAUCET_TIMEOUT_MS}ms`);
    }
    await sleep(FAUCET_POLL_MS);
  }
  logger.info({ module: MODULE, action: 'fund_address', context: { address } }, 'funded address via faucet (gas coin indexed)');
}

/** Generate a fresh keypair and faucet-fund it (replicates createFundedKeypair). */
async function createFundedKeypair(client: SuiClient, logger: Logger): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  await fundAddress(client, kp.getPublicKey().toSuiAddress(), logger);
  return kp;
}

/**
 * Run a built TX through the shared executeWithRetry and FAIL LOUD on null
 * (retries exhausted). Returns the non-null TxResult so callers can mine objects.
 */
async function execOrThrow(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<TxResult> {
  const result = await executeWithRetry(client, signer, build, label, logger);
  if (result === null) {
    throw new Error(`${label}: transaction failed after retries`);
  }
  return result;
}

interface RegisterResult {
  /** miner_id == the keypair address (registration computes id_from_address(sender)). */
  minerId: string;
  minerCapId: string | null;
  cpCapId: string | null;
  stakeId: string;
}

/**
 * Build & sign `registration::register` with a freshly split `stakeMist` coin, then
 * extract the created cap + StakePosition. A stake >= the CP threshold yields a
 * ControlPlaneCap; otherwise a MinerCap.
 *
 * Arg order verified against:
 *   - registration.move:78-91 register(registry, store, coin, ip, port, stun_url,
 *     turn_url, region, bandwidth_mbps, max_concurrent, cpu_cores,
 *     turn_credential_hash) [ctx implicit]
 *   - revote-localnet-helpers.ts:149-165 registerMiner (identical order)
 */
async function registerMiner(
  client: SuiClient,
  kp: Ed25519Keypair,
  config: NetworkConfig,
  stakeMist: bigint,
  logger: Logger,
): Promise<RegisterResult> {
  const minerId = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());
  const result = await execOrThrow(
    client,
    kp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeMist)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId), // registry: &NetworkRegistry
          tx.object(config.minerStoreId), // store: &mut MinerStore
          coin!, // coin: Coin<SUI>
          tx.pure.vector('u8', [1, 2, 3, 4]), // ip
          tx.pure.u16(0), // port
          tx.pure.vector('u8', [1, 2, 3, 4]), // stun_url
          tx.pure.vector('u8', [1, 2, 3, 4]), // turn_url
          tx.pure.vector('u8', [1, 2, 3, 4]), // region
          tx.pure.u64(0), // bandwidth_mbps
          tx.pure.u64(0), // max_concurrent
          tx.pure.u64(0), // cpu_cores
          tx.pure.vector('u8', [1, 2, 3, 4]), // turn_credential_hash
        ],
      });
    },
    'register',
    logger,
  );

  const stakeId = extractCreatedObjectByType(result, '::staking::StakePosition');
  if (!stakeId) {
    throw new Error('registerMiner: no StakePosition in objectChanges');
  }
  // CP stake yields a ControlPlaneCap; everyone else a MinerCap.
  const cpCapId = extractCreatedObjectByType(result, '::caps::ControlPlaneCap');
  const minerCapId = cpCapId ? null : extractCreatedObjectByType(result, '::caps::MinerCap');

  logger.info(
    { module: MODULE, action: 'register_miner', context: { minerId, hasCpCap: cpCapId !== null } },
    'registered miner',
  );
  return { minerId, minerCapId, cpCapId, stakeId };
}

interface CpHandle {
  kp: Ed25519Keypair;
  minerId: string;
  cpCapId: string;
  stakeId: string;
}

/**
 * Stand up the first CP DIRECTLY (never voting — CPs are the voters): fund, register
 * with 1.0 SUI (>= first-CP threshold 0.5 SUI -> determine_role = CP -> yields a
 * ControlPlaneCap), then enroll via control_plane_registry::register_cp.
 *
 * register_cp arg order verified against:
 *   - control_plane_registry.move:82-87 register_cp(net_reg, registry, cap, stake) [ctx implicit]
 *   - revote-localnet-helpers.ts:232-238 bootstrapCp (identical order)
 */
async function bootstrapCp(client: SuiClient, config: NetworkConfig, logger: Logger): Promise<CpHandle> {
  const kp = await createFundedKeypair(client, logger);
  const reg = await registerMiner(client, kp, config, CP_STAKE_MIST, logger);
  if (reg.cpCapId === null) {
    throw new Error('bootstrapCp: expected a ControlPlaneCap from a 1.0 SUI register, got none');
  }
  const cpCapId = reg.cpCapId;

  await execOrThrow(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
          tx.object(config.cpRegistryId), // registry: &mut ControlPlaneRegistry
          tx.object(cpCapId), // cap: &ControlPlaneCap
          tx.object(reg.stakeId), // stake: &StakePosition
        ],
      });
    },
    'register_cp',
    logger,
  );

  logger.info({ module: MODULE, action: 'bootstrap_cp', context: { minerId: reg.minerId, cpCapId } }, 'bootstrapped CP');
  return { kp, minerId: reg.minerId, cpCapId, stakeId: reg.stakeId };
}

/**
 * CP-signed `role_voting::cast_role_vote` for `minerId` into `role`. One bootstrapped
 * CP meets the floored quorum (= 1); current_role is User so the re-vote-eligibility
 * guard is skipped on this INITIAL vote -> writes assigned_roles[minerId] = role.
 *
 * Arg order verified against:
 *   - role_voting.move:197-208 cast_role_vote(net_reg, vote_box, miner_store, cp_reg,
 *     relay_reg, validator_reg, signaling_reg, cap, miner_id, role) [ctx implicit]
 *   - revote-localnet-helpers.ts:285-297 castRoleVoteFromCp (identical order)
 *   NOTE: cp_reg comes BEFORE relay/validator/signaling regs (DIFFERS from mark_*).
 */
async function castRoleVoteFromCp(
  client: SuiClient,
  cp: CpHandle,
  minerId: string,
  role: number,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await execOrThrow(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
          tx.object(config.roleVoteBoxId), // vote_box: &mut RoleVoteBox
          tx.object(config.minerStoreId), // miner_store: &MinerStore
          tx.object(config.cpRegistryId), // cp_reg: &ControlPlaneRegistry
          tx.object(config.relayRegistryId), // relay_reg: &RelayRegistry
          tx.object(config.validatorRegistryId), // validator_reg: &ValidatorRegistry
          tx.object(config.signalingRegistryId), // signaling_reg: &SignalingRegistry
          tx.object(cp.cpCapId), // cap: &ControlPlaneCap
          tx.pure.id(minerId), // miner_id: ID
          tx.pure.u8(role), // role: u8
        ],
      });
    },
    'cast_role_vote',
    logger,
  );
}

/**
 * Miner-signed `registration::apply_voted_role` — consumes the pending assignment,
 * flips MinerCap + profile + stake to the voted role. Stake guard requires
 * amount(stake) >= minimum_for_role(new_role) — our 0.3 SUI clears all three.
 *
 * Arg order verified against:
 *   - registration.move:141-151 apply_voted_role(registry, store, vote_box,
 *     signaling_reg, relay_reg, validator_reg, cp_reg, cap, stake) [ctx implicit]
 *   - revote-localnet-helpers.ts:329-340 applyVotedRoleAs AND
 *     packages/shared/src/chain/role-assignment.ts:87-97 applyVotedRole (identical order)
 */
async function applyVotedRoleAs(
  client: SuiClient,
  minerKp: Ed25519Keypair,
  minerCapId: string,
  stakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await execOrThrow(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId), // registry: &NetworkRegistry
          tx.object(config.minerStoreId), // store: &mut MinerStore
          tx.object(config.roleVoteBoxId), // vote_box: &mut RoleVoteBox
          tx.object(config.signalingRegistryId), // signaling_reg: &mut SignalingRegistry
          tx.object(config.relayRegistryId), // relay_reg: &mut RelayRegistry
          tx.object(config.validatorRegistryId), // validator_reg: &mut ValidatorRegistry
          tx.object(config.cpRegistryId), // cp_reg: &mut ControlPlaneRegistry
          tx.object(minerCapId), // cap: &mut MinerCap
          tx.object(stakeId), // stake: &mut StakePosition
        ],
      });
    },
    'apply_voted_role',
    logger,
  );
}

/**
 * Role-specific registry enrollment, signed by the miner keypair. Arg orders
 * verified against the .move source AND the daemon auto-register.ts callers:
 *   - relay     relay_registry.move:105-112  register_relay(net_reg, registry, cap,
 *               stake, region, endpoint_url)  == relay/auto-register.ts:232-239
 *   - validator validator_registry.move:91-96 register_validator(net_reg, registry,
 *               cap, stake)                    == validator-daemon/auto-register.ts:138-143
 *   - signaling signaling_registry.move:92-99  register_signaling(net_reg, registry,
 *               cap, stake, endpoint_url, region) == signaling/auto-register.ts:231-238
 *               (endpoint_url BEFORE region — opposite of relay's region/endpoint order)
 */
async function enrollInRegistry(
  client: SuiClient,
  minerKp: Ed25519Keypair,
  role: DaemonRole,
  minerCapId: string,
  stakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  const REGION = Array.from(new TextEncoder().encode('local'));
  if (role === 'relay') {
    const endpoint = Array.from(new TextEncoder().encode('ws://relay-daemon:4000'));
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.relayRegistryId), // registry: &mut RelayRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
            tx.pure.vector('u8', REGION), // region: vector<u8>
            tx.pure.vector('u8', endpoint), // endpoint_url: vector<u8>
          ],
        });
      },
      'register_relay',
      logger,
    );
  } else if (role === 'validator') {
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::validator_registry::register_validator`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.validatorRegistryId), // registry: &mut ValidatorRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
          ],
        });
      },
      'register_validator',
      logger,
    );
  } else if (role === 'signaling') {
    const endpoint = Array.from(new TextEncoder().encode('ws://signaling-daemon:8080'));
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::signaling_registry::register_signaling`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.signalingRegistryId), // registry: &mut SignalingRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
            tx.pure.vector('u8', endpoint), // endpoint_url: vector<u8>
            tx.pure.vector('u8', REGION), // region: vector<u8>
          ],
        });
      },
      'register_signaling',
      logger,
    );
  } else if (role === 'relay-standby') {
    // relay-standby IS a relay on-chain — votes as Relay, enrolls via relay_registry::register_relay.
    // Uses a DISTINCT endpoint (ws://relay-standby:4002, matching the compose service + WS_PORT 4002)
    // so it is a separate relay_registry entry from the primary relay (ws://relay-daemon:4000).
    const endpoint = Array.from(new TextEncoder().encode('ws://relay-standby:4002'));
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.relayRegistryId), // registry: &mut RelayRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
            tx.pure.vector('u8', REGION), // region: vector<u8>
            tx.pure.vector('u8', endpoint), // endpoint_url: vector<u8>
          ],
        });
      },
      'register_relay',
      logger,
    );
  } else {
    throw new Error(`enrollInRegistry: unsupported voted role ${role}`);
  }
}

/** On-chain role code per daemon role (constants.move:14-17; mirrors @dvconf/shared MinerRole). */
function roleCodeFor(role: DaemonRole): number {
  switch (role) {
    case 'relay':
    case 'relay-standby': // standby IS a relay on-chain — same role code (2)
      return MinerRole.Relay; // 2
    case 'validator':
      return MinerRole.Validator; // 1
    case 'signaling':
      return MinerRole.Signaling; // 4
    default:
      throw new Error(`roleCodeFor: ${role} is not a CP-voted role`);
  }
}

/**
 * Full CP-voted lifecycle for ONE miner against the bootstrapped CP, generalised by
 * `role` (called 3x — relay, validator, signaling):
 *   1. register the miner with 0.3 SUI (role User -> MinerCap)
 *   2. CP casts cast_role_vote(miner_id, roleCode) -> assigned_roles[miner_id] = role
 *   3. miner applies apply_voted_role -> flips MinerCap+profile+stake to the role
 *   4. miner enrolls in the role-specific registry
 */
async function voteAndApplyMiner(
  client: SuiClient,
  cp: CpHandle,
  role: DaemonRole,
  config: NetworkConfig,
  logger: Logger,
): Promise<SeededKey> {
  const minerKp = await createFundedKeypair(client, logger);
  const reg = await registerMiner(client, minerKp, config, MINER_STAKE_MIST, logger);
  if (reg.minerCapId === null) {
    throw new Error(`voteAndApplyMiner(${role}): expected a MinerCap from a 0.3 SUI register, got none`);
  }
  const minerCapId = reg.minerCapId;

  await castRoleVoteFromCp(client, cp, reg.minerId, roleCodeFor(role), config, logger);
  await applyVotedRoleAs(client, minerKp, minerCapId, reg.stakeId, config, logger);
  await enrollInRegistry(client, minerKp, role, minerCapId, reg.stakeId, config, logger);

  logger.info(
    { module: MODULE, action: 'seed_role', context: { role, minerId: reg.minerId, capId: minerCapId } },
    `seeded ${role} node (registered + enrolled)`,
  );
  return { secretKey: minerKp.getSecretKey(), capId: minerCapId, stakeId: reg.stakeId };
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  // loadNetworkConfig() reads PACKAGE_ID + all *_REGISTRY_ID / MINER_STORE_ID /
  // ROLE_VOTE_BOX_ID from env (exported by read-publish-output.sh) and derives
  // config.rpcUrl from SUI_NETWORK -- the ONLY network lever packages/shared/chain/
  // client.ts honours (SUI_RPC_URL is dead config there). In docker SUI_NETWORK is the
  // sui-localnet container URL so config.rpcUrl resolves on the bridge network; the bare
  // keyword 'localnet' would hardcode 127.0.0.1:9000 = the container's own loopback.
  // Build the client EXACTLY like every daemon (createSuiClient(config.rpcUrl)).
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  logger.info(
    { module: MODULE, action: 'start', context: { rpcUrl: config.rpcUrl, faucetUrl: FAUCET_URL, keysOut: KEYS_OUTPUT_PATH, packageId: config.packageId } },
    'seed-bootstrap starting',
  );

  // 1. CP directly (it is the voter for everyone else).
  const cp = await bootstrapCp(client, config, logger);
  const cpKey: SeededKey = { secretKey: cp.kp.getSecretKey(), capId: cp.cpCapId, stakeId: cp.stakeId };

  // 2. relay / validator / signaling / relay-standby via the generalised CP-voted lifecycle.
  const relay = await voteAndApplyMiner(client, cp, 'relay', config, logger);
  const validator = await voteAndApplyMiner(client, cp, 'validator', config, logger);
  const signaling = await voteAndApplyMiner(client, cp, 'signaling', config, logger);
  // 3. relay-standby: 5th funded keypair — a second relay enrolled at ws://relay-standby:4002
  //    (REQ-RO-021 Phase 5.3 bench; matches the relay-standby service in the relay-overlap compose override).
  const relayStandby = await voteAndApplyMiner(client, cp, 'relay-standby', config, logger);

  const keys: Record<DaemonRole, SeededKey> = { cp: cpKey, relay, 'relay-standby': relayStandby, validator, signaling };
  writeFileSync(KEYS_OUTPUT_PATH, `${JSON.stringify(keys, null, 2)}\n`, 'utf8');

  logger.info(
    { module: MODULE, action: 'done', context: { keysOut: KEYS_OUTPUT_PATH, roles: Object.keys(keys) } },
    'seed-bootstrap complete — keys written, 5 daemons registered',
  );
}

main().catch((err) => {
  // Fail LOUD: a non-zero exit blocks the daemons' `depends_on: service_completed_successfully`.
  process.stderr.write(`seed-bootstrap: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
