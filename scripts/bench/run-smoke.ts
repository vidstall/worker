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
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import { createGraphQLClient, fetchEventsForDigest } from '../../packages/shared/src/index.ts';

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

/**
 * Subset of a Sui transaction event we care about. `parsedJson` is the BCS
 * payload decoded by the SDK; we only ever read top-level string/number
 * fields like `room_id` so the loose record type is sufficient.
 */
export interface SuiTxEvent {
  type: string;
  parsedJson?: Record<string, unknown>;
}

/** Tx result with events — what `signAndExecuteTransaction({showEvents:true})` returns. */
export interface SuiTxResult {
  events?: SuiTxEvent[];
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
  livenessVoteBoxId: string;
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
  let livenessVoteBoxId: string | null = null;

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
      } else if (objType.includes('::liveness_voting::LivenessVoteBox')) {
        livenessVoteBoxId = objId;
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
  if (livenessVoteBoxId === null) {
    throw new Error('parsePublishJson: LivenessVoteBox not in objectChanges');
  }
  return {
    packageId,
    adminCapId,
    treasuryCapId,
    networkRegistryId,
    minerStoreId,
    roleVoteBoxId,
    livenessVoteBoxId,
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
  roleVoteBoxId: string;
  livenessVoteBoxId: string;
}

/**
 * The three canonical env-var names for daemon keypairs, mirroring the
 * per-app `.env.example` files. Each daemon reads a *different* name so the
 * bundle is a flat record, not a list.
 */
export interface DaemonKeys {
  /** cp-daemon — apps/cp-daemon/.env.example */
  CP_KEYPAIR: string;
  /** validator-daemon — apps/validator-daemon/.env.example */
  SUI_PRIVATE_KEY: string;
  /** relay — apps/relay/.env.example */
  PRIVATE_KEY: string;
}

/**
 * Render the dvconf-daemons/.env file the three daemons share. Matches the
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
    `ROLE_VOTE_BOX_ID=${ids.roleVoteBoxId}`,
    `LIVENESS_VOTE_BOX_ID=${ids.livenessVoteBoxId}`,
    `CP_KEYPAIR=${keys.CP_KEYPAIR}`,
    `SUI_PRIVATE_KEY=${keys.SUI_PRIVATE_KEY}`,
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
 * daemon WS ports (4000 relay, etc.).
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

// ── parseRoomIdFromEvents ─────────────────────────────────────────────

/**
 * Pluck a string `room_id` from the first event whose `type` ends with
 * `eventTypeSuffix` (typically `'::room_manager::RoomCreated'`). The Sui
 * Move side emits `RoomCreated` from `create_room` instead of returning the
 * object — the SDK surfaces it in `tx.events`, not `tx.objectChanges`.
 *
 * Throws when (a) `events` is missing, (b) no event matches the suffix, or
 * (c) the matched event lacks a string `room_id`. Bench bring-up cannot
 * recover from any of these; failing loudly beats a silent placeholder.
 */
export function parseRoomIdFromEvents(
  result: SuiTxResult,
  eventTypeSuffix: string,
): string {
  if (!Array.isArray(result.events)) {
    throw new Error(
      `parseRoomIdFromEvents: tx result has no events array (suffix=${eventTypeSuffix})`,
    );
  }
  for (const ev of result.events) {
    if (typeof ev.type !== 'string' || !ev.type.endsWith(eventTypeSuffix)) {
      continue;
    }
    const roomId = ev.parsedJson?.['room_id'];
    if (typeof roomId !== 'string') {
      throw new Error(
        `parseRoomIdFromEvents: matched ${ev.type} but room_id is not a string (got ${typeof roomId})`,
      );
    }
    return roomId;
  }
  throw new Error(
    `parseRoomIdFromEvents: no event matched ${eventTypeSuffix} in ${result.events.length} events`,
  );
}

// ── waitForLogLine ────────────────────────────────────────────────────

/** Minimal readable-stream shape — `child_process.spawn` stdout/stderr fit. */
export interface LogStream {
  on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  off?: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  removeListener?: (
    event: 'data',
    listener: (chunk: Buffer | string) => void,
  ) => unknown;
}

/**
 * Watch a readable stream for the first complete line that matches `pattern`,
 * resolving with the matched line text (without trailing newline). Lines
 * without a terminating `\n` are kept in a buffer — they're not considered
 * complete and never match. Rejects with `timeout` if `timeoutMs` passes.
 *
 * Used for ready-detection on daemons that don't expose a listening port:
 *   - cp-daemon: `"Starting role voting loop"`
 *   - validator-daemon: `"Validator daemon started"`
 * And as a secondary check for those that do:
 *   - relay: `"Relay daemon starting"` + later auto-register success
 */
export function waitForLogLine(
  stream: LogStream,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Split on \n; the last fragment (no trailing \n) stays in buffer.
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
        buffer = buffer.slice(nlIdx + 1);
        if (pattern.test(line)) {
          finish(null, line);
          return;
        }
      }
    };

    const finish = (err: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detach = stream.off ?? stream.removeListener;
      if (detach !== undefined) detach.call(stream, 'data', onData);
      if (err !== null) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => {
      finish(new Error(`waitForLogLine: timeout after ${timeoutMs}ms waiting for ${pattern}`));
    }, timeoutMs);

    stream.on('data', onData);
  });
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
  for (const sub of ['cp-daemon', 'validator-daemon', 'relay']) {
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

/** 5 registries that need an explicit `<module>::create(adminCap)` PTB call. */
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
] as const;

