/**
 * wan-bootstrap.ts — one-shot bootstrap for WAN bench.
 *
 * Uses deployer to register as CP, then votes for relay + signaling roles,
 * then registers both in their respective registries.
 * Outputs MINER_CAP_IDs.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const RPC = 'http://127.0.0.1:9000';
const PUBLISH_OUTPUT = (process.env['HOME'] ?? '/home/azureuser') + '/publish-output.json';

// Secrets/run-specific values come from env (never hardcode keys — see runbook 6.1a).
// Export them first, e.g.  `set -a; source .env; set +a`  then pass DEPLOYER_ADDRESS.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Load IDs from publish-output.json
const po = JSON.parse(readFileSync(PUBLISH_OUTPUT, 'utf8'));
const changes: any[] = po.objectChanges || [];

function extractPkg(): string {
  const p = changes.find((c) => c.type === 'published');
  return p ? p.packageId : '';
}
function extractShared(typeName: string): string {
  const re = new RegExp('::' + typeName + '(<|$)');
  const o = changes.find((c) => c.type === 'created' && re.test(c.objectType || ''));
  return o ? o.objectId : '';
}

const PKG = extractPkg();
const NETWORK_REGISTRY_ID = extractShared('NetworkRegistry');
const MINER_STORE_ID = extractShared('MinerStore');
const ROLE_VOTE_BOX_ID = extractShared('RoleVoteBox');
const RELAY_REGISTRY_ID = extractShared('RelayRegistry');
const SIGNALING_REGISTRY_ID = extractShared('SignalingRegistry');
const CP_REGISTRY_ID = extractShared('ControlPlaneRegistry');
const VALIDATOR_REGISTRY_ID = extractShared('ValidatorRegistry');

console.log('PKG:', PKG);
console.log('NETWORK_REGISTRY_ID:', NETWORK_REGISTRY_ID);
console.log('MINER_STORE_ID:', MINER_STORE_ID);
console.log('ROLE_VOTE_BOX_ID:', ROLE_VOTE_BOX_ID);

// Load keypairs
function loadKp(suiPrivKey: string): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(suiPrivKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

function getDeployerKey(): Ed25519Keypair {
  // The deployer address is minted during publish (publish-and-init step 2). Its key
  // is exported from the local sui keystore — only the address is needed here.
  const deployerAddr = requireEnv('DEPLOYER_ADDRESS');
  const raw = execSync(`sui keytool export --key-identity "${deployerAddr}" --json 2>/dev/null`).toString();
  const result = JSON.parse(raw);
  const exportedKey = result.exportedPrivateKey;
  if (!exportedKey) throw new Error('Could not export deployer key');
  const { secretKey } = decodeSuiPrivateKey(exportedKey);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

const client = new SuiClient({ url: RPC });

async function waitForObject(objectId: string, maxMs = 30000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const obj = await client.getObject({ id: objectId });
      if (obj.data) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Object ${objectId} not indexed after ${maxMs}ms`);
}

async function executeAndWait(
  kp: Ed25519Keypair,
  buildTx: (tx: Transaction) => void,
  label: string,
  retries = 3,
): Promise<any> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    // Small delay before each attempt to let previous txs settle
    if (attempt > 1) {
      console.log(`[${label}] Retry attempt ${attempt}...`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    const tx = new Transaction();
    tx.setSender(kp.toSuiAddress());
    tx.setGasBudget(200_000_000);
    buildTx(tx);
    const bytes = await tx.build({ client });
    const sig = await kp.signTransaction(bytes);
    try {
      const result = await client.executeTransactionBlock({
        transactionBlock: bytes,
        signature: sig.signature,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (result.effects?.status?.status !== 'success') {
        throw new Error(`${label} failed: ${JSON.stringify(result.effects?.status)}`);
      }
      console.log(`[${label}] OK digest=${result.digest}`);
      // Wait for the transaction to be fully indexed so subsequent txs see latest object versions
      await client.waitForTransaction({ digest: result.digest });
      return result;
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      // Retry on version mismatch (-32002 / "is not available for consumption")
      if (msg.includes('not available for consumption') && attempt < retries) {
        console.log(`[${label}] Version mismatch, will retry (attempt ${attempt}/${retries})`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`${label} failed after ${retries} retries`);
}

function extractCreatedByType(result: any, typeFragment: string): string | null {
  const re = new RegExp(typeFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const obj = (result.objectChanges || []).find(
    (c: any) => c.type === 'created' && re.test(c.objectType || ''),
  );
  return obj ? obj.objectId : null;
}

/** Find a specific object type in an address's owned objects. */
async function findOwnedObject(owner: string, typeSubstr: string): Promise<string | null> {
  const result = await client.getOwnedObjects({
    owner,
    options: { showType: true },
    limit: 50,
  });
  const found = result.data.find((o) => o.data?.type && o.data.type.includes(typeSubstr));
  return found?.data?.objectId ?? null;
}

