/**
 * Daemon process spawn + ready-wait + teardown — extracted from run-smoke.ts
 * (S25.C.2 split). Owns the 3 daemon specs (cp-daemon, relay,
 * validator-daemon), spawning them as long-lived children, waiting for their
 * readiness signal (port and/or log line), and tearing them down cleanly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { waitForPort, waitForLogLine, type LogStream } from './parsers.ts';

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