type RegistryKey =
  | 'userRegistryId'
  | 'roomManagerId'
  | 'relayRegistryId'
  | 'cpRegistryId'
  | 'validatorRegistryId';

/**
 * Sequentially create the 5 admin-gated shared registries. SDK PTBs +
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
 * Generate the 3 daemon Ed25519 keypairs via the SDK (no sui keytool round-trip).
 * Each emits the bech32 `suiprivkey…` form that the daemon .env files expect.
 */
export function generateDaemonKeypairs(): DaemonIdentity {
  const names: (keyof DaemonKeys)[] = [
    'CP_KEYPAIR',
    'SUI_PRIVATE_KEY',
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
 * AdminCap-gated registries, generate + fund the 3 daemon keypairs, mint
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

  console.log('[bench] generating 3 daemon keypairs...');
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
    livenessVoteBoxId: publishOut.livenessVoteBoxId,
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

// ── Daemon spawn + ready-wait (S25.C.2) ──────────────────────────────

/**
 * Per-daemon spec: where to spawn it, how to detect readiness, what env to
 * pass on top of the shared `.env`. Ports are populated only for daemons that
 * expose a listening socket (relay 4000). Daemons without a port (cp-daemon,
 * validator-daemon) rely on log-tail alone.
 *
 * Spawn order discipline (see docs/00-meta/gotchas.md G-014): cp-daemon FIRST
 * so its role-voter loop is active before relay/validator register in voting
 * mode. The other two can come up in parallel after CP is ready because the
 * single-CP quorum (compute_threshold clamps `required >= 1`) satisfies each
 * vote with one self-cast TX.
 */
export interface DaemonSpec {
  name: 'cp-daemon' | 'relay' | 'validator-daemon';
  /** Path under `dvconf-daemons/apps/` — usually identical to `name`. */
  appDir: string;
  /** Open TCP port the daemon binds, or undefined for log-only ready check. */
  port?: number;
  /** First log line that signals the daemon is fully initialised. */
  readyLogPattern: RegExp;
  /** Per-daemon env overrides on top of the shared `dvconf-daemons/.env`. */
  envOverrides?: Record<string, string>;
}

const DAEMON_SPECS: DaemonSpec[] = [
  {
    name: 'cp-daemon',
    appDir: 'cp-daemon',
    readyLogPattern: /CP daemon started/,
  },
  {
    name: 'relay',
    appDir: 'relay',
    port: 4000,
    readyLogPattern: /Relay daemon started/,
  },
  {
    name: 'validator-daemon',
    appDir: 'validator-daemon',
    readyLogPattern: /Validator daemon started/,
  },
];

export interface DaemonHandle {
  spec: DaemonSpec;
  proc: ChildProcess;
  logPath: string;
  /** Last `tailBytes` of merged stdout+stderr — surfaced on failure. */
  tail: string[];
  killed: boolean;
}

const MAX_TAIL_LINES = 80;

/**
 * Launch a daemon as a long-lived child process. stdout + stderr stream to
 * `<logDir>/daemon-<name>-<ts>.log` (file mirror for post-mortem) AND are
 * re-emitted on the ChildProcess so `waitForDaemonReady` can pattern-match
 * lines as they arrive. No shell — sidesteps Windows PS5.1's
 * NativeCommandError class (the bug that gated S23.3).
 */
export function spawnDaemon(
  spec: DaemonSpec,
  daemonsDir: string,
  logDir: string,
  envOverrides: NodeJS.ProcessEnv = {},
): DaemonHandle {
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(logDir, `daemon-${spec.name}-${ts}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const entry = join('apps', spec.appDir, 'src', 'index.ts');
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx/esm', entry],
    {
      cwd: daemonsDir,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...spec.envOverrides, ...envOverrides },
    },
  );

  const handle: DaemonHandle = {
    spec,
    proc,
    logPath,
    tail: [],
    killed: false,
  };

  const onChunk = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    logStream.write(text);
    // Maintain a small in-memory tail for failure reporting.
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      handle.tail.push(line);
      if (handle.tail.length > MAX_TAIL_LINES) handle.tail.shift();
    }
  };
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);
  proc.on('exit', () => {
    logStream.end();
  });

  console.log(`[bench] spawned ${spec.name} (pid=${proc.pid}) → ${logPath}`);
  return handle;
}

/**
 * Block until either (a) the daemon's port accepts a TCP connection (when
 * `spec.port` is set) AND (b) its `readyLogPattern` matches a log line.
 * Both must succeed within `timeoutMs`. On timeout, throws an error containing
 * the daemon name, the missing signal, and the last 20 log lines — without
 * this, voting-mode hangs are silent because the daemon stays alive but
 * never reaches the registered state.
 *
 * cp-daemon + validator-daemon have no port, so log-tail alone suffices.
 */
export async function waitForDaemonReady(
  handle: DaemonHandle,
  timeoutMs = 180_000,
): Promise<void> {
  const { spec, proc } = handle;
  const tasks: Array<Promise<unknown>> = [];

  if (spec.port !== undefined) {
    tasks.push(waitForPort('127.0.0.1', spec.port, timeoutMs, 1000));
  }

  if (proc.stdout !== null) {
    tasks.push(
      waitForLogLine(
        proc.stdout as unknown as LogStream,
        spec.readyLogPattern,
        timeoutMs,
      ),
    );
  }

  // Detect early exit — if the daemon crashes during ready-wait, surface the
  // crash instead of waiting out the full timeout.
  const exitPromise = new Promise<never>((_, reject) => {
    proc.once('exit', (code, signal) => {
      reject(
        new Error(
          `daemon ${spec.name} exited unexpectedly (code=${code}, signal=${signal ?? 'none'}) before ready`,
        ),
      );
    });
  });

  try {
    await Promise.race([Promise.all(tasks), exitPromise]);
    console.log(`[bench] ${spec.name} ready (port=${spec.port ?? '—'})`);
  } catch (err) {
    const tail = handle.tail.slice(-20).join('\n');
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `waitForDaemonReady(${spec.name}): ${msg}\n--- last 20 log lines (full: ${handle.logPath}) ---\n${tail}`,
    );
  }
}

/**
 * Spawn all 3 daemons in voting-safe order: cp-daemon first (await ready),
 * then relay + validator in parallel. Returns all 3 handles for later
 * teardown. On any failure, tears down whatever was already spawned and
 * re-throws — leaving orphan daemon processes around would block subsequent
 * runs on the same ports.
 */
export async function spawnAllDaemons(
  daemonsDir: string,
  logDir: string,
): Promise<DaemonHandle[]> {
  const handles: DaemonHandle[] = [];
  try {
    const cp = DAEMON_SPECS.find((s) => s.name === 'cp-daemon')!;
    const cpHandle = spawnDaemon(cp, daemonsDir, logDir);
    handles.push(cpHandle);
    await waitForDaemonReady(cpHandle);

    const others = DAEMON_SPECS.filter((s) => s.name !== 'cp-daemon');
    const otherHandles = others.map((s) =>
      spawnDaemon(s, daemonsDir, logDir),
    );
    handles.push(...otherHandles);
    await Promise.all(otherHandles.map((h) => waitForDaemonReady(h)));

    return handles;
  } catch (err) {
    await teardownDaemons(handles);
    throw err;
  }
}

/**
 * SIGTERM all daemons in reverse-spawn order, wait up to 5 s each for graceful
 * exit, then SIGKILL stragglers. Idempotent — calling on already-dead handles
 * is a no-op.
 */
export async function teardownDaemons(
  handles: readonly DaemonHandle[],
): Promise<void> {
  for (const h of [...handles].reverse()) {
    if (h.killed || h.proc.exitCode !== null) continue;
    h.killed = true;
    console.log(`[bench] SIGTERM ${h.spec.name} (pid=${h.proc.pid})`);
    h.proc.kill('SIGTERM');
    const exited = await new Promise<boolean>((res) => {
      const timer = setTimeout(() => res(false), 5_000);
      h.proc.once('exit', () => {
        clearTimeout(timer);
        res(true);
      });
    });
    if (!exited) {
      console.log(`[bench] SIGKILL ${h.spec.name} (graceful exit timed out)`);
      h.proc.kill('SIGKILL');
    }
  }
}

// ── Room creation (S25.C.3) ───────────────────────────────────────────

/** user_registry::E_ALREADY_REGISTERED — idempotency check on second bring-up. */
const E_USER_ALREADY_REGISTERED = 540;

/**
 * Best-effort `user_registry::register_user`. Swallows the E_ALREADY_REGISTERED
 * abort (code 540) — bench may re-run against an existing localnet (--reuse-running)
 * where the deployer is already in `UserRegistry`. Any other failure rethrows.
 */
export async function ensureUserRegistered(
  sui: SuiClient,
  signer: Ed25519Keypair,
  ids: BenchIds,
  displayName = 'bench-deployer',
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ids.packageId}::user_registry::register_user`,
    arguments: [
      tx.object(ids.networkRegistryId),
      tx.object(ids.userRegistryId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(displayName))),
    ],
  });
  try {
    const result = await sui.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true },
    });
    // CI-14: without waitForTransaction, the next call's dry-run can
    // execute against pre-register state and abort with E_USER_NOT_REGISTERED.
    await sui.waitForTransaction({ digest: result.digest });
    console.log('[bench] registered deployer in UserRegistry');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(`abort_code: ${E_USER_ALREADY_REGISTERED}`) || msg.includes(`, ${E_USER_ALREADY_REGISTERED})`)) {
      console.log('[bench] deployer already registered in UserRegistry (idempotent)');
      return;
    }
    throw err;
  }
}

