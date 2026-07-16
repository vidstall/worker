/**
 * P3 evaluation-only localnet chain-latency harness.
 *
 * Measures two distinct client-observed quantities with the production EventPoller
 * left byte-for-byte unchanged:
 *   - L_chain_create: create_room submission -> first exact RoomCreated observation
 *   - L_chain_settle: distribute_rewards submission -> first exact
 *     RewardsDistributed observation
 *
 * The harness deliberately owns timestamps and exact matching. It reuses the proven
 * localnet/roster/proof builders, but does not change product semantics or production
 * symbols. Official mode is exactly 30 sequential rooms on one persistent localnet;
 * --samples 1 is a non-publishable spike.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { bcs } from '@mysten/sui/bcs';
import type {
  SuiClient,
  SuiEvent,
  SuiTransactionBlockResponse,
} from '@mysten/sui/client';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { LocalnetHandle } from '../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts';
import {
  dualKeySign,
  serializeProofBcs,
} from '../../apps/validator-daemon/src/session-proof.ts';
import {
  createLogger,
  EventPoller,
  type Logger,
  type NetworkConfig,
} from '../../packages/shared/src/index.ts';
import {
  bootstrapCp,
  voteAndApplyMiner,
  type CpHandle,
  type SeededKey,
} from '../demo/seed-bootstrap.ts';
import {
  assertLocalnetPortsFree,
  captureActiveSuiEnvironment,
  readFrameworkRevision,
  readGitState,
  readSuiCliVersion,
  resolveGitRef,
  restoreSuiEnvironment,
} from './cost-run-safety.ts';
import {
  CHAIN_LATENCY_SCHEMA_VERSION,
  parseChainLatencyEvidence,
  validateChainLatencyBundle,
} from './chain-latency-evidence.ts';

const MODULE = 'measure-chain-latency';
const SCHEMA_VERSION = CHAIN_LATENCY_SCHEMA_VERSION;
const POLL_INTERVAL_MS = 5_000;
const EVENT_TIMEOUT_MS = 30_000;
const PINNED_CONTRACT_REF = '17e1fce0efd7b7668a5cd7d6aa34ebae762670bd';
const PINNED_FRAMEWORK_REV = '94ad8ccd0ed6c089a9fe072ff80c918b5ab44943';
const PINNED_SUI_CLI = '1.66.2';
const ESCROW_AMOUNT_MIST = 1_000_000n;
const GAS_BUDGET_MIST = 100_000_000;
const EXPECTED_RELAYS = 2;
const EXPECTED_VALIDATORS = 4;
const PROOFS_PER_ROOM = EXPECTED_RELAYS * EXPECTED_VALIDATORS;
const FAUCET_URL = getFaucetHost('localnet');

const __filename = fileURLToPath(import.meta.url);
const HERE = resolve(__filename, '..');
const DAEMONS_ROOT = resolve(HERE, '..', '..');
const WORKSPACE_ROOT = resolve(DAEMONS_ROOT, '..');
const CONTRACTS_SOURCE_ROOT = resolve(WORKSPACE_ROOT, 'dvconf-contracts');
const CLIENT_ROOT = resolve(WORKSPACE_ROOT, 'dvconf-client');

type Metric = 'L_chain_create' | 'L_chain_settle';
type RunMode = 'spike' | 'official';

export interface ChainLatencyOptions {
  contractsDir: string;
  contractRef: string;
  runId: string;
  traceId: string;
  samples: 1 | 30;
  mode: RunMode;
  outputRoot: string;
  runDir: string;
}

interface MonotonicWallTime {
  wallIso: string;
  wallEpochMs: number;
  monoMs: number;
}

interface ObservedTargetEvent extends MonotonicWallTime {
  txDigest: string;
  eventType: string;
  eventSeq: string;
  roomId: string;
  timestampMs: string | null;
}

interface PendingObservation {
  eventType: string;
  roomId: string;
  resolve: (event: ObservedTargetEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyValidator {
  mainKp: Ed25519Keypair;
  sessionKp: Ed25519Keypair;
  minerId: string;
}

interface Roster {
  cp: CpHandle;
  relayIds: [string, string];
  validators: [ReadyValidator, ReadyValidator, ReadyValidator, ReadyValidator];
  signaling: SeededKey;
  userKp: Ed25519Keypair;
}

interface SampleRecord {
  schema_version: typeof SCHEMA_VERSION;
  record_type: 'sample';
  run_id: string;
  trace_id: string;
  metric: Metric;
  sample_index: number;
  tx_digest: string;
  event_type: string;
  event_seq: string;
  room_id: string;
  escrow_id: string | null;
  submit_wall_iso: string;
  submit_mono_ms: number;
  rpc_return_wall_iso: string;
  rpc_return_mono_ms: number;
  finality_return_wall_iso: string;
  finality_return_mono_ms: number;
  observed_wall_iso: string;
  observed_mono_ms: number;
  value_ms: number;
  rpc_return_ms: number;
  return_to_event_ms: number;
  finality_return_ms: number;
  success: true;
  exact_match: true;
}

interface TimedExecution {
  result: SuiTransactionBlockResponse;
  digest: string;
  submit: MonotonicWallTime;
  rpcReturn: MonotonicWallTime;
}

interface FinalityReturn {
  result: SuiTransactionBlockResponse;
  time: MonotonicWallTime;
}

interface SnapshotVerification {
  commit: string;
  trackedFileCount: number;
  treeSha256: string;
}

class ExclusiveJsonlWriter {
  readonly path: string;
  private readonly fd: number;
  private closed = false;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, 'wx');
  }

  write(record: unknown): void {
    if (this.closed) throw new Error(`writer already closed: ${this.path}`);
    writeSync(this.fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.closed) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.closed = true;
  }
}

class RunLog {
  private readonly fd: number;
  private closed = false;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'wx');
  }

  write(message: string, context: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const line = JSON.stringify({ at: new Date().toISOString(), message, ...context });
    writeSync(this.fd, `${line}\n`, undefined, 'utf8');
    fsyncSync(this.fd);
    process.stdout.write(`${MODULE}: ${line}\n`);
  }

  close(): void {
    if (this.closed) return;
    fsyncSync(this.fd);
    closeSync(this.fd);
    this.closed = true;
  }
}

/**
 * Exact, first-observation matcher outside EventPoller.
 *
 * Target events are cached by digest so an event that reaches the handler before
 * signAndExecuteTransaction returns is not lost. A duplicate, malformed target,
 * digest/type/room mismatch, or timeout makes the run fail closed.
 */
