/**
 * Reusable helpers for cap-token live integration tests. Mirror the inline
 * helpers from cap-token-wiring-e2e.integration.test.ts, but expose a
 * parameterized `setupQuorumStateWithThreshold` (instead of the hardcoded
 * threshold=1 version in the 1-CP E2E) and a richer `pollForIssued` that
 * also returns `issuer_quorum` from the CapabilityIssued event.
 *
 * Used by: cap-token-2of2-issue.integration.test.ts (Task 2, gap #3).
 */

import { spawn } from 'node:child_process';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import type { Logger } from '@dvconf/shared';
import { fundAddress, type LocalnetHandle } from './localnet-fixture.js';
import { registerMiner, CP_STAKE_MIST, type BootstrapCpResult } from './revote-localnet-helpers.js';

// ── CLI helper ───────────────────────────────────────────────────────────────

function runCli(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

// ── Deployer signer ──────────────────────────────────────────────────────────

/** Export the active sui-CLI deployer keypair (owns the AdminCap created at publish). */
export async function loadDeployerSigner(): Promise<Ed25519Keypair> {
  const addr = (await runCli('sui', ['client', 'active-address'])).stdout.trim();
  const exp = await runCli('sui', ['keytool', 'export', '--key-identity', addr, '--json']);
  const parsed = JSON.parse(exp.stdout) as { exportedPrivateKey?: string };
  if (typeof parsed.exportedPrivateKey !== 'string') {
    throw new Error('loadDeployerSigner: keytool export returned no exportedPrivateKey');
  }
  return Ed25519Keypair.fromSecretKey(parsed.exportedPrivateKey);
}

// ── Object helpers ───────────────────────────────────────────────────────────

interface SuiObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

/** Find the AdminCap object owned by the deployer. */
export async function findAdminCap(
  client: SuiClient,
  packageId: string,
  owner: string,
): Promise<string> {
  const owned = await client.getOwnedObjects({
    owner,
    filter: { StructType: `${packageId}::network_registry::AdminCap` },
    options: { showType: true },
  });
  const first = owned.data[0];
  if (!first?.data?.objectId) throw new Error('findAdminCap: deployer owns no AdminCap');
  return first.data.objectId;
}

// ── TX executor ──────────────────────────────────────────────────────────────

export async function signAndExec(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
): Promise<{ status: string; error?: string; objectChanges: SuiObjectChange[]; digest: string }> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(100_000_000);
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const status = (res.effects?.status?.status as string) ?? 'unknown';
  const error = res.effects?.status?.error;
  return {
    status,
    ...(error !== undefined && { error }),
    objectChanges: (res.objectChanges ?? []) as SuiObjectChange[],
    digest: res.digest,
  };
}

// ── Quorum setup ─────────────────────────────────────────────────────────────

/**
 * create_config → update_threshold(<threshold>).
 * Pass 1 for single-CP tests, 2 for the 2-of-2 live run.
 *
 * Note: update_threshold in Move only asserts new_threshold >= 1 (not against
 * active CP count), so it is safe to call before CPs are enrolled.
 */
export async function setupQuorumStateWithThreshold(
  client: SuiClient,
  deployer: Ed25519Keypair,
  packageId: string,
  networkRegistryId: string,
  adminCapId: string,
  threshold: number,
): Promise<string> {
  const create = await signAndExec(
    client,
    deployer,
    (tx) => {
      tx.moveCall({
        target: `${packageId}::cp_quorum_sig::create_config`,
        arguments: [tx.object(adminCapId)],
      });
    },
    'create_config',
  );
  if (create.status !== 'success') {
    throw new Error(`create_config failed: ${create.error ?? create.status}`);
  }
  const stateObj = create.objectChanges.find(
    (c) => c.type === 'created' && (c.objectType ?? '').includes('::cp_quorum_sig::QuorumConfigState'),
  );
  if (!stateObj?.objectId) throw new Error('setupQuorumStateWithThreshold: QuorumConfigState not created');
  const quorumStateId = stateObj.objectId;

  // update_threshold arg order (cp_quorum_sig.move:200):
  // _: &AdminCap, net_reg: &NetworkRegistry, state: &mut QuorumConfigState, new_threshold: u64, updater: address
  const upd = await signAndExec(
    client,
    deployer,
    (tx) => {
      tx.moveCall({
        target: `${packageId}::cp_quorum_sig::update_threshold`,
        arguments: [
          tx.object(adminCapId),
          tx.object(networkRegistryId),
          tx.object(quorumStateId),
          tx.pure.u64(BigInt(threshold)),
          tx.pure.address(deployer.toSuiAddress()),
        ],
      });
    },
    'update_threshold',
  );
  if (upd.status !== 'success') {
    throw new Error(`update_threshold(${threshold}) failed: ${upd.error ?? upd.status}`);
  }
  return quorumStateId;
}

// ── CP enrollment ─────────────────────────────────────────────────────────────

/**
 * Generate a fresh keypair and enroll it as a CP operator:
 *   fund → registerMiner (0.6 SUI → ControlPlaneCap) → register_cp.
 *
 * register_cp arg order (control_plane_registry.move:82):
 *   net_reg, registry, cap, stake.
 */
export async function enrollCp(
  client: SuiClient,
  config: LocalnetHandle['config'],
  logger: Logger,
): Promise<BootstrapCpResult> {
  const kp = Ed25519Keypair.generate();
  await fundAddress(kp.getPublicKey().toSuiAddress());
  await new Promise((r) => setTimeout(r, 1500));
  const reg = await registerMiner(client, kp, config, CP_STAKE_MIST, logger);
  if (reg.cpCapId === null) {
    throw new Error('enrollCp: expected a ControlPlaneCap from 0.6 SUI register, got none');
  }
  const cpCapId = reg.cpCapId;
  const enroll = await signAndExec(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(cpCapId),
          tx.object(reg.stakeId),
        ],
      });
    },
    'register_cp',
  );
  if (enroll.status !== 'success') {
    throw new Error(`register_cp failed: ${enroll.error ?? enroll.status}`);
  }
  logger.info({ module: 'cap-token-live-helpers', action: 'enroll_cp', context: { minerId: reg.minerId } }, 'enrolled CP');
  return { kp, minerId: reg.minerId, cpCapId, stakeId: reg.stakeId };
}

// ── Event polling ─────────────────────────────────────────────────────────────

/**
 * Poll capability_events for a CapabilityIssued matching peer_pubkey.
 * Returns { tokenId, issuerQuorum } on match, null on timeout.
 *
 * issuerQuorum is the raw vector<address> from the event — callers should
 * normalize addresses (e.g. via normalizeSuiAddress) before string comparison.
 */
export async function pollForIssued(
  client: SuiClient,
  packageId: string,
  peerPubkey: number[],
  timeoutMs: number,
): Promise<{ tokenId: string; issuerQuorum: string[] } | null> {
  const deadline = Date.now() + timeoutMs;
  const target = peerPubkey.join(',');
  while (Date.now() < deadline) {
    const page = await client.queryEvents({
      query: { MoveEventModule: { package: packageId, module: 'capability_events' } },
      limit: 50,
      order: 'descending',
    });
    for (const ev of page.data) {
      if (!ev.type.endsWith('::CapabilityIssued')) continue;
      const data = ev.parsedJson as {
        token_id?: string;
        peer_pubkey?: number[];
        issuer_quorum?: string[];
      };
      if (
        Array.isArray(data.peer_pubkey) &&
        data.peer_pubkey.join(',') === target &&
        data.token_id
      ) {
        return { tokenId: data.token_id, issuerQuorum: data.issuer_quorum ?? [] };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
