/**
 * Validator-driven liveness enforcement sweep.
 *
 * "i expect that job belong to validator" — the on-chain `liveness_voting.move`
 * module lets a validator-quorum vote a stale node (relay / cp-daemon /
 * another validator) stale and, once quorum is reached, `registration::
 * execute_ejection` removes it from its registry and returns its stake to its
 * original owner. This file is the OFF-CHAIN half: it discovers candidate nodes,
 * decides which look stale enough to vote on, casts `cast_liveness_vote`, and —
 * once a `NodeEjectionApproved` event proves quorum was reached for a target —
 * submits `execute_ejection` (a crank anyone can call, mirroring
 * `economic_layer::distribute_rewards`).
 *
 * Discovery (BCS schemas + discoverRole/discoverAllActiveNodes) lives in
 * `liveness/node-discovery.ts`; heartbeat tracking (HeartbeatTracker) lives in
 * `liveness/heartbeat-tracker.ts`; vote-casting/ejection (castLivenessVote/
 * findStakePositionId/executeEjection) lives in `liveness/voting.ts`. This file
 * keeps `startLivenessSweep` + the public option/handle types, wiring those
 * pieces together, and re-exports `discoverAllActiveNodes`/`findStakePositionId`
 * so external import sites (`from '.../liveness-sweep.js'`) are unchanged.
 *
 * CRASH-SAFE: every discovery / vote / ejection attempt is independently
 * try/caught and logged — a single failed devInspect or TX must never crash the
 * sweep tick or the daemon (same convention as validator-discovery.ts and
 * SelfShutdownWatcher).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger, EventPoller, type NetworkConfig, type Logger } from '@dvconf/shared';
import { discoverAllActiveNodes } from './liveness/node-discovery.js';
import { HeartbeatTracker, cursorDir } from './liveness/heartbeat-tracker.js';
import { castLivenessVote, findStakePositionId, executeEjection } from './liveness/voting.js';

export { discoverAllActiveNodes, type LivenessCandidate } from './liveness/node-discovery.js';
export { findStakePositionId } from './liveness/voting.js';

const MOD = 'liveness-sweep';

/** Default tick cadence: independent of, and much slower than, the canary cell loop. */
const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** Don't resubmit a vote against the same target more than once per cooldown window. */
const DEFAULT_VOTE_COOLDOWN_MS = 5 * 60_000;
/**
 * No heartbeat event observed for this long (real wall-clock ms) -> vote stale.
 * Deliberately generous (not the raw "5 minutes no response" SLA) -- a validator's
 * own EventPoller can lag several minutes behind chain tip on the relay
 * heartbeat stream specifically (far higher event volume than CP/validator), and
 * a target newly discovered mid-lag gets `seed()`-ed to "now" with no way to tell
 * catch-up lag apart from genuine staleness. A false-positive ejection destroys
 * the target's StakePosition (see registration::execute_ejection) -- unrecoverable
 * without operator intervention -- so this errs toward under-ejecting live nodes
 * over risking a live node's forced removal.
 */
const DEFAULT_STALE_THRESHOLD_MS = 20 * 60_000;
/**
 * No votes cast until this long after process startup, giving HeartbeatTracker's
 * genesis-replay time to catch up to real-time before its data is trusted for
 * staleness decisions (see LivenessSweepOptions.startupGraceMs). Deliberately
 * generous -- a slow-to-vote daemon costs nothing (its peers still vote once
 * their own grace period elapses); a false-positive ejection of a live peer
 * costs that peer's registration and stake.
 */
const DEFAULT_STARTUP_GRACE_MS = 10 * 60_000;

export interface LivenessSweepOptions {
  client: SuiClient;
  graphqlClient: SuiGraphQLClient;
  config: NetworkConfig;
  signer: Ed25519Keypair;
  minerCapId: string;
  ownMinerId: string;
  logger?: Logger;
  tickIntervalMs?: number;
  voteCooldownMs?: number;
  /** No heartbeat event observed for this long (real ms) -> vote stale. Default 5 minutes. */
  staleThresholdMs?: number;
  /** Event-poll cadence for the heartbeat trackers + ejection-crank listener (default: mirrors tickIntervalMs). */
  pollIntervalMs?: number;
  /**
   * No liveness votes are cast until this long after startup (default: see
   * DEFAULT_STARTUP_GRACE_MS). A fresh process's HeartbeatTracker starts its
   * EventPoller replay from genesis with no cursor -- replaying potentially
   * hours of 30s-interval heartbeat history via paginated GraphQL polling
   * takes real wall-clock time. `tick()` runs on its own fixed interval
   * starting immediately, independent of replay progress; without this gate,
   * an early tick can read a `lastSeenMs` that's real but stale (replay
   * hasn't reached recent events yet) and cast a FALSE-POSITIVE stale vote
   * against a genuinely-alive peer -- confirmed live on devnet: 8/8
   * freshly-restarted validators voted each other stale within minutes of
   * boot, and one hit quorum before its peer's replay had caught up.
   */
  startupGraceMs?: number;
}

export interface LivenessSweepHandle {
  stop: () => void;
}

/**
 * Start the periodic liveness sweep (vote-casting tick) + the `NodeEjectionApproved`
 * crank listener (execute_ejection). Returns a handle whose `stop()` clears both.
 */