export class ExactEventMatcher {
  private readonly cachedByDigest = new Map<string, ObservedTargetEvent>();
  private readonly pendingByDigest = new Map<string, PendingObservation>();
  private fatalError: Error | null = null;
  private ignoredEventCount = 0;
  private targetEventCount = 0;

  constructor(
    private readonly targetTypes: ReadonlySet<string>,
    private readonly eventWriter: ExclusiveJsonlWriter,
    private readonly runId: string,
    private readonly traceId: string,
  ) {}

  async observe(event: SuiEvent): Promise<void> {
    const observed = nowPair();
    if (!this.targetTypes.has(event.type)) {
      this.ignoredEventCount += 1;
      return;
    }

    try {
      const txDigest = event.id?.txDigest;
      const eventSeq = event.id?.eventSeq;
      const rawRoomId = (event.parsedJson as { room_id?: unknown } | null)?.room_id;
      if (typeof txDigest !== 'string' || txDigest.length === 0) {
        throw new Error(`target event missing transaction digest: ${event.type}`);
      }
      if (typeof eventSeq !== 'string') {
        throw new Error(`target event missing event sequence: ${event.type} digest=${txDigest}`);
      }
      if (typeof rawRoomId !== 'string') {
        throw new Error(`target event missing room_id: ${event.type} digest=${txDigest}`);
      }

      const target: ObservedTargetEvent = {
        ...observed,
        txDigest,
        eventType: event.type,
        eventSeq,
        roomId: normalizeSuiAddress(rawRoomId),
        timestampMs: event.timestampMs ?? null,
      };
      this.targetEventCount += 1;
      this.eventWriter.write({
        schema_version: SCHEMA_VERSION,
        record_type: 'observed_event',
        run_id: this.runId,
        trace_id: this.traceId,
        tx_digest: target.txDigest,
        event_type: target.eventType,
        event_seq: target.eventSeq,
        room_id: target.roomId,
        chain_timestamp_ms: target.timestampMs,
        observed_wall_iso: target.wallIso,
        observed_wall_epoch_ms: target.wallEpochMs,
        observed_mono_ms: target.monoMs,
      });

      if (this.cachedByDigest.has(txDigest)) {
        throw new Error(`duplicate target event for digest ${txDigest}`);
      }

      const pending = this.pendingByDigest.get(txDigest);
      if (pending === undefined) {
        this.cachedByDigest.set(txDigest, target);
        return;
      }

      this.assertExpected(target, pending.eventType, pending.roomId);
      clearTimeout(pending.timer);
      this.pendingByDigest.delete(txDigest);
      pending.resolve(target);
    } catch (error) {
      const failure = asError(error);
      this.fail(failure);
      throw failure;
    }
  }

  waitFor(
    txDigest: string,
    eventType: string,
    roomId: string,
    timeoutMs = EVENT_TIMEOUT_MS,
  ): Promise<ObservedTargetEvent> {
    this.throwIfFatal();
    const normalizedRoomId = normalizeSuiAddress(roomId);
    if (this.pendingByDigest.has(txDigest)) {
      throw new Error(`duplicate observation waiter for digest ${txDigest}`);
    }

    const cached = this.cachedByDigest.get(txDigest);
    if (cached !== undefined) {
      this.assertExpected(cached, eventType, normalizedRoomId);
      this.cachedByDigest.delete(txDigest);
      return Promise.resolve(cached);
    }

    return new Promise<ObservedTargetEvent>((resolveObservation, rejectObservation) => {
      const timer = setTimeout(() => {
        this.pendingByDigest.delete(txDigest);
        const failure = new Error(
          `timed out after ${timeoutMs}ms waiting for ${eventType} digest=${txDigest} room=${normalizedRoomId}`,
        );
        this.fail(failure);
        rejectObservation(failure);
      }, timeoutMs);
      this.pendingByDigest.set(txDigest, {
        eventType,
        roomId: normalizedRoomId,
        resolve: resolveObservation,
        reject: rejectObservation,
        timer,
      });
    });
  }

  stats(): { targetEventCount: number; ignoredEventCount: number } {
    return {
      targetEventCount: this.targetEventCount,
      ignoredEventCount: this.ignoredEventCount,
    };
  }

  assertDrained(): void {
    this.throwIfFatal();
    if (this.pendingByDigest.size !== 0) {
      throw new Error(`matcher still has ${this.pendingByDigest.size} pending observation(s)`);
    }
    if (this.cachedByDigest.size !== 0) {
      throw new Error(
        `matcher has ${this.cachedByDigest.size} unconsumed target event(s): ${[...this.cachedByDigest.keys()].join(',')}`,
      );
    }
  }

