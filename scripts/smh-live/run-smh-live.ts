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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import {
  createSuiClient,
  loadNetworkConfig,
  executeWithRetry,
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
import { readAssignedRelays, pollRelayPromoted, resolveRelayWsPort } from './rpc-verify.js';
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
const RELAY_WS_PORTS = [4000, 4002, 4004]; // the native rig's relay WS ports (fleet homes one peer per port)

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
  // `sui start --force-regenesis` intermittently exceeds the ps1's 120s RPC-ready poll on a
  // contended host (documented flake in localnet-fixture) -> the ps1 `network` step exits 1. Retry
  // it (kill the half-booted sui first) rather than failing the whole run. deploy/daemons are
  // deterministic once the chain is up.
  const NETWORK_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      runPs1('network');
      break;
    } catch (err) {
      if (attempt >= NETWORK_ATTEMPTS) throw err;
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
  }
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
  const setKeys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) {
      process.env[m[1]!] = m[2]!;
      setKeys.push(m[1]!);
    }
  }
  const config = loadNetworkConfig();
  // CRITICAL (D1b fix): delete the keys we just set so they DON'T leak into the NEXT boot's ps1
  // daemon children. execFileSync inherits THIS process.env, and the daemons' dotenv is
  // override:false — an inherited stale PACKAGE_ID from the prior phase's (torn-down, regenesis'd)
  // chain would win over the fresh .env, making every daemon fail "Package object does not exist"
  // (registration stuck at 0/0/0). The returned `config` is a plain object, so cleanup is safe.
  for (const k of setKeys) delete process.env[k];
  return config;
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
  // create_room stores the room in the RoomManager TABLE (no standalone Room object — verified
  // room_manager.move + rms-live-local test), so the id comes from the RoomCreated event, NOT
  // extractCreatedObjectByType. Normalize so it matches rpc-verify's normalized RoomAssigned.room_id.
  const events = result.events ?? [];
  const evt = events.find(
    (e) => typeof e['type'] === 'string' && (e['type'] as string).includes('::room_manager::RoomCreated'),
  );
  const rawRoomId = (evt?.['parsedJson'] as { room_id?: unknown } | undefined)?.room_id;
  if (typeof rawRoomId !== 'string') throw new Error('create_room: RoomCreated event missing room_id');
  return normalizeSuiAddress(rawRoomId);
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

// ── Registration readiness (devInspect active-count getters) ───────────

