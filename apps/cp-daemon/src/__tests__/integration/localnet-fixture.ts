/**
 * LocalnetFixture — boots a fresh Sui localnet, publishes the contracts package,
 * creates the 6 admin-gated registries, and assembles a NetworkConfig pointing at
 * the empty chain. Used by the F47 Phase 4.0 smoke integration test (RV-013).
 *
 * NOT a `.test.ts` — this is import-safe helper code with NO top-level side
 * effects. The localnet-boot helpers are COPIED (not imported) from
 * scripts/bench/run-smoke.ts: that module lives outside the cp-daemon rootDir
 * (so a relative import would break tsc), and it has ZERO `@dvconf/shared`
 * imports (only `@mysten/sui` + node stdlib), so copying is clean.
 *
 * Heavy + env-sensitive (`sui start`): only ever run via
 * `pnpm test:integration` (vitest.integration.config.ts), never `pnpm test`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import type { NetworkConfig } from '@dvconf/shared';

const SUI_RPC_URL = 'http://127.0.0.1:9000';
const FAUCET_URL = getFaucetHost('localnet');

// Resolve the contracts dir RELATIVE to the workspace root (no hardcoded
// absolute path). This file sits at
// dvconf-daemons/apps/cp-daemon/src/__tests__/integration/ → 6 levels up is the
// workspace root that also holds dvconf-contracts/.
const __filename = fileURLToPath(import.meta.url);
const HERE = resolve(__filename, '..');
const WORKSPACE_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..');
const CONTRACTS_DIR = join(WORKSPACE_ROOT, 'dvconf-contracts');

export interface LocalnetHandle {
  client: SuiClient;
  config: NetworkConfig;
  signer: Ed25519Keypair;
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

/** Spawn `sui start --with-faucet --force-regenesis` as a long-lived child. */
function spawnSuiNode(): { proc: ChildProcess; stop: () => Promise<void> } {
  const proc = spawn('sui', ['start', '--with-faucet', '--force-regenesis'], {
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

/** new-env + switch (G-018) + faucet-fund the active deployer address. */
async function setupSuiClient(alias: string): Promise<void> {
  await runCli('sui', ['client', 'new-env', '--alias', alias, '--rpc', SUI_RPC_URL]);
  await runCli('sui', ['client', 'switch', '--env', alias]);
  const faucet = await runCli('sui', ['client', 'faucet', '--url', `${FAUCET_URL}/gas`]);
  if (faucet.code !== 0) {
    throw new Error(`sui client faucet failed: ${faucet.stderr.slice(0, 300)}`);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

/** Delete stale Pub.*.toml + Move.lock (chain-id mismatch after regenesis). */
function cleanStalePublishState(): void {
  for (const entry of readdirSync(CONTRACTS_DIR)) {
    if (entry.startsWith('Pub.') && entry.endsWith('.toml')) {
      unlinkSync(join(CONTRACTS_DIR, entry));
    }
  }
  const moveLock = join(CONTRACTS_DIR, 'Move.lock');
  if (existsSync(moveLock)) unlinkSync(moveLock);
}

interface PublishOutput {
  packageId: string;
  adminCapId: string;
  networkRegistryId: string;
  minerStoreId: string;
  roleVoteBoxId: string;
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
    if (isShared(change.owner)) {
      if (objType.includes('::network_registry::NetworkRegistry')) networkRegistryId = objId;
      else if (objType.includes('::miner_store::MinerStore')) minerStoreId = objId;
      else if (objType.includes('::role_voting::RoleVoteBox')) roleVoteBoxId = objId; // auto-created by role_voting::init
    } else if (isAddressOwned(change.owner)) {
      if (objType.includes('::network_registry::AdminCap')) adminCapId = objId;
    }
  }

  if (packageId === null) throw new Error('publishPackage: PACKAGE_ID not in objectChanges');
  if (adminCapId === null) throw new Error('publishPackage: AdminCap not in objectChanges');
  if (networkRegistryId === null) throw new Error('publishPackage: NetworkRegistry not in objectChanges');
  if (minerStoreId === null) throw new Error('publishPackage: MinerStore not in objectChanges');
  if (roleVoteBoxId === null) throw new Error('publishPackage: RoleVoteBox not in objectChanges');
  return { packageId, adminCapId, networkRegistryId, minerStoreId, roleVoteBoxId };
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
 * Boot a fresh localnet, publish, create registries, and assemble a
 * NetworkConfig for the empty chain. The returned `signer` is a fresh,
 * faucet-funded keypair (the getters used by the 4.0 smoke are read-only, so
 * any funded address suffices).
 */
export async function bootLocalnet(): Promise<LocalnetHandle> {
  const alias = `phase40-${Date.now()}`;
  const node = spawnSuiNode();
  try {
    await waitForSuiRpc();
    await setupSuiClient(alias);

    const publishOut = await publishPackage();
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
      networkRegistryId: publishOut.networkRegistryId,
      minerStoreId: publishOut.minerStoreId,
      roleVoteBoxId: publishOut.roleVoteBoxId,
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

    return { client, config, signer, teardown };
  } catch (err) {
    // Boot failed partway — kill the node so we don't leak a localnet process.
    try {
      await node.stop();
    } catch {
      // ignore
    }
    throw err;
  }
}
