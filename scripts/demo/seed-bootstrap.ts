/**
 * F47 Phase 5.4 (REQ-RV-013 infra / REQ-RV-015 demo orchestration) — docker
 * seed-bootstrap one-shot.
 *
 * Brings a fresh `--force-regenesis` localnet from "published but empty" to
 * "4 daemons funded + on-chain registered", then hands each daemon its keypair +
 * CAP_ID via /shared/daemon-keys.json so the daemons SKIP their own
 * auto-registration (each `auto-register.ts` early-returns when its CAP_ID env is
 * set: CP_CAP_ID / MINER_CAP_ID / VALIDATOR_CAP_ID / MINER_CAP_ID) and just run
 * their loop. This is what lets `up -d --wait` reach healthy+registered fast so the
 * client RoleRevotePanel (Phase 5.3) shows live revote data.
 *
 * LIFECYCLE: the exact register -> cast_role_vote -> apply_voted_role ->
 * <role>_registry::register lifecycle is the one proven + tested in
 * apps/cp-daemon/src/__tests__/integration/revote-localnet-helpers.ts. That file is
 * __tests__-gated (cannot be imported from a standalone script), so its logic is
 * REPLICATED here. Every moveCall target + arg order below is cross-checked against
 * BOTH that helper AND the .move source (see the per-call comments citing
 * file:line).
 *
 * Run (matches the miner-cli-test one-shot: working_dir /work/dvconf-daemons):
 *   pnpm exec tsx scripts/demo/seed-bootstrap.ts
 *
 * Env (no hardcoded hosts — all defaulted):
 *   SUI_NETWORK       the lever loadNetworkConfig() resolves the RPC URL from; a URL
 *                     value is treated as a custom node (in docker: http://sui-localnet:9000).
 *                     NOTE: packages/shared/chain/client.ts honours ONLY SUI_NETWORK --
 *                     SUI_RPC_URL is dead config there (kept in compose for readability).
 *   FAUCET_URL        default = SDK getFaucetHost('localnet') (standalone); docker: http://sui-localnet:9123/gas
 *   KEYS_OUTPUT_PATH  default /shared/daemon-keys.json
 *   PLUS the published object IDs (PACKAGE_ID, *_REGISTRY_ID, MINER_STORE_ID,
 *   ROLE_VOTE_BOX_ID, ...) exported by read-publish-output.sh, which runs as this
 *   container's entrypoint BEFORE the command.
 *
 * Fails LOUD: any missing cap/stake or failed TX throws, and an uncaught throw in
 * main() calls process.exit(1) so `depends_on: service_completed_successfully`
 * gates the daemons correctly (a non-zero one-shot blocks them).
 *
 * Structured logging only (shared pino Logger). No console.log.
 *
 * SCOPE (Phase 5.4): seeds the 1 CP + 1 relay + 1 validator base
 * daemons (the standalone signaling node type was removed from the contract).
 * The `--profile scaled` replicas (Phase 5.5) are NOT seeded here.
 *
 * Implementation split into sibling modules under seed-bootstrap/ (pure code
 * movement, no behavior change):
 *   - seed-bootstrap/actor-setup.ts : faucet funding, registration::register, first-CP bootstrap.
 *   - seed-bootstrap/role-voting.ts  : CP-signed vote + miner-signed apply + registry enrollment.
 */

import { writeFileSync } from 'node:fs';
import { createSuiClient, createLogger, loadNetworkConfig } from '../../packages/shared/src/index.ts'; // relative SOURCE import, not the '@dvconf/shared' bare specifier: scripts/ sits OUTSIDE the pnpm workspace package graph, so the bare name is unresolvable from root node_modules (only apps/* carry the symlink). shared's own transitive deps resolve from packages/shared/node_modules. Verified under tsx.
import { MODULE, FAUCET_URL, bootstrapCp, type SeededKey, type CpHandle } from './seed-bootstrap/actor-setup.js';
import { voteAndApplyMiner, buildKeysRecord } from './seed-bootstrap/role-voting.js';