/** devInspect a `public fun <module>::<fn>(&Registry): u64` and parse the u64 (LE bytes). */
async function activeCount(client: SuiClient, packageId: string, moduleFn: string, registryId: string): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::${moduleFn}`, arguments: [tx.object(registryId)] });
  const res = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });
  const bytes = (res.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[];
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n += bytes[i]! * Math.pow(256, i);
  return n;
}

interface ActiveCounts {
  relays: number;
  validators: number;
  signaling: number;
}

/**
 * Poll on-chain active counts until >=3 relays + >=4 validators (ballot floor) + >=1 signaling, or
 * deadline. The native daemons self-register asynchronously (voting flow) AFTER `daemons` returns;
 * seeding the room BEFORE they are up makes the cp defer at "No relays available" and the escrow
 * re-drive only fires on RelayRegistered (NOT ValidatorRegistered), so we must gate on full readiness.
 */
async function waitForRegistration(client: SuiClient, config: NetworkConfig, logger: Logger, deadlineMs: number): Promise<ActiveCounts> {
  const deadline = Date.now() + deadlineMs;
  let counts: ActiveCounts = { relays: 0, validators: 0, signaling: 0 };
  while (Date.now() < deadline) {
    try {
      counts = {
        relays: await activeCount(client, config.packageId, 'relay_registry::active_count', config.relayRegistryId),
        validators: await activeCount(client, config.packageId, 'validator_registry::active_count', config.validatorRegistryId),
        signaling: await activeCount(client, config.packageId, 'signaling_registry::active_signaling_count', config.signalingRegistryId),
      };
      logger.info({ ...counts }, 'registration readiness poll');
      if (counts.relays >= 3 && counts.validators >= 4 && counts.signaling >= 1) return counts;
    } catch (err) {
      logger.debug({ err }, 'readiness poll failed — retrying');
    }
    await sleep(5000);
  }
  return counts;
}

/** Poll the newest cp log until a placement_basis line appears (re-drive can lag registration), or deadline. */
async function pollForPlacementBasis(deadlineMs: number): Promise<string | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const basis = readPlacementBasis(newestLogLines('cp-1-'));
    if (basis !== null) return basis;
    await sleep(3000);
  }
  return readPlacementBasis(newestLogLines('cp-1-'));
}

/**
 * SERVER-SIDE real-media proof: the relay's `GET /metrics/:roomId` returns `bytesForwarded`
 * (bigint string; open when no metrics token — the validator scrapes this same endpoint). >0 proves
 * REAL media forwarded THROUGH the relay — independent of @roamhq/wrtc client stats (which only
 * expose candidate-pair RTT, not inbound-rtp bytesReceived). `metricsPort` = relay WS port + 1.
 */
async function fetchRelayBytesForwarded(metricsPort: number, roomId: string): Promise<bigint> {
  try {
    const res = await fetch(`http://127.0.0.1:${metricsPort}/metrics/${roomId}`);
    if (res.status !== 200) return 0n;
    const j = (await res.json()) as { bytesForwarded?: string; totalBytesForwarded?: string };
    return BigInt(j.bytesForwarded ?? j.totalBytesForwarded ?? '0');
  } catch {
    return 0n;
  }
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
  // The /canary/load feed probe is INFORMATIONAL on this single-host rig: the validator coverage
  // server is intentionally NOT enabled (running it on exactly one of 4 validators needs per-index
  // coverage ports via a shared-rig ps1 val-arm edit, outside this worktree; enabling it on all 4
  // via the shared .env makes 3 crash on EADDRINUSE and breaks the ballot floor). The strict-defer
  // claim is proven CP-SIDE and does NOT depend on the feed being reachable: the poller fail-opens
  // an unreachable feed to an EMPTY attested-load map (attested-load-poller.ts, spec §2-D1.3), which
  // yields basis=defer identically to a reachable relays:[] feed. D1a verdict = poller-started +
  // placement_basis=defer.
  const feed = await pollFeed(8_000);
  lines.push(
    `[informational] curl ${FEED_URL} -> HTTP ${feed.status} body=${feed.raw || '(unreachable — coverage server not enabled on single-host rig; see note)'}`,
  );

  const pollerStarted = newestLogLines('cp-1-').some((l) => l.includes('attested-load poller started'));
  lines.push(`cp log 'attested-load poller started' (RMS_ATTESTED_PLACEMENT=1): ${pollerStarted}`);

  const config = loadFreshConfig();
  const client = createSuiClient('localnet');
  const ready = await waitForRegistration(client, config, logger, 240_000);
  lines.push(`registration readiness: relays=${ready.relays} validators=${ready.validators} signaling=${ready.signaling}`);

  const roomId = await seedRoom(client, config, logger);
  lines.push(`room=${roomId} + escrow created (placement trigger)`);

  const basis = await pollForPlacementBasis(90_000);
  lines.push(`placement_basis=${basis ?? '(none)'} (expected: defer)`);

  const verdict: PhaseResult['verdict'] = pollerStarted && basis === 'defer' ? 'PASS' : 'FAIL';
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
  const ready = await waitForRegistration(client, config, logger, 240_000);
  lines.push(`registration readiness: relays=${ready.relays} validators=${ready.validators} signaling=${ready.signaling}`);

  const roomId = await seedRoom(client, config, logger);
  lines.push(`room=${roomId} + escrow created`);

  const assigned = await readAssignedRelays(client, config.packageId, roomId, 180_000);
  const distinct = assigned ? new Set(assigned).size : 0;
  lines.push(`RPC readAssignedRelays -> ${JSON.stringify(assigned)} (distinct=${distinct}, expected >=3)`);

  const basis = await pollForPlacementBasis(30_000);
  lines.push(`placement_basis=${basis ?? '(none)'} (expected: legacy-self-report)`);

  const verdict: PhaseResult['verdict'] =
    assigned !== null && distinct >= 3 && basis === 'legacy-self-report' ? 'PASS' : 'FAIL';
  return { phase: { phase: 'D1b', verdict, lines }, roomId, assigned, client, config };
}