  private assertExpected(
    event: ObservedTargetEvent,
    expectedType: string,
    expectedRoomId: string,
  ): void {
    if (event.eventType !== expectedType) {
      throw new Error(
        `event type mismatch for ${event.txDigest}: expected ${expectedType}, got ${event.eventType}`,
      );
    }
    if (event.roomId !== expectedRoomId) {
      throw new Error(
        `event room mismatch for ${event.txDigest}: expected ${expectedRoomId}, got ${event.roomId}`,
      );
    }
  }

  private fail(error: Error): void {
    if (this.fatalError === null) this.fatalError = error;
    for (const [digest, pending] of this.pendingByDigest) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error(`event matcher failed while waiting for ${digest}: ${this.fatalError.message}`),
      );
    }
    this.pendingByDigest.clear();
  }

  private throwIfFatal(): void {
    if (this.fatalError !== null) throw this.fatalError;
  }
}

function nowPair(): MonotonicWallTime {
  const wallEpochMs = Date.now();
  return {
    wallIso: new Date(wallEpochMs).toISOString(),
    wallEpochMs,
    monoMs: performance.now(),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function flagValue(argv: string[], flag: string): string | undefined {
  const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length > 1) throw new Error(`${flag} may be supplied only once`);
  if (indexes.length === 0) return undefined;
  const value = argv[indexes[0]! + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseChainLatencyOptions(argv: string[]): ChainLatencyOptions {
  const knownFlags = new Set([
    '--contracts-dir',
    '--contract-ref',
    '--run-id',
    '--trace-id',
    '--samples',
    '--output-root',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith('--')) throw new Error(`unexpected positional argument: ${value}`);
    if (!knownFlags.has(value)) throw new Error(`unknown option: ${value}`);
    index += 1;
  }

  const contractsArg = flagValue(argv, '--contracts-dir');
  if (contractsArg === undefined) throw new Error('--contracts-dir is required');
  const contractsDir = resolve(contractsArg);
  if (isWithin(CONTRACTS_SOURCE_ROOT, contractsDir)) {
    throw new Error(`refusing canonical contracts working tree: ${contractsDir}`);
  }
  if (!existsSync(resolve(contractsDir, 'Move.toml')) || !existsSync(resolve(contractsDir, 'Move.lock'))) {
    throw new Error(`contracts snapshot must contain Move.toml and Move.lock: ${contractsDir}`);
  }

  const contractRef = flagValue(argv, '--contract-ref') ?? PINNED_CONTRACT_REF;
  if (!/^[0-9a-fA-F]{7,40}$/.test(contractRef)) {
    throw new Error('--contract-ref must be a 7-40 digit hexadecimal Git ref');
  }

  const runId = flagValue(argv, '--run-id');
  if (runId === undefined) throw new Error('--run-id is required');
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error('--run-id may contain only letters, digits, dot, underscore, and dash');
  }

  const traceId = flagValue(argv, '--trace-id') ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) {
    throw new Error('--trace-id must be a UUIDv4');
  }

  const samplesRaw = flagValue(argv, '--samples');
  if (samplesRaw === undefined) throw new Error('--samples is required and must be 1 or 30');
  const samplesNumber = Number(samplesRaw);
  if (samplesNumber !== 1 && samplesNumber !== 30) {
    throw new Error('--samples must be exactly 1 (spike) or 30 (official)');
  }
  const samples = samplesNumber as 1 | 30;
  const mode: RunMode = samples === 1 ? 'spike' : 'official';

  const outputArg = flagValue(argv, '--output-root');
  if (outputArg === undefined) throw new Error('--output-root is required');
  const outputRoot = resolve(outputArg);
  const runDir = resolve(outputRoot, runId);
  if (!isWithin(outputRoot, runDir) || runDir === outputRoot) {
    throw new Error(`derived run directory escapes output root: ${runDir}`);
  }
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);

  return { contractsDir, contractRef, runId, traceId, samples, mode, outputRoot, runDir };
}

