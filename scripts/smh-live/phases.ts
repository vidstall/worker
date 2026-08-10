/**
 * SMH-LIVE orchestrator — D1a / D1b / D2 phase implementations + the feed/placement
 * pollers they share.
 *
 * Split out of run-smh-live.ts (pure code movement, no behavior change).
 */

import { createSuiClient, type NetworkConfig, type Logger } from '../../packages/shared/src/index.js';
import type { SuiClient } from '@mysten/sui/client';
import { DEFAULT_CANARY_COVERAGE_PORT } from './ports.js';
import { readAssignedRelays, pollRelayPromoted, resolveRelayWsPort, readCurrentAssignedRelays } from './rpc-verify.js';
import { readPlacementBasis, readPromoteSubmit } from './log-asserts.js';
import type { PhaseResult } from './evidence.js';
import { launchFleet, pollUntil } from './media-fleet.js';
import { sleep, chaos, newestLogLines } from './infra-control.js';
import { loadFreshConfig, seedRoom, waitForRegistration } from './chain-seed.js';

export const CANARY_PORT = DEFAULT_CANARY_COVERAGE_PORT; // 8105 — outside the 8101-8104 healthz band
export const FEED_URL = `http://127.0.0.1:${CANARY_PORT}/canary/load`;
export const RELAY_WS_URLS = ['ws://127.0.0.1:4000', 'ws://127.0.0.1:4002', 'ws://127.0.0.1:4004'];
export const RELAY_WS_PORTS = [4000, 4002, 4004]; // the native rig's relay WS ports (fleet homes one peer per port)

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

export async function runD1a(logger: Logger): Promise<PhaseResult> {
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
  lines.push(`registration readiness: relays=${ready.relays} validators=${ready.validators}`);

  const roomId = await seedRoom(client, config, logger);
  lines.push(`room=${roomId} + escrow created (placement trigger)`);

  const basis = await pollForPlacementBasis(90_000);
  lines.push(`placement_basis=${basis ?? '(none)'} (expected: defer)`);

  const verdict: PhaseResult['verdict'] = pollerStarted && basis === 'defer' ? 'PASS' : 'FAIL';
  return { phase: 'D1a', verdict, lines };
}

export interface D1bResult {
  phase: PhaseResult;
  roomId: string | null;
  assigned: string[] | null;
  client: SuiClient;
  config: NetworkConfig;
}