export type { SeededKey, CpHandle };
export { bootstrapCp, voteAndApplyMiner, buildKeysRecord };

const KEYS_OUTPUT_PATH = process.env['KEYS_OUTPUT_PATH'] ?? '/shared/daemon-keys.json';

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  // loadNetworkConfig() reads PACKAGE_ID + all *_REGISTRY_ID / MINER_STORE_ID /
  // ROLE_VOTE_BOX_ID from env (exported by read-publish-output.sh) and derives
  // config.rpcUrl from SUI_NETWORK -- the ONLY network lever packages/shared/chain/
  // client.ts honours (SUI_RPC_URL is dead config there). In docker SUI_NETWORK is the
  // sui-localnet container URL so config.rpcUrl resolves on the bridge network; the bare
  // keyword 'localnet' would hardcode 127.0.0.1:9000 = the container's own loopback.
  // Build the client EXACTLY like every daemon (createSuiClient(config.rpcUrl)).
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  logger.info(
    { module: MODULE, action: 'start', context: { rpcUrl: config.rpcUrl, faucetUrl: FAUCET_URL, keysOut: KEYS_OUTPUT_PATH, packageId: config.packageId } },
    'seed-bootstrap starting',
  );

  // 1. CP directly (it is the voter for everyone else).
  const cp = await bootstrapCp(client, config, logger);
  const cpKey: SeededKey = { secretKey: cp.kp.getSecretKey(), capId: cp.cpCapId, stakeId: cp.stakeId, minerId: cp.minerId };

  // 2. relay / validator / relay-standby via the generalised CP-voted lifecycle.
  const relay = await voteAndApplyMiner(client, cp, 'relay', config, logger);
  const validator = await voteAndApplyMiner(client, cp, 'validator', config, logger);
  // A 2nd DISTINCT validator (own funded keypair -> own miner_id). On-chain it is a
  // plain validator (same role code + register_validator); the keys-file slot key is
  // the only thing that differs. Gives the canary VecSet >=2 distinct attesters so
  // CanaryDivergenceSlashed can form on ONE host (spec §0.2 co-homing, REQ-CMD-1).
  const validator2 = await voteAndApplyMiner(client, cp, 'validator-2', config, logger);
  // 3. relay-standby: 4th funded keypair — a second relay enrolled at ws://relay-standby:4002
  //    (REQ-RO-021 Phase 5.3 bench; matches the relay-standby service in the relay-overlap compose override).
  const relayStandby = await voteAndApplyMiner(client, cp, 'relay-standby', config, logger);

  const keys = buildKeysRecord({
    cp: cpKey,
    relay,
    'relay-standby': relayStandby,
    validator,
    'validator-2': validator2,
  });
  writeFileSync(KEYS_OUTPUT_PATH, `${JSON.stringify(keys, null, 2)}\n`, 'utf8');

  logger.info(
    { module: MODULE, action: 'done', context: { keysOut: KEYS_OUTPUT_PATH, roles: Object.keys(keys) } },
    'seed-bootstrap complete — keys written, 5 daemons registered',
  );
}

// Run main() ONLY when invoked directly (mirrors escrow-driver.ts:233 /
// run-multicp-voting.ts:699). seed-multicp.ts VALUE-imports bootstrapCp/
// voteAndApplyMiner from here (added in C1) — WITHOUT this guard, seed-bootstrap's
// own N=1 seed fired on import and raced seed-multicp's cascade, inflating
// active_cp_count so the N=1 single-vote infra seed (required must be 1) aborted
// 707 (consume_assignment: no assignment) in apply_voted_role.
if (process.argv[1]?.endsWith('seed-bootstrap.ts')) {
  main().catch((err) => {
    // Fail LOUD: a non-zero exit blocks the daemons' `depends_on: service_completed_successfully`.
    process.stderr.write(`seed-bootstrap: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
