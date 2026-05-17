/**
 * Bench smoke bring-up — S25 (TS replacement for run-local.ps1 + run-e2e-tests.ps1
 * on the bench critical path).
 *
 * Pure cross-platform Node orchestrator that brings the DVConf stack up against
 * a fresh Sui localnet, drives the existing 2/4-peer mediasoup harness, and tears
 * everything down. Replaces the PowerShell + python3 pipe pattern that surfaced
 * the PS-5.1 NativeCommandError class blocking S23.3.
 *
 * Module layout:
 *
 *   ── Pure helpers (vitest-covered, S25.A) ──
 *   - parsePublishJson(json)               — extract 6 identities from sui test-publish
 *   - parseSharedObjectFromCreate(json, s) — extract shared ID from module::create
 *   - buildEnvContent(ids, keys, extras)   — format dvconf-daemons/.env
 *   - waitForPort(host, port, timeoutMs)   — TCP poll
 *
 *   ── Orchestrator (S25.B/C, integration-tested manually) ──
 *   - main()                               — full bring-up + drive + teardown
 *
 * Plan: docs/00-meta/progress.md § Session 25 (TS bench bring-up)
 * Hook:  pnpm bench:smoke (added in S25.D)
 */

import { createConnection } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmSync,
  writeFileSync,
  createWriteStream,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Sui SDK object-change schema (subset we care about) ───────────────

export interface SuiSharedOwner {
  Shared: { initial_shared_version?: number | string } | unknown;
}

export interface SuiAddressOwner {
  AddressOwner: string;
}

export type SuiOwner = SuiSharedOwner | SuiAddressOwner | Record<string, unknown>;

export interface SuiObjectChange {
  type: 'published' | 'created' | 'mutated' | 'transferred' | 'wrapped' | 'deleted' | string;
  packageId?: string;
  objectId?: string;
  objectType?: string;
  owner?: SuiOwner;
}

export interface SuiPublishResult {
  objectChanges?: SuiObjectChange[];
}

function isShared(owner: SuiOwner | undefined): boolean {
  return owner !== undefined && typeof owner === 'object' && 'Shared' in owner;
}

function isAddressOwned(owner: SuiOwner | undefined): boolean {
  return (
    owner !== undefined && typeof owner === 'object' && 'AddressOwner' in owner
  );
}

// ── parsePublishJson ──────────────────────────────────────────────────

export interface PublishOutput {
  packageId: string;
  adminCapId: string;
  treasuryCapId: string;
  /** Auto-created by module::init when the package is published. */
  networkRegistryId: string;
  minerStoreId: string;
  roleVoteBoxId: string;
}

/**
 * Pluck the six load-bearing identities from a `sui client test-publish --json`
 * payload. Throws when any of the six is missing — bring-up cannot proceed
 * without them and a partial result is more dangerous than a clean abort.
 */
export function parsePublishJson(json: SuiPublishResult): PublishOutput {
  let packageId: string | null = null;
  let adminCapId: string | null = null;
  let treasuryCapId: string | null = null;
  let networkRegistryId: string | null = null;
  let minerStoreId: string | null = null;
  let roleVoteBoxId: string | null = null;

  for (const change of json.objectChanges ?? []) {
    if (change.type === 'published') {
      if (typeof change.packageId === 'string') packageId = change.packageId;
      continue;
    }
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    const objId = change.objectId;
    if (typeof objId !== 'string') continue;
    const owner = change.owner;

    if (isShared(owner)) {
      if (objType.includes('::network_registry::NetworkRegistry')) {
        networkRegistryId = objId;
      } else if (objType.includes('::miner_store::MinerStore')) {
        minerStoreId = objId;
      } else if (objType.includes('::role_voting::RoleVoteBox')) {
        roleVoteBoxId = objId;
      }
    } else if (isAddressOwned(owner)) {
      if (objType.includes('::network_registry::AdminCap')) {
        adminCapId = objId;
      } else if (objType.includes('0x2::coin::TreasuryCap<')) {
        treasuryCapId = objId;
      }
    }
  }

  if (packageId === null) {
    throw new Error('parsePublishJson: PACKAGE_ID not in objectChanges');
  }
  if (adminCapId === null) {
    throw new Error('parsePublishJson: AdminCap not in objectChanges');
  }
  if (treasuryCapId === null) {
    throw new Error(
      'parsePublishJson: TreasuryCap<token::TOKEN> not in objectChanges',
    );
  }
  if (networkRegistryId === null) {
    throw new Error('parsePublishJson: NetworkRegistry not in objectChanges');
  }
  if (minerStoreId === null) {
    throw new Error('parsePublishJson: MinerStore not in objectChanges');
  }
  if (roleVoteBoxId === null) {
    throw new Error('parsePublishJson: RoleVoteBox not in objectChanges');
  }
  return {
    packageId,
    adminCapId,
    treasuryCapId,
    networkRegistryId,
    minerStoreId,
    roleVoteBoxId,
  };
}

