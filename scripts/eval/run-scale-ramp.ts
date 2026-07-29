/**
 * scripts/eval/run-scale-ramp.ts — scalability load-ramp harness.
 *
 * Drives a REAL, already-deployed bot daemon's HTTP control API
 * (`POST /bots/pool`, see apps/bot/src/server.ts) to ramp concurrent bot
 * sessions through a sequence of strictly-increasing step target counts,
 * holding each step so Prometheus's normal scrape cadence captures
 * steady-state `dvconf_active_sessions`/CPU/RSS/`dvconf_bot_join_phase_seconds`
 * numbers from the fleet itself (see the "Scalability" row of the
 * xaisen-academic-eval Grafana dashboard). This script does NOT read those
 * series back -- it only drives the ramp and pushes its OWN
 * client-observed pool-launch-latency/failure summary per step to the
 * Pushgateway (`packages/shared/src/metrics-prom.ts`'s `pushToGateway()`),
 * for a discrete "load-test step results" table alongside the live series.
 *
 * Unlike `scripts/stress/signaling-stress.ts` (boots an in-process protocol-
 * level driver, no chain/mediasoup), this targets a REAL deployed bot over
 * HTTP -- every launched session is a real on-chain-registered participant
 * with real ffmpeg/mediasoup resource cost, same as a human clicking
 * "launch bot" in the admin dashboard, just scripted and ramped.
 *
 * Cleans up (DELETEs) only the bot sessions THIS run launched, tracked by
 * id -- never touches pre-existing sessions from other operators/runs.
 *
 * Usage:
 *   pnpm tsx scripts/eval/run-scale-ramp.ts \
 *     --bot-url https://bot.1-2-3-4.sslip.io \
 *     --bot-token "$BOT_CONTROL_TOKEN" \
 *     --steps 1,5,10,20,40 \
 *     --hold-sec 60 \
 *     --pushgateway-url https://pushgateway.1-2-3-4.sslip.io \
 *     --pushgateway-token "$METRICS_AUTH_TOKEN"
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pushToGateway } from '@dvconf/shared';

// Mirrors apps/bot/src/server.ts's own MAX_POOL_COUNT -- a single
// /bots/pool call can't exceed this, so a step bigger than it needs
// multiple calls.
const MAX_POOL_COUNT = 25;

type RoomMode = 'create' | 'join';
type MediaMode = 'listen' | 'camera' | 'mic' | 'both';

interface Args {
  botUrl: string;
  botToken: string;
  steps: number[];
  holdSec: number;
  roomMode: RoomMode;
  mediaMode: MediaMode;
  pushgatewayUrl?: string;
  pushgatewayToken?: string;
  runId: string;
}

function need(argv: string[], i: number, flag: string): [string, number] {
  const v = argv[i];
  if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
  return [v, i + 1];
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    botUrl: '',
    botToken: '',
    steps: [1, 5, 10, 20],
    holdSec: 60,
    roomMode: 'create',
    mediaMode: 'listen',
    runId: randomUUID(),
  };
  let i = 0;
  while (i < argv.length) {
    const flag = argv[i]!;
    i++;
    if (flag === '--bot-url') [args.botUrl, i] = need(argv, i, flag);
    else if (flag === '--bot-token') [args.botToken, i] = need(argv, i, flag);
    else if (flag === '--steps') {
      let raw: string;
      [raw, i] = need(argv, i, flag);
      args.steps = raw.split(',').map((s) => {
        const n = Number(s.trim());
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--steps: invalid step "${s}"`);
        return n;
      });
    } else if (flag === '--hold-sec') {
      let raw: string;
      [raw, i] = need(argv, i, flag);
      args.holdSec = Number(raw);
    } else if (flag === '--room-mode') {
      let raw: string;
      [raw, i] = need(argv, i, flag);
      args.roomMode = raw as RoomMode;
    } else if (flag === '--media-mode') {
      let raw: string;
      [raw, i] = need(argv, i, flag);
      args.mediaMode = raw as MediaMode;
    } else if (flag === '--pushgateway-url') [args.pushgatewayUrl, i] = need(argv, i, flag);
    else if (flag === '--pushgateway-token') [args.pushgatewayToken, i] = need(argv, i, flag);
    else if (flag === '--run-id') [args.runId, i] = need(argv, i, flag);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.botUrl === '') throw new Error('--bot-url is required');
  for (let k = 1; k < args.steps.length; k++) {
    if (args.steps[k]! <= args.steps[k - 1]!) throw new Error('--steps must be strictly increasing');
  }
  return args;
}

interface PoolCallResult {
  launchedIds: string[];
  failures: number;
  wallMs: number;
}

async function launchPoolBatch(
  args: Args,
  count: number,
): Promise<PoolCallResult> {
  const t0 = Date.now();
  const res = await fetch(`${args.botUrl}/bots/pool`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(args.botToken ? { authorization: `Bearer ${args.botToken}` } : {}),
    },
    body: JSON.stringify({ roomMode: args.roomMode, mediaMode: args.mediaMode, count }),
  });
  const wallMs = Date.now() - t0;
  if (!res.ok && res.status !== 201) {
    throw new Error(`POST /bots/pool failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    launched: { botId: string }[];
    failed: { error: string }[];
  };
  return { launchedIds: body.launched.map((b) => b.botId), failures: body.failed.length, wallMs };
}

/** Launch `count` NEW bots (on top of whatever's already running), split into MAX_POOL_COUNT-sized batches. */
async function launchStep(args: Args, count: number): Promise<{ ids: string[]; failures: number; wallMsSamples: number[] }> {
  const ids: string[] = [];
  const wallMsSamples: number[] = [];
  let failures = 0;
  let remaining = count;
  while (remaining > 0) {
    const batch = Math.min(remaining, MAX_POOL_COUNT);
    const result = await launchPoolBatch(args, batch);
    ids.push(...result.launchedIds);
    failures += result.failures;
    wallMsSamples.push(result.wallMs);
    remaining -= batch;
  }
  return { ids, failures, wallMsSamples };
}