/**
 * Build + execute the `room_manager::create_room` PTB and pluck `room_id` out
 * of the `RoomCreated` event. Default is SFU mode (relay_mode=0) with 4
 * expected participants — matches the bench scenario in `mediasoup-client-harness.ts`.
 *
 * The Move side stores the Room in `RoomManager`'s internal table rather than
 * minting a shared object, so we can't use `parseSharedObjectFromCreate`. The
 * event carries the room ID — see `parseRoomIdFromEvents`.
 */
export async function createBenchRoom(
  sui: SuiClient,
  signer: Ed25519Keypair,
  ids: BenchIds,
  opts: { relayMode?: 'sfu' | 'mcu'; expectedParticipants?: number } = {},
): Promise<string> {
  const mode = opts.relayMode === 'mcu' ? 1 : 0;
  const expected = opts.expectedParticipants ?? 4;

  const tx = new Transaction();
  tx.moveCall({
    target: `${ids.packageId}::room_manager::create_room`,
    arguments: [
      tx.object(ids.networkRegistryId),
      tx.object(ids.roomManagerId),
      tx.object(ids.userRegistryId),
      tx.pure.u8(mode),
      tx.pure.u64(expected),
      tx.pure.u8(0), // room_class_hint = small (NEW REQ-RMS-016)
    ],
  });

  const result = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEvents: true, showEffects: true },
  });
  await sui.waitForTransaction({ digest: result.digest });

  // devnet's public fullnode returns empty `events` on the JSON-RPC execute
  // response (event-shaped reads are deprecated there); harmless no-op on
  // localnet (bench's usual target), where JSON-RPC events already work.
  let events = result.events ?? [];
  if (events.length === 0) {
    const graphqlClient: SuiGraphQLClient = createGraphQLClient('localnet');
    events = await fetchEventsForDigest(graphqlClient, result.digest);
  }

  const roomId = parseRoomIdFromEvents(
    { events } as SuiTxResult,
    '::room_manager::RoomCreated',
  );
  console.log(`[bench] created bench room id=${roomId} mode=${opts.relayMode ?? 'sfu'} expected=${expected}`);
  return roomId;
}

