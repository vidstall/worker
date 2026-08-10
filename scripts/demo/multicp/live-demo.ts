/**
 * Multi-CP Voting Live (N=5) — C4 live-demo orchestration module, extracted
 * from run-multicp-voting.ts (pure code movement, no behavior change): the
 * devInspect active-CP-count read, Move event polling/paging, the transient
 * escrow-driver one-shot spawn, and the live-run evidence markdown writer.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import { type Logger, type NetworkConfig, type RoomAssigned } from '../../../packages/shared/src/index.ts'; // relative SOURCE import — scripts/ sits OUTSIDE the pnpm workspace graph (mirrors seed-multicp.ts:56 / escrow-driver.ts:61).
import { MODULE, WORKTREE_ROOT, IDENTITY_ENV_KEYS, cwdFor } from './launch-plan.ts';
import { decodeLeU64, parseRoomId, REQUIRED_QUORUM_AT_N5, type RoleQuorumResult, type PairingQuorumResult, type RetrySummary } from './quorum-asserters.ts';
import { sleep } from './process-lifecycle.ts';

// ── C4 live-demo levers ──
/** Read-only devInspect sender — no gas, no signature (mirrors role-assignment.ts:41 / seed-multicp.ts:73). */
const DEV_INSPECT_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000000';
/**
 * Wave-3 role-vote budget. The 5 CPs poll every ROLE_VOTING_INTERVAL_MS (30s) and
 * need 4 DISTINCT casts to finalize, so a cold discover→4-cast→assign can take
 * ~30-120s; 180s is generous headroom. (This gates launch on #6 finalizing rather
 * than the user-miner's /healthz — see launchFleet wave 3.)
 */
export const ROLE_VOTE_TIMEOUT_MS = 180_000;
/** #7 pairing budget: escrow → 5 CPs each submitProposal → PVR finalize; same 30s-poll class as #6. */
const ROOM_ASSIGN_TIMEOUT_MS = 180_000;
/** Hard cap on the transient escrow-driver one-shot — a hung driver (RPC stall) must not wedge the launcher with all 13 daemons up. */
const ESCROW_DRIVER_TIMEOUT_MS = 180_000;
const EVENT_POLL_MS = 3_000;
/** queryEvents page size — the demo's 4 user-miner casts / room proposals are the NEWEST role/room events, so a descending page of 50 always contains them. */
const EVENT_QUERY_LIMIT = 50;
/** Absolute entry for the transient #7 pairing driver (foreign CWD ⇒ absolute; mirrors entryFor). */
const ESCROW_ENTRY = join(WORKTREE_ROOT, 'scripts', 'demo', 'escrow-driver.ts');
/** The live-run evidence the controller's run produces (mkdir -p'd at write time). */
export const EVIDENCE_PATH = join(WORKTREE_ROOT, '.evidence', 'verification', 'multi-cp-voting-live-run.md');

/**
 * devInspect `control_plane_registry::active_cp_count(&CpRegistry): u64` and decode
 * the 8-byte LE u64. FAIL-CLOSED: throws on any RPC/decode error (a precondition
 * assert must never silently pass). Replicates seed-multicp.ts readU64Count INLINE
 * (that module runs main() on import → we import only its TYPE, not this fn).
 */
export async function readActiveCpCount(client: SuiClient, config: NetworkConfig): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::control_plane_registry::active_cp_count`,
    arguments: [tx.object(config.cpRegistryId)],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx as never,
    sender: DEV_INSPECT_SENDER,
  });
  if (result.error) {
    throw new Error(`readActiveCpCount: devInspect failed: ${result.error}`);
  }
  const returnValues = result.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length === 0) {
    throw new Error('readActiveCpCount: devInspect returned no value');
  }
  return Number(decodeLeU64(returnValues[0]![0] as number[]));
}

/**
 * Page the most-recent Move events of one fully-qualified type (descending). The
 * MoveEventType filter is NOT subject-scoped, so callers filter parsedJson by
 * miner_id / room_id. The demo's votes/proposals are the newest such events, so a
 * single EVENT_QUERY_LIMIT page always contains them.
 */
export async function queryMoveEvents(
  client: SuiClient,
  config: NetworkConfig,
  typeSuffix: string,
  limit = EVENT_QUERY_LIMIT,
): Promise<SuiEvent[]> {
  const res = await client.queryEvents({
    query: { MoveEventType: `${config.packageId}::${typeSuffix}` },
    limit,
    order: 'descending',
  });
  return res.data;
}

/**
 * Poll for the #7 `room_manager::RoomAssigned` event for `roomId` (mirrors
 * waitForRoleAssignment's shape — there is no shared waitForRoomAssignment helper).
 * Resolves the matching SuiEvent (caller reads parsedJson + id.txDigest); throws on
 * timeout.
 */
export async function waitForRoomAssignment(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
  timeoutMs = ROOM_ASSIGN_TIMEOUT_MS,
  pollIntervalMs = EVENT_POLL_MS,
): Promise<SuiEvent> {
  const deadline = Date.now() + timeoutMs;
  const target = normalizeSuiAddress(roomId);
  logger.info({ module: MODULE, action: 'wait_room_assignment', context: { roomId } }, 'waiting for RoomAssigned (CP pairing quorum)...');
  while (Date.now() < deadline) {
    try {
      const events = await queryMoveEvents(client, config, 'room_manager::RoomAssigned');
      const match = events.find((e) => {
        const pj = e.parsedJson as RoomAssigned | undefined;
        return pj !== undefined && normalizeSuiAddress(pj.room_id) === target;
      });
      if (match) {
        logger.info(
          { module: MODULE, action: 'room_assigned', context: { roomId, txDigest: match.id.txDigest } },
          'RoomAssigned observed',
        );
        return match;
      }
    } catch (err) {
      logger.debug(
        { module: MODULE, action: 'wait_room_assignment', context: { err: err instanceof Error ? err.message : String(err) } },
        'queryEvents RoomAssigned failed, retrying',
      );
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Room assignment timeout after ${timeoutMs}ms for room ${roomId}`);
}