// ── parseSharedObjectFromCreate ───────────────────────────────────────

/**
 * Pluck the lone shared object out of a `<module>::create` call result.
 * The 6 registry-create calls each produce exactly one shared object whose
 * struct name matches `structSubstring`; we scan `objectChanges` for it.
 */
export function parseSharedObjectFromCreate(
  result: { objectChanges?: SuiObjectChange[] },
  structSubstring: string,
): string {
  for (const change of result.objectChanges ?? []) {
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    if (
      isShared(change.owner) &&
      objType.includes(structSubstring) &&
      typeof change.objectId === 'string'
    ) {
      return change.objectId;
    }
  }
  throw new Error(
    `parseSharedObjectFromCreate: no shared object matching ${structSubstring}`,
  );
}

// ── buildEnvContent ───────────────────────────────────────────────────

export interface BenchIds {
  packageId: string;
  networkRegistryId: string;
  minerStoreId: string;
  cpRegistryId: string;
  relayRegistryId: string;
  validatorRegistryId: string;
  userRegistryId: string;
  roomManagerId: string;
  signalingRegistryId: string;
  roleVoteBoxId: string;
}

/**
 * The four canonical env-var names for daemon keypairs, mirroring the
 * per-app `.env.example` files. Each daemon reads a *different* name so the
 * bundle is a flat record, not a list.
 */
export interface DaemonKeys {
  /** cp-daemon — apps/cp-daemon/.env.example */
  CP_KEYPAIR: string;
  /** validator-daemon — apps/validator-daemon/.env.example */
  SUI_PRIVATE_KEY: string;
  /** signaling — apps/signaling/.env.example */
  SIGNALING_KEYPAIR: string;
  /** relay — apps/relay/.env.example */
  PRIVATE_KEY: string;
}

/**
 * Render the dvconf-daemons/.env file the four daemons share. Matches the
 * legacy run-local.ps1 layout so existing daemon code paths (heartbeat,
 * auto-register, latency probe gating via `BENCH_LATENCY=1`) light up
 * unchanged.
 */