async function runD2(logger: Logger, client: SuiClient, config: NetworkConfig, roomId: string, assigned: string[]): Promise<PhaseResult> {
  const lines: string[] = [];
  const oldPrimary = assigned[0]!;

  // Resolve the primary WS port FROM CHAIN (relay ids are fresh per regenesis — NEVER hardcode
  // assigned[0]==4000). borrow_info -> info_endpoint_url -> decode -> port.
  const primaryPort = await resolveRelayWsPort(client, config.packageId, config.relayRegistryId, oldPrimary);
  lines.push(`resolved primary ${oldPrimary} -> WS port ${primaryPort ?? '(UNRESOLVED)'}`);
  if (primaryPort === null) {
    lines.push('D2 FAIL: could not resolve the primary WS port from chain (info_endpoint_url)');
    return { phase: 'D2', verdict: 'FAIL', lines };
  }

  const fleet = await launchFleet(RELAY_WS_URLS, roomId);
  lines.push(`fleet: ${fleet.peers.length} peers on ${RELAY_WS_URLS.join(', ')}`);

  // PRE-KILL real-media proof. Client-side bytesReceived is UNAVAILABLE on @roamhq/wrtc (getStats
  // exposes only candidate-pair RTT, NOT inbound-rtp — documented harness limitation; it returns 0
  // even while media flows), so we prove REAL media SERVER-side via the relay's /metrics/:roomId
  // bytesForwarded (>0 = real bytes forwarded through the relay). Client bytesReceived is still
  // recorded as informational. Cross-failover client RE-consume from the promoted relay is a
  // separate CLIENT concern (bench peer has no reconnect) — NOT asserted; continuity is SERVER-side.
  let clientBytes = 0;
  let fwdBytes = 0n;
  const mediaDeadline = Date.now() + 45_000;
  while (Date.now() < mediaDeadline) {
    const fwd = await Promise.all(RELAY_WS_PORTS.map((wp) => fetchRelayBytesForwarded(wp + 1, roomId)));
    fwdBytes = fwd.reduce((a, b) => (b > a ? b : a), 0n);
    const cli = await Promise.all(fleet.peers.map((p) => p.bytesReceived().catch(() => 0)));
    clientBytes = Math.max(0, ...cli);
    if (fwdBytes > 0n) break;
    await sleep(3_000);
  }
  lines.push(`pre-kill media: relay bytesForwarded (server-side) = ${fwdBytes}; client bytesReceived (@roamhq/wrtc, informational) = ${clientBytes}`);
  const mediaFlowing = fwdBytes > 0n;

  const killOut = chaos('kill', primaryPort);
  lines.push(`chaos kill ${primaryPort} (RESOLVED primary, assigned_relays[0]=${oldPrimary}) -> ${killOut}`);
  await sleep(2_000);
  const primaryState = chaos('isopen', primaryPort);
  lines.push(`primary WS ${primaryPort} isopen=${primaryState}`);
  const primaryDown = primaryState === 'NOT-OPEN';

  // promote_relay requires current_epoch - last_hb > MAX_HEARTBEAT_EPOCHS(3) (room_manager.move:884),
  // i.e. ~4 epochs of staleness. The native rig's epoch duration is 60s (unset --epoch-duration-ms)
  // and the cp relay-heartbeat-watcher scans once per epoch, so the promotion lands ~4-5 min after
  // the kill. Poll up to 7 min. (A short-epoch rig would fire in seconds — see the hermetic test.)
  const promo = await pollRelayPromoted(client, config.packageId, roomId, oldPrimary, 420_000);
  lines.push(`RPC pollRelayPromoted(old=${oldPrimary}) -> ${JSON.stringify(promo)}`);

  const after = await readAssignedRelays(client, config.packageId, roomId, 30_000);
  lines.push(`RPC readAssignedRelays after -> ${JSON.stringify(after)}`);
  const oldOut = after !== null && !after.includes(oldPrimary);
  const newIn = promo !== null && after !== null && after[0] === promo.newPrimary;
  const stillKr = after !== null && after.length >= 3;
  lines.push(`swap: old-primary OUT=${oldOut}, new-primary IN as [0]=${newIn}, active>=K_r(3)=${stillKr}`);
  const replaced = oldOut && newIn && stillKr;

  // SERVER-SIDE continuity: the surviving relay WS ports (incl. the promoted relay, now in the
  // active set per the swap check) stay OPEN + serving. Combined with the PRE-KILL bytesReceived>0
  // (real media was flowing), this is the honest continuity proof; client re-consume post-failover
  // is out of charter (documented above).
  const survivingPorts = RELAY_WS_PORTS.filter((p) => p !== primaryPort);
  const surviving = survivingPorts.map((p) => ({ port: p, state: chaos('isopen', p) }));
  lines.push(`surviving relays (incl. promoted): ${surviving.map((x) => `${x.port}=${x.state}`).join(' ')}`);
  const survivingOpen = surviving.every((x) => x.state === 'OPEN');
  const continuity = mediaFlowing && survivingOpen;
  lines.push(`continuity = real-media-flowed(${mediaFlowing}) AND surviving-relays-serving(${survivingOpen})`);

  // Stretch (NON-FATAL): promotion-dedup is per (room, oldPrimary), so killing the NEW primary fires
  // a SECOND RelayPromoted. Resolve the NEW primary's port FROM CHAIN (exact — not a heuristic).
  let stretch = 'not attempted';
  if (promo !== null) {
    const newPrimaryPort = await resolveRelayWsPort(client, config.packageId, config.relayRegistryId, promo.newPrimary);
    if (newPrimaryPort !== null) {
      try {
        const k2 = chaos('kill', newPrimaryPort);
        lines.push(`chaos kill ${newPrimaryPort} (stretch, RESOLVED new primary ${promo.newPrimary}) -> ${k2}`);
        // Same ~4-epoch staleness gate as the first promotion (60s epochs) — poll up to 6 min.
        const promo2 = await pollRelayPromoted(client, config.packageId, roomId, promo.newPrimary, 360_000);
        stretch = promo2
          ? `2nd RelayPromoted new_primary=${promo2.newPrimary} epoch=${promo2.epoch}`
          : 'no 2nd promotion observed within 6min (non-fatal — dedup is per (room,oldPrimary), so this is a genuine 2nd swap when it fires)';
      } catch (err) {
        stretch = `stretch error (non-fatal): ${String(err)}`;
      }
    } else {
      stretch = 'skipped — new-primary port unresolved';
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

  // NOTE: CANARY_CELL_SECRET + VALIDATOR_CANARY_COVERAGE_PORT are deliberately NOT injected — in the
  // shared .env they enable the /canary/load coverage server on ALL 4 validators, which then race to
  // bind the same 8105 and 3 crash on unhandled EADDRINUSE (breaking the >=4 validator ballot floor).
  // The cp still polls RMS_LOAD_FEED_URL (unreachable -> fail-open empty map -> basis=defer). Enabling
  // the feed on exactly one validator needs a per-index ps1 val-arm edit (out of this worktree).
  const commonInject = [
    `RMS_LOAD_FEED_URL=${FEED_URL}`,
    'LOG_PRETTY=false',
  ];

  const mode = process.env['SMH_PHASES'];
  try {
    if (mode === 'd2') {
      // D2-only: boot flag-OFF once, place a room (the D1b setup: seed + readAssignedRelays), run D2.
      // D1a/D1b phases are NOT recorded — only D2 (a failed placement surfaces as a D2 FAIL).
      bootFresh(commonInject);
      const setup = await runD1b(logger);
      if (setup.phase.verdict === 'PASS' && setup.roomId && setup.assigned && setup.assigned.length >= 3) {
        phases.push(await runD2(logger, setup.client, setup.config, setup.roomId, setup.assigned));
      } else {
        phases.push({ phase: 'D2', verdict: 'FAIL', lines: ['D2 setup failed — placement did not yield >=3 relays:', ...setup.phase.lines] });
      }
    } else {
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

      // Fleet + D2 (only if D1b gave us a placed room). SMH_PHASES=d1 stops after D1b.
      if (mode === 'd1') {
        logger.info('SMH_PHASES=d1 — skipping media fleet + D2');
      } else if (d1b.phase.verdict === 'PASS' && d1b.roomId && d1b.assigned && d1b.assigned.length >= 3) {
        phases.push(await runD2(logger, d1b.client, d1b.config, d1b.roomId, d1b.assigned));
      } else {
        phases.push({ phase: 'D2', verdict: 'FAIL', lines: ['skipped — D1b did not place a room with >=3 relays'] });
      }
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

// Fleet peers (mediasoup-client VirtualPeers) consume via a fire-and-forget (void-ed) onNewProducer;
// a cross-relay consume that times out ('Relay response timeout') surfaces as an UNHANDLED rejection
// that would crash the whole orchestrator before the evidence write. Those — and the documented
// @roamhq/wrtc native-teardown crash on Windows — are NON-FATAL to D2's SERVER-side asserts (the
// producer is still created + piped -> bytesForwarded; promotion is RPC-verified). Log + swallow so
// one flaky peer never kills the run; main()'s own critical path stays explicitly try/catch'd/awaited.
process.on('unhandledRejection', (reason) => {
  console.error('[smh-live] non-fatal unhandledRejection (fleet peer async, e.g. consume timeout):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[smh-live] non-fatal uncaughtException (fleet peer / wrtc async):', err);
});

const isMain =
  process.argv[1]?.endsWith('run-smh-live.ts') === true || process.argv[1]?.endsWith('run-smh-live.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