export function startLivenessSweep(opts: LivenessSweepOptions): LivenessSweepHandle {
  const {
    client, graphqlClient, config, signer, minerCapId, ownMinerId,
    logger = createLogger(MOD),
    tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
    voteCooldownMs = DEFAULT_VOTE_COOLDOWN_MS,
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    pollIntervalMs = tickIntervalMs,
    startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
  } = opts;

  const heartbeats = new HeartbeatTracker(graphqlClient, config, pollIntervalMs, logger);
  const startedAtMs = Date.now();
  const lastVotedAt = new Map<string, number>();
  // Targets THIS validator has already successfully voted for and that haven't
  // resolved yet (quorum reached, or the node recovered/dropped out of
  // discovery). A hard skip -- unlike lastVotedAt's cooldown, this prevents ANY
  // repeat submission: re-submitting a vote for a target already recorded
  // on-chain deterministically aborts with E_ALREADY_VOTED, and executeWithRetry
  // has no way to distinguish that from a transient failure, so it burns all its
  // retries every tick for nothing until the cooldown window passes.
  const votedFor = new Set<string>();
  let running = true;

  async function tick(): Promise<void> {
    if (!running) return;
    try {
      const candidates = await discoverAllActiveNodes(client, config, logger);
      const now = Date.now();

      const stillCandidateIds = new Set(candidates.map((c) => c.minerId));
      for (const votedId of votedFor) {
        // Dropped out of the active set (unregistered/ejected/recovered) -- stop
        // tracking it, freeing it up should it ever reappear and go stale again.
        if (!stillCandidateIds.has(votedId)) votedFor.delete(votedId);
      }

      if (now - startedAtMs < startupGraceMs) {
        logger.debug(
          { elapsedMs: now - startedAtMs, startupGraceMs },
          'liveness-sweep: within startup grace period, skipping vote-casting this tick',
        );
        return;
      }

      for (const candidate of candidates) {
        if (candidate.minerId === ownMinerId) continue; // E_CANNOT_VOTE_SELF
        if (votedFor.has(candidate.minerId)) continue; // already voted, awaiting quorum

        const lastSeenMs = heartbeats.lastSeen(candidate.minerId);
        if (lastSeenMs === undefined) {
          // Never observed a heartbeat event for this node yet (freshly registered,
          // or history replay still in flight) -- default to "seen now" rather than
          // risk an immediate false-positive vote against a node that just hasn't
          // heartbeated once yet.
          heartbeats.seed(candidate.minerId, now);
          continue;
        }

        const idleMs = now - lastSeenMs;
        if (idleMs <= staleThresholdMs) continue; // not stale enough

        const last = lastVotedAt.get(candidate.minerId);
        if (last !== undefined && now - last < voteCooldownMs) continue; // per-target cooldown

        lastVotedAt.set(candidate.minerId, now);
        logger.info(
          { targetMinerId: candidate.minerId, role: candidate.role, idleMs },
          'liveness-sweep: casting liveness vote against stale node',
        );
        const ok = await castLivenessVote(client, signer, config, minerCapId, candidate.minerId, logger);
        if (ok) {
          votedFor.add(candidate.minerId);
        } else {
          logger.warn({ targetMinerId: candidate.minerId }, 'liveness-sweep: cast_liveness_vote failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'liveness-sweep: tick failed (daemon continues)');
    }
  }

  const timer = setInterval(() => void tick(), tickIntervalMs);
  void tick(); // run one cycle immediately

  const ejectionPoller = new EventPoller({
    client: graphqlClient,
    // NOT config.originalPackageId -- liveness_voting was added in a LATER
    // upgrade than the package's first-ever publish, so its event structs
    // (NodeEjectionApproved) are pinned to that later package address. Using
    // originalPackageId here silently matches zero events forever. See
    // NetworkConfig.livenessVotingOriginPackageId.
    packageId: config.livenessVotingOriginPackageId ?? config.originalPackageId ?? config.packageId,
    // NOT 'liveness_voting' -- NodeEjectionApproved is defined in the
    // companion liveness_voting_events module (LOC-budget split,
    // liveness_voting/events.move), and events are pinned to whichever
    // module FIRST DEFINED the struct.
    module: 'liveness_voting_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('liveness-voting-events.json'),
    logger: logger.child({ poller: 'liveness_voting' }),
  });

  void ejectionPoller.start(async (event) => {
    if (!running) return;
    if (!event.type?.endsWith('::NodeEjectionApproved')) return;
    const parsed = event.parsedJson as { miner_id?: string } | undefined;
    const minerId = parsed?.miner_id;
    if (!minerId) return;

    logger.info({ targetMinerId: minerId }, 'liveness-sweep: NodeEjectionApproved observed, resolving StakePosition');
    const stakePositionId = await findStakePositionId(graphqlClient, config, minerId, logger);
    if (!stakePositionId) {
      logger.warn(
        { targetMinerId: minerId },
        'liveness-sweep: could not resolve StakePosition for approved ejection — will retry on next occurrence/tick',
      );
      return;
    }

    const ok = await executeEjection(client, signer, config, stakePositionId, logger);
    if (ok) {
      logger.info({ targetMinerId: minerId, stakePositionId }, 'liveness-sweep: execute_ejection succeeded');
    } else {
      logger.warn({ targetMinerId: minerId, stakePositionId }, 'liveness-sweep: execute_ejection failed');
    }
  });

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
      ejectionPoller.stop();
      heartbeats.stop();
    },
  };
}