export function buildEnvContent(
  ids: BenchIds,
  keys: DaemonKeys,
  extras: Record<string, string> = {},
): string {
  const lines = [
    'SUI_NETWORK=localnet',
    `PACKAGE_ID=${ids.packageId}`,
    `NETWORK_REGISTRY_ID=${ids.networkRegistryId}`,
    `MINER_STORE_ID=${ids.minerStoreId}`,
    `CP_REGISTRY_ID=${ids.cpRegistryId}`,
    `RELAY_REGISTRY_ID=${ids.relayRegistryId}`,
    `VALIDATOR_REGISTRY_ID=${ids.validatorRegistryId}`,
    `USER_REGISTRY_ID=${ids.userRegistryId}`,
    `ROOM_MANAGER_ID=${ids.roomManagerId}`,
    `SIGNALING_REGISTRY_ID=${ids.signalingRegistryId}`,
    `ROLE_VOTE_BOX_ID=${ids.roleVoteBoxId}`,
    `CP_KEYPAIR=${keys.CP_KEYPAIR}`,
    `SUI_PRIVATE_KEY=${keys.SUI_PRIVATE_KEY}`,
    `SIGNALING_KEYPAIR=${keys.SIGNALING_KEYPAIR}`,
    `PRIVATE_KEY=${keys.PRIVATE_KEY}`,
    'LOG_LEVEL=info',
    'HEARTBEAT_INTERVAL_MS=30000',
    'EVENT_POLL_INTERVAL_MS=3000',
    'BENCH_LATENCY=1',
  ];
  for (const [k, v] of Object.entries(extras)) {
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

// ── waitForPort ───────────────────────────────────────────────────────

function tryConnectOnce(
  host: string,
  port: number,
  connectTimeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(connectTimeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/**
 * Poll a TCP port until it accepts a connection, or fail after `timeoutMs`.
 * Used to wait on the Sui RPC socket (9000), the faucet (9123), and the
 * 4 daemon WS ports (4000 relay, 8080 signaling, etc.).
 */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number,
  pollIntervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await tryConnectOnce(host, port, Math.min(1000, pollIntervalMs));
    if (ok) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `waitForPort: ${host}:${port} not reachable after ${timeoutMs}ms`,
  );
}

// ── Orchestrator (S25.B) ──────────────────────────────────────────────

/** Workspace root — three levels up from scripts/bench/. */
const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..');
const CONTRACTS_DIR = join(WORKSPACE_ROOT, 'dvconf-contracts');
const DAEMONS_DIR = join(WORKSPACE_ROOT, 'dvconf-daemons');
const LOGS_DIR = join(WORKSPACE_ROOT, '.logs', 'bench');
const SUI_RPC_URL = 'http://127.0.0.1:9000';
const FAUCET_URL = getFaucetHost('localnet');

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn a CLI binary and capture stdout/stderr cleanly. No shell — no PS↔python
 * NativeCommandError class possible. Optional timeout SIGTERM-kills the child.
 */
function runCli(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
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
    proc.on('exit', (code) => {
      resolveResult({ stdout, stderr, code: code ?? 1 });
    });
    if (opts.timeoutMs !== undefined) {
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGTERM');
      }, opts.timeoutMs);
    }
  });
}

export interface SuiNodeHandle {
  proc: ChildProcess;
  stop: () => Promise<void>;
}

/**
 * Spawn `sui start --with-faucet --force-regenesis` as a long-lived child.
 * Returns a stop() that SIGTERMs, then SIGKILLs after 5s grace.
 */