function runChecked(
  command: string,
  args: string[],
  label: string,
  options: { cwd?: string; input?: string } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label}: exited ${result.status ?? 'unknown'}: ${(result.stderr ?? '').trim().slice(0, 1200)}`);
  }
  return (result.stdout ?? '').trim();
}

function gitArgs(repo: string, args: string[]): string[] {
  return ['-c', `safe.directory=${repo.replace(/\\/g, '/')}`, '-C', repo, ...args];
}

function gitStatus(repo: string): string {
  return runChecked(
    'git',
    gitArgs(repo, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']),
    `git status ${repo}`,
  );
}

function assertOfficialHarnessScopeClean(): void {
  const paths = [
    'packages/shared/src/chain/events.ts',
    'apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts',
    'apps/validator-daemon/src/session-proof.ts',
    'scripts/demo/seed-bootstrap.ts',
    'scripts/eval/cost-run-safety.ts',
    'scripts/eval/measure-chain-latency.ts',
    'scripts/eval/chain-latency-evidence.ts',
    'scripts/eval/replay-chain-latency.ts',
    'scripts/eval/__tests__/chain-latency-evidence.test.ts',
    'scripts/eval/__tests__/measure-chain-latency.test.ts',
  ];
  const status = runChecked(
    'git',
    gitArgs(DAEMONS_ROOT, ['status', '--porcelain=v1', '--untracked-files=normal', '--', ...paths]),
    'git status harness scope',
  );
  if (status.length !== 0) {
    throw new Error(`official run requires committed/clean harness scope:\n${status}`);
  }
}

function listFiles(root: string, current = ''): string[] {
  const directory = resolve(root, current);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath));
    } else {
      files.push(relativePath.replace(/\\/g, '/'));
    }
  }
  return files;
}

function verifyContractsSnapshot(contractsDir: string, contractRef: string): SnapshotVerification {
  const commit = resolveGitRef(CONTRACTS_SOURCE_ROOT, contractRef);
  const tree = runChecked(
    'git',
    gitArgs(CONTRACTS_SOURCE_ROOT, ['ls-tree', '-r', commit]),
    `git ls-tree ${commit}`,
  );
  const entries = tree.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
    if (match === null) throw new Error(`unexpected git ls-tree row: ${line}`);
    return { hash: match[1]!, path: match[2]!.replace(/\\/g, '/') };
  });
  const expectedPaths = entries.map((entry) => entry.path).sort();
  const actualPaths = listFiles(contractsDir).sort();
  if (expectedPaths.length !== actualPaths.length) {
    throw new Error(
      `contracts snapshot file-count mismatch: expected ${expectedPaths.length}, got ${actualPaths.length}`,
    );
  }
  for (let index = 0; index < expectedPaths.length; index += 1) {
    if (expectedPaths[index] !== actualPaths[index]) {
      throw new Error(
        `contracts snapshot inventory mismatch at ${index}: expected ${expectedPaths[index]}, got ${actualPaths[index]}`,
      );
    }
  }
  for (const path of actualPaths) {
    if (!lstatSync(resolve(contractsDir, path)).isFile()) {
      throw new Error(`contracts snapshot contains unsupported non-file entry: ${path}`);
    }
  }
  const hashOutput = runChecked(
    'git',
    ['hash-object', '--stdin-paths'],
    'git hash-object contracts snapshot',
    { cwd: contractsDir, input: `${entries.map((entry) => entry.path).join('\n')}\n` },
  );
  const hashes = hashOutput.split(/\r?\n/).filter(Boolean);
  if (hashes.length !== entries.length) {
    throw new Error(`contracts snapshot hash count mismatch: expected ${entries.length}, got ${hashes.length}`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (hashes[index] !== entries[index]!.hash) {
      throw new Error(`contracts snapshot blob mismatch: ${entries[index]!.path}`);
    }
  }
  return {
    commit,
    trackedFileCount: entries.length,
    treeSha256: createHash('sha256')
      .update(entries.map((entry) => `${entry.hash}  ${entry.path}`).join('\n'), 'utf8')
      .digest('hex'),
  };
}

function activeSuiEnvironment(): string | null {
  const result = spawnSync('sui', ['client', 'active-env'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length === 0 ? null : value;
}

function activeSuiAddress(): string | null {
  const result = spawnSync('sui', ['client', 'active-address'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length === 0 ? null : value;
}

function switchToCheckedLocalEnvironment(): { alias: string; rpc: string } {
  const envsRaw = runChecked('sui', ['client', 'envs', '--json'], 'sui client envs --json');
  const parsed = JSON.parse(envsRaw) as unknown;
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
    throw new Error('sui client envs --json returned an unexpected shape');
  }
  const environments = parsed[0] as Array<{ alias?: unknown; rpc?: unknown }>;
  const local = environments.find((entry) => entry.alias === 'local');
  if (local === undefined || local.rpc !== 'http://127.0.0.1:9000') {
    throw new Error(
      `required local Sui environment is missing or misconfigured: ${JSON.stringify(local ?? null)}`,
    );
  }
  runChecked('sui', ['client', 'switch', '--env', 'local'], 'sui client switch --env local');
  const active = activeSuiEnvironment();
  if (active !== 'local') {
    throw new Error(`Sui environment switch verification failed: expected local, got ${active ?? '(none)'}`);
  }
  return { alias: 'local', rpc: local.rpc };
}

function assertLocalCliEnvironment(handle: LocalnetHandle): string {
  const active = activeSuiEnvironment();
  if (active === null || !active.startsWith('phase40-')) {
    throw new Error(`fixture did not switch to its checked local alias: ${active ?? '(none)'}`);
  }
  if (handle.config.rpcUrl !== 'http://127.0.0.1:9000') {
    throw new Error(`fixture RPC URL is not pinned localnet: ${handle.config.rpcUrl}`);
  }
  return active;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeExclusive(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' });
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForPortsClosed(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertLocalnetPortsFree();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}

async function fundAndWait(client: SuiClient, address: string, timeoutMs = 90_000): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const coins = await client.getCoins({ owner: address });
    if (coins.data.length > 0) return;
    if (Date.now() >= deadline) throw new Error(`faucet gas not indexed for ${address}`);
    await sleep(1_000);
  }
}

function assertTxSuccess(result: SuiTransactionBlockResponse, label: string): void {
  const status = result.effects?.status;
  if (status?.status !== 'success') {
    throw new Error(
      `${label} failed on-chain: status=${status?.status ?? 'missing'} error=${status?.error ?? '(none)'}`,
    );
  }
}

async function executeUnmeasured(
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
  return result;
}

async function executeTimed(
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
  return { result, digest: result.digest, submit, rpcReturn };
}

async function awaitFinality(
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

function exactEvent(
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

function eventRoomId(event: SuiEvent, label: string): string {
  const value = (event.parsedJson as { room_id?: unknown } | null)?.room_id;
  if (typeof value !== 'string') throw new Error(`${label}: event room_id missing or malformed`);
  return normalizeSuiAddress(value);
}

function eventEscrowId(event: SuiEvent, label: string): string {
  const value = (event.parsedJson as { escrow_id?: unknown } | null)?.escrow_id;
  if (typeof value !== 'string') throw new Error(`${label}: event escrow_id missing or malformed`);
  return normalizeSuiAddress(value);
}

async function buildRoster(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<Roster> {
  const cp = await bootstrapCp(client, config, logger);
  const relay = await voteAndApplyMiner(client, cp, 'relay', config, logger);
  const relayStandby = await voteAndApplyMiner(client, cp, 'relay-standby', config, logger);
  const signaling = await voteAndApplyMiner(client, cp, 'signaling', config, logger);

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
    signaling,
    userKp,
  };
}

async function createEscrow(
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

async function assertEscrowState(
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

async function submitPairing(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  roomId: string,
): Promise<void> {
  await executeUnmeasured(client, roster.cp.kp, 'submit_pairing_proposal', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::room_manager::submit_pairing_proposal`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roomManagerId),
        tx.object(config.cpRegistryId),
        tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(config.signalingRegistryId),
        tx.object(roster.cp.cpCapId),
        tx.pure.id(roomId),
        tx.pure.vector('id', roster.relayIds),
        tx.pure.vector('id', roster.validators.map((validator) => validator.minerId)),
        tx.pure.id(roster.signaling.minerId),
        tx.pure.u64(1_000),
      ],
    });
  });
}

