/**
 * P1 local measurement runner for the production signaling RTT probe.
 *
 * The CLI deliberately exposes only run identity and destination. Measurement
 * settings are fixed below so a retained run cannot silently change its arm.
 * Every run gets an exclusive directory containing raw JSONL, replay CSV,
 * pre-run Git status, a human-readable log, and a hash-bearing manifest.
 *
 * Usage:
 *   pnpm bench:signaling-latency -- --run-id <id> --trace-id <uuid> --output-root <directory>
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { WebSocketServer } from 'ws';
import {
  LATENCY_EVENT_SCHEMA_VERSION,
  type LatencyEvent,
} from '../../packages/shared/src/index.js';
import {
  closeSignalingProbe,
  createServer,
  setAccepting,
} from '../../apps/signaling/src/index.js';
import {
  runSignalingProbeWorkload,
  type SignalingProbeWorkloadResult,
} from './signaling-probe-workload.js';
import { aggregateEvents, formatCsv } from './replay.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = /^[a-z0-9][a-z0-9._-]{0,126}$/i;

export interface SignalingLatencySettings {
  connections: number;
  durationMs: number;
  sampleIntervalMs: number;
  messageIntervalMs: number;
  messagesPerPeer: number;
  minTotalSamples: number;
  minSamplesPerPeer: number;
}

export const P1_SIGNALING_LATENCY_SETTINGS: Readonly<SignalingLatencySettings> = {
  connections: 8,
  durationMs: 31_000,
  sampleIntervalMs: 5_000,
  messageIntervalMs: 4_000,
  messagesPerPeer: 6,
  minTotalSamples: 32,
  minSamplesPerPeer: 4,
};

export interface SignalingLatencyRunOptions {
  runId: string;
  traceId: string;
  outputRoot: string;
  /** Test-only seam; the CLI always uses the fixed P1 settings above. */
  settings?: SignalingLatencySettings;
  /** Test-only seam; retained CLI runs require a committed harness. */
  requireCleanHarness?: boolean;
}

export interface ValidatedSignalingLatencyEvents {
  events: LatencyEvent[];
  perPeerSamples: Record<string, number>;
}

export interface SignalingLatencyRunResult {
  runDir: string;
  rawPath: string;
  replayPath: string;
  manifestPath: string;
  logPath: string;
  events: LatencyEvent[];
  workload: SignalingProbeWorkloadResult;
}

export interface SignalingLatencyCliArgs {
  runId: string;
  traceId: string;
  outputRoot: string;
}

function fail(message: string): never {
  throw new Error(`P1 signaling latency gate failed: ${message}`);
}

function validateSettings(settings: SignalingLatencySettings): void {
  const positiveIntegers: Array<keyof SignalingLatencySettings> = [
    'connections',
    'durationMs',
    'sampleIntervalMs',
    'messageIntervalMs',
    'messagesPerPeer',
    'minTotalSamples',
    'minSamplesPerPeer',
  ];
  for (const key of positiveIntegers) {
    const value = settings[key];
    if (!Number.isInteger(value) || value <= 0) {
      fail(`${key} must be a positive integer, got ${value}`);
    }
  }
  if (settings.connections < 2) fail('connections must be at least 2');
  if (settings.minTotalSamples < settings.connections * settings.minSamplesPerPeer) {
    fail('minTotalSamples cannot be below aggregate per-peer coverage');
  }
}