export function spawnSuiNode(logFilePath?: string): SuiNodeHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUST_LOG: 'off,sui_node=info',
  };
  const proc = spawn(
    'sui',
    ['start', '--with-faucet', '--force-regenesis'],
    { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (logFilePath !== undefined) {
    mkdirSync(dirname(logFilePath), { recursive: true });
    const ws = createWriteStream(logFilePath);
    proc.stdout?.pipe(ws);
    proc.stderr?.pipe(ws);
  }
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

/**
 * Wait for the Sui RPC to both bind port 9000 and respond to
 * `sui_getLatestCheckpointSequenceNumber`. Two phases: TCP, then JSON-RPC.
 */
export async function waitForSuiRpc(timeoutMs = 180_000): Promise<void> {
  const portDeadline = Date.now() + Math.min(120_000, timeoutMs);
  await waitForPort('127.0.0.1', 9000, portDeadline - Date.now(), 2000);
  const rpcDeadline = Date.now() + 60_000;
  while (Date.now() < rpcDeadline) {
    try {
      const resp = await fetch(SUI_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sui_getLatestCheckpointSequenceNumber',
          params: [],
        }),
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

/**
 * Idempotent `sui client` env setup: new-env (alias `bench-localnet`),
 * switch, faucet-fund the active address.
 */
export async function setupSuiClient(): Promise<void> {
  await runCli('sui', [
    'client',
    'new-env',
    '--alias',
    'bench-localnet',
    '--rpc',
    SUI_RPC_URL,
  ]);
  await runCli('sui', ['client', 'switch', '--env', 'bench-localnet']);
  const faucet = await runCli('sui', [
    'client',
    'faucet',
    '--url',
    `${FAUCET_URL}/gas`,
  ]);
  if (faucet.code !== 0) {
    throw new Error(`sui client faucet failed: ${faucet.stderr.slice(0, 300)}`);
  }
  // Give the faucet a moment to land + checkpoint.
  await new Promise((r) => setTimeout(r, 2000));
}

/**
 * Clean stale publication state (chain-id mismatch after force-regenesis) +
 * stale event-poller cursors that would re-replay old events into fresh chain.
 */
function cleanStaleState(): void {
  // Delete every Pub.<env>.toml + Move.lock — they cache a chain-id that
  // doesn't match after `--force-regenesis`. The PS script only deleted
  // Pub.local.toml because it used a fixed env alias; we use whatever alias
  // we passed to `new-env`, so glob-delete.
  for (const entry of readdirSync(CONTRACTS_DIR)) {
    if (entry.startsWith('Pub.') && entry.endsWith('.toml')) {
      unlinkSync(join(CONTRACTS_DIR, entry));
    }
  }
  const moveLock = join(CONTRACTS_DIR, 'Move.lock');
  if (existsSync(moveLock)) unlinkSync(moveLock);
  for (const sub of ['cp-daemon', 'validator-daemon', 'relay', 'signaling']) {
    const cursorDir = join(DAEMONS_DIR, 'apps', sub, '.cursors');
    if (existsSync(cursorDir)) rmSync(cursorDir, { recursive: true, force: true });
  }
}

/**
 * Publish the Move package via `sui client test-publish --json`. Returns the
 * 6 load-bearing identities surfaced by parsePublishJson.
 */
export async function publishPackage(): Promise<PublishOutput> {
  cleanStaleState();
  const result = await runCli(
    'sui',
    [
      'client',
      'test-publish',
      '--gas-budget',
      '1000000000',
      '--build-env',
      'local',
      '--json',
    ],
    { cwd: CONTRACTS_DIR, timeoutMs: 240_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `sui test-publish exited ${result.code}\n--- STDERR ---\n${result.stderr.slice(0, 1500)}\n--- STDOUT ---\n${result.stdout.slice(0, 1500)}`,
    );
  }
  // Strip any non-JSON noise that `sui` occasionally prints before the JSON.
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(
      `sui test-publish produced no JSON: ${result.stdout.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(result.stdout.slice(jsonStart)) as SuiPublishResult;
  return parsePublishJson(parsed);
}

/**
 * Export the bech32 secret key of the currently-active sui client address.
 * Used to construct an SDK signer that holds AdminCap + TreasuryCap after
 * publish, so subsequent transactions can run via the SDK (no shell for ops
 * we control).
 */
export async function loadActiveSigner(): Promise<Ed25519Keypair> {
  const addrResult = await runCli('sui', ['client', 'active-address']);
  if (addrResult.code !== 0) {
    throw new Error(
      `sui client active-address failed: ${addrResult.stderr.slice(0, 300)}`,
    );
  }
  const activeAddr = addrResult.stdout.trim();
  const exportResult = await runCli('sui', [
    'keytool',
    'export',
    '--key-identity',
    activeAddr,
    '--json',
  ]);
  if (exportResult.code !== 0) {
    throw new Error(
      `sui keytool export failed: ${exportResult.stderr.slice(0, 300)}`,
    );
  }
  const exported = JSON.parse(exportResult.stdout) as {
    exportedPrivateKey?: string;
  };
  if (typeof exported.exportedPrivateKey !== 'string') {
    throw new Error('sui keytool export returned no exportedPrivateKey');
  }
  return Ed25519Keypair.fromSecretKey(exported.exportedPrivateKey);
}

/** 6 registries that need an explicit `<module>::create(adminCap)` PTB call. */
const REGISTRY_SPEC = [
  { module: 'user_registry', structName: 'UserRegistry', key: 'userRegistryId' },
  { module: 'room_manager', structName: 'RoomManager', key: 'roomManagerId' },
  { module: 'relay_registry', structName: 'RelayRegistry', key: 'relayRegistryId' },
  {
    module: 'control_plane_registry',
    structName: 'ControlPlaneRegistry',
    key: 'cpRegistryId',
  },
  {
    module: 'validator_registry',
    structName: 'ValidatorRegistry',
    key: 'validatorRegistryId',
  },
  {
    module: 'signaling_registry',
    structName: 'SignalingRegistry',
    key: 'signalingRegistryId',
  },
] as const;

type RegistryKey =
  | 'userRegistryId'
  | 'roomManagerId'
  | 'relayRegistryId'
  | 'cpRegistryId'
  | 'validatorRegistryId'
  | 'signalingRegistryId';

/**
 * Sequentially create the 6 admin-gated shared registries. SDK PTBs +
 * showObjectChanges → parseSharedObjectFromCreate. One TX per registry keeps
 * failure diagnosis simple (one bad TX → one named bad registry).
 */
export async function createRegistries(
  client: SuiClient,
  signer: Ed25519Keypair,
  packageId: string,
  adminCapId: string,
): Promise<Record<RegistryKey, string>> {
  const out = {} as Record<RegistryKey, string>;
  for (const spec of REGISTRY_SPEC) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::${spec.module}::create`,
      arguments: [tx.object(adminCapId)],
    });
    tx.setGasBudget(100_000_000);
    const result = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: result.digest });
    out[spec.key] = parseSharedObjectFromCreate(
      { objectChanges: result.objectChanges ?? [] },
      spec.structName,
    );
  }
  return out;
}

