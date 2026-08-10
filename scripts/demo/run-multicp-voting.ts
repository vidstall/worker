/**
 * Multi-CP Voting Live (N=5) — Phase C (GĐ2) Task C3: the NATIVE 12-process
 * launcher. Spawns the full local fleet against an already-staged localnet and
 * proves it ALL-UP healthy, then tears it down. This is the launcher SKELETON:
 * it does NOT run the live demo flows (#6 role vote / #7 pairing) — those are
 * C4, which EXTENDS main() at the clearly-marked seam below.
 *
 * THE FLEET (12 processes — the genuine N=5 substrate seed-multicp writes; the
 * standalone signaling node type was removed from the contract, so there is no
 * signaling process/wave anymore):
 *   wave 1  cp-0..cp-4         5 cp-daemon   (role-vote loops — MUST be up first)
 *   wave 2  val-0..val-3       4 validator   (pre-registered infra: VALIDATOR_CAP_ID set)
 *           relay-0,relay-1    2 relay
 *   wave 3  user-miner         1 validator-daemon in VOTING mode (the vote subject)
 *
 * WHY THE ORDER (load-bearing for determinism): all 5 CPs must be healthy BEFORE
 * the user-miner registers, so every role-vote loop is live and the genuine
 * 4-of-5 (required = ceil(5·2/3)) quorum can form. Infra (validators/relays)
 * comes up in parallel between them; the user-miner is spawned LAST.
 *
 * KEY MATRIX FACTS (verified against the daemon entrypoints — see per-field
 * comments + the C3 env-matrix spec):
 *   - Per-process CWD `.run/<role>-<i>/` is the ONLY isolation for the relative
 *     `.cursors/` event-poller state (no env override exists). Because CWD ≠ repo
 *     root, the spawn ENTRY must be an ABSOLUTE path to apps/<app>/src/index.ts and
 *     ALL env is passed explicitly (dotenv's CWD-relative .env discovery won't fire).
 *   - cp-daemon CAP_TOKEN_QUORUM_THRESHOLD defaults to '2' (index.ts:934) → we set
 *     '1' (the cap-token SIGNATURE quorum is orthogonal to the on-chain role-vote
 *     quorum this lane proves; '1' needs no QUORUM_STATE_OBJECT_ID — threshold<2
 *     skips that check). TURN_RPC_TOKEN / QUORUM_CLAIMS_ENABLED stay unset (demo).
 *   - The user-miner has NO slot in the keys file → the launcher self-provisions it
 *     (generate + faucet-fund) and runs it with REGISTRATION_MODE=voting and
 *     VALIDATOR_CAP_ID ABSENT (presence ⇒ voting skipped; auto-register.ts:40,56).
 *
 * SCOPE: connects to an ALREADY-RUNNING localnet with the `multi-cp-live` package
 * published + seeded (seed-multicp.ts already ran → .run/multicp-keys.json exists,
 * the published *_OBJECT_ID set is in env). It does NOT boot `sui start`, publish,
 * or seed. Run from the worktree root against a staged localnet on :9000:
 *   pnpm exec tsx scripts/demo/run-multicp-voting.ts
 *
 * Env levers: MULTICP_KEYS_PATH (default <worktree>/.run/multicp-keys.json),
 * FAUCET_URL / SUI_NETWORK / the published *_OBJECT_ID set (same as seed-multicp.ts),
 * KEEP_ALIVE=1 (leave the fleet running after the all-up check — for C4 to chain off).
 *
 * Fails LOUD: a missing $CFG var, an underfunded user-miner, or any daemon that
 * never reaches /healthz=alive throws; an uncaught throw in main() exits non-zero
 * (already-spawned children are torn down first).
 *
 * Structured logging only (shared pino Logger). No console.log.
 *
 * THIS FILE is a thin CLI entry point: the launch-plan matrix builder, the C4
 * pure quorum-assert helpers, the process-lifecycle spawn/health/teardown
 * machinery, and the launchFleet/main() orchestration all live under
 * ./multicp/ — this file just re-exports the public surface (for the unit
 * test) and runs main() when invoked directly.
 */

export type { App, SpawnOrder, ProcessSpec } from './multicp/launch-plan.ts';
export { buildLaunchPlan } from './multicp/launch-plan.ts';

export {
  REQUIRED_QUORUM_AT_N5,
  parseRoomId,
  decodeLeU64,
  assertRoleQuorum,
  assertPairingQuorum,
  classifyRetryLine,
  summarizeRetryTails,
} from './multicp/quorum-asserters.ts';
export type {
  ProposalSubmittedJson,
  RoleQuorumResult,
  PairingQuorumResult,
  RetrySummary,
} from './multicp/quorum-asserters.ts';

export type { ProcessHandle } from './multicp/process-lifecycle.ts';
export { mergeChildEnv, spawnProcess, waitHealthy, teardownFleet } from './multicp/process-lifecycle.ts';

export { launchFleet, main } from './multicp/orchestrator.ts';

import { main } from './multicp/orchestrator.ts';

// Run only when invoked directly so the unit test can import buildLaunchPlan
// without launching (mirrors escrow-driver.ts:233 / provision-room.ts:91).
if (process.argv[1]?.endsWith('run-multicp-voting.ts')) {
  main().catch((err) => {
    // Fail LOUD: a non-zero exit lets the controller gate on the all-up check.
    process.stderr.write(`run-multicp-voting: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
