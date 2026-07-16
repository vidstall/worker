// wan-split-driver.ts — 2-machine SPLIT driver for the WAN glass-to-glass run (Lane A).
//
// WHY split: `wan-playwright-driver.ts` runs BOTH peers in ONE process on ONE
// machine, so both last-mile legs share a single ISP (probe gap G2). To measure
// two REAL, DISTINCT ISPs, run this on two machines:
//   Machine A (ISP-1):  tsx scripts/bench/wan-split-driver.ts --role produce  --start-epoch <E> --relay ws://<VM>:4000 --bench http://<VM>:8081 --page http://<VM>:5173/bench/wan-measure-page.html
//   Machine B (ISP-2):  tsx scripts/bench/wan-split-driver.ts --role consume  --start-epoch <E> --relay ws://<VM>:4000 --bench http://<VM>:8081 --page http://<VM>:5173/bench/wan-measure-page.html
// where <E> is ONE shared wall-clock epoch-ms both operators pass verbatim
// (e.g. `node -e "console.log(Date.now()+120000)"` on one machine → 2 min lead).
//
// SYNC MODEL — absolute-time windows (no A<->B coordination channel):
//   Session i owns the wall-clock window [E + i*window, E + (i+1)*window).
//   Both machines compute the room index (`wan-<i>`) FROM THE CLOCK, so they
//   land in the SAME room at the SAME time without any handshake. Drift is
//   absolute (anchored to E), not cumulative; Azure NTP keeps skew sub-second,
//   and the consumer's `newProducer` wait (bench/wan-measure.ts, 30 s) absorbs
//   the rest. The producer/consumer rendezvous is RELAY-MEDIATED (the relay's
//   `newProducer` fan-out), which is exactly what wan-measure.ts consumeRemote
//   already consumes — no direct peer-to-peer channel exists or is needed.
//
// PER-SESSION WALL-CLOCK (satisfies the H1 6b deferral): each session's browser
// context is force-closed at the window boundary, so ANY hang (join, produce,
// consume, collector) is bounded — a stuck session cannot stall the whole run.
//
// Sessions pool into the ONE signaling bench JSONL; separate them by
// context.room_id (= `wan-<i>`) with join-g2g.ts (one row per session + p95).

import { chromium, type BrowserContext } from 'playwright';

type Role = 'produce' | 'consume';
type E2eeMode = 'on' | 'off';

export function parseRole(raw: string): { role: Role; relayPin: 'standby' | null; distinguishable: boolean } {
  switch (raw) {
    case 'produce':         return { role: 'produce', relayPin: null,       distinguishable: false };
    case 'produce-id':      return { role: 'produce', relayPin: null,       distinguishable: true  };
    case 'consume':         return { role: 'consume', relayPin: null,       distinguishable: false };
    case 'consume-standby': return { role: 'consume', relayPin: 'standby',  distinguishable: false };
    case 'consume-id':         return { role: 'consume', relayPin: null,      distinguishable: true  };
    case 'consume-standby-id': return { role: 'consume', relayPin: 'standby', distinguishable: true  };
    default: throw new Error(`--role must be one of produce|produce-id|consume|consume-standby|consume-id|consume-standby-id, got "${raw}"`);
  }
}

interface DriverOpts {
  role: Role;
  relayPin: 'standby' | null;
  distinguishable: boolean;
  startEpochMs: number;
  windowMs: number;
  teardownMs: number;
  sessions: number;
  pageBase: string;
  relay: string;
  bench: string;
  realCamera: boolean;
  peerPrefix: string;
  // E2EE toggle passed straight through to the bench page (?e2ee=<on|off>).
  // wan-measure.ts reads `q.get('e2ee') === 'on'` and, when on, attaches the
  // real SFrame transform to BOTH legs — mirrors wan-playwright-driver.ts.
  // Default 'off' preserves plaintext behavior for callers that don't pass it.
  e2ee: E2eeMode;
  // Fixed relay room to join for EVERY session, overriding the default `wan-<i>`.
  // WHY: the relay's standby cross-forward (RMS_ACTIVE_FORWARD) is keyed to the
  // ON-CHAIN assigned room id (RoomAssigned.room_id, a 0x… object id), NOT an
  // arbitrary string. To make media cross the R1→R2 warm pipe the produce+consume
  // legs must join THAT assigned room. `trace`/JSONL row separation still uses
  // `wan-<i>` so per-session assembly is unchanged. Null → legacy `wan-<i>` room.
  roomOverride: string | null;
  // Per-session room-name prefix (session i joins `<roomPrefix><i>` and its JSONL
  // rows carry that as context.room_id). Default 'wan-' preserves the historical
  // `wan-<i>` naming byte-for-byte for every existing caller; the P2 scheduler
  // passes e.g. `p2b0off-` so each sub-run's rooms encode arm+block (plan
  // 2026-07-16-p2-vm-only-cloud-wan-e2ee-window.md — rooms are never `wan-*`).
  roomPrefix: string;
}

