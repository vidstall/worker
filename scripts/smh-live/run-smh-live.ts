/**
 * SMH-LIVE orchestrator — hands-off D1a + D1b + D2 on the native N=3 localnet rig.
 *
 * Flow (RECONCILIATION v2): pre-flight port scan -> boot(flag ON) -> D1a -> teardown ->
 * boot(flag OFF) -> D1b -> attach media fleet -> D2 -> write evidence. D3 is proven
 * hermetically (NOT here). Every on-chain claim is re-read by an independent Sui RPC
 * query (rpc-verify), never a daemon log alone; the daemon logs are only grepped for the
 * `placement_basis` / poller markers.
 *
 * Boot channel: shells `C:\Thesis\dvconf\run-rms-live-local.ps1` (network/deploy/daemons/
 * stop). That script boots the daemons from the MAIN repo `C:\Thesis\dvconf\dvconf-daemons`
 * (branch static-mesh-hardening = the lane under test), reading `dvconf-daemons\.env`. The
 * `deploy` step REWRITES that .env, so the D1a/D1b env injections are appended AFTER `deploy`
 * and BEFORE `daemons`, on each boot.
 *
 * NOT invoked in the write/typecheck batch — the live run is controller-coordinated (Tasks 9-11).
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import {
  createSuiClient,
  loadNetworkConfig,
  executeWithRetry,
  extractCreatedObjectByType,
  createLogger,
  type NetworkConfig,
  type Logger,
} from '../../packages/shared/src/index.js';
import type { SuiClient } from '@mysten/sui/client';
import {
  requiredPorts,
  scanCollisions,
  formatCollisions,
  DEFAULT_PORT_CONFIG,
  DEFAULT_CANARY_COVERAGE_PORT,
} from './ports.js';
import { readAssignedRelays, pollRelayPromoted } from './rpc-verify.js';
import { readPlacementBasis } from './log-asserts.js';
import { assembleEvidence, SMH_LIVE_CAVEATS, type PhaseResult } from './evidence.js';
import { launchFleet } from './media-fleet.js';

// ── Fixed paths / constants (AUDIT Step 5) ─────────────────────────────

const WORKSPACE_ROOT = 'C:\\Thesis\\dvconf';
const RUN_PS1 = path.join(WORKSPACE_ROOT, 'run-rms-live-local.ps1');
const DAEMONS_ENV = path.join(WORKSPACE_ROOT, 'dvconf-daemons', '.env');
const LOGS_DIR = path.join(WORKSPACE_ROOT, '.logs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAOS_PS1 = path.join(HERE, 'chaos.ps1');
const EVIDENCE_PATH = path.resolve(HERE, '..', '..', '.evidence', 'verification', 'static-mesh-hardening-live.md');

const CANARY_PORT = DEFAULT_CANARY_COVERAGE_PORT; // 8105 — outside the 8101-8104 healthz band
const FEED_URL = `http://127.0.0.1:${CANARY_PORT}/canary/load`;
const RELAY_WS_URLS = ['ws://127.0.0.1:4000', 'ws://127.0.0.1:4002', 'ws://127.0.0.1:4004'];
const PRIMARY_WS_PORT = 4000; // relay-1 = registration-first = assigned_relays[0] (ps1 comment)
const STANDBY_WS_PORT = 4002; // heuristic stretch target (see D2)

const BOOT_TIMEOUT_MS = 6 * 60 * 1000;

// ── Small shell + fs boundaries ────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run a `run-rms-live-local.ps1` sub-command (inherits stdio so live output streams). */
function runPs1(action: string, extra: string[] = []): void {
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUN_PS1, action, ...extra],
    { cwd: WORKSPACE_ROOT, stdio: 'inherit', timeout: BOOT_TIMEOUT_MS },
  );
}

/** Run a chaos.ps1 verb; return the last non-empty stdout line (the output contract). */
function chaos(action: 'kill' | 'isopen', port: number): string {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CHAOS_PS1, '-Action', action, '-Port', String(port)],
    { encoding: 'utf8' },
  );
  return out.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
}

/** Append env lines to the daemons `.env` (deploy just rewrote it, so this must run per-boot). */
function injectEnv(lines: string[]): void {
  fs.appendFileSync(DAEMONS_ENV, `\n# --- smh-live injected ---\n${lines.join('\n')}\n`);
}