export interface DaemonIdentity {
  keys: DaemonKeys;
  addresses: Record<keyof DaemonKeys, string>;
}

/**
 * Generate the 4 daemon Ed25519 keypairs via the SDK (no sui keytool round-trip).
 * Each emits the bech32 `suiprivkey…` form that the daemon .env files expect.
 */
export function generateDaemonKeypairs(): DaemonIdentity {
  const names: (keyof DaemonKeys)[] = [
    'CP_KEYPAIR',
    'SUI_PRIVATE_KEY',
    'SIGNALING_KEYPAIR',
    'PRIVATE_KEY',
  ];
  const keys = {} as DaemonKeys;
  const addresses = {} as Record<keyof DaemonKeys, string>;
  for (const name of names) {
    const kp = Ed25519Keypair.generate();
    keys[name] = kp.getSecretKey();
    addresses[name] = kp.getPublicKey().toSuiAddress();
  }
  return { keys, addresses };
}

/** Faucet-fund each address. Sequential to avoid the localnet faucet rate limit. */
export async function fundAddresses(addresses: string[]): Promise<void> {
  for (const addr of addresses) {
    await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: addr });
    // Localnet faucet is single-threaded; back off briefly between requests.
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Per-daemon DVCONF mint amounts (mirror run-local.ps1 Mint-DVCONF table). */
const MINT_AMOUNTS: Record<keyof DaemonKeys, bigint> = {
  CP_KEYPAIR: 3_000_000_000n, // 3 DVCONF (CP stake = 2 DVCONF)
  SUI_PRIVATE_KEY: 1_000_000_000n, // 1 DVCONF (validator stake = 0.5)
  SIGNALING_KEYPAIR: 500_000_000n, // 0.5 DVCONF (signaling stake = 0.25)
  PRIVATE_KEY: 2_000_000_000n, // 2 DVCONF (relay stake = 1)
};

/**
 * Mint DVCONF tokens to each daemon address via PTB `token::mint`.
 * One TX per recipient (matches PS layout — easier failure attribution).
 */