async function stopBot(args: Args, id: string): Promise<void> {
  try {
    await fetch(`${args.botUrl}/bots/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: args.botToken ? { authorization: `Bearer ${args.botToken}` } : {},
    });
  } catch {
    // Best-effort cleanup -- a failed DELETE here just leaves a stray bot
    // session running, not a correctness issue for the measurement already
    // recorded.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pct(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1));
  return sorted[i]!;
}

interface StepReport {
  step: number;
  newlyLaunched: number;
  failures: number;
  poolLaunchMsP50: number;
  poolLaunchMsP95: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allLaunchedIds: string[] = [];
  const stepReports: StepReport[] = [];

  console.log('='.repeat(60));
  console.log('Scale-ramp load-test harness');
  console.log('='.repeat(60));
  console.log(`  bot url:       ${args.botUrl}`);
  console.log(`  steps:         ${args.steps.join(' -> ')}`);
  console.log(`  hold per step: ${args.holdSec}s`);
  console.log(`  run_id:        ${args.runId}`);
  console.log('');

  let currentCount = 0;
  for (const target of args.steps) {
    const toLaunch = target - currentCount;
    console.log(`[step ${target}] launching ${toLaunch} more bot(s) (${currentCount} -> ${target})…`);
    const { ids, failures, wallMsSamples } = await launchStep(args, toLaunch);
    allLaunchedIds.push(...ids);
    currentCount += ids.length;

    const report: StepReport = {
      step: target,
      newlyLaunched: ids.length,
      failures,
      poolLaunchMsP50: pct(wallMsSamples, 0.5),
      poolLaunchMsP95: pct(wallMsSamples, 0.95),
    };
    stepReports.push(report);
    console.log(
      `[step ${target}] launched ${ids.length}/${toLaunch} (${failures} failed), ` +
        `pool-launch-call p50/p95: ${report.poolLaunchMsP50}ms / ${report.poolLaunchMsP95}ms`,
    );

    if (args.pushgatewayUrl) {
      await pushToGateway({
        baseUrl: args.pushgatewayUrl,
        job: 'xaisen_loadtest',
        instance: args.runId,
        groupingLabels: { step: String(target) },
        token: args.pushgatewayToken,
        metrics: [
          { name: 'dvconf_loadtest_step_participants', help: 'Target participant count for this step', value: target },
          { name: 'dvconf_loadtest_step_launched', help: 'Bots actually launched this step', value: ids.length },
          { name: 'dvconf_loadtest_step_failures', help: 'Bot launch failures this step', value: failures },
          { name: 'dvconf_loadtest_step_pool_launch_ms_p50', help: 'POST /bots/pool call latency p50 (ms)', value: report.poolLaunchMsP50 },
          { name: 'dvconf_loadtest_step_pool_launch_ms_p95', help: 'POST /bots/pool call latency p95 (ms)', value: report.poolLaunchMsP95 },
        ],
      });
    }

    console.log(`[step ${target}] holding for ${args.holdSec}s (steady-state window for Prometheus scrapes)…`);
    await sleep(args.holdSec * 1000);
  }

  console.log('');
  console.log('-'.repeat(60));
  console.log('cleaning up — stopping all bots this run launched…');
  await Promise.all(allLaunchedIds.map((id) => stopBot(args, id)));

  console.log('-'.repeat(60));
  console.log('RESULTS');
  console.log('-'.repeat(60));
  for (const r of stepReports) {
    console.log(
      `  step ${String(r.step).padStart(4)}: launched ${r.newlyLaunched}, failures ${r.failures}, ` +
        `pool-launch p50/p95 ${r.poolLaunchMsP50}ms/${r.poolLaunchMsP95}ms`,
    );
  }
  console.log('='.repeat(60));

  const hadFailures = stepReports.some((r) => r.failures > 0);
  process.exit(hadFailures ? 1 : 0);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((err) => {
    console.error('run-scale-ramp crashed:', err);
    process.exit(2);
  });
}
