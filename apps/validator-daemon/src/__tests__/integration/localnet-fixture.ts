/**
 * LocalnetFixture (canary-slash E2E, Phase 4.1) — boots a fresh Sui localnet,
 * publishes the contracts package, creates the 6 admin-gated registries, and
 * assembles a NetworkConfig pointing at the empty chain.
 *
 * COPIED (not imported) from cp-daemon/src/__tests__/integration/localnet-fixture.ts
 * for the SAME rootDir reason that file documents: a cross-package relative import
 * (apps/cp-daemon/... from apps/validator-daemon/...) escapes this package's
 * `rootDir: src` (TS6059), and the only deps are `@mysten/sui` + node stdlib +
 * `@dvconf/shared` (all available here), so a copy is clean and keeps the cp-daemon
 * path byte-for-byte untouched.
 *
 * DELTA vs the cp-daemon copy: the returned {@link LocalnetHandle} additionally
 * exposes the DEPLOYER keypair + the published AdminCap id, because the canary E2E
 * must create a user + create a room + AdminCap-assign R_k to it
 * (`room_manager::assign_relay_and_signaling` is AdminCap-gated). The cp-daemon
 * revote fixture never needed an admin-gated mutation so it discarded both.
 *
 * NOT a `.test.ts` — import-safe helper code with NO top-level side effects. Heavy +
 * env-sensitive (`sui start`): only ever run via the canary integration glob in
 * vitest.integration.config.ts, never `pnpm test`.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import type { NetworkConfig } from '@dvconf/shared';

export const SUI_RPC_URL = 'http://127.0.0.1:9000';
export const FAUCET_URL = getFaucetHost('localnet');

// This file sits at services/worker/apps/validator-daemon/src/__tests__/integration/
// → 6 levels up is services/, which holds contract/ (this checkout's current
// layout -- both Move packages now nest under services/contract/ as core/
// and role-voting/ subfolders instead of living at the submodule root / as a
// sibling top-level directory).
const __filename = fileURLToPath(import.meta.url);
const HERE = resolve(__filename, '..');
const WORKSPACE_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..');
const CONTRACTS_DIR = resolve(process.env['DVCONF_CONTRACTS_DIR'] ?? join(WORKSPACE_ROOT, 'contract', 'core'));
// Package split (see services/contract/role-voting): role_voting now
// publishes as its own package, which depends on CONTRACTS_DIR above via a
// local Move.toml dependency -- must be published AFTER it.
const CONTRACT_ROLE_VOTING_DIR = resolve(
  process.env['DVCONF_CONTRACT_ROLE_VOTING_DIR'] ?? join(WORKSPACE_ROOT, 'contract', 'role-voting'),
);

export interface LocalnetHandle {
  client: SuiClient;
  config: NetworkConfig;
  /** Fresh, faucet-funded keypair (read-only sender for getters). */
  signer: Ed25519Keypair;
  /** The package DEPLOYER (owns the AdminCap) — needed for admin-gated room assignment. */
  deployer: Ed25519Keypair;
  /** The published AdminCap object id (owned by `deployer`). */
  adminCapId: string;
  teardown: () => Promise<void>;
}

// ── object-change shapes (subset) ────────────────────────────────────────

interface SuiObjectChange {
  type: string;
  packageId?: string;
  objectId?: string;
  objectType?: string;
  owner?: unknown;
}

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

function isShared(owner: unknown): boolean {
  return owner !== undefined && owner !== null && typeof owner === 'object' && 'Shared' in owner;
}

function isAddressOwned(owner: unknown): boolean {
  return owner !== undefined && owner !== null && typeof owner === 'object' && 'AddressOwner' in owner;
}

/** Spawn a CLI binary, capture stdout/stderr, no shell. */
function runCli(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('exit', (code) => resolveResult({ stdout, stderr, code: code ?? 1 }));
    if (opts.timeoutMs !== undefined) {
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGTERM');
      }, opts.timeoutMs);
    }
  });
}

/** Poll a TCP port until it accepts a connection, or fail after timeoutMs. */
function waitForPort(host: string, port: number, timeoutMs: number, pollIntervalMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const tryOnce = (): Promise<boolean> =>
    new Promise((res) => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        res(ok);
      };
      socket.setTimeout(1000);
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    });
  return (async () => {
    while (Date.now() < deadline) {
      if (await tryOnce()) return;
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`waitForPort: ${host}:${port} not reachable after ${timeoutMs}ms`);
  })();
}