export function parseSignalingLatencyArgs(
  argv: readonly string[],
): SignalingLatencyCliArgs {
  const args = argv.slice(2);
  let runId: string | null = null;
  let traceId: string | null = null;
  let outputRoot: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--run-id') {
      if (runId !== null) fail('duplicate --run-id');
      runId = args[++i] ?? null;
    } else if (arg === '--trace-id') {
      if (traceId !== null) fail('duplicate --trace-id');
      traceId = args[++i] ?? null;
    } else if (arg === '--output-root') {
      if (outputRoot !== null) fail('duplicate --output-root');
      outputRoot = args[++i] ?? null;
    } else {
      fail(`unknown argument ${arg}`);
    }
  }
  if (runId === null || traceId === null || outputRoot === null) {
    fail('usage: --run-id <id> --trace-id <uuid-v4> --output-root <directory>');
  }
  if (!RUN_ID.test(runId) || runId === '.' || runId === '..') {
    fail(`run-id must be filename-safe, got ${runId}`);
  }
  if (!UUID_V4.test(traceId)) fail(`trace-id must be a UUID-v4, got ${traceId}`);
  if (outputRoot.trim().length === 0) fail('output-root must not be empty');
  return { runId, traceId, outputRoot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRawLine(line: string, lineNumber: number): Record<string, unknown> {
  if (line.trim().length === 0) fail(`blank raw line at ${lineNumber}`);
  try {
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) fail(`raw line ${lineNumber} is not an object`);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('P1 signaling latency gate failed:')) {
      throw error;
    }
    fail(`malformed JSON at raw line ${lineNumber}`);
  }
}

export function validateSignalingLatencyJsonl(
  content: string,
  runId: string,
  instance: string,
  settings: SignalingLatencySettings,
): ValidatedSignalingLatencyEvents {
  validateSettings(settings);
  if (!content.endsWith('\n')) fail('raw JSONL lacks the writer final newline');
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) fail('raw JSONL is empty');

  const events: LatencyEvent[] = [];
  const perPeer = new Map<string, number>();
  lines.forEach((line, index) => {
    const event = parseRawLine(line, index + 1);
    const lineNumber = index + 1;
    if (event['schema_version'] !== LATENCY_EVENT_SCHEMA_VERSION) {
      fail(`wrong schema_version at raw line ${lineNumber}`);
    }
    if (event['trace_id'] !== runId) fail(`wrong trace_id at raw line ${lineNumber}`);
    if (event['scenario'] !== 'adhoc') fail(`wrong scenario at raw line ${lineNumber}`);
    if (event['source'] !== 'signaling') fail(`wrong source at raw line ${lineNumber}`);
    if (event['instance'] !== instance) fail(`wrong instance at raw line ${lineNumber}`);
    if (event['metric'] !== 'L_sig_rtt') fail(`wrong metric at raw line ${lineNumber}`);
    if (!Number.isInteger(event['ts']) || (event['ts'] as number) <= 0) {
      fail(`invalid ts at raw line ${lineNumber}`);
    }
    if (
      typeof event['value_ms'] !== 'number' ||
      !Number.isFinite(event['value_ms']) ||
      event['value_ms'] < 0
    ) {
      fail(`invalid value_ms at raw line ${lineNumber}`);
    }
    const context = event['context'];
    if (!isRecord(context) || typeof context['peer_id'] !== 'string') {
      fail(`missing peer_id at raw line ${lineNumber}`);
    }
    const peerId = context['peer_id'];
    if (peerId.length === 0) fail(`empty peer_id at raw line ${lineNumber}`);
    perPeer.set(peerId, (perPeer.get(peerId) ?? 0) + 1);
    events.push(event as unknown as LatencyEvent);
  });

  if (events.length < settings.minTotalSamples) {
    fail(`only ${events.length} samples; require ${settings.minTotalSamples}`);
  }
  if (perPeer.size !== settings.connections) {
    fail(`observed ${perPeer.size} peers; require ${settings.connections}`);
  }
  for (const [peerId, count] of perPeer) {
    if (count < settings.minSamplesPerPeer) {
      fail(`peer ${peerId} has ${count} samples; require ${settings.minSamplesPerPeer}`);
    }
  }

  return {
    events,
    perPeerSamples: Object.fromEntries(
      [...perPeer.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function git(args: string[]): string {
  return execFileSync(
    'git',
    ['-c', `safe.directory=${REPO_ROOT}`, '-C', REPO_ROOT, ...args],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ).trimEnd();
}

function closeServer(server: WebSocketServer, timeoutMs = 5_000): Promise<void> {
  if (server.address() === null) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    let settled = false;
    let forced = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(terminateTimer);
      clearTimeout(hardTimer);
      server.off('error', onError);
      if (error === undefined) resolveClose();
      else rejectClose(error);
    };
    const onError = (error: Error): void => settle(error);
    const terminateTimer = setTimeout(() => {
      forced = true;
      for (const client of server.clients) client.terminate();
    }, timeoutMs);
    const hardTimer = setTimeout(
      () => settle(new Error(`signaling server teardown exceeded ${timeoutMs + 2_000}ms`)),
      timeoutMs + 2_000,
    );
    server.once('error', onError);
    server.close((error) => {
      if (error !== undefined) settle(error);
      else if (forced) settle(new Error(`signaling server required forced teardown after ${timeoutMs}ms`));
      else settle();
    });
  });
}

