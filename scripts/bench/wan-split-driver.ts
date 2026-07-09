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
  e2ee: string;
  // Fixed relay room to join for EVERY session, overriding the default `wan-<i>`.
  // WHY: the relay's standby cross-forward (RMS_ACTIVE_FORWARD) is keyed to the
  // ON-CHAIN assigned room id (RoomAssigned.room_id, a 0x… object id), NOT an
  // arbitrary string. To make media cross the R1→R2 warm pipe the produce+consume
  // legs must join THAT assigned room. `trace`/JSONL row separation still uses
  // `wan-<i>` so per-session assembly is unchanged. Null → legacy `wan-<i>` room.
  roomOverride: string | null;
}

export function parseArgs(argv: string[]): DriverOpts {
  // A missing value OR a neighbouring `--flag` (operator forgot the value) →
  // fall back to the default rather than silently swallowing the next flag.
  const g = (k: string, d: string): string => {
    const i = argv.indexOf(`--${k}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith('--') ? v : d;
  };
  // Numeric flag with a NaN guard — a typo (`--window-ms foo`) must ERROR, not
  // become NaN and make every setTimeout fire immediately (silent zero-windows).
  const num = (k: string, d: number): number => {
    const raw = g(k, String(d));
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be an integer (got "${raw}").`);
    return n;
  };

  const rawRole = g('role', '');
  const { role, relayPin, distinguishable } = parseRole(rawRole);

  const startRaw = g('start-epoch', '');
  const startEpochMs = parseInt(startRaw, 10);
  if (!startRaw || !Number.isFinite(startEpochMs)) {
    throw new Error(
      '--start-epoch <epoch-ms> is REQUIRED and must be IDENTICAL on both machines ' +
        '(the shared wall-clock anchor). Compute once with `node -e "console.log(Date.now()+120000)"` and pass the same value to both.',
    );
  }

  const windowMs = num('window-ms', 25000); // per-session budget (~23 samples/session at 1 Hz after teardown)
  const teardownMs = num('teardown-ms', 2000); // margin before window end to close the context cleanly
  if (teardownMs >= windowMs) {
    throw new Error(`--teardown-ms (${teardownMs}) must be < --window-ms (${windowMs}), else every session is zero-length.`);
  }

  return {
    role,
    relayPin,
    distinguishable,
    startEpochMs,
    windowMs,
    teardownMs,
    sessions: num('sessions', 30),
    pageBase: g('page', 'http://localhost:5173/bench/wan-measure-page.html'),
    relay: g('relay', 'ws://localhost:4000'),
    bench: g('bench', 'http://localhost:8081'),
    realCamera: argv.includes('--real-camera'),
    peerPrefix: g('peer-prefix', role),
    e2ee: g('e2ee', 'off'), // passthrough to both legs (ON-vs-OFF glass-to-glass); default off = plaintext
    roomOverride: (() => {
      const r = g('room', '');
      return r ? r : null;
    })(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Build the bench-page URL for session `i`'s role+room. Pure (no browser) so the
 * flag→query wiring is unit-testable. `trace` separates JSONL rows by `wan-<i>`
 * even when `roomOverride` pins the actual relay room to the on-chain assigned id.
 */
export function buildSessionUrl(o: DriverOpts, i: number): string {
  const traceRoom = `wan-${i}`;
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
async function openSession(ctx: BrowserContext, o: DriverOpts, i: number): Promise<void> {
  const traceRoom = `wan-${i}`;
  const page = await ctx.newPage();

  // Surface the page's own logs — including consumeRemote's rendezvous-timeout
  // fatal — so the operator sees per-session success/failure live.
  page.on('console', (msg) => console.log(`[${o.role} ${traceRoom}] ${msg.text()}`));
  page.on('pageerror', (err) => console.log(`[${o.role} ${traceRoom}] PAGEERROR ${err.message}`));

  // Clamp a navigation hang to within this session's window (default goto
  // timeout is 30s, which can exceed windowMs) so the wall-clock bound is real.
  await page.goto(buildSessionUrl(o, i), { timeout: Math.max(1000, o.windowMs - o.teardownMs) });
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  // Print the schedule up front so both operators can eyeball alignment.
  const lastEnd = o.startEpochMs + o.sessions * o.windowMs;
  console.log(
    `wan-split-driver: role=${o.role} sessions=${o.sessions} window=${o.windowMs}ms\n` +
      `  anchor  E = ${o.startEpochMs} (${new Date(o.startEpochMs).toISOString()})\n` +
      `  last end  = ${lastEnd} (${new Date(lastEnd).toISOString()})\n` +
      `  relay=${o.relay} bench=${o.bench} page=${o.pageBase}`,
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
        console.log(`session ${i + 1}/${o.sessions} (${`wan-${i}`}) SKIPPED — window elapsed`);
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
        await openSession(ctx, o, i);
        await sleep(closeAt - Date.now());
        ran++;
        console.log(`session ${i + 1}/${o.sessions} (${`wan-${i}`}) done`);
      } catch (err) {
        failed++;
        console.log(`session ${i + 1}/${o.sessions} (${`wan-${i}`}) FAILED — ${(err as Error).message}`);
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
}

// Guard: only run as entrypoint, not when imported by tests.
if (process.argv[1] && (process.argv[1].endsWith('wan-split-driver.ts') || process.argv[1].endsWith('wan-split-driver.js'))) {
  main().catch((err) => {
    console.error('wan-split-driver fatal:', err);
    process.exitCode = 1;
  });
}