/**
 * Spawn the transient escrow-driver.ts one-shot (register_user → create_room →
 * create_escrow → EscrowCreated → the 5 CPs' pairing vote). Buffers stdout, parses
 * the `ROOM_ID=…` contract line (parseRoomId), and resolves the room id. Rejects
 * LOUD on a non-zero exit / a missing ROOM_ID / a spawn error / a timeout. The
 * driver self-generates its own user key (needs no SUI_PRIVATE_KEY), so the
 * inherited identity keys are scrubbed as noise. A distinct CWD isolates its
 * relative `.cursors/`. Mirrors the spawnProcess idiom (execPath + tsx/esm entry).
 *
 * Settle discipline: parse+resolve on `'close'` (fires AFTER the stdio pipes flush —
 * `'exit'` alone can precede the final `\nROOM_ID=…\n` chunk → spurious reject), with
 * the exit code captured in `'exit'`. `'error'` handles spawn failure (fires alone,
 * without exit/close). A bounded timer kills a hung child (tree-kill on win32, where
 * tsx may spawn) and rejects so main()'s catch tears the fleet down. `settle` guards
 * against a double-settle (harmless no-op).
 */
export async function spawnEscrowDriver(logger: Logger): Promise<string> {
  const cwd = cwdFor('escrow-0');
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of IDENTITY_ENV_KEYS) delete env[k];
  logger.info(
    { module: MODULE, action: 'escrow_driver', context: { entry: ESCROW_ENTRY, cwd } },
    'spawning escrow-driver (register_user → create_room → create_escrow → CP pairing vote)',
  );
  return new Promise<string>((resolveRoom, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx/esm', ESCROW_ENTRY], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    timer = setTimeout(() => {
      if (proc.pid !== undefined) {
        if (process.platform === 'win32') {
          // Tree-kill (tsx/esm may spawn) — mirrors killHandle's win32 path.
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
        } else {
          proc.kill('SIGKILL');
        }
      }
      settle(() => reject(new Error(`escrow-driver timed out after ${ESCROW_DRIVER_TIMEOUT_MS}ms (killed)`)));
    }, ESCROW_DRIVER_TIMEOUT_MS);

    proc.once('error', (err) => settle(() => reject(new Error(`escrow-driver spawn error: ${err.message}`))));
    proc.once('exit', (code) => {
      exitCode = code; // stdio may still be flushing → defer the parse to 'close'.
    });
    proc.once('close', () => {
      settle(() => {
        const roomId = parseRoomId(stdout);
        if (exitCode !== 0 || roomId === null) {
          const tail = `${stdout}\n${stderr}`.split('\n').filter((l) => l.length > 0).slice(-20).join('\n');
          reject(new Error(`escrow-driver failed (code=${exitCode ?? 'null'}, roomId=${roomId ?? 'none'})\n--- last 20 stdout/stderr lines ---\n${tail}`));
          return;
        }
        logger.info({ module: MODULE, action: 'escrow_driver', context: { roomId, code: exitCode } }, 'escrow-driver completed; ROOM_ID captured');
        resolveRoom(roomId);
      });
    });
  });
}

/** The load-bearing facts a live demo run proves — captured for the evidence file. */
export interface LiveRunEvidence {
  activeCpCount: number;
  role: RoleQuorumResult;
  roleTxDigest: string;
  pairing: PairingQuorumResult;
  roomTxDigest: string;
  roomId: string;
  userMinerAddress: string;
  /** CP-fleet daemon count (excludes the user-miner) held to the alive gate. */
  fleetCount: number;
  /** user-miner (vote SUBJECT) exit code post-#6; null = still alive. Logged, NOT gated. */
  userMinerExit: number | null;
  retries: RetrySummary;
}

