/**
 * native-bwan-bootstrap.ts — Track-C B-WAN native (NO-DOCKER) seed bootstrap.
 *
 * The committed slash orchestrator `m2b-live-bhermetic-slash.ts` was written against an already-booted
 * docker-compose consolidated stack: it reads the seed CP key + admin creds off a docker VOLUME
 * (`copyFromVolume` → `docker compose cp cp-daemon:/shared/...`) and the on-chain ids + seed room from
 * `.demo-shared/{onchain-config,room}.json`. On the Azure 2-VM/1-VNet rig there is NO docker — the stack
 * is booted NATIVELY (`sui start --force-regenesis` + `sui client test-publish` + 6 `create(AdminCap)`
 * registry calls). This one-shot produces the SAME four artifact files a native boot needs, so the
 * orchestrator (with the env-gated `CANARY_NATIVE_ARTIFACTS` adapter) runs unchanged:
 *
 *   .demo-shared/onchain-config.json            — the 10 env-keyed on-chain ids (hydrateOnchainEnv → env)
 *   .demo-shared/room.json                      — { roomId, relayId } seed room (honest-leg fallback only)
 *   .demo-shared/.daemon-keys-from-volume.json  — { cp: { secretKey, capId, stakeId } } (the role-vote voter)
 *   .demo-shared/.admin-creds-from-volume.json  — { adminCapId, adminSecretKey } (provisions fresh rooms)
 *
 * It creates the FIRST ControlPlaneCap on the fresh network (reliable: no existing CP → the dynamic CP
 * stake threshold is still at base, unlike the orchestrator's note about a network that already has a CP),
 * registers ONE seed relay, and provisions ONE seed room assigned to it. The orchestrator still registers
 * its OWN fresh validators + relay + rooms for the actual slash — the seed room is only room.json's value.
 *
 * NO on-chain contract change (0 Move); additive scripts/demo tooling. INV-C: only public ids + the
 * deployer/cp secret land in LOCAL 0600 files under .demo-shared (never a socket / manifest).
 *
 * RUN (on vm1, all ids from the publish + create phase passed via env):
 *   PACKAGE_ID=.. NETWORK_REGISTRY_ID=.. MINER_STORE_ID=.. ROLE_VOTE_BOX_ID=.. USER_REGISTRY_ID=.. \
 *   ROOM_MANAGER_ID=.. RELAY_REGISTRY_ID=.. CP_REGISTRY_ID=.. VALIDATOR_REGISTRY_ID=.. \
 *   ADMIN_CAP_ID=.. DEPLOYER_SECRET=suiprivkey1.. SUI_NETWORK=http://127.0.0.1:9000 \
 *   pnpm --dir dvconf-daemons exec tsx scripts/demo/native-bwan-bootstrap.ts
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  createSuiClient,
  loadNetworkConfig,
  createRoomWithRelay,
  signAndAssert,
  MinerRole,
  createLogger,
  type NetworkConfig,
  type Logger,
  type TxStatusLike,
} from '../../packages/shared/src/index.ts';

const MOD = 'native-bwan-bootstrap';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..'); // demo -> scripts -> dvconf-daemons -> workspace root
const DEMO_SHARED = process.env['CANARY_NATIVE_ARTIFACTS_DIR'] || join(ROOT, '.demo-shared');

const FAUCET_URL = process.env['FAUCET_URL'] ?? 'http://127.0.0.1:9123/gas';
const RPC_URL = (process.env['SUI_NETWORK'] && /^https?:\/\//.test(process.env['SUI_NETWORK']))
  ? process.env['SUI_NETWORK'] : 'http://127.0.0.1:9000';
const CP_STAKE_MIST = 2_000_000_000n;      // 2.0 SUI — safely above the first-CP determine_role threshold
const RELAY_STAKE_MIST = 300_000_000n;     // 0.3 SUI — clears the relay min (0.25)
const FAUCET_TIMEOUT_MS = 90_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`${MOD}: ${what} required (env)`);
  return v;
};
function kpFromSecret(secret: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
}
function createdByType(result: TxStatusLike, substring: string, label: string): string {
  for (const c of result.objectChanges ?? []) {
    if (c.type === 'created' && typeof c.objectId === 'string' && (c.objectType ?? '').includes(substring)) {
      return c.objectId;
    }
  }
  throw new Error(`${label}: no created object matching ${substring}`);
}
async function fundAddress(client: SuiClient, address: string): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) return;
    if (Date.now() > deadline) throw new Error(`${MOD}: faucet gas never indexed for ${address}`);
    await sleep(1000);
  }
}
// register() metadata args are non-load-bearing placeholders (role is decided by stake).
const regMeta = (tx: {
  pure: { vector: (t: string, v: number[]) => unknown; u16: (n: number) => unknown; u64: (n: number) => unknown };
}): unknown[] => [
  tx.pure.vector('u8', [1, 2, 3, 4]), tx.pure.u16(0), tx.pure.vector('u8', [1, 2, 3, 4]),
  tx.pure.vector('u8', [1, 2, 3, 4]), tx.pure.vector('u8', [1, 2, 3, 4]),
  tx.pure.u64(0), tx.pure.u64(0), tx.pure.u64(0), tx.pure.vector('u8', [1, 2, 3, 4]),
];

async function main(): Promise<void> {
  const logger: Logger = createLogger(MOD);
  const config: NetworkConfig = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const adminCapId = need(process.env['ADMIN_CAP_ID'], 'ADMIN_CAP_ID');
  const deployerSecret = need(process.env['DEPLOYER_SECRET'], 'DEPLOYER_SECRET');
  const deployer = kpFromSecret(deployerSecret);
  process.stdout.write(`[${MOD}] pkg=${config.packageId} rpc=${config.rpcUrl}\n`);
  process.stdout.write(`[${MOD}] deployer=${deployer.getPublicKey().toSuiAddress()} adminCap=${adminCapId}\n`);

  // ── 1. the FIRST ControlPlaneCap (fresh CP keypair; determine_role at register → CP by stake) ──
  const cpKp = Ed25519Keypair.generate();
  await fundAddress(client, cpKp.getPublicKey().toSuiAddress());
  await sleep(500);
  const cpReg = await signAndAssert(client, cpKp, (tx) => {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(CP_STAKE_MIST)]);
    tx.moveCall({
      target: `${config.packageId}::registration::register`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.minerStoreId), coin!, ...regMeta(tx)],
    });
  }, 'register_cp_miner', logger);
  const cpCapId = createdByType(cpReg, '::caps::ControlPlaneCap', 'register CP');
  const cpStakeId = createdByType(cpReg, '::staking::StakePosition', 'register CP');
  // register the CP in the ControlPlaneRegistry so cast_role_vote accepts the cap.
  await signAndAssert(client, cpKp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::control_plane_registry::register_cp`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.cpRegistryId),
        tx.object(cpCapId), tx.object(cpStakeId)],
    });
  }, 'register_cp_registry', logger);
  process.stdout.write(`[${MOD}] CP cap=${cpCapId} stake=${cpStakeId}\n`);

  // ── 2. a seed relay (register → CP votes Relay → apply → register_relay) ─────────────────────────
  const relayKp = Ed25519Keypair.generate();
  await fundAddress(client, relayKp.getPublicKey().toSuiAddress());
  await sleep(500);
  const relayMinerId = normalizeSuiAddress(relayKp.getPublicKey().toSuiAddress());
  const relayReg = await signAndAssert(client, relayKp, (tx) => {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(RELAY_STAKE_MIST)]);
    tx.moveCall({
      target: `${config.packageId}::registration::register`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.minerStoreId), coin!, ...regMeta(tx)],
    });
  }, 'register_relay_miner', logger);
  const relayCapId = createdByType(relayReg, '::caps::MinerCap', 'register relay');
  const relayStakeId = createdByType(relayReg, '::staking::StakePosition', 'register relay');
  await signAndAssert(client, cpKp, (tx) => {
    tx.moveCall({
      // Package split (see services/contract/role-voting): role_voting now lives in
      // its own package, not config.packageId. Signature no longer takes a
      // signaling_reg -- the standalone signaling node type was removed.
      target: `${config.roleVotingPackageId}::role_voting::cast_role_vote`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.roleVoteBoxId),
        tx.object(config.minerStoreId), tx.object(config.cpRegistryId), tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId), tx.object(cpCapId),
        tx.pure.id(relayMinerId), tx.pure.u8(MinerRole.Relay)],
    });
  }, 'cast_role_vote_relay', logger);
  await signAndAssert(client, relayKp, (tx) => {
    // apply_voted_role no longer takes the RoleVoteBox (or a signaling_reg) directly
    // -- consume the pending assignment via role_voting::consume_voted_assignment in
    // the SAME PTB and feed its u8 return into apply_voted_role's new_role param
    // (mirrors packages/shared/src/chain/role-assignment.ts applyVotedRole).
    const [newRole] = tx.moveCall({
      target: `${config.roleVotingPackageId}::role_voting::consume_voted_assignment`,
      arguments: [tx.object(config.roleVoteBoxId), tx.object(relayCapId)],
    });
    tx.moveCall({
      target: `${config.packageId}::registration::apply_voted_role`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.minerStoreId),
        newRole, tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId), tx.object(config.cpRegistryId), tx.object(relayCapId),
        tx.object(relayStakeId)],
    });
  }, 'apply_voted_role_relay', logger);
  await signAndAssert(client, relayKp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::relay_registry::register_relay`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.relayRegistryId),
        tx.object(relayCapId), tx.object(relayStakeId),
        tx.pure.vector('u8', [1, 2, 3, 4]), tx.pure.vector('u8', [1, 2, 3, 4])],
    });
  }, 'register_relay', logger);
  process.stdout.write(`[${MOD}] seed relay minerId=${relayMinerId}\n`);

  // ── 3. a seed room assigned to the seed relay (room.json value / honest-leg fallback) ───────────
  const seedRoomId = await createRoomWithRelay(
    client, Ed25519Keypair.generate(), deployer, adminCapId, relayMinerId, config, logger,
    (addr: string) => fundAddress(client, addr),
  );
  process.stdout.write(`[${MOD}] seed room=${seedRoomId}\n`);

  // ── 4. write the four artifacts (the shapes the orchestrator + adapter read) ────────────────────
  if (!existsSync(DEMO_SHARED)) mkdirSync(DEMO_SHARED, { recursive: true });
  const onchain = {
    PACKAGE_ID: config.packageId,
    NETWORK_REGISTRY_ID: config.networkRegistryId,
    MINER_STORE_ID: config.minerStoreId,
    CP_REGISTRY_ID: config.cpRegistryId,
    RELAY_REGISTRY_ID: config.relayRegistryId,
    VALIDATOR_REGISTRY_ID: config.validatorRegistryId,
    USER_REGISTRY_ID: config.userRegistryId,
    ROOM_MANAGER_ID: config.roomManagerId,
    ROLE_VOTE_BOX_ID: config.roleVoteBoxId,
  };
  const write0600 = (name: string, obj: unknown): void => {
    const p = join(DEMO_SHARED, name);
    writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    try { chmodSync(p, 0o600); } catch { /* windows best-effort */ }
    process.stdout.write(`[${MOD}] wrote ${p}\n`);
  };
  write0600('onchain-config.json', onchain);
  write0600('room.json', { roomId: seedRoomId, relayId: relayMinerId });
  // the two docker-volume dests the CANARY_NATIVE_ARTIFACTS adapter reads in place of a `docker cp`.
  write0600('.daemon-keys-from-volume.json', { cp: { secretKey: cpKp.getSecretKey(), capId: cpCapId, stakeId: cpStakeId } });
  write0600('.admin-creds-from-volume.json', { adminCapId, adminSecretKey: deployerSecret });

  process.stdout.write(`NATIVE_BOOTSTRAP_OK demoShared=${DEMO_SHARED} seedRoom=${seedRoomId} cpCap=${cpCapId}\n`);
}

main().catch((err) => {
  process.stderr.write(`${MOD}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
