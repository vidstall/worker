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
 *
 * Implementation split into sibling modules (pure code movement, no behavior change):
 *   - infra-control.ts : boot channel (ps1 shells), chaos.ps1 wrapper, .env injection, .logs reads.
 *   - chain-seed.ts     : on-chain user-side ops (fresh config reload, room+escrow seed, readiness poll).
 *   - phases.ts          : D1a / D1b / D2 phase implementations + feed/placement pollers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../packages/shared/src/index.js';
import { requiredPorts, scanCollisions, formatCollisions, DEFAULT_PORT_CONFIG } from './ports.js';
import { assembleEvidence, SMH_LIVE_CAVEATS, type PhaseResult } from './evidence.js';
import { teardown, sleep, bootFresh } from './infra-control.js';
import { runD1a, runD1b, runD2, FEED_URL } from './phases.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_PATH = path.resolve(HERE, '..', '..', '.evidence', 'verification', 'static-mesh-hardening-live.md');

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