/** Read the newest `.logs/<prefix>*.log`, split into lines (empty when none yet). */
function newestLogLines(prefix: string): string[] {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
    .map((f) => ({ f, m: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) return [];
  return fs.readFileSync(path.join(LOGS_DIR, files[0]!.f), 'utf8').split(/\r?\n/);
}

// ── Boot / teardown ────────────────────────────────────────────────────

function bootFresh(inject: string[]): void {
  runPs1('network');
  runPs1('deploy'); // REWRITES dvconf-daemons/.env — inject AFTER this
  injectEnv(inject);
  runPs1('daemons', ['-RelayCount', '3', '-ValidatorCount', '4']);
}

function teardown(): void {
  try {
    runPs1('stop');
  } catch {
    // best-effort — never throw from teardown
  }
  // ps1 `stop` intentionally leaves sui alive (AUDIT Step 5) — kill it + the faucet.
  try {
    chaos('kill', 9000);
  } catch {
    /* ignore */
  }
  try {
    chaos('kill', 9123);
  } catch {
    /* ignore */
  }
}

// ── On-chain user-side ops (reuse @dvconf/shared primitives; do NOT hand-roll) ──

/**
 * Reload the freshly-written daemons .env into process.env (OVERRIDE: a prior phase's stale
 * ids must lose — `loadNetworkConfig` only dotenv-loads CWD/../../.env without override), then
 * reuse `loadNetworkConfig` to assemble the NetworkConfig from process.env (not hand-rolled).
 */
function loadFreshConfig(): NetworkConfig {
  const raw = fs.readFileSync(DAEMONS_ENV, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]!] = m[2]!;
  }
  return loadNetworkConfig();
}

async function createFundedUser(logger: Logger): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  await requestSuiFromFaucetV2({ host: getFaucetHost('localnet'), recipient: kp.getPublicKey().toSuiAddress() });
  await sleep(2000); // gas coin queryable before the first TX
  logger.info({ addr: kp.getPublicKey().toSuiAddress() }, 'funded user keypair');
  return kp;
}