/**
 * Spawn `sui start --with-faucet --force-regenesis` as a long-lived child.
 * `epochDurationMs` (additive): appends `--epoch-duration-ms` so the test can
 * advance epochs quickly (used by the role-vote→apply lifecycle). Teardown is
 * platform-split: `child.kill()` does NOT reap the `sui` process TREE on Windows,
 * so on win32 we `taskkill /PID <pid> /T /F` the whole tree.
 */
function spawnSuiNode(epochDurationMs?: number): { proc: ChildProcess; stop: () => Promise<void> } {
  const args = ['start', '--with-faucet', '--force-regenesis'];
  if (epochDurationMs !== undefined) {
    args.push('--epoch-duration-ms', String(epochDurationMs));
  }
  const proc = spawn('sui', args, {
    env: { ...process.env, RUST_LOG: 'off,sui_node=info' },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = (): Promise<void> =>
    new Promise<void>((resolveStop) => {
      if (proc.exitCode !== null || proc.killed) {
        resolveStop();
        return;
      }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolveStop();
      });
      if (process.platform === 'win32' && proc.pid !== undefined) {
        try {
          spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
        } catch {
          // best-effort; fall through to the SIGTERM path + kill timer below
        }
      }
      proc.kill('SIGTERM');
    });
  return { proc, stop };
}

/** Wait for RPC port 9000, then for JSON-RPC readiness. */
async function waitForSuiRpc(timeoutMs = 180_000): Promise<void> {
  await waitForPort('127.0.0.1', 9000, Math.min(120_000, timeoutMs));
  const rpcDeadline = Date.now() + 60_000;
  while (Date.now() < rpcDeadline) {
    try {
      const resp = await fetch(SUI_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getLatestCheckpointSequenceNumber', params: [] }),
      });
      const json = (await resp.json()) as { result?: unknown };
      if (json.result !== undefined) return;
    } catch {
      // RPC not yet accepting calls
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('waitForSuiRpc: JSON-RPC not responding after 60s');
}

/** Faucet-fund an arbitrary address. */
export async function fundAddress(address: string): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
}

/**
 * new-env + switch + faucet-fund the active deployer address.
 *
 * `--with-faucet`'s companion HTTP server can still be starting up for a moment
 * after the JSON-RPC port (which waitForSuiRpc already confirmed) is accepting
 * calls, so the first faucet call can race a "connection refused"-style failure
 * on a freshly booted node -- retry a few times before giving up.
 */
async function setupSuiClient(alias: string): Promise<void> {
  await runCli('sui', ['client', 'new-env', '--alias', alias, '--rpc', SUI_RPC_URL]);
  await runCli('sui', ['client', 'switch', '--env', alias]);

  const maxAttempts = 5;
  let lastFaucet: CliResult | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const faucet = await runCli('sui', ['client', 'faucet', '--url', `${FAUCET_URL}/gas`]);
    if (faucet.code === 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }
    lastFaucet = faucet;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `sui client faucet failed after ${maxAttempts} attempts: stderr=${lastFaucet?.stderr.slice(0, 300)} stdout=${lastFaucet?.stdout.slice(0, 300)}`,
  );
}

/** Delete stale Pub.*.toml + Move.lock (chain-id mismatch after regenesis). */
function cleanStalePublishState(dir: string = CONTRACTS_DIR): void {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('Pub.') && entry.endsWith('.toml')) {
      unlinkSync(join(dir, entry));
    }
  }
  const moveLock = join(dir, 'Move.lock');
  if (existsSync(moveLock)) unlinkSync(moveLock);
}

interface PublishOutput {
  packageId: string;
  adminCapId: string;
  networkRegistryId: string;
  minerStoreId: string;
  livenessVoteBoxId: string;
}