export async function mintDvconfTokens(
  client: SuiClient,
  signer: Ed25519Keypair,
  packageId: string,
  treasuryCapId: string,
  recipients: Record<keyof DaemonKeys, string>,
): Promise<void> {
  for (const [name, addr] of Object.entries(recipients) as [
    keyof DaemonKeys,
    string,
  ][]) {
    const amount = MINT_AMOUNTS[name];
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::token::mint`,
      arguments: [
        tx.object(treasuryCapId),
        tx.pure.u64(amount),
        tx.pure.address(addr),
      ],
    });
    tx.setGasBudget(100_000_000);
    const result = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: result.digest });
  }
}

/**
 * Full Phase-1 bring-up: spawn Sui, publish package, create the 6
 * AdminCap-gated registries, generate + fund the 4 daemon keypairs, mint
 * DVCONF, write `dvconf-daemons/.env`. Returns the assembled bench identity
 * bundle so Phase 2 (daemon spawn + room create) can chain off it.
 */
export interface BenchBringupResult {
  ids: BenchIds;
  identity: DaemonIdentity;
  publishOut: PublishOutput;
  sui: SuiNodeHandle;
  client: SuiClient;
  deployer: Ed25519Keypair;
}

export async function bringUpBench(opts: {
  reuseRunning?: boolean;
} = {}): Promise<BenchBringupResult> {
  mkdirSync(LOGS_DIR, { recursive: true });

  let sui: SuiNodeHandle;
  if (opts.reuseRunning === true) {
    // Caller asserts a sui node is already running; we don't manage lifecycle.
    sui = {
      proc: null as unknown as ChildProcess,
      stop: () => Promise.resolve(),
    };
  } else {
    console.log('[bench] spawning sui localnet...');
    sui = spawnSuiNode(join(LOGS_DIR, 'sui-localnet.log'));
    await waitForSuiRpc();
    console.log('[bench] sui RPC ready at', SUI_RPC_URL);
  }

  console.log('[bench] setting up sui client env...');
  await setupSuiClient();

  console.log('[bench] publishing package (test-publish, ~30-60s)...');
  const publishOut = await publishPackage();
  console.log('[bench] package:', publishOut.packageId);

  const deployer = await loadActiveSigner();
  const client = new SuiClient({ url: SUI_RPC_URL });

  console.log('[bench] creating 6 admin-gated registries...');
  const registries = await createRegistries(
    client,
    deployer,
    publishOut.packageId,
    publishOut.adminCapId,
  );

  console.log('[bench] generating 4 daemon keypairs...');
  const identity = generateDaemonKeypairs();
  console.log('[bench] funding daemon addresses...');
  await fundAddresses(Object.values(identity.addresses));

  console.log('[bench] minting DVCONF to daemons...');
  await mintDvconfTokens(
    client,
    deployer,
    publishOut.packageId,
    publishOut.treasuryCapId,
    identity.addresses,
  );

  const ids: BenchIds = {
    packageId: publishOut.packageId,
    networkRegistryId: publishOut.networkRegistryId,
    minerStoreId: publishOut.minerStoreId,
    roleVoteBoxId: publishOut.roleVoteBoxId,
    ...registries,
  };

  const envPath = join(DAEMONS_DIR, '.env');
  writeFileSync(
    envPath,
    buildEnvContent(ids, identity.keys, {
      MEASUREMENT_INTERVAL_MS: '10000',
      ROLE_VOTING_INTERVAL_MS: '5000',
      POLL_INTERVAL_MS: '3000',
      REGISTRATION_MODE: 'voting',
    }),
  );
  console.log('[bench] wrote', envPath);

  return { ids, identity, publishOut, sui, client, deployer };
}

async function main(): Promise<void> {
  const reuseRunning = process.argv.includes('--reuse-running');
  const bringupOnly = process.argv.includes('--bringup-only');
  const result = await bringUpBench({ reuseRunning });
  console.log('[bench] bring-up complete');
  if (bringupOnly) {
    console.log('[bench] --bringup-only set; leaving sui node running');
    return;
  }
  // S25.C extension point: daemon spawn + room create + 4-peer harness.
  console.log(
    '[bench] S25.C (daemon spawn + 4-peer scenario) lands in the next sub-task',
  );
  // For S25.B, keep the sui node alive long enough to inspect the .env then exit.
  if (!reuseRunning) {
    await result.sui.stop();
  }
}

const isMain =
  process.argv[1]?.endsWith('run-smoke.ts') === true ||
  process.argv[1]?.endsWith('run-smoke.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