// ── Scenario runner (S25.C.5) ─────────────────────────────────────────

export interface BenchScenarioOpts {
  /** dvconf-daemons working directory (cwd for harness spawn). */
  daemonsDir: string;
  /** On-chain room ID from createBenchRoom. */
  roomId: string;
  /** Peer count per run — passed to harness as --peers. */
  peers: number;
  /** How many times to run the scenario. */
  runs: number;
  /** Per-run capture duration in seconds (passed as --duration). */
  durationSec: number;
  /** Quiet period between runs so the relay can close stale transports. */
  cooldownMs?: number;
  /** Extra env vars (e.g. BENCH_LATENCY=1, BENCH_TRACE_ID). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Sequentially execute `runs` copies of the N-peer harness against the bench
 * room. Each run is a fresh `tsx mediasoup-client-harness.ts` child process
 * with its own JSONL trace file (LatencyWriter generates a UUID per process).
 *
 * Failure of one run is logged but does not abort the loop — bench wants a
 * sample set, not a fail-fast pipeline. Per-run hard timeout =
 * `(durationSec + 30) * 1000` covers join + close overhead.
 */
export async function runBenchScenario(opts: BenchScenarioOpts): Promise<void> {
  const cooldown = opts.cooldownMs ?? 5_000;
  const perRunBudgetMs = (opts.durationSec + 30) * 1000;
  const harnessEntry = join('scripts', 'bench', 'mediasoup-client-harness.ts');

  for (let i = 1; i <= opts.runs; i++) {
    console.log(
      `[bench] scenario run ${i}/${opts.runs} — peers=${opts.peers} duration=${opts.durationSec}s`,
    );
    const startedAt = Date.now();
    const result = await runCli(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        harnessEntry,
        '--room-id',
        opts.roomId,
        '--peers',
        String(opts.peers),
        '--duration',
        String(opts.durationSec),
      ],
      {
        cwd: opts.daemonsDir,
        timeoutMs: perRunBudgetMs,
        env: { ...process.env, ...opts.env, BENCH_LATENCY: '1' },
      },
    );
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Treat as success if the harness logged `[harness] done` (data was
    // flushed) regardless of exit code — the harness deliberately SIGKILLs
    // itself after flushing JSONL to skip the @roamhq/wrtc native cleanup
    // crash on Windows (CI-19 mitigation, see harness main()).
    const harnessDone = result.stdout.includes('[harness] done');
    if (result.code === 0 || harnessDone) {
      const exitNote = result.code === 0 ? '' : ` (exit=${result.code}, data flushed)`;
      console.log(`[bench] scenario run ${i} done in ${elapsed}s${exitNote}`);
    } else {
      console.error(
        `[bench] scenario run ${i} FAILED (code=${result.code}, elapsed=${elapsed}s)`,
      );
      console.error('[bench] ── full stderr ──');
      console.error(result.stderr);
      console.error('[bench] ── full stdout (tail 30) ──');
      console.error(result.stdout.split('\n').slice(-30).join('\n'));
    }

    if (i < opts.runs) {
      console.log(`[bench] cooldown ${cooldown}ms before next run`);
      await new Promise((r) => setTimeout(r, cooldown));
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const reuseRunning = process.argv.includes('--reuse-running');
  const bringupOnly = process.argv.includes('--bringup-only');
  const daemonsOnly = process.argv.includes('--daemons-only');
  const peers = pickIntArg('--peers', 4);
  const runs = pickIntArg('--runs', 5);
  const durationSec = pickIntArg('--duration', 60);

  const result = await bringUpBench({ reuseRunning });
  console.log('[bench] bring-up complete');
  if (bringupOnly) {
    console.log('[bench] --bringup-only set; leaving sui node running');
    return;
  }

  const daemonHandles = await spawnAllDaemons(DAEMONS_DIR, LOGS_DIR);
  console.log(`[bench] all ${daemonHandles.length} daemons ready`);

  if (daemonsOnly) {
    console.log(
      '[bench] --daemons-only set; leaving daemons + sui running. SIGINT to clean up.',
    );
    return;
  }

  try {
    await ensureUserRegistered(result.client, result.deployer, result.ids);
    const roomId = await createBenchRoom(
      result.client,
      result.deployer,
      result.ids,
    );
    await runBenchScenario({
      daemonsDir: DAEMONS_DIR,
      roomId,
      peers,
      runs,
      durationSec,
    });
  } finally {
    await teardownDaemons(daemonHandles);
    if (!reuseRunning) {
      await result.sui.stop();
    }
  }
}

/** Read an integer CLI flag like `--peers 4` from argv, or fall back. */
function pickIntArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  const n = parseInt(process.argv[idx + 1]!, 10);
  return Number.isFinite(n) ? n : fallback;
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