/** Publish the package via `sui client test-publish --json` + extract identities. */
async function publishPackage(): Promise<PublishOutput> {
  cleanStalePublishState();
  const result = await runCli(
    'sui',
    ['client', 'test-publish', '--gas-budget', '1000000000', '--build-env', 'local', '--json'],
    { cwd: CONTRACTS_DIR, timeoutMs: 240_000 },
  );
  if (result.code !== 0) {
    throw new Error(`sui test-publish exited ${result.code}\nSTDERR: ${result.stderr.slice(0, 1500)}`);
  }
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`sui test-publish produced no JSON: ${result.stdout.slice(0, 300)}`);
  const parsed = JSON.parse(result.stdout.slice(jsonStart)) as { objectChanges?: SuiObjectChange[] };

  let packageId: string | null = null;
  let adminCapId: string | null = null;
  let networkRegistryId: string | null = null;
  let minerStoreId: string | null = null;
  let livenessVoteBoxId: string | null = null;

  for (const change of parsed.objectChanges ?? []) {
    if (change.type === 'published') {
      if (typeof change.packageId === 'string') packageId = change.packageId;
      continue;
    }
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    const objId = change.objectId;
    if (typeof objId !== 'string') continue;
    if (isShared(change.owner)) {
      if (objType.includes('::network_registry::NetworkRegistry')) networkRegistryId = objId;
      else if (objType.includes('::miner_store::MinerStore')) minerStoreId = objId;
      else if (objType.includes('::liveness_voting::LivenessVoteBox')) livenessVoteBoxId = objId;
    } else if (isAddressOwned(change.owner)) {
      if (objType.includes('::network_registry::AdminCap')) adminCapId = objId;
    }
  }

  if (packageId === null) throw new Error('publishPackage: PACKAGE_ID not in objectChanges');
  if (adminCapId === null) throw new Error('publishPackage: AdminCap not in objectChanges');
  if (networkRegistryId === null) throw new Error('publishPackage: NetworkRegistry not in objectChanges');
  if (minerStoreId === null) throw new Error('publishPackage: MinerStore not in objectChanges');
  if (livenessVoteBoxId === null) throw new Error('publishPackage: LivenessVoteBox not in objectChanges');
  return { packageId, adminCapId, networkRegistryId, minerStoreId, livenessVoteBoxId };
}

interface RoleVotingPublishOutput {
  packageId: string;
  roleVoteBoxId: string;
}

/**
 * Package split (see services/contract/role-voting): publish dvconf_role_voting
 * AFTER package A -- its Move.toml resolves package A's on-chain address via a
 * local dependency, which only exists once A's Move.lock records a real publish
 * for this build-env.
 */
async function publishRoleVotingPackage(): Promise<RoleVotingPublishOutput> {
  cleanStalePublishState(CONTRACT_ROLE_VOTING_DIR);
  const result = await runCli(
    'sui',
    ['client', 'test-publish', '--gas-budget', '1000000000', '--build-env', 'local', '--json'],
    { cwd: CONTRACT_ROLE_VOTING_DIR, timeoutMs: 240_000 },
  );
  if (result.code !== 0) {
    throw new Error(`sui test-publish (role-voting) exited ${result.code}\nSTDERR: ${result.stderr.slice(0, 1500)}`);
  }
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) throw new Error(`sui test-publish (role-voting) produced no JSON: ${result.stdout.slice(0, 300)}`);
  const parsed = JSON.parse(result.stdout.slice(jsonStart)) as { objectChanges?: SuiObjectChange[] };

  let packageId: string | null = null;
  let roleVoteBoxId: string | null = null;
  for (const change of parsed.objectChanges ?? []) {
    if (change.type === 'published') {
      if (typeof change.packageId === 'string') packageId = change.packageId;
      continue;
    }
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    const objId = change.objectId;
    if (typeof objId !== 'string') continue;
    if (isShared(change.owner) && objType.includes('::role_voting::RoleVoteBox')) roleVoteBoxId = objId;
  }

  if (packageId === null) throw new Error('publishRoleVotingPackage: PACKAGE_ID not in objectChanges');
  if (roleVoteBoxId === null) throw new Error('publishRoleVotingPackage: RoleVoteBox not in objectChanges');
  return { packageId, roleVoteBoxId };
}

/** Pluck the lone shared object from a `<module>::create` result. */
function parseSharedObjectFromCreate(objectChanges: SuiObjectChange[], structSubstring: string): string {
  for (const change of objectChanges) {
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    if (isShared(change.owner) && objType.includes(structSubstring) && typeof change.objectId === 'string') {
      return change.objectId;
    }
  }
  throw new Error(`parseSharedObjectFromCreate: no shared object matching ${structSubstring}`);
}

const REGISTRY_SPEC = [
  { module: 'user_registry', structName: 'UserRegistry', key: 'userRegistryId' },
  { module: 'room_manager', structName: 'RoomManager', key: 'roomManagerId' },
  { module: 'relay_registry', structName: 'RelayRegistry', key: 'relayRegistryId' },
  { module: 'control_plane_registry', structName: 'ControlPlaneRegistry', key: 'cpRegistryId' },
  { module: 'validator_registry', structName: 'ValidatorRegistry', key: 'validatorRegistryId' },
  { module: 'signaling_registry', structName: 'SignalingRegistry', key: 'signalingRegistryId' },
] as const;