async function submitProof(
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

async function submitAllProofs(
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

async function closeRoom(
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

function makeSampleRecord(
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

async function measureCreate(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  matcher: ExactEventMatcher,
  options: ChainLatencyOptions,
  sampleIndex: number,
): Promise<{ roomId: string; record: SampleRecord }> {
  const eventType = `${config.packageId}::room_manager::RoomCreated`;
  const execution = await executeTimed(client, roster.userKp, 'create_room', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::room_manager::create_room`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roomManagerId),
        tx.object(config.userRegistryId),
        tx.pure.u8(0),
        tx.pure.u64(2),
        tx.pure.u8(0),
      ],
    });
  });
  const receiptEvent = exactEvent(execution.result, eventType, 'create_room');
  const roomId = eventRoomId(receiptEvent, 'create_room');
  const observationPromise = matcher.waitFor(execution.digest, eventType, roomId);
  const [finality, observation] = await Promise.all([
    awaitFinality(client, execution.digest, 'create_room'),
    observationPromise,
  ]);
  return {
    roomId,
    record: makeSampleRecord(
      options,
      'L_chain_create',
      sampleIndex,
      roomId,
      null,
      execution,
      finality,
      observation,
    ),
  };
}

async function measureSettlement(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  matcher: ExactEventMatcher,
  options: ChainLatencyOptions,
  sampleIndex: number,
  roomId: string,
  escrowId: string,
): Promise<SampleRecord> {
  const eventType = `${config.packageId}::economic_layer::RewardsDistributed`;
  const execution = await executeTimed(client, roster.userKp, 'distribute_rewards', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::economic_layer::distribute_rewards`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(escrowId),
        tx.object(config.roomManagerId),
        tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(config.cpRegistryId),
        tx.object(config.signalingRegistryId),
      ],
    });
  });
  const receiptEvent = exactEvent(execution.result, eventType, 'distribute_rewards');
  const receiptRoomId = eventRoomId(receiptEvent, 'distribute_rewards');
  if (receiptRoomId !== roomId) {
    throw new Error(`RewardsDistributed receipt room mismatch: expected ${roomId}, got ${receiptRoomId}`);
  }
  const observationPromise = matcher.waitFor(execution.digest, eventType, roomId);
  const [finality, observation] = await Promise.all([
    awaitFinality(client, execution.digest, 'distribute_rewards'),
    observationPromise,
  ]);
  return makeSampleRecord(
    options,
    'L_chain_settle',
    sampleIndex,
    roomId,
    escrowId,
    execution,
    finality,
    observation,
  );
}