const ROLE_RELAY = 2;
const ROLE_SIGNALING = 4;
const CP_STAKE = 1_000_000_000n;
const MINER_STAKE = 300_000_000n;

const textEnc = new TextEncoder();
function toBytes(s: string): number[] {
  return Array.from(textEnc.encode(s));
}

async function main() {
  const deployerKp = getDeployerKey();
  const relayKp = loadKp(requireEnv('PRIVATE_KEY'));          // relay node keypair (stakes 0.25 SUI)
  const signalingKp = loadKp(requireEnv('SIGNALING_KEYPAIR')); // signaling node keypair

  const deployerAddr = deployerKp.toSuiAddress();
  const relayAddr = relayKp.toSuiAddress();
  const sigAddr = signalingKp.toSuiAddress();

  console.log('Deployer:', deployerAddr);
  console.log('Relay:', relayAddr);
  console.log('Signaling:', sigAddr);

  // Step 1: Register deployer as CP (1.0 SUI -> determine_role yields role_cp)
  // IDEMPOTENT: check if already registered
  console.log('\n=== Step 1: Register deployer as CP miner ===');
  let cpCapId = await findOwnedObject(deployerAddr, '::caps::ControlPlaneCap');
  let cpStakeId = await findOwnedObject(deployerAddr, '::staking::StakePosition');

  if (cpCapId && cpStakeId) {
    console.log('[Step 1] Already registered, reusing cpCapId=' + cpCapId);
  } else {
    const cpRegResult = await executeAndWait(deployerKp, (tx) => {
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(CP_STAKE)]);
      tx.moveCall({
        target: `${PKG}::registration::register`,
        arguments: [
          tx.object(NETWORK_REGISTRY_ID),
          tx.object(MINER_STORE_ID),
          stakeCoin!,
          tx.pure.vector('u8', toBytes('127.0.0.1')),
          tx.pure.u16(9000),
          tx.pure.vector('u8', []),
          tx.pure.vector('u8', []),
          tx.pure.vector('u8', toBytes('local')),
          tx.pure.u64(100),
          tx.pure.u64(50),
          tx.pure.u64(4),
          tx.pure.vector('u8', []),
        ],
      });
    }, 'register-cp-miner');

    cpCapId = extractCreatedByType(cpRegResult, '::caps::ControlPlaneCap');
    cpStakeId = extractCreatedByType(cpRegResult, '::staking::StakePosition');
    if (!cpCapId || !cpStakeId) throw new Error('No ControlPlaneCap or StakePosition from CP register');
    console.log('CP ControlPlaneCap:', cpCapId);
    console.log('Waiting for CP objects to be indexed...');
    await waitForObject(cpCapId);
    await waitForObject(cpStakeId);
  }

  // Step 2: Register CP in ControlPlaneRegistry (idempotent: ignore E_ALREADY_REGISTERED=511)
  console.log('\n=== Step 2: Register CP in CP registry ===');
  try {
    await executeAndWait(deployerKp, (tx) => {
      tx.moveCall({
        target: `${PKG}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(NETWORK_REGISTRY_ID),
          tx.object(CP_REGISTRY_ID),
          tx.object(cpCapId),
          tx.object(cpStakeId),
        ],
      });
    }, 'register-cp-registry');
  } catch (e: any) {
    if (String(e?.message).includes('511')) {
      console.log('[Step 2] CP already registered in CP registry, skipping');
    } else {
      throw e;
    }
  }

  // Step 3: Register relay as miner (role_user initially)
  console.log('\n=== Step 3: Register relay as miner (role_user) ===');
  let relayMinerCapId = await findOwnedObject(relayAddr, '::caps::MinerCap');
  let relayStakeId = await findOwnedObject(relayAddr, '::staking::StakePosition');

  if (relayMinerCapId && relayStakeId) {
    console.log('[Step 3] Already registered, reusing relayMinerCapId=' + relayMinerCapId);
  } else {
    const relayRegResult = await executeAndWait(relayKp, (tx) => {
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(MINER_STAKE)]);
      tx.moveCall({
        target: `${PKG}::registration::register`,
        arguments: [
          tx.object(NETWORK_REGISTRY_ID),
          tx.object(MINER_STORE_ID),
          stakeCoin!,
          tx.pure.vector('u8', toBytes('127.0.0.1')),
          tx.pure.u16(4000),
          tx.pure.vector('u8', []),
          tx.pure.vector('u8', []),
          tx.pure.vector('u8', toBytes('asia-southeast1')),
          tx.pure.u64(1000),
          tx.pure.u64(100),
          tx.pure.u64(4),
          tx.pure.vector('u8', []),
        ],
      });
    }, 'register-relay-miner');

    relayMinerCapId = extractCreatedByType(relayRegResult, '::caps::MinerCap');
    relayStakeId = extractCreatedByType(relayRegResult, '::staking::StakePosition');
    if (!relayMinerCapId || !relayStakeId) throw new Error('No MinerCap or StakePosition from relay register');
    console.log('Relay MinerCap:', relayMinerCapId);
    await waitForObject(relayMinerCapId);
    await waitForObject(relayStakeId);
  }

  // Step 4: Register signaling as miner (role_user initially)
  console.log('\n=== Step 4: Register signaling as miner (role_user) ===');
  let sigMinerCapId = await findOwnedObject(sigAddr, '::caps::MinerCap');
  let sigStakeId = await findOwnedObject(sigAddr, '::staking::StakePosition');

  if (sigMinerCapId && sigStakeId) {
    console.log('[Step 4] Already registered, reusing sigMinerCapId=' + sigMinerCapId);
  } else {
    const sigRegResult = await executeAndWait(signalingKp, (tx) => {
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(MINER_STAKE)]);
      tx.moveCall({
        target: `${PKG}::registration::register`,
        arguments: [
          tx.object(NETWORK_REGISTRY_ID),
          tx.object(MINER_STORE_ID),
          stakeCoin!,
          tx.pure.vector('u8', toBytes('127.0.0.1')),
          tx.pure.u16(8080),
          tx.pure.vector('u8', []),
          tx.pure.vector('u8', []),
          tx.pure.vector('u8', toBytes('asia-southeast1')),
          tx.pure.u64(100),
          tx.pure.u64(50),
          tx.pure.u64(4),
          tx.pure.vector('u8', []),
        ],
      });
    }, 'register-signaling-miner');

    sigMinerCapId = extractCreatedByType(sigRegResult, '::caps::MinerCap');
    sigStakeId = extractCreatedByType(sigRegResult, '::staking::StakePosition');
    if (!sigMinerCapId || !sigStakeId) throw new Error('No MinerCap or StakePosition from signaling register');
    console.log('Signaling MinerCap:', sigMinerCapId);
    await waitForObject(sigMinerCapId);
    await waitForObject(sigStakeId);
  }

  // Helper: run a step, ignoring specific Move abort codes
  async function tryStep(
    label: string,
    fn: () => Promise<any>,
    ignoreCodes: number[],
    skipMsg: string,
  ): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      const ignored = ignoreCodes.some((code) => msg.includes(String(code)));
      if (ignored) {
        console.log(`[${label}] ${skipMsg}`);
      } else {
        throw e;
      }
    }
  }

  // Step 5: CP votes for relay role (role=2)
  // E_ALREADY_VOTED=704, E_MINER_ALREADY_ACTIVE=705
  console.log('\n=== Step 5: CP votes for relay (role=2) ===');
  await tryStep('Step 5', () => executeAndWait(deployerKp, (tx) => {
    tx.moveCall({
      target: `${PKG}::role_voting::cast_role_vote`,
      arguments: [
        tx.object(NETWORK_REGISTRY_ID),
        tx.object(ROLE_VOTE_BOX_ID),
        tx.object(MINER_STORE_ID),
        tx.object(CP_REGISTRY_ID),
        tx.object(RELAY_REGISTRY_ID),
        tx.object(VALIDATOR_REGISTRY_ID),
        tx.object(SIGNALING_REGISTRY_ID),
        tx.object(cpCapId),
        tx.pure.id(relayAddr),
        tx.pure.u8(ROLE_RELAY),
      ],
    });
  }, 'vote-relay-role'), [704, 705], 'Vote already cast or relay already active, skipping');

  // Step 6: CP votes for signaling role (role=4)
  // E_ALREADY_VOTED=704, E_MINER_ALREADY_ACTIVE=705
  console.log('\n=== Step 6: CP votes for signaling (role=4) ===');
  await tryStep('Step 6', () => executeAndWait(deployerKp, (tx) => {
    tx.moveCall({
      target: `${PKG}::role_voting::cast_role_vote`,
      arguments: [
        tx.object(NETWORK_REGISTRY_ID),
        tx.object(ROLE_VOTE_BOX_ID),
        tx.object(MINER_STORE_ID),
        tx.object(CP_REGISTRY_ID),
        tx.object(RELAY_REGISTRY_ID),
        tx.object(VALIDATOR_REGISTRY_ID),
        tx.object(SIGNALING_REGISTRY_ID),
        tx.object(cpCapId),
        tx.pure.id(sigAddr),
        tx.pure.u8(ROLE_SIGNALING),
      ],
    });
  }, 'vote-signaling-role'), [704, 705], 'Vote already cast or signaling already active, skipping');

  // Step 7: Relay applies voted role
  // E_NO_ASSIGNMENT=707 means role already applied
  console.log('\n=== Step 7: Relay applies voted role ===');
  await tryStep('Step 7', () => executeAndWait(relayKp, (tx) => {
    tx.moveCall({
      target: `${PKG}::registration::apply_voted_role`,
      arguments: [
        tx.object(NETWORK_REGISTRY_ID),
        tx.object(MINER_STORE_ID),
        tx.object(ROLE_VOTE_BOX_ID),
        tx.object(SIGNALING_REGISTRY_ID),
        tx.object(RELAY_REGISTRY_ID),
        tx.object(VALIDATOR_REGISTRY_ID),
        tx.object(CP_REGISTRY_ID),
        tx.object(relayMinerCapId),
        tx.object(relayStakeId),
      ],
    });
  }, 'relay-apply-voted-role'), [707], 'No pending assignment (already applied), skipping');

  // Step 8: Signaling applies voted role
  // E_NO_ASSIGNMENT=707 means role already applied
  console.log('\n=== Step 8: Signaling applies voted role ===');
  await tryStep('Step 8', () => executeAndWait(signalingKp, (tx) => {
    tx.moveCall({
      target: `${PKG}::registration::apply_voted_role`,
      arguments: [
        tx.object(NETWORK_REGISTRY_ID),
        tx.object(MINER_STORE_ID),
        tx.object(ROLE_VOTE_BOX_ID),
        tx.object(SIGNALING_REGISTRY_ID),
        tx.object(RELAY_REGISTRY_ID),
        tx.object(VALIDATOR_REGISTRY_ID),
        tx.object(CP_REGISTRY_ID),
        tx.object(sigMinerCapId),
        tx.object(sigStakeId),
      ],
    });
  }, 'signaling-apply-voted-role'), [707], 'No pending assignment (already applied), skipping');

  // Step 9: Relay registers in relay_registry
  // E_ALREADY_REGISTERED=521
  console.log('\n=== Step 9: Relay registers in relay_registry ===');
  await tryStep('Step 9', () => executeAndWait(relayKp, (tx) => {
    tx.moveCall({
      target: `${PKG}::relay_registry::register_relay`,
      arguments: [
        tx.object(NETWORK_REGISTRY_ID),
        tx.object(RELAY_REGISTRY_ID),
        tx.object(relayMinerCapId),
        tx.object(relayStakeId),
        tx.pure.vector('u8', toBytes('asia-southeast1')),
        tx.pure.vector('u8', toBytes('ws://85.211.181.194:4000')),
      ],
    });
  }, 'relay-register-relay-registry'), [521], 'Relay already in relay registry, skipping');

  // Step 10: Signaling registers in signaling_registry
  // E_ALREADY_REGISTERED=601
  console.log('\n=== Step 10: Signaling registers in signaling_registry ===');
  await tryStep('Step 10', () => executeAndWait(signalingKp, (tx) => {
    tx.moveCall({
      target: `${PKG}::signaling_registry::register_signaling`,
      arguments: [
        tx.object(NETWORK_REGISTRY_ID),
        tx.object(SIGNALING_REGISTRY_ID),
        tx.object(sigMinerCapId),
        tx.object(sigStakeId),
        tx.pure.vector('u8', toBytes('ws://85.211.181.194:8080')),
        tx.pure.vector('u8', toBytes('asia-southeast1')),
      ],
    });
  }, 'signaling-register-signaling-registry'), [601], 'Signaling already in signaling registry, skipping');

  console.log('\n=== BOOTSTRAP COMPLETE ===');
  console.log('RELAY_MINER_CAP_ID=' + relayMinerCapId);
  console.log('RELAY_STAKE_ID=' + relayStakeId);
  console.log('SIGNALING_MINER_CAP_ID=' + sigMinerCapId);
  console.log('SIGNALING_STAKE_ID=' + sigStakeId);
}

main().catch((e: unknown) => {
  console.error('FATAL:', e);
  process.exit(1);
});