type RegistryKey =
  | 'userRegistryId'
  | 'roomManagerId'
  | 'relayRegistryId'
  | 'cpRegistryId'
  | 'validatorRegistryId'
  | 'signalingRegistryId';

/** Sequentially create the 6 admin-gated shared registries. */
async function createRegistries(
  client: SuiClient,
  signer: Ed25519Keypair,
  packageId: string,
  adminCapId: string,
): Promise<Record<RegistryKey, string>> {
  const out = {} as Record<RegistryKey, string>;
  for (const spec of REGISTRY_SPEC) {
    const tx = new Transaction();
    tx.moveCall({ target: `${packageId}::${spec.module}::create`, arguments: [tx.object(adminCapId)] });
    tx.setGasBudget(100_000_000);
    const result = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: result.digest });
    out[spec.key] = parseSharedObjectFromCreate(
      (result.objectChanges ?? []) as SuiObjectChange[],
      spec.structName,
    );
  }
  return out;
}

/** Export the active deployer's secret key into an SDK Ed25519Keypair. */
async function loadActiveSigner(): Promise<Ed25519Keypair> {
  const addrResult = await runCli('sui', ['client', 'active-address']);
  if (addrResult.code !== 0) throw new Error(`sui client active-address failed: ${addrResult.stderr.slice(0, 300)}`);
  const activeAddr = addrResult.stdout.trim();
  const exportResult = await runCli('sui', ['keytool', 'export', '--key-identity', activeAddr, '--json']);
  if (exportResult.code !== 0) throw new Error(`sui keytool export failed: ${exportResult.stderr.slice(0, 300)}`);
  const exported = JSON.parse(exportResult.stdout) as { exportedPrivateKey?: string };
  if (typeof exported.exportedPrivateKey !== 'string') throw new Error('sui keytool export returned no exportedPrivateKey');
  return Ed25519Keypair.fromSecretKey(exported.exportedPrivateKey);
}

/**
 * Boot a fresh localnet, publish, create registries, and assemble a NetworkConfig
 * for the empty chain. Exposes the deployer + AdminCap id so the canary E2E can
 * AdminCap-assign R_k to a room.
 */
export async function bootLocalnet(
  opts: { epochDurationMs?: number } = {},
): Promise<LocalnetHandle> {
  const alias = `canary-e2e-${Date.now()}`;
  const node = spawnSuiNode(opts.epochDurationMs);
  try {
    await waitForSuiRpc();
    await setupSuiClient(alias);

    const publishOut = await publishPackage();
    // Package split: dvconf_role_voting publishes AFTER package A (see
    // publishRoleVotingPackage's doc) -- its Move.toml resolves A's address
    // via the local dependency + A's freshly-written Move.lock above.
    const roleVotingOut = await publishRoleVotingPackage();
    const deployer = await loadActiveSigner();
    const client = new SuiClient({ url: SUI_RPC_URL });

    const registries = await createRegistries(client, deployer, publishOut.packageId, publishOut.adminCapId);

    // Fresh test signer, faucet-funded (read-only getters need a valid sender).
    const signer = Ed25519Keypair.generate();
    await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: signer.getPublicKey().toSuiAddress() });
    await new Promise((r) => setTimeout(r, 1000));

    const config: NetworkConfig = {
      rpcUrl: SUI_RPC_URL,
      packageId: publishOut.packageId,
      roleVotingPackageId: roleVotingOut.packageId,
      networkRegistryId: publishOut.networkRegistryId,
      minerStoreId: publishOut.minerStoreId,
      roleVoteBoxId: roleVotingOut.roleVoteBoxId,
      livenessVoteBoxId: publishOut.livenessVoteBoxId,
      cpRegistryId: registries.cpRegistryId,
      relayRegistryId: registries.relayRegistryId,
      validatorRegistryId: registries.validatorRegistryId,
      userRegistryId: registries.userRegistryId,
      roomManagerId: registries.roomManagerId,
      signalingRegistryId: registries.signalingRegistryId,
    };

    const teardown = async (): Promise<void> => {
      try {
        await node.stop();
      } catch {
        // best-effort; never throw from teardown
      }
    };

    return { client, config, signer, deployer, adminCapId: publishOut.adminCapId, teardown };
  } catch (err) {
    try {
      await node.stop();
    } catch {
      // ignore
    }
    throw err;
  }
}
