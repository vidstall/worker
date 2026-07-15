import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

const PINNED_CONTRACT_REF = '17e1fce0efd7b7668a5cd7d6aa34ebae762670bd';
const LEGACY_RAW_BASENAME = 'cost-onchain-localnet-2026-07-13.jsonl';

export interface CostRunOptions {
  runId: string;
  outputPath: string;
  contractsDir: string;
  contractRef: string;
}

export interface GitState {
  commit: string;
  dirty: boolean;
  dirtyFingerprint: string | null;
}

function flagValue(argv: string[], flag: string): string | undefined {
  const indices = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indices.length > 1) throw new Error(`${flag} may be supplied only once`);
  if (indices.length === 0) return undefined;
  const value = argv[indices[0]! + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseCostRunOptions(
  argv: string[],
  workspaceRoot: string,
  now = new Date(),
): CostRunOptions {
  const knownFlags = new Set(['--out', '--run-id', '--contracts-dir', '--contract-ref']);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith('--')) continue;
    if (!knownFlags.has(value)) throw new Error(`unknown option: ${value}`);
    index += 1;
  }

  const contractsArg = flagValue(argv, '--contracts-dir');
  if (contractsArg === undefined) {
    throw new Error('--contracts-dir is required and must point to an isolated pinned snapshot');
  }
  const contractsDir = resolve(contractsArg);
  const canonicalContractsDir = resolve(workspaceRoot, 'dvconf-contracts');
  if (isWithin(canonicalContractsDir, contractsDir)) {
    throw new Error(`refusing canonical contracts working tree: ${contractsDir}`);
  }
  for (const required of ['Move.toml', 'Move.lock']) {
    if (!existsSync(resolve(contractsDir, required))) {
      throw new Error(`contracts snapshot missing ${required}: ${contractsDir}`);
    }
  }

  const defaultRunId = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z').replace('T', 'T');
  const runId = flagValue(argv, '--run-id') ?? defaultRunId;
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error('--run-id may contain only letters, digits, dot, underscore, and dash');
  }

  const date = now.toISOString().slice(0, 10);
  const defaultOutput = resolve(
    workspaceRoot,
    'docs',
    '80-research',
    'evaluation',
    'raw',
    `cost-onchain-localnet-k2-n4-${date}-${runId}.jsonl`,
  );
  const outputPath = resolve(flagValue(argv, '--out') ?? defaultOutput);
  if (!outputPath.toLowerCase().endsWith('.jsonl')) {
    throw new Error(`--out must end in .jsonl: ${outputPath}`);
  }
  if (basename(outputPath).toLowerCase() === LEGACY_RAW_BASENAME) {
    throw new Error(`refusing to overwrite canonical legacy evidence: ${outputPath}`);
  }
  if (existsSync(outputPath)) {
    throw new Error(`output already exists (append-only evidence): ${outputPath}`);
  }

  const contractRef = flagValue(argv, '--contract-ref') ?? PINNED_CONTRACT_REF;
  if (!/^[0-9a-fA-F]{7,40}$/.test(contractRef)) {
    throw new Error(`--contract-ref must be a 7-40 digit hexadecimal Git ref: ${contractRef}`);
  }

  return { runId, outputPath, contractsDir, contractRef };
}

function runChecked(command: string, args: string[], label: string): string {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label}: exited ${result.status ?? 'unknown'}: ${(result.stderr ?? '').trim().slice(0, 500)}`);
  }
  return (result.stdout ?? '').trim();
}

function gitArgs(repoPath: string, args: string[]): string[] {
  return ['-c', `safe.directory=${repoPath.replace(/\\/g, '/')}`, '-C', repoPath, ...args];
}

export function resolveGitRef(repoPath: string, ref = 'HEAD'): string {
  return runChecked('git', gitArgs(repoPath, ['rev-parse', `${ref}^{commit}`]), `git rev-parse ${ref}`);
}

export function readGitState(repoPath: string): GitState {
  const commit = resolveGitRef(repoPath);
  const porcelain = runChecked(
    'git',
    gitArgs(repoPath, ['status', '--porcelain=v1', '--untracked-files=normal']),
    'git status',
  );
  return {
    commit,
    dirty: porcelain.length > 0,
    dirtyFingerprint: porcelain.length === 0
      ? null
      : createHash('sha256').update(porcelain, 'utf8').digest('hex'),
  };
}

export function readFrameworkRevision(contractsDir: string): string {
  const lock = readFileSync(resolve(contractsDir, 'Move.lock'), 'utf8');
  const section = lock.match(/\[pinned\.local\.Sui\]([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  const revision = section?.match(/\brev\s*=\s*["']([0-9a-f]{7,40})["']/i)?.[1];
  if (revision === undefined) {
    throw new Error(`cannot read pinned.local.Sui revision from ${resolve(contractsDir, 'Move.lock')}`);
  }
  return revision;
}

export function readSuiCliVersion(): string {
  return runChecked('sui', ['--version'], 'sui --version');
}

export function captureActiveSuiEnvironment(): string | null {
  const result = spawnSync('sui', ['client', 'active-env'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length > 0 ? value : null;
}

export function restoreSuiEnvironment(alias: string | null): void {
  if (alias === null) return;
  runChecked('sui', ['client', 'switch', '--env', alias], `restore Sui environment ${alias}`);
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResult(listening);
    };
    socket.setTimeout(500);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

export async function assertLocalnetPortsFree(ports = [9000, 9123]): Promise<void> {
  const states = await Promise.all(ports.map(async (port) => ({ port, listening: await isPortListening(port) })));
  const occupied = states.filter((state) => state.listening).map((state) => state.port);
  if (occupied.length > 0) {
    throw new Error(`refusing to start localnet; ports already listening: ${occupied.join(', ')}`);
  }
}

export function writeTextExclusive(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' });
}

export function sha256Text(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