export async function runD1b(logger: Logger): Promise<D1bResult> {
  const lines: string[] = [];
  const config = loadFreshConfig();
  const client = createSuiClient('localnet');
  const ready = await waitForRegistration(client, config, logger, 240_000);
  lines.push(`registration readiness: relays=${ready.relays} validators=${ready.validators}`);

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

export async function runD2(logger: Logger, client: SuiClient, config: NetworkConfig, roomId: string, assigned: string[]): Promise<PhaseResult> {
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

  // D2 media-hardening: home an EXTRA consumer peer on the PRIMARY relay so a
  // deterministic INTRA-relay consume forwards real bytes on the primary before the kill
  // (one-peer-per-relay only yields flaky cross-relay consumes — observed zero consumes →
  // bytesForwarded=0). The per-relay producers still exist, so failover stays observable.
  const primaryUrl = `ws://127.0.0.1:${primaryPort}`;
  const fleet = await launchFleet(RELAY_WS_URLS, roomId, { extraConsumerRelayUrl: primaryUrl });
  lines.push(`fleet: ${fleet.peers.length} peers on ${RELAY_WS_URLS.join(', ')} (+1 consumer homed to primary ${primaryUrl} for intra-relay forwarding)`);

  // PRE-KILL real-media proof. Client-side bytesReceived is UNAVAILABLE on @roamhq/wrtc (getStats
  // exposes only candidate-pair RTT, NOT inbound-rtp — documented harness limitation; it returns 0
  // even while media flows), so we prove REAL media SERVER-side via the relay's /metrics/:roomId
  // bytesForwarded (>0 = real bytes forwarded through the relay). Client bytesReceived is still
  // recorded as informational. Cross-failover client RE-consume from the promoted relay is a
  // separate CLIENT concern (bench peer has no reconnect) — NOT asserted. Server-side we prove
  // pre-kill media established + post-kill survivor process/port liveness, NOT post-promotion media
  // continuity (no post-kill media re-read / re-consume is performed).
  //
  // Media establishment is FLAKY across the mesh, so ADAPTIVELY POLL the relay bytesForwarded until
  // it is >0 (bounded 90s) BEFORE proceeding to the kill — the pre-existing /metrics/:roomId
  // endpoint is the ground truth. `pollUntil` returns the last observed value on timeout (honest).
  let clientBytes = 0;
  const fwdBytes = await pollUntil(
    async () => {
      const fwd = await Promise.all(RELAY_WS_PORTS.map((wp) => fetchRelayBytesForwarded(wp + 1, roomId)));
      const cli = await Promise.all(fleet.peers.map((p) => p.bytesReceived().catch(() => 0)));
      clientBytes = Math.max(0, ...cli);
      return fwd.reduce((a, b) => (b > a ? b : a), 0n);
    },
    (b) => b > 0n,
    { deadlineMs: 90_000, intervalMs: 3_000 },
  );
  const consumerCounts = fleet.peers.map((p) => `${p.peerId}:${p.consumerCount()}`).join(' ');
  lines.push(`pre-kill fleet consumers established: ${consumerCounts}`);
  lines.push(`pre-kill media: relay bytesForwarded (server-side) = ${fwdBytes}; client bytesReceived (@roamhq/wrtc, informational) = ${clientBytes}`);
  const mediaFlowing = fwdBytes > 0n;

  const killBeforeMs = Date.now();
  const killOut = chaos('kill', primaryPort);
  const killAfterMs = Date.now();
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

  // T1-1 failover-promotion decomposition [primary kill]. Split the recovery latency into its two
  // structurally-distinct halves by joining the cp watcher's `promote_submit` log (matched on
  // oldPrimary, submit instant = pino `time`) to the kill t0 and the on-chain RelayPromoted envelope
  // timestampMs. kill t0 = kill-COMPLETED (killAfterMs) so the chaos ps-spawn is excluded and the
  // primary is provably dead by t0. Reported as a SEPARATE population from the stretch (2nd) kill.
  const submitRec = readPromoteSubmit(newestLogLines('cp-1-'), oldPrimary);
  const killToSubmitMs = submitRec ? submitRec.submitTimeMs - killAfterMs : null;
  const submitToPromotedMs =
    submitRec && promo?.promotedAtMs != null ? promo.promotedAtMs - submitRec.submitTimeMs : null;
  lines.push('--- T1-1 promotion decomposition [primary kill] ---');
  lines.push(`  kill t0: before=${killBeforeMs} after=${killAfterMs} (chaos ps-spawn=${killAfterMs - killBeforeMs}ms, EXCLUDED from kill->submit)`);
  if (submitRec) {
    lines.push(`  promote_submit: trace_id=${submitRec.traceId} time=${submitRec.submitTimeMs} (cp log, joined by oldPrimary)`);
    lines.push(`  kill->promote_submit = ${killToSubmitMs}ms [config-arithmetic: strict >MAX_HEARTBEAT_EPOCHS(3) staleness x 60s localnet epochs; NOT a detection-time measurement, NOT MTTR]`);
    lines.push(`  promote_submit->RelayPromoted = ${submitToPromotedMs ?? 'unavailable (RelayPromoted envelope carried no timestampMs)'}ms [measured localnet consensus-commit floor; NOT client-visible, NOT MTTR]`);
  } else {
    lines.push(`  promote_submit log NOT found for oldPrimary=${oldPrimary} -> decomposition unavailable this run`);
  }

  // Verify the swap via LIVE assigned_relays (get_room_assignment), NOT the RoomAssigned event:
  // promote_relay mutates assigned_relays[0] + emits RelayPromoted but does NOT re-emit RoomAssigned,
  // so event-based readAssignedRelays returns the STALE original set.
  const currentAssigned = await readCurrentAssignedRelays(client, config.packageId, config.roomManagerId, roomId);
  lines.push(`RPC get_room_assignment (LIVE assigned_relays) -> ${JSON.stringify(currentAssigned)}`);
  const oldOut = currentAssigned !== null && !currentAssigned.includes(oldPrimary);
  const newIn = promo !== null && currentAssigned !== null && currentAssigned[0] === promo.newPrimary;
  const stillKr = currentAssigned !== null && currentAssigned.length >= 3;
  lines.push(`swap: old-primary OUT of [0]=${oldOut}, new-primary IN as [0]=${newIn}, room spans>=K_r(3)=${stillKr}`);
  const replaced = oldOut && newIn && stillKr;

  // SERVER-SIDE survivor liveness: the surviving relay WS ports (incl. the promoted relay, now in
  // the active set per the swap check) stay OPEN (TCP LISTEN socket only). Combined with the PRE-KILL
  // bytesForwarded>0 (real media flowed BEFORE the kill), this proves pre-kill-media-established +
  // post-kill-survivor-liveness — it is NOT a post-promotion media-continuity proof: no second media
  // read / re-consume is performed after the promotion (client re-consume post-failover is out of
  // charter, documented above). Reserve "continuity" for a real post-promotion media observation.
  const survivingPorts = RELAY_WS_PORTS.filter((p) => p !== primaryPort);
  const surviving = survivingPorts.map((p) => ({ port: p, state: chaos('isopen', p) }));
  lines.push(`surviving relays (incl. promoted): ${surviving.map((x) => `${x.port}=${x.state}`).join(' ')}`);
  const survivingOpen = surviving.every((x) => x.state === 'OPEN');
  const preKillMediaAndSurvivorPortsOpen = mediaFlowing && survivingOpen;
  lines.push(`pre-kill-media-established(${mediaFlowing}) AND post-kill-survivor-ports-open(${survivingOpen}) [TCP LISTEN only, NOT a post-promotion media-continuity proof — no post-kill media re-read]`);

  // Stretch (NON-FATAL): promotion-dedup is per (room, oldPrimary), so killing the NEW primary fires
  // a SECOND RelayPromoted. Resolve the NEW primary's port FROM CHAIN (exact — not a heuristic).
  let stretch = 'not attempted';
  if (promo !== null) {
    const newPrimaryPort = await resolveRelayWsPort(client, config.packageId, config.relayRegistryId, promo.newPrimary);
    if (newPrimaryPort !== null) {
      try {
        const kill2BeforeMs = Date.now();
        const k2 = chaos('kill', newPrimaryPort);
        const kill2AfterMs = Date.now();
        lines.push(`chaos kill ${newPrimaryPort} (stretch, RESOLVED new primary ${promo.newPrimary}) -> ${k2}`);
        // Same ~4-epoch staleness gate as the first promotion (60s epochs) — poll up to 6 min.
        const promo2 = await pollRelayPromoted(client, config.packageId, roomId, promo.newPrimary, 360_000);
        stretch = promo2
          ? `2nd RelayPromoted new_primary=${promo2.newPrimary} epoch=${promo2.epoch}`
          : 'no 2nd promotion observed within 6min (non-fatal — dedup is per (room,oldPrimary), so this is a genuine 2nd swap when it fires)';
        // T1-1 decomposition for the STRETCH (2nd) kill — SEPARATE non-pooled population (this leg
        // degrades to 1 DISTINCT relay). oldPrimary of this leg = promo.newPrimary.
        const submitRec2 = readPromoteSubmit(newestLogLines('cp-1-'), promo.newPrimary);
        const kill2ToSubmitMs = submitRec2 ? submitRec2.submitTimeMs - kill2AfterMs : null;
        const submit2ToPromotedMs =
          submitRec2 && promo2?.promotedAtMs != null ? promo2.promotedAtMs - submitRec2.submitTimeMs : null;
        lines.push('--- T1-1 promotion decomposition [stretch / 2nd kill — separate population] ---');
        lines.push(`  kill t0: before=${kill2BeforeMs} after=${kill2AfterMs} (chaos ps-spawn=${kill2AfterMs - kill2BeforeMs}ms, EXCLUDED)`);
        if (submitRec2) {
          lines.push(`  promote_submit: trace_id=${submitRec2.traceId} time=${submitRec2.submitTimeMs}`);
          lines.push(`  kill->promote_submit = ${kill2ToSubmitMs}ms [config-arithmetic; NOT detection, NOT MTTR]`);
          lines.push(`  promote_submit->RelayPromoted = ${submit2ToPromotedMs ?? 'unavailable'}ms [measured localnet consensus-commit floor; NOT client-visible, NOT MTTR]`);
        } else {
          lines.push(`  promote_submit log NOT found for stretch oldPrimary=${promo.newPrimary} -> decomposition unavailable`);
        }
      } catch (err) {
        stretch = `stretch error (non-fatal): ${String(err)}`;
      }
    } else {
      stretch = 'skipped — new-primary port unresolved';
    }
  }
  lines.push(`stretch: ${stretch}`);

  await fleet.stopAll();

  const verdict: PhaseResult['verdict'] = promo !== null && primaryDown && replaced && preKillMediaAndSurvivorPortsOpen ? 'PASS' : 'FAIL';
  return { phase: 'D2', verdict, lines };
}