async function runMeasurement(options: ChainLatencyOptions): Promise<void> {
  mkdirSync(options.outputRoot, { recursive: true });
  mkdirSync(options.runDir, { recursive: false });
  mkdirSync(resolve(options.runDir, 'cursors'), { recursive: false });

  const rawPath = resolve(options.runDir, 'chain-latency.jsonl');
  const eventsPath = resolve(options.runDir, 'observed-events.jsonl');
  const runLogPath = resolve(options.runDir, 'run.log');
  const gitStatusPath = resolve(options.runDir, 'git-status.txt');
  const manifestPath = resolve(options.runDir, 'manifest.json');
  const failurePath = resolve(options.runDir, 'failure.json');
  let rawWriter: ExclusiveJsonlWriter | null = null;
  const eventWriter = new ExclusiveJsonlWriter(eventsPath);
  const runLog = new RunLog(runLogPath);
  const logger = createLogger(MODULE);

  const previousSuiEnvironment = captureActiveSuiEnvironment();
  const previousSuiAddress = activeSuiAddress();
  let handle: LocalnetHandle | null = null;
  let roomPoller: EventPoller | null = null;
  let economicPoller: EventPoller | null = null;
  let primaryFailure: Error | null = null;
  let completed = false;
  let suiEnvironmentRestored = false;
  const sampleRecords: SampleRecord[] = [];

  try {
    runLog.write('preflight-start', { mode: options.mode, samples: options.samples });
    if (options.mode === 'official') assertOfficialHarnessScopeClean();
    await assertLocalnetPortsFree();
    if (previousSuiEnvironment === null) {
      throw new Error('refusing run without a restorable active Sui environment');
    }
    const checkedLocalEnvironment = switchToCheckedLocalEnvironment();

    const snapshot = verifyContractsSnapshot(options.contractsDir, options.contractRef);
    if (snapshot.commit !== PINNED_CONTRACT_REF) {
      throw new Error(`contract commit mismatch: expected ${PINNED_CONTRACT_REF}, got ${snapshot.commit}`);
    }
    const frameworkRev = readFrameworkRevision(options.contractsDir);
    if (frameworkRev !== PINNED_FRAMEWORK_REV) {
      throw new Error(`framework pin mismatch: expected ${PINNED_FRAMEWORK_REV}, got ${frameworkRev}`);
    }
    const suiCliVersion = readSuiCliVersion();
    if (!suiCliVersion.includes(PINNED_SUI_CLI)) {
      throw new Error(`Sui CLI mismatch: expected ${PINNED_SUI_CLI}, got ${suiCliVersion}`);
    }

    const statusText = [
      '=== root ===',
      gitStatus(WORKSPACE_ROOT),
      '=== daemons ===',
      gitStatus(DAEMONS_ROOT),
      '=== contracts-source ===',
      gitStatus(CONTRACTS_SOURCE_ROOT),
      '=== client ===',
      gitStatus(CLIENT_ROOT),
      '',
    ].join('\n');
    writeExclusive(gitStatusPath, statusText);

    const rootGit = readGitState(WORKSPACE_ROOT);
    const daemonGit = readGitState(DAEMONS_ROOT);
    const contractSourceGit = readGitState(CONTRACTS_SOURCE_ROOT);
    const clientGit = readGitState(CLIENT_ROOT);
    const startedAt = nowPair();

    process.env['DVCONF_CONTRACTS_DIR'] = options.contractsDir;
    process.env['DVCONF_KEEP_MOVE_LOCK'] = '1';
    const { bootLocalnet } = await import(
      '../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts'
    );
    runLog.write('localnet-boot-start');
    handle = await bootLocalnet({ epochDurationMs: 86_400_000, portWaitMs: 240_000 });
    const activeLocalAlias = assertLocalCliEnvironment(handle);
    const { client, config } = handle;
    const chainIdentifier = await client.getChainIdentifier();
    const protocolConfig = await client.getProtocolConfig();
    const referenceGasPrice = await client.getReferenceGasPrice();
    runLog.write('localnet-boot-complete', {
      activeLocalAlias,
      chainIdentifier,
      packageId: config.packageId,
    });

    const roster = await buildRoster(client, config, logger);
    runLog.write('roster-complete', {
      relays: roster.relayIds.length,
      validators: roster.validators.length,
      proofsPerRoom: PROOFS_PER_ROOM,
    });

    const roomCreatedType = `${config.packageId}::room_manager::RoomCreated`;
    const rewardsDistributedType = `${config.packageId}::economic_layer::RewardsDistributed`;
    const matcher = new ExactEventMatcher(
      new Set([roomCreatedType, rewardsDistributedType]),
      eventWriter,
      options.runId,
      options.traceId,
    );
    roomPoller = new EventPoller({
      client,
      packageId: config.packageId,
      module: 'room_manager',
      pollingIntervalMs: POLL_INTERVAL_MS,
      cursorPath: resolve(options.runDir, 'cursors', 'room-manager.json'),
      logger,
    });
    economicPoller = new EventPoller({
      client,
      packageId: config.packageId,
      module: 'economic_layer',
      pollingIntervalMs: POLL_INTERVAL_MS,
      cursorPath: resolve(options.runDir, 'cursors', 'economic-layer.json'),
      logger,
    });
    await Promise.all([
      roomPoller.start(async (event) => matcher.observe(event)),
      economicPoller.start(async (event) => matcher.observe(event)),
    ]);

    const metaRecord = {
      schema_version: SCHEMA_VERSION,
      record_type: 'meta',
      complete: true,
      run_id: options.runId,
      trace_id: options.traceId,
      mode: options.mode,
      network: 'localnet',
      sample_target: options.samples,
      expected_samples_per_metric: options.samples,
      poll_interval_ms: POLL_INTERVAL_MS,
      event_timeout_ms: EVENT_TIMEOUT_MS,
      observer_path: 'production_event_poller',
      execution_order: 'sequential',
      lifecycle_order: 'create -> escrow -> pairing -> eight proofs -> close -> distribute',
      shared_state_disclosure: 'one persistent localnet, one shared roster, one registered user, and shared registries across all samples',
      warm_cache_disclosure: 'sample order is fixed and later samples may observe warm RPC, object, and process caches plus growing shared state',
      independence_boundary: 'repeated transactions on one persistent localnet; not independent sessions',
      submit_boundary: 'immediately before SuiClient.signAndExecuteTransaction call; includes SDK transaction build/sign and RPC execution',
      availability_boundary: 'finality_return_* records waitForTransaction/getTransactionBlock availability, NOT consensus/mainnet finality',
      started_at: startedAt.wallIso,
      completed_at: null as string | null,
      performance_time_origin_ms: performance.timeOrigin,
      command_argv: process.argv,
      canonical_invocation: `pnpm.cmd exec tsx scripts/eval/measure-chain-latency.ts --contracts-dir ${options.contractsDir.replace(/\\/g, '/')} --contract-ref ${options.contractRef} --run-id ${options.runId} --trace-id ${options.traceId} --samples ${options.samples} --output-root ${options.outputRoot.replace(/\\/g, '/')}`,
      package_id: config.packageId,
      framework_rev: frameworkRev,
      sui_cli_version: suiCliVersion,
      daemon_commit: daemonGit.commit,
      contract_commit: snapshot.commit,
      pins: {
        root: rootGit,
        daemons: daemonGit,
        contracts_source: contractSourceGit,
        client: clientGit,
        contract_commit: snapshot.commit,
        framework_revision: frameworkRev,
        sui_cli_version: suiCliVersion,
      },
      contracts_snapshot: {
        path: options.contractsDir.replace(/\\/g, '/'),
        tracked_file_count: snapshot.trackedFileCount,
        tree_sha256: snapshot.treeSha256,
      },
      chain: {
        identifier: chainIdentifier,
        protocol_version: String(protocolConfig.protocolVersion),
        reference_gas_price: String(referenceGasPrice),
        rpc_url: config.rpcUrl,
        package_id: config.packageId,
        network_registry_id: config.networkRegistryId,
        miner_store_id: config.minerStoreId,
        role_vote_box_id: config.roleVoteBoxId,
        user_registry_id: config.userRegistryId,
        room_manager_id: config.roomManagerId,
        relay_registry_id: config.relayRegistryId,
        cp_registry_id: config.cpRegistryId,
        validator_registry_id: config.validatorRegistryId,
        signaling_registry_id: config.signalingRegistryId,
      },
      topology: {
        cp: 1,
        relays: EXPECTED_RELAYS,
        validators: EXPECTED_VALIDATORS,
        signaling: 1,
        registered_users: 1,
        proofs_per_room: PROOFS_PER_ROOM,
        escrow_amount_mist: ESCROW_AMOUNT_MIST.toString(),
      },
      sui_environment: {
        before_alias: previousSuiEnvironment,
        before_address: previousSuiAddress,
        checked_preboot_alias: checkedLocalEnvironment.alias,
        checked_preboot_rpc: checkedLocalEnvironment.rpc,
        local_alias: activeLocalAlias,
        local_address: activeSuiAddress(),
      },
    };

    const seenDigests = new Set<string>();
    const seenRooms = new Set<string>();
    const seenEscrows = new Set<string>();
    for (let sampleIndex = 1; sampleIndex <= options.samples; sampleIndex += 1) {
      runLog.write('sample-start', { sampleIndex });
      const create = await measureCreate(
        client,
        config,
        roster,
        matcher,
        options,
        sampleIndex,
      );
      if (seenDigests.has(create.record.tx_digest)) {
        throw new Error(`duplicate measured digest: ${create.record.tx_digest}`);
      }
      if (seenRooms.has(create.roomId)) throw new Error(`duplicate room id: ${create.roomId}`);
      seenDigests.add(create.record.tx_digest);
      seenRooms.add(create.roomId);
      sampleRecords.push(create.record);

      const escrowId = await createEscrow(client, config, roster.userKp, create.roomId);
      if (seenEscrows.has(escrowId)) throw new Error(`duplicate escrow id: ${escrowId}`);
      seenEscrows.add(escrowId);
      await assertEscrowState(client, escrowId, create.roomId, false);
      await submitPairing(client, config, roster, create.roomId);
      await submitAllProofs(client, config, roster, escrowId, create.roomId);
      await closeRoom(client, config, roster.userKp, create.roomId);
      const settle = await measureSettlement(
        client,
        config,
        roster,
        matcher,
        options,
        sampleIndex,
        create.roomId,
        escrowId,
      );
      if (seenDigests.has(settle.tx_digest)) {
        throw new Error(`duplicate measured digest: ${settle.tx_digest}`);
      }
      seenDigests.add(settle.tx_digest);
      sampleRecords.push(settle);
      await assertEscrowState(client, escrowId, create.roomId, true);
      runLog.write('sample-complete', {
        sampleIndex,
        roomId: create.roomId,
        escrowId,
        createMs: create.record.value_ms,
        settleMs: settle.value_ms,
      });
    }

    matcher.assertDrained();
    const matcherStats = matcher.stats();
    const expectedTargetEvents = options.samples * 2;
    if (matcherStats.targetEventCount !== expectedTargetEvents) {
      throw new Error(
        `target event coverage mismatch: got ${matcherStats.targetEventCount}, expected ${expectedTargetEvents}`,
      );
    }
    if (seenRooms.size !== options.samples || seenEscrows.size !== options.samples) {
      throw new Error(
        `identity coverage mismatch: rooms=${seenRooms.size}, escrows=${seenEscrows.size}, expected=${options.samples}`,
      );
    }
    if (seenDigests.size !== options.samples * 2) {
      throw new Error(
        `measured digest coverage mismatch: got ${seenDigests.size}, expected ${options.samples * 2}`,
      );
    }

    roomPoller.stop();
    economicPoller.stop();
    roomPoller = null;
    economicPoller = null;
    await sleep(100);
    eventWriter.close();
    const endedAt = nowPair();

    if (handle === null) throw new Error('localnet handle missing before teardown');
    await handle.teardown();
    await waitForPortsClosed();
    handle = null;
    restoreSuiEnvironment(previousSuiEnvironment);
    const restoredEnvironment = activeSuiEnvironment();
    if (restoredEnvironment !== previousSuiEnvironment) {
      throw new Error(
        `Sui environment restore mismatch: expected ${previousSuiEnvironment}, got ${restoredEnvironment ?? '(none)'}`,
      );
    }
    const restoredAddress = activeSuiAddress();
    if (previousSuiAddress !== null && restoredAddress !== previousSuiAddress) {
      throw new Error(
        `Sui address restore mismatch: expected ${previousSuiAddress}, got ${restoredAddress ?? '(none)'}`,
      );
    }
    suiEnvironmentRestored = true;

    // Persist publishable evidence only after teardown and Sui-client restoration
    // both succeed. A cleanup failure therefore leaves diagnostics + failure.json,
    // but no self-declared complete raw distribution or manifest.
    rawWriter = new ExclusiveJsonlWriter(rawPath);
    rawWriter.write({ ...metaRecord, completed_at: endedAt.wallIso });
    for (const record of sampleRecords) rawWriter.write(record);
    rawWriter.close();
    rawWriter = null;
    runLog.write('measurement-data-complete', {
      sampleRecords: sampleRecords.length,
      rawSha256: sha256File(rawPath),
      restoredSuiEnvironment: restoredEnvironment,
      restoredSuiAddress: restoredAddress,
    });
    runLog.close();
    const rawText = readFileSync(rawPath, 'utf8');
    parseChainLatencyEvidence(rawText);
    const manifest = {
      schema_version: SCHEMA_VERSION,
      run_id: options.runId,
      trace_id: options.traceId,
      complete: true,
      publishable: options.mode === 'official',
      mode: options.mode,
      started_at: startedAt.wallIso,
      ended_at: endedAt.wallIso,
      duration_ms: endedAt.monoMs - startedAt.monoMs,
      samples: {
        L_chain_create: options.samples,
        L_chain_settle: options.samples,
      },
      malformed_count: 0,
      excluded_count: 0,
      matcher: matcherStats,
      cleanup: {
        localnet_ports_closed: true,
        restored_sui_environment: restoredEnvironment,
        restored_sui_address: restoredAddress,
      },
      poll_interval_ms: POLL_INTERVAL_MS,
      event_timeout_ms: EVENT_TIMEOUT_MS,
      artifact_sha256: {
        'chain-latency.jsonl': sha256File(rawPath),
        'observed-events.jsonl': sha256File(eventsPath),
        'git-status.txt': sha256File(gitStatusPath),
        'run.log': sha256File(runLogPath),
      },
      limitations: [
        'One persistent single-host Sui localnet; no mainnet or WAN finality claim.',
        'Sequential warm-state transactions share registries, process, RPC, caches, and execution order.',
        'The unchanged shared EventPoller is exercised at 5000 ms; this is not the React browser hook or UI latency.',
        'The distribution includes the configured client polling cadence.',
        'finality_return_* records waitForTransaction/getTransactionBlock availability on this localnet, not consensus or mainnet finality.',
        'RewardsDistributed carries room_id but no escrow_id; escrow identity is retained from the submitted PTB and checked against the on-chain RoomEscrow before and after distribution.',
        'Create and settlement are reported separately and do not imply join, revocation, failover recovery, or a sub-second guarantee.',
      ],
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    validateChainLatencyBundle({
      'chain-latency.jsonl': rawText,
      'observed-events.jsonl': readFileSync(eventsPath, 'utf8'),
      'manifest.json': manifestText,
      'git-status.txt': readFileSync(gitStatusPath, 'utf8'),
      'run.log': readFileSync(runLogPath, 'utf8'),
    });
    writeExclusive(manifestPath, manifestText);
    completed = true;
  } catch (error) {
    primaryFailure = asError(error);
    runLog.write('measurement-failed', { error: primaryFailure.stack ?? primaryFailure.message });
    throw primaryFailure;
  } finally {
    try {
      roomPoller?.stop();
      economicPoller?.stop();
    } catch (error) {
      primaryFailure ??= asError(error);
    }
    try {
      rawWriter?.close();
    } catch (error) {
      primaryFailure ??= asError(error);
    }
    try {
      eventWriter.close();
    } catch (error) {
      primaryFailure ??= asError(error);
    }
    if (handle !== null) {
      try {
        await handle.teardown();
        await waitForPortsClosed();
      } catch (error) {
        primaryFailure ??= new Error(`localnet teardown failed: ${asError(error).message}`);
      }
    }
    if (!suiEnvironmentRestored) {
      try {
        restoreSuiEnvironment(previousSuiEnvironment);
        const restored = activeSuiEnvironment();
        if (previousSuiEnvironment !== null && restored !== previousSuiEnvironment) {
          throw new Error(
            `Sui environment restore mismatch: expected ${previousSuiEnvironment}, got ${restored ?? '(none)'}`,
          );
        }
        suiEnvironmentRestored = true;
      } catch (error) {
        primaryFailure ??= new Error(`Sui environment restore failed: ${asError(error).message}`);
      }
    }
    if (!completed && !existsSync(failurePath)) {
      try {
        writeExclusive(failurePath, `${JSON.stringify({
          schema_version: SCHEMA_VERSION,
          run_id: options.runId,
          trace_id: options.traceId,
          complete: false,
          failed_at: new Date().toISOString(),
          error: primaryFailure?.stack ?? primaryFailure?.message ?? 'unknown failure',
          command_argv: process.argv,
          previous_sui_environment: previousSuiEnvironment,
          restored_sui_environment: activeSuiEnvironment(),
        }, null, 2)}\n`);
      } catch {
        // The exclusive run directory and console error remain as the failure trace.
      }
    }
    runLog.close();
    if (primaryFailure !== null && completed) throw primaryFailure;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseChainLatencyOptions(argv);
  await runMeasurement(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    process.stderr.write(`${MODULE}: ${asError(error).stack ?? asError(error).message}\n`);
    process.exitCode = 1;
  });
}