/**
 * Render + write the live-run evidence markdown (mkdir -p'd). Records the two
 * finalize tx digests, the distinct voter/cp sets + the shared score, the
 * active_cp_count==5 precondition, and the HONEST facts F (determinism is
 * structural: canary-OFF + identical env + same on-chain state — NOT an
 * off-chain relayState-equality assert) + G (a benign deterministic abort is
 * RETRIED 5× then swallowed by executeWithRetry — null, no throw, no crash —
 * NOT "non-retryable"). This is the ONLY raw file the demo writes; the asserts
 * above are the load-bearing part, so the caller guards this write.
 */
export function writeLiveRunEvidence(ev: LiveRunEvidence): void {
  const stamp = new Date().toISOString();
  const body = `# Multi-CP Voting Live (N=5) — live-run evidence

_Generated ${stamp} by scripts/demo/run-multicp-voting.ts (C4 SEAM)._

## Substrate precondition
- \`control_plane_registry::active_cp_count\` = **${ev.activeCpCount}** (asserted === 5).
- Fleet: ${ev.fleetCount + 1} processes all-up (5 cp + 4 val + 2 relay + 1 sig + 1 user-miner).
- Required quorum at N=5: \`ceil(5 * 6667 / 10000)\` = **${REQUIRED_QUORUM_AT_N5}**.

## #6 — live role-vote (4-of-5 quorum)
- user-miner (miner_id / address): \`${ev.userMinerAddress}\`
- RoleAssigned: role=${ev.role.role}, vote_count=**${ev.role.voteCount}**, threshold=**${ev.role.threshold}**.
- Finalize tx digest: \`${ev.roleTxDigest}\`
- ${ev.role.voters.length} DISTINCT RoleVoteCast voters:
${ev.role.voters.map((v) => `  - \`${v}\``).join('\n')}

## #7 — live pairing (4-of-5 quorum)
- room_id: \`${ev.roomId}\`
- RoomAssigned: consensus_reached=true, winning_cp=\`${ev.pairing.winningCp}\`, verified_score=**${ev.pairing.winningScore}**.
- Finalize tx digest: \`${ev.roomTxDigest}\`
- ${ev.pairing.agreeingCpIds.length} DISTINCT ProposalSubmitted cp_id at the winning score:
${ev.pairing.agreeingCpIds.map((c) => `  - \`${c}\``).join('\n')}

## Benign-abort (CP fleet survived — fact G, honest)
- All ${ev.fleetCount} CP-fleet daemons still alive after the demos (no crash). The
  user-miner (vote SUBJECT) is EXCLUDED from this gate — exit=${ev.userMinerExit ?? 'alive'}.
- The user-miner's post-#6 exit is EXPECTED-and-benign when the vote lands in the
  120-180s tail (its ensureRegistered uses the DEFAULT 120s waitForRoleAssignment,
  auto-register.ts:123, vs the launcher's 180s gate) OR the CPs assign a role whose
  stake floor > the FIXED 0.1 SUI it stakes (auto-register.ts:59; relay 0.25 / cp 0.5
  → apply_voted_role aborts 713 / the follow-on register aborts). It does NOT affect
  the #6/#7 proofs, which are read from the on-chain events, not from the subject
  daemon staying up.
- executeWithRetry retry traces observed across tails: retrying=${ev.retries.retrying}, exhausted=${ev.retries.exhausted}.
- Mechanism: a deterministic Move abort (704 E_ALREADY_VOTED / 711 E_PRIOR_ASSIGNMENT_PENDING /
  719 E_ROLE_MISMATCH / 508 E_NOT_PENDING) is RETRIED 5× (warn) by executeWithRetry
  (tx.ts:38-69), then swallowed with ONE benign \`exhausted retries, skipping\` error
  (null return, NO throw, NO crash). This is the accurate mechanism — NOT "non-retryable".

## Honesty notes
- **Fact F (determinism pin):** the spec's "assert all 5 CPs' relayState/validatorState
  are equal" is NOT feasible off-chain — every CP reads the SAME on-chain state and derives
  identical scores deterministically. The practical pin implemented here is STRUCTURAL:
  (i) canary is off UNLESS a CANARY_* var is present in the launching environment —
  buildLaunchPlan itself sets none, and mergeChildEnv does NOT scrub CANARY_* (it scrubs
  only IDENTITY_ENV_KEYS), so children inherit any CANARY_* the launching shell exports;
  and (ii) the active_cp_count==5 precondition above. No fake equality assert is made.
- **Fact G (benign-abort):** see the mechanism note above — retried-then-swallowed, not non-retryable.
`;
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, body, 'utf8');
}