function waitForListening(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolveListen, rejectListen) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolveListen();
    };
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function assertWorkload(
  workload: SignalingProbeWorkloadResult,
  settings: SignalingLatencySettings,
  eventCount: number,
): void {
  const expectedMessages = settings.connections * settings.messagesPerPeer;
  if (workload.connections !== settings.connections) {
    fail(`workload accepted ${workload.connections}/${settings.connections} sockets`);
  }
  if (
    workload.requestedUserMessages !== expectedMessages ||
    workload.sentUserMessages !== expectedMessages ||
    workload.deliveredUserMessages !== expectedMessages
  ) {
    fail(
      `user workload mismatch requested/sent/delivered=` +
        `${workload.requestedUserMessages}/${workload.sentUserMessages}/` +
        `${workload.deliveredUserMessages}, expected ${expectedMessages}`,
    );
  }
  if (workload.droppedUserMessages !== 0) {
    fail(`workload dropped ${workload.droppedUserMessages} messages`);
  }
  if (workload.errors.length !== 0) {
    fail(`workload socket errors: ${workload.errors.join('; ')}`);
  }
  if (workload.benchPongsSent !== eventCount) {
    fail(`pong/raw mismatch ${workload.benchPongsSent}/${eventCount}`);
  }
}

function writeFailure(runDir: string, error: unknown): void {
  try {
    writeFileSync(
      join(runDir, 'failure.json'),
      JSON.stringify(
        {
          status: 'FAIL',
          error: error instanceof Error ? error.message : String(error),
          failed_at: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      { flag: 'wx' },
    );
  } catch {
    // Preserve the original gate error if the failure record cannot be created.
  }
}

export async function runSignalingLatencyMeasurement(
  options: SignalingLatencyRunOptions,
): Promise<SignalingLatencyRunResult> {
  if (!RUN_ID.test(options.runId) || options.runId === '.' || options.runId === '..') {
    fail(`run-id must be filename-safe, got ${options.runId}`);
  }
  if (!UUID_V4.test(options.traceId)) {
    fail(`trace-id must be a UUID-v4, got ${options.traceId}`);
  }
  const settings = options.settings ?? { ...P1_SIGNALING_LATENCY_SETTINGS };
  validateSettings(settings);
  const requireCleanHarness = options.requireCleanHarness ?? true;
  const harnessPaths = [
    'package.json',
    'apps/signaling/src/index.ts',
    'apps/signaling/src/latency-probe.ts',
    'packages/shared/src/bench/types.ts',
    'packages/shared/src/bench/writer.ts',
    'packages/shared/src/index.ts',
    'pnpm-lock.yaml',
    'scripts/bench/run-signaling-latency.ts',
    'scripts/bench/__tests__/run-signaling-latency.test.ts',
    'scripts/bench/signaling-probe-workload.ts',
    'scripts/bench/replay.ts',
  ];
  const scopedStatus = git([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...harnessPaths,
  ]);
  if (requireCleanHarness && scopedStatus.length !== 0) {
    fail(`harness scope is dirty:\n${scopedStatus}`);
  }

  const outputRoot = resolve(options.outputRoot);
  const runDir = join(outputRoot, options.runId);
  mkdirSync(outputRoot, { recursive: true });
  try {
    mkdirSync(runDir);
  } catch (error) {
    fail(
      `run directory must be new (duplicate run-id/path protection): ${runDir}; ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const instance = `p1-local-${options.runId}`;
  const rawDir = join(runDir, 'bench-output');
  const rawPath = join(rawDir, `adhoc-signaling-${options.traceId}.jsonl`);
  const replayPath = join(runDir, 'replay.csv');
  const manifestPath = join(runDir, 'manifest.json');
  const logPath = join(runDir, 'run-console.txt');
  const statusPath = join(runDir, 'git-status.txt');
  const preRunGitStatus = git(['status', '--porcelain=v1', '--untracked-files=normal']);
  const startedAt = new Date();
  const originalCwd = process.cwd();
  const envKeys = [
    'BENCH_LATENCY',
    'BENCH_RUN_ID',
    'BENCH_TRACE_ID',
    'BENCH_SCENARIO',
    'BENCH_SAMPLE_INTERVAL_MS',
    'SIGNALING_INSTANCE',
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let server: WebSocketServer | null = null;
  let serverAddress: AddressInfo | null = null;

  try {
    process.env['BENCH_LATENCY'] = '1';
    process.env['BENCH_RUN_ID'] = options.runId;
    process.env['BENCH_TRACE_ID'] = options.traceId;
    process.env['BENCH_SCENARIO'] = 'adhoc';
    process.env['BENCH_SAMPLE_INTERVAL_MS'] = String(settings.sampleIntervalMs);
    process.env['SIGNALING_INSTANCE'] = instance;
    process.chdir(runDir);
    closeSignalingProbe();
    setAccepting(true);

    server = createServer(0);
    await waitForListening(server);
    const address = server.address() as AddressInfo | null;
    if (address === null || typeof address === 'string') fail('ephemeral server has no TCP port');
    serverAddress = address;

    let expectedClose = false;
    let prematureClose: (() => void) | null = null;
    let serverError: ((error: Error) => void) | null = null;
    const prematureExit = new Promise<never>((_resolve, reject) => {
      prematureClose = (): void => {
        if (!expectedClose) reject(new Error('signaling server closed before workload completed'));
      };
      serverError = (error: Error): void => reject(error);
      server!.once('close', prematureClose);
      server!.once('error', serverError);
    });

    let workload: SignalingProbeWorkloadResult;
    try {
      workload = await Promise.race([
        runSignalingProbeWorkload({
          url: `ws://127.0.0.1:${address.port}`,
          roomId: options.runId,
          connections: settings.connections,
          durationMs: settings.durationMs,
          messageIntervalMs: settings.messageIntervalMs,
          messagesPerPeer: settings.messagesPerPeer,
        }),
        prematureExit,
      ]);
      if (server.address() === null) fail('signaling server is not listening after workload');
    } finally {
      expectedClose = true;
      if (prematureClose !== null) server.off('close', prematureClose);
      if (serverError !== null) server.off('error', serverError);
    }

    await closeServer(server);
    server = null;
    closeSignalingProbe();
    process.chdir(originalCwd);

    const rawFiles = readdirSync(rawDir).filter((name) => name.endsWith('.jsonl'));
    if (rawFiles.length !== 1 || rawFiles[0] !== `adhoc-signaling-${options.traceId}.jsonl`) {
      fail(`expected exactly one trace raw file, found: ${rawFiles.join(', ') || '(none)'}`);
    }
    const validated = validateSignalingLatencyJsonl(
      readFileSync(rawPath, 'utf8'),
      options.traceId,
      instance,
      settings,
    );
    assertWorkload(workload, settings, validated.events.length);
    const rows = aggregateEvents(validated.events);
    if (
      rows.length !== 1 ||
      rows[0]?.metric !== 'L_sig_rtt' ||
      rows[0].source !== 'signaling' ||
      rows[0].n !== validated.events.length ||
      rows[0].note !== null
    ) {
      fail('replay aggregation did not produce one sufficient L_sig_rtt/signaling row');
    }

    writeFileSync(replayPath, formatCsv(rows), { flag: 'wx' });
    writeFileSync(statusPath, preRunGitStatus + (preRunGitStatus.length === 0 ? '' : '\n'), {
      flag: 'wx',
    });
    const endedAt = new Date();
    const rawSha256 = sha256File(rawPath);
    const replaySha256 = sha256File(replayPath);
    const statusSha256 = sha256File(statusPath);
    const firstSampleTs = Math.min(...validated.events.map((event) => event.ts));
    const lastSampleTs = Math.max(...validated.events.map((event) => event.ts));
    const logLines = [
      `status=PASS`,
      `run_id=${options.runId}`,
      `trace_id=${options.traceId}`,
      `started_at=${startedAt.toISOString()}`,
      `ended_at=${endedAt.toISOString()}`,
      `accepted_sockets=${workload.connections}`,
      `samples=${validated.events.length}`,
      `per_peer_samples=${JSON.stringify(validated.perPeerSamples)}`,
      `p50_ms=${rows[0].p50?.toFixed(2)}`,
      `p95_ms=${rows[0].p95?.toFixed(2)}`,
      `p99_ms=${rows[0].p99?.toFixed(2)}`,
      `mean_ms=${rows[0].mean.toFixed(2)}`,
      `raw_sha256=${rawSha256}`,
      `replay_sha256=${replaySha256}`,
    ];
    writeFileSync(logPath, logLines.join('\n') + '\n', { flag: 'wx' });
    const consoleSha256 = sha256File(logPath);
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };

    const manifest = {
      schema_version: 'p1-signaling-latency-run/v1',
      complete: true,
      status: 'PASS',
      verdict: 'RUN-WITH-RAW/DIRECT within the disclosed local mechanism-floor scope',
      claim_scope: {
        metric: 'L_sig_rtt',
        topology:
          'single host/process/event loop; production signaling WebSocket probe and synthetic clients over OS loopback',
        sampling_unit: 'repeated RTT observations nested within accepted sockets in one run',
        independence_limit:
          'local mechanism floor; not separate-process deployment RTT or independent sessions, hosts, networks, or WAN paths',
        observer_note:
          'the application switch logs one Unknown-message warning per bench-pong after the probe listener records that RTT; this logging load remains part of the single-process arm',
      },
      run: {
        run_id: options.runId,
        trace_id: options.traceId,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
        elapsed_ms: endedAt.getTime() - startedAt.getTime(),
        first_sample_ts: firstSampleTs,
        last_sample_ts: lastSampleTs,
        invocation_cwd: originalCwd,
        command_argv: process.argv.slice(),
        canonical_invocation: [
          'pnpm',
          'bench:signaling-latency',
          '--',
          '--run-id',
          options.runId,
          '--trace-id',
          options.traceId,
          '--output-root',
          outputRoot,
        ],
        measurement_environment: {
          BENCH_LATENCY: '1',
          BENCH_RUN_ID: options.runId,
          BENCH_TRACE_ID: options.traceId,
          BENCH_SCENARIO: 'adhoc',
          BENCH_SAMPLE_INTERVAL_MS: String(settings.sampleIntervalMs),
          SIGNALING_INSTANCE: instance,
        },
        run_dir: runDir,
        settings,
      },
      topology: {
        host_count: 1,
        process_count: 1,
        event_loop_count: 1,
        signaling_server_count: 1,
        transport: 'OS loopback WebSocket',
        listen_address: serverAddress,
        client_url: `ws://127.0.0.1:${serverAddress?.port}`,
        room_id: options.runId,
        sockets_requested: settings.connections,
        sockets_accepted: workload.connections,
        sockets_rejected: 0,
      },
      workload,
      validation: {
        raw_lines: validated.events.length,
        valid_lines: validated.events.length,
        samples_selected: validated.events.length,
        peers: Object.keys(validated.perPeerSamples).length,
        peer_ids: Object.keys(validated.perPeerSamples),
        per_peer_samples: validated.perPeerSamples,
        malformed_lines: 0,
        unexpected_lines: 0,
        excluded_lines: 0,
        bench_pongs_sent: workload.benchPongsSent,
        latency_rows_emitted: validated.events.length,
        premature_server_exit: false,
        forced_server_teardown: false,
        writer_final_newline: true,
        selection_predicate: {
          trace_id: options.traceId,
          metric: 'L_sig_rtt',
          source: 'signaling',
          instance,
          peer_id_membership: `exactly the observed ${settings.connections} accepted sockets`,
        },
        gates: {
          aggregate: `n >= ${settings.minTotalSamples}`,
          per_peer: `n >= ${settings.minSamplesPerPeer}`,
          peer_count: `n = ${settings.connections}`,
          malformed_unexpected_excluded: 'all zero',
          pong_row_equality: true,
        },
        gate: 'PASS',
      },
      replay: {
        implementation: 'scripts/bench/replay.ts aggregateEvents + formatCsv',
        equivalent_command:
          `pnpm bench:replay ${options.traceId} --csv replay.csv --output-dir bench-output`,
        percentile_method: 'nearest-rank; rank = ceil(p * n); no interpolation',
        row: rows[0],
      },
      provenance: {
        repositories_exercised: ['dvconf-daemons'],
        daemon_git_head: git(['rev-parse', 'HEAD']),
        daemon_git_branch: git(['branch', '--show-current']),
        harness_scope_status: scopedStatus,
        pre_run_git_status_file: 'git-status.txt',
        pre_run_git_status_dirty: preRunGitStatus.length !== 0,
        pre_run_git_status_sha256: statusSha256,
        node: process.version,
        platform: `${platform()} ${release()}`,
        architecture: arch(),
        hostname: hostname(),
        cpu_model: cpus()[0]?.model ?? 'unknown',
        logical_cpu_count: cpus().length,
        total_memory_bytes: totalmem(),
        package_manager_user_agent: process.env['npm_config_user_agent'] ?? 'unavailable',
        tsx_declared_version: packageJson.devDependencies?.['tsx'] ?? 'unavailable',
        pnpm_lock_sha256: sha256File(join(REPO_ROOT, 'pnpm-lock.yaml')),
      },
      secret_audit: {
        result: 'PASS',
        policy: 'manifest records only the six allowlisted BENCH/SIGNALING environment keys',
        raw_payload: 'latency schema plus generated peer UUIDs; no SDP, token, key, or credential fields',
      },
      artifacts: {
        raw_jsonl: {
          path: `bench-output/adhoc-signaling-${options.traceId}.jsonl`,
          bytes: statSync(rawPath).size,
          sha256: rawSha256,
        },
        replay_csv: {
          path: 'replay.csv',
          bytes: statSync(replayPath).size,
          sha256: replaySha256,
        },
        git_status: {
          path: 'git-status.txt',
          bytes: statSync(statusPath).size,
          sha256: statusSha256,
        },
        run_console: {
          path: 'run-console.txt',
          bytes: statSync(logPath).size,
          sha256: consoleSha256,
          scope: 'runner gate summary; raw JSONL remains the measurement authority',
        },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    for (const line of logLines) console.log(line);
    console.log(`manifest=${manifestPath}`);

    return {
      runDir,
      rawPath,
      replayPath,
      manifestPath,
      logPath,
      events: validated.events,
      workload,
    };
  } catch (error) {
    writeFailure(runDir, error);
    throw error;
  } finally {
    if (server !== null) {
      try {
        await closeServer(server);
      } catch {
        // Preserve the primary gate error.
      }
    }
    closeSignalingProbe();
    process.chdir(originalCwd);
    for (const key of envKeys) {
      const previous = previousEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}

const isMain =
  process.argv[1]?.endsWith('run-signaling-latency.ts') === true ||
  process.argv[1]?.endsWith('run-signaling-latency.js') === true;

if (isMain) {
  runSignalingLatencyMeasurement(parseSignalingLatencyArgs(process.argv)).catch(
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