export function parseArgs(argv: string[]): DriverOpts {
  // A missing value OR a neighbouring `--flag` (operator forgot the value) →
  // strict parsing below rejects it instead of silently changing the declared arm.
  const valueFlags = new Set([
    '--role', '--start-epoch', '--window-ms', '--teardown-ms', '--sessions',
    '--page', '--relay', '--bench', '--peer-prefix', '--e2ee', '--room',
    '--room-prefix',
  ]);
  const switchFlags = new Set(['--real-camera']);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!flag.startsWith('--')) throw new Error(`unexpected positional argument: ${flag}`);
    if (switchFlags.has(flag)) {
      if (switches.has(flag)) throw new Error(`duplicate option: ${flag}`);
      switches.add(flag);
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`unknown option: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    values.set(flag, value);
    i += 1;
  }

  const g = (k: string, d: string): string => values.get(`--${k}`) ?? d;
  // Numeric flag with a NaN guard — a typo (`--window-ms foo`) must ERROR, not
  // become NaN and make every setTimeout fire immediately (silent zero-windows).
  const num = (k: string, d: number, minimum: number): number => {
    const raw = g(k, String(d));
    if (!/^-?\d+$/.test(raw)) {
      throw new Error(`--${k} must be a strict integer (got "${raw}").`);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < minimum) {
      throw new Error(`--${k} must be >= ${minimum} (got "${raw}").`);
    }
    return n;
  };

  const rawRole = g('role', '');
  const { role, relayPin, distinguishable } = parseRole(rawRole);

  const startRaw = g('start-epoch', '');
  if (!/^\d+$/.test(startRaw)) {
    throw new Error(
      '--start-epoch <epoch-ms> is REQUIRED and must be IDENTICAL on both machines ' +
        '(the shared wall-clock anchor). Compute once with `node -e "console.log(Date.now()+120000)"` and pass the same value to both.',
    );
  }
  const startEpochMs = Number(startRaw);
  if (!Number.isSafeInteger(startEpochMs) || startEpochMs <= 0) {
    throw new Error('--start-epoch must be a positive safe integer epoch-ms value');
  }

  const windowMs = num('window-ms', 25000, 1); // per-session budget (~23 samples/session at 1 Hz after teardown)
  const teardownMs = num('teardown-ms', 2000, 0); // margin before window end to close the context cleanly
  const sessions = num('sessions', 30, 1);
  if (teardownMs >= windowMs) {
    throw new Error(`--teardown-ms (${teardownMs}) must be < --window-ms (${windowMs}), else every session is zero-length.`);
  }
  if (windowMs - teardownMs < 1000) {
    throw new Error('--window-ms minus --teardown-ms must leave at least 1000ms of session budget');
  }

  const e2eeRaw = g('e2ee', 'off');
  if (e2eeRaw !== 'on' && e2eeRaw !== 'off') {
    throw new Error(`--e2ee must be either on or off (got "${e2eeRaw}").`);
  }

  // Default 'wan-' keeps every existing caller's room names (`wan-<i>`) unchanged.
  // An EMPTY prefix would name rooms bare `0`,`1`,… — reject it so an operator
  // typo can never silently drop the arm/block encoding from the room ids.
  const roomPrefix = g('room-prefix', 'wan-');
  if (roomPrefix.length === 0) {
    throw new Error('--room-prefix must be a non-empty string (e.g. "wan-" or "p2b0off-").');
  }

  return {
    role,
    relayPin,
    distinguishable,
    startEpochMs,
    windowMs,
    teardownMs,
    sessions,
    pageBase: g('page', 'http://localhost:5173/bench/wan-measure-page.html'),
    relay: g('relay', 'ws://localhost:4000'),
    bench: g('bench', 'http://localhost:8081'),
    realCamera: switches.has('--real-camera'),
    peerPrefix: g('peer-prefix', role),
    e2ee: e2eeRaw, // passthrough to both legs (ON-vs-OFF glass-to-glass); default off = plaintext
    roomOverride: (() => {
      const r = g('room', '');
      return r ? r : null;
    })(),
    roomPrefix,
  };
}

/** Classify console proof that this client's requested E2EE leg was attached. */
export function classifyE2eeAttachment(
  role: Role,
  message: string,
): 'attached' | 'missing' | null {
  const success =
    role === 'produce'
      ? '[wan-measure] E2EE encrypt attached'
      : '[wan-measure] E2EE decrypt attached';
  if (message.includes(success)) return 'attached';
  if (message.includes('[wan-measure] fatal:')) return 'missing';
  if (
    message.includes('[wan-measure] E2EE') &&
    message.includes('attachment FAILED')
  ) {
    return 'missing';
  }
  if (
    message.includes('[wan-measure] e2ee=on') &&
    (message.includes('NOT encrypted') || message.includes('NOT decrypted'))
  ) {
    return 'missing';
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function remainingSessionBudget(closeAtMs: number, nowMs = Date.now()): number {
  const remainingMs = closeAtMs - nowMs;
  if (remainingMs <= 0) {
    throw new Error(`session attachment deadline already elapsed by ${Math.abs(remainingMs)}ms`);
  }
  return remainingMs;
}

/**
 * Build the bench-page URL for session `i`'s role+room. Pure (no browser) so the
 * flag→query wiring is unit-testable. `trace` separates JSONL rows by `wan-<i>`
 * even when `roomOverride` pins the actual relay room to the on-chain assigned id.
 */
export function buildSessionUrl(o: DriverOpts, i: number): string {
  const traceRoom = `${o.roomPrefix}${i}`;
  // The relay room actually JOINED: the on-chain assigned room when overridden,
  // else the per-session `wan-<i>`. Cross-relay forwarding needs the assigned id.
  const room = o.roomOverride ?? traceRoom;

  const u = new URL(o.pageBase);
  u.searchParams.set('role', o.role);
  u.searchParams.set('trace', traceRoom); // consumed by getTraceId() in rtcstats-collector.ts → JSONL trace_id
  u.searchParams.set('room', room);
  u.searchParams.set('relay', o.relay);
  u.searchParams.set('bench', o.bench);
  u.searchParams.set('peer', `${o.peerPrefix}-${i}`);
  u.searchParams.set('e2ee', o.e2ee); // both legs get the same flag (ON-vs-OFF glass-to-glass); mirrors wan-playwright-driver.ts
  if (o.realCamera) u.searchParams.set('camera', 'real');
  if (o.relayPin === 'standby') u.searchParams.set('relayPin', 'standby');
  if (o.distinguishable) u.searchParams.set('distinguishable', '1');
  if (o.distinguishable) u.searchParams.set('streamId', String(i));
  return u.toString();
}

/**
 * Open the bench page for one session's role+room in the GIVEN context and pipe
 * its console to stdout. The caller owns `ctx` (created before this call) so a
 * throw from newPage/goto still leaves the context tracked + closeable in the
 * caller's finally — no leaked context on the failure path.
 */
async function openSession(
  ctx: BrowserContext,
  o: DriverOpts,
  i: number,
  closeAtMs: number,
): Promise<void> {
  const traceRoom = `${o.roomPrefix}${i}`;
  const page = await ctx.newPage();

  let attachmentSettled = false;
  let resolveAttachment: (() => void) | null = null;
  let rejectAttachment: ((error: Error) => void) | null = null;
  const attachment =
    o.e2ee === 'on'
      ? new Promise<void>((resolve, reject) => {
          resolveAttachment = resolve;
          rejectAttachment = reject;
        })
      : null;
  // A page can emit a failure while navigation is still pending. Attach a
  // rejection observer immediately; the original promise remains rejected and
  // is still consumed by the later race.
  void attachment?.catch(() => {});

  // Surface the page's own logs — including consumeRemote's rendezvous-timeout
  // fatal — so the operator sees per-session success/failure live.
  page.on('console', (msg) => {
    const text = msg.text();
    console.log(`[${o.role} ${traceRoom}] ${text}`);
    if (attachmentSettled || attachment === null) return;
    const evidence = classifyE2eeAttachment(o.role, text);
    if (evidence === 'attached') {
      attachmentSettled = true;
      resolveAttachment?.();
    } else if (evidence === 'missing') {
      attachmentSettled = true;
      rejectAttachment?.(
        new Error(`E2EE ${o.role} transform was not attached for ${traceRoom}`),
      );
    }
  });
  page.on('pageerror', (err) => console.log(`[${o.role} ${traceRoom}] PAGEERROR ${err.message}`));

  // Clamp a navigation hang to within this session's window (default goto
  // timeout is 30s, which can exceed windowMs) so the wall-clock bound is real.
  try {
    await page.goto(buildSessionUrl(o, i), {
      timeout: remainingSessionBudget(closeAtMs),
    });
    if (attachment !== null) {
      const remainingMs = remainingSessionBudget(closeAtMs);
      await Promise.race([
        attachment,
        sleep(remainingMs).then(() => {
          throw new Error(
            `Timed out waiting for E2EE ${o.role} attachment evidence for ${traceRoom}`,
          );
        }),
      ]);
    }
  } catch (error) {
    void attachment?.catch(() => {});
    throw error;
  }
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  // Print the schedule up front so both operators can eyeball alignment.
  const lastEnd = o.startEpochMs + o.sessions * o.windowMs;
  console.log(
    `wan-split-driver: role=${o.role} sessions=${o.sessions} window=${o.windowMs}ms\n` +
      `  anchor  E = ${o.startEpochMs} (${new Date(o.startEpochMs).toISOString()})\n` +
      `  last end  = ${lastEnd} (${new Date(lastEnd).toISOString()})\n` +
      `  relay=${o.relay} bench=${o.bench} page=${o.pageBase} e2ee=${o.e2ee} rooms=${o.roomPrefix}<i>`,
  );
  if (Date.now() > o.startEpochMs) {
    console.log(
      `  WARNING: E is already in the past by ${Date.now() - o.startEpochMs}ms — sessions whose window elapsed will be SKIPPED. ` +
        `Both machines must start before E; pick a later --start-epoch.`,
    );
  }

  const flags = o.realCamera ? [] : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  const browser = await chromium.launch({ args: flags });

  let ran = 0;
  let skipped = 0;
  let failed = 0;
  try {
    for (let i = 0; i < o.sessions; i++) {
      const windowStart = o.startEpochMs + i * o.windowMs;
      const windowEnd = windowStart + o.windowMs;
      const closeAt = windowEnd - o.teardownMs;

      // The window already elapsed (this machine started late) → skip to stay
      // clock-aligned with the other machine rather than run a lone half.
      if (Date.now() >= windowEnd) {
        skipped++;
        console.log(`session ${i + 1}/${o.sessions} (${`${o.roomPrefix}${i}`}) SKIPPED — window elapsed`);
        continue;
      }

      // Wait for this session's window to open (both machines gate on the same E).
      await sleep(windowStart - Date.now());

      // Per-session isolation: a failure (page.goto refused, relay blip, a
      // page-side throw) must NOT abort the remaining sessions. Log it and let
      // the loop re-align on the NEXT window's `windowStart` gate. The context
      // is force-closed in `finally` — this is the per-session wall-clock that
      // bounds any page-side hang OR throw.
      let ctx: BrowserContext | null = null;
      try {
        ctx = await browser.newContext();
        await openSession(ctx, o, i, closeAt);
        await sleep(closeAt - Date.now());
        ran++;
        console.log(`session ${i + 1}/${o.sessions} (${`${o.roomPrefix}${i}`}) done`);
      } catch (err) {
        failed++;
        console.log(`session ${i + 1}/${o.sessions} (${`${o.roomPrefix}${i}`}) FAILED — ${(err as Error).message}`);
      } finally {
        if (ctx) await ctx.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }

  console.log(
    `\nAll windows processed: ${ran} ran, ${failed} failed, ${skipped} skipped.` +
      (o.role === 'consume'
        ? `\nAssemble the run with join-g2g.ts → one row per context.room_id (wan-<i>) + per-session p50/p95/p99.`
        : `\n(produce side emits send-leg RTCStats; assemble on the machine that collected both, or pool JSONLs.)`),
  );

  if (failed > 0 || skipped > 0 || ran !== o.sessions) {
    throw new Error(
      `Incomplete WAN arm: expected ${o.sessions} successful sessions, got ` +
        `${ran} ran, ${failed} failed, ${skipped} skipped.`,
    );
  }
}

// Guard: only run as entrypoint, not when imported by tests.
if (process.argv[1] && (process.argv[1].endsWith('wan-split-driver.ts') || process.argv[1].endsWith('wan-split-driver.js'))) {
  main().catch((err) => {
    console.error('wan-split-driver fatal:', err);
    process.exitCode = 1;
  });
}