async function registerUser(client: SuiClient, kp: Ed25519Keypair, config: NetworkConfig, logger: Logger): Promise<void> {
  await executeWithRetry(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::user_registry::register_user`,
        arguments: [tx.object(config.networkRegistryId), tx.object(config.userRegistryId), tx.pure.vector('u8', [115, 109, 104])],
      });
    },
    'register_user',
    logger,
  );
}

/** create_room (pattern scripts/load-test.ts) → the created Room object id (== RoomAssigned.room_id). */
async function createRoom(client: SuiClient, kp: Ed25519Keypair, config: NetworkConfig, logger: Logger): Promise<string> {
  const result = await executeWithRetry(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(config.userRegistryId),
          tx.pure.u8(0), // relay_mode = SFU
          tx.pure.u64(2), // expected_participants (floors required_validators to 4)
          tx.pure.u8(0), // room_class_hint = small
        ],
      });
    },
    'create_room',
    logger,
  );
  if (!result) throw new Error('create_room failed');
  const roomId = extractCreatedObjectByType(result, '::room_manager::Room');
  if (!roomId) throw new Error('create_room: could not extract Room object id');
  return roomId;
}

/** create_escrow (pattern scripts/load-test.ts:126-159) — the NATIVE placement trigger (EscrowCreated). */
async function createEscrow(client: SuiClient, kp: Ed25519Keypair, config: NetworkConfig, roomId: string, logger: Logger): Promise<void> {
  await executeWithRetry(
    client,
    kp,
    (tx) => {
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000_000n)]); // 1 DVCONF
      tx.moveCall({
        target: `${config.packageId}::economic_layer::create_escrow`,
        arguments: [tx.object(config.networkRegistryId), tx.object(config.roomManagerId), tx.pure.address(roomId), payment!],
      });
    },
    'create_escrow',
    logger,
  );
}

/** Register a fresh user + create a room + create its escrow (the placement trigger). Returns the room id. */
async function seedRoom(client: SuiClient, config: NetworkConfig, logger: Logger): Promise<string> {
  const user = await createFundedUser(logger);
  await registerUser(client, user, config, logger);
  const roomId = await createRoom(client, user, config, logger);
  await createEscrow(client, user, config, roomId, logger);
  return roomId;
}

// ── Feed probe ─────────────────────────────────────────────────────────

async function pollFeed(deadlineMs: number): Promise<{ status: number; relaysEmpty: boolean; raw: string }> {
  const deadline = Date.now() + deadlineMs;
  let last = { status: 0, relaysEmpty: false, raw: '' };
  while (Date.now() < deadline) {
    try {
      const res = await fetch(FEED_URL);
      const raw = await res.text();
      let relaysEmpty = false;
      try {
        const j = JSON.parse(raw) as { relays?: unknown };
        relaysEmpty = Array.isArray(j.relays) && j.relays.length === 0;
      } catch {
        /* not JSON yet */
      }
      last = { status: res.status, relaysEmpty, raw: raw.slice(0, 500) };
      if (res.status === 200) return last;
    } catch {
      /* server not up yet */
    }
    await sleep(3000);
  }
  return last;
}

// ── Phases ─────────────────────────────────────────────────────────────

async function runD1a(logger: Logger): Promise<PhaseResult> {
  const lines: string[] = [];
  const feed = await pollFeed(90_000);
  lines.push(`curl ${FEED_URL} -> HTTP ${feed.status} body=${feed.raw}`);
  const feedOk = feed.status === 200 && feed.relaysEmpty;

  const pollerStarted = newestLogLines('cp-1-').some((l) => l.includes('attested-load poller started'));
  lines.push(`cp log 'attested-load poller started': ${pollerStarted}`);

  const config = loadFreshConfig();
  const client = createSuiClient('localnet');
  const roomId = await seedRoom(client, config, logger);
  lines.push(`room=${roomId} + escrow created (placement trigger)`);

  await sleep(20_000); // let the native cp process EscrowCreated + emit placement_basis
  const basis = readPlacementBasis(newestLogLines('cp-1-'));
  lines.push(`placement_basis=${basis ?? '(none)'} (expected: defer)`);

  const verdict: PhaseResult['verdict'] = feedOk && pollerStarted && basis === 'defer' ? 'PASS' : 'FAIL';
  return { phase: 'D1a', verdict, lines };
}

interface D1bResult {
  phase: PhaseResult;
  roomId: string | null;
  assigned: string[] | null;
  client: SuiClient;
  config: NetworkConfig;
}

async function runD1b(logger: Logger): Promise<D1bResult> {
  const lines: string[] = [];
  const config = loadFreshConfig();
  const client = createSuiClient('localnet');
  const roomId = await seedRoom(client, config, logger);
  lines.push(`room=${roomId} + escrow created`);

  const assigned = await readAssignedRelays(client, config.packageId, roomId, 90_000);
  const distinct = assigned ? new Set(assigned).size : 0;
  lines.push(`RPC readAssignedRelays -> ${JSON.stringify(assigned)} (distinct=${distinct}, expected >=3)`);

  const basis = readPlacementBasis(newestLogLines('cp-1-'));
  lines.push(`placement_basis=${basis ?? '(none)'} (expected: legacy-self-report)`);

  const verdict: PhaseResult['verdict'] =
    assigned !== null && distinct >= 3 && basis === 'legacy-self-report' ? 'PASS' : 'FAIL';
  return { phase: { phase: 'D1b', verdict, lines }, roomId, assigned, client, config };
}

async function runD2(logger: Logger, client: SuiClient, config: NetworkConfig, roomId: string, assigned: string[]): Promise<PhaseResult> {
  const lines: string[] = [];
  const oldPrimary = assigned[0]!;

  const fleet = await launchFleet(RELAY_WS_URLS, roomId);
  lines.push(`fleet: ${fleet.peers.length} peers on ${RELAY_WS_URLS.join(', ')}`);
  await sleep(8_000); // let cross-relay consume establish through the active-forward mesh

  const killOut = chaos('kill', PRIMARY_WS_PORT);
  lines.push(`chaos kill ${PRIMARY_WS_PORT} (assigned_relays[0]=${oldPrimary}) -> ${killOut}`);
  await sleep(2_000);
  const primaryState = chaos('isopen', PRIMARY_WS_PORT);
  lines.push(`relay0 WS ${PRIMARY_WS_PORT} isopen=${primaryState}`);
  const primaryDown = primaryState === 'NOT-OPEN';

  const promo = await pollRelayPromoted(client, config.packageId, roomId, oldPrimary, 120_000);
  lines.push(`RPC pollRelayPromoted(old=${oldPrimary}) -> ${JSON.stringify(promo)}`);

  const after = await readAssignedRelays(client, config.packageId, roomId, 30_000);
  lines.push(`RPC readAssignedRelays after -> ${JSON.stringify(after)}`);
  const replaced = promo !== null && after !== null && after[0] !== oldPrimary && after[0] === promo.newPrimary;

  // Continuity PROXY (VirtualPeer.consumers is private; no deeper media introspection without a
  // further harness edit, which is out of scope): the surviving relay WS ports stay OPEN + the
  // fleet peers homed to them were not torn down.
  const s2 = chaos('isopen', 4002);
  const s3 = chaos('isopen', 4004);
  lines.push(`surviving relays: 4002=${s2} 4004=${s3} (continuity proxy)`);
  const continuity = s2 === 'OPEN' && s3 === 'OPEN';

  // Stretch (best-effort, NON-FATAL): the promotion-dedup is per (room, oldPrimary), so killing the
  // NEW primary should fire a SECOND RelayPromoted. Port selection is heuristic (STANDBY_WS_PORT) —
  // exact minerId->port mapping via info_endpoint_url is a live-exec refinement.
  let stretch = 'not attempted';
  if (promo !== null) {
    try {
      const k2 = chaos('kill', STANDBY_WS_PORT);
      lines.push(`chaos kill ${STANDBY_WS_PORT} (stretch) -> ${k2}`);
      const promo2 = await pollRelayPromoted(client, config.packageId, roomId, promo.newPrimary, 60_000);
      stretch = promo2
        ? `2nd RelayPromoted new_primary=${promo2.newPrimary} epoch=${promo2.epoch}`
        : 'no 2nd promotion (new primary likely not at the probed port — heuristic; non-fatal)';
    } catch (err) {
      stretch = `stretch error (non-fatal): ${String(err)}`;
    }
  }
  lines.push(`stretch: ${stretch}`);

  await fleet.stopAll();

  const verdict: PhaseResult['verdict'] = promo !== null && primaryDown && replaced && continuity ? 'PASS' : 'FAIL';
  return { phase: 'D2', verdict, lines };
}

// ── Orchestration ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const logger = createLogger('smh-live');
  const phases: PhaseResult[] = [];

  // 0. Pre-flight port scan — DETECT-and-ABORT (never bind over a live port).
  const specs = requiredPorts(DEFAULT_PORT_CONFIG);
  const occupied = scanCollisions(specs);
  if (occupied.length > 0) {
    logger.error({ occupied: occupied.length }, 'pre-flight port collision — aborting');
    console.error('SMH-LIVE ABORT — occupied ports:\n' + formatCollisions(occupied));
    process.exit(1);
  }
  logger.info({ scanned: specs.length }, 'pre-flight port scan clean');

  const cellSecret = randomBytes(32).toString('hex');
  const commonInject = [
    `CANARY_CELL_SECRET=${cellSecret}`,
    `VALIDATOR_CANARY_COVERAGE_PORT=${CANARY_PORT}`,
    `RMS_LOAD_FEED_URL=${FEED_URL}`,
    'LOG_PRETTY=false',
  ];

  try {
    // D1a — flag ON (strict no-attestation defer).
    bootFresh([...commonInject, 'RMS_ATTESTED_PLACEMENT=1']);
    phases.push(await runD1a(logger));

    // Teardown between sub-runs (kill sui too — ps1 stop won't).
    teardown();
    await sleep(3_000);

    // D1b — flag OFF (byte-stable K_r>=3 placement).
    bootFresh(commonInject);
    const d1b = await runD1b(logger);
    phases.push(d1b.phase);

    // Fleet + D2 (only if D1b gave us a placed room).
    if (d1b.phase.verdict === 'PASS' && d1b.roomId && d1b.assigned && d1b.assigned.length >= 3) {
      phases.push(await runD2(logger, d1b.client, d1b.config, d1b.roomId, d1b.assigned));
    } else {
      phases.push({ phase: 'D2', verdict: 'FAIL', lines: ['skipped — D1b did not place a room with >=3 relays'] });
    }
  } catch (err) {
    logger.error({ err }, 'orchestrator error');
    phases.push({ phase: 'ERROR', verdict: 'FAIL', lines: [String((err as Error)?.stack ?? err)] });
  } finally {
    teardown();
  }

  const md = assembleEvidence(phases, SMH_LIVE_CAVEATS);
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  fs.writeFileSync(EVIDENCE_PATH, md);
  const overall = phases.every((p) => p.verdict === 'PASS');
  logger.info({ evidencePath: EVIDENCE_PATH, overall }, 'evidence written');
  process.exit(overall ? 0 : 1);
}

const isMain =
  process.argv[1]?.endsWith('run-smh-live.ts') === true || process.argv[1]?.endsWith('run-smh-live.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
