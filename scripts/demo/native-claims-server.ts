// scripts/demo/native-claims-server.ts
/**
 * Track-C GENUINE 2-host co-sign — the standalone `/canary/claims` board carrier for the LIVE run.
 *
 * vm1 runs this ONE tiny process (bind 0.0.0.0:8092 via CANARY_CLAIMS_BIND_HOST, bearer-authed, TLS OFF
 * over the NSG-restricted private VNet). BOTH parties talk to it against a SINGLE InMemoryClaimBoard:
 *   - the orchestrator (m2b-live-bhermetic-slash.ts, peer mode) POSTs host-A att1 + POLLs the cell;
 *   - vm2's attester CROSS-POSTs its independently-observed att2 (coObserverBoard -> http://10.0.0.4:8092).
 * The cell thus accrues 2 DISTINCT Wallet-B pubkeys -> the orchestrator assembles a >=2-distinct proof.
 *
 * WHY a dedicated process (not the deployed index.ts validator): index.ts only starts a claims-server
 * when CANARY_LIVE_SEAMS_ENABLED is ON — but seams ON makes the SYNTHETIC injected capture win over the
 * REAL forwarded-pipe capture we need for a genuine attestation. So the live carrier is stood up here,
 * decoupled from the capture path. This is LIVE infra, not the hermetic InMemoryClaimBoard test double.
 *
 * Env: CANARY_CLAIMS_AUTH_TOKEN (required, fail-loud), CANARY_CLAIMS_BIND_HOST=0.0.0.0,
 *      CANARY_CLAIMS_PORT=8092. Leave CANARY_CLAIMS_TLS_ENABLED unset for the plain-bearer VNet path.
 */
// scripts/ sits OUTSIDE the pnpm workspace graph, so @dvconf/shared is imported via the relative
// SOURCE path (same constraint as m2b-live-bhermetic-slash.ts:62) — the bare specifier is unresolvable
// from root node_modules under tsx.
import { createLogger } from '../../packages/shared/src/index.ts';
import { InMemoryClaimBoard } from '../../apps/validator-daemon/src/canary/claim-board.ts';
import { startCanaryClaimsServer } from '../../apps/validator-daemon/src/canary/claims-server.ts';

async function main(): Promise<void> {
  const logger = createLogger('track-c/native-claims-server');
  // wCorr huge so a cell NEVER GCs mid-run — the live TAMPER leg (browser -> evil-relay -> cross-host
  // pipe -> vm2 verify -> att2 post -> orchestrator poll) can span many rounds end-to-end.
  const board = new InMemoryClaimBoard({ wCorr: 1_000_000 });
  const server = await startCanaryClaimsServer({ board, logger });
  const boundPort = (server.server.address() as { port: number } | null)?.port;
  logger.info(
    { port: boundPort },
    'track-c native claims-server up (bind host from CANARY_CLAIMS_BIND_HOST; TLS off; bearer required)',
  );
  const shutdown = (): void => {
    void server.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise<never>(() => {}); // keep the carrier alive until signalled
}

void main();
