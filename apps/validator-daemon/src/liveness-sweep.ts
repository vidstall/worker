/**
 * Validator-driven liveness enforcement sweep.
 *
 * "i expect that job belong to validator" — the on-chain `liveness_voting.move`
 * module lets a validator-quorum vote a stale node (relay / signaling / cp-daemon
 * / another validator) stale and, once quorum is reached, `registration::
 * execute_ejection` removes it from its registry and returns its stake to its
 * original owner. This file is the OFF-CHAIN half: it discovers candidate nodes,
 * decides which look stale enough to vote on, casts `cast_liveness_vote`, and —
 * once a `NodeEjectionApproved` event proves quorum was reached for a target —
 * submits `execute_ejection` (a crank anyone can call, mirroring
 * `economic_layer::distribute_rewards`).
 *
 * DISCOVERY (mirrors canary/validator-discovery.ts's convention): each of the
 * four registries' `get_active_*` getters is read via a read-only `devInspect`
 * (no gas, no signature) using a hand-copied positional BCS schema matching the
 * Move struct's field order EXACTLY (load-bearing, same convention as
 * ValidatorInfoSchema there).
 *
 * STALENESS: VALIDATOR-ATTESTED, not on-chain-provable. `cast_liveness_vote` no
 * longer gates on the target's on-chain last_heartbeat/epoch — epoch granularity
 * floors at the network's real epoch length (e.g. 1 HOUR on devnet), which cannot
 * express a sub-hour SLA like "5 minutes no response". Instead this module tracks
 * each node's most recent heartbeat EVENT (RelayHeartbeat / SignalingHeartbeat /
 * CPHeartbeat / ValidatorHeartbeat), which carries a REAL wall-clock timestamp
 * (unlike the on-chain epoch field), via four EventPoller subscriptions. A node is
 * voted stale once its most-recently-seen heartbeat event is older than
 * `staleThresholdMs` (default 5 minutes) in real time. The 2/3-of-active-validator
 * quorum on-chain is the sole authority for the actual ejection, the same trust
 * model canary_audit already uses for its >=2-distinct-validator attestation.
 *
 * STAKE POSITION LOOKUP: `StakePosition` is a SHARED object (post owned→shared
 * migration, see liveness_voting.move's module doc) with no on-chain miner_id ->
 * object_id index, so `execute_ejection`'s `position` argument is resolved via a
 * GraphQL `objects(filter: { type: "<pkg>::staking::StakePosition" })` scan
 * (Sui's documented mechanism for finding shared objects by type, independent of
 * owner) rather than a Move-side lookup table.
 *
 * CRASH-SAFE: every discovery / vote / ejection attempt is independently
 * try/caught and logged — a single failed devInspect or TX must never crash the
 * sweep tick or the daemon (same convention as validator-discovery.ts and
 * SelfShutdownWatcher).
 */

import { join } from 'node:path';
import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient, GraphQLQueryResult } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import {
  createLogger,
  executeWithRetry,
  EventPoller,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';
import { recordWorkerDownVote } from './worker-down-vote-metrics.js';

const MOD = 'liveness-sweep';

/** Base dir for these cursors -- DATA_DIR (mirrors ChainEventListener's own
 *  default), NOT process.cwd(), so a container recreate (redeploy) doesn't
 *  force a full event-history replay from genesis. */
const cursorDir = (name: string): string => join(process.env.DATA_DIR ?? '.', '.cursors', name);

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Role codes (dvconf::constants — role_user=0, role_validator=1, role_relay=2, role_cp=3, role_signaling=4).
const ROLE_VALIDATOR = 1;
const ROLE_RELAY = 2;
const ROLE_CP = 3;
const ROLE_SIGNALING = 4;

/** Default tick cadence: independent of, and much slower than, the canary cell loop. */
const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** Don't resubmit a vote against the same target more than once per cooldown window. */
const DEFAULT_VOTE_COOLDOWN_MS = 5 * 60_000;
/**
 * No heartbeat event observed for this long (real wall-clock ms) -> vote stale.
 * Deliberately generous (not the raw "5 minutes no response" SLA) -- a validator's
 * own EventPoller can lag several minutes behind chain tip on the relay/signaling
 * heartbeat streams specifically (far higher event volume than CP/validator), and
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

// ── BCS schemas (VERBATIM copies of each registry's *Info struct, positional / load-bearing order) ──

const ValidatorInfoSchema = bcs.struct('ValidatorInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  session_count: bcs.u64(),
});

// relay_registry.move:26-33
const RelayNodeInfoSchema = bcs.struct('RelayNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  region: bcs.vector(bcs.u8()),
  endpoint_url: bcs.vector(bcs.u8()),
  reserved_primary_count: bcs.u64(),
  reserved_standby_count: bcs.u64(),
});

// signaling_registry.move:28-36
const SignalingNodeInfoSchema = bcs.struct('SignalingNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  endpoint_url: bcs.vector(bcs.u8()),
  region: bcs.vector(bcs.u8()),
  load: bcs.u64(),
  registered_at: bcs.u64(),
});

// control_plane_registry.move:27-33
const CPNodeInfoSchema = bcs.struct('CPNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  registered_at: bcs.u64(),
  reputation: bcs.u64(),
});

interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

/** A discovered node candidate for liveness voting. */
export interface LivenessCandidate {
  minerId: string;
  role: number;
}

/**
 * Read-only devInspect of one registry's `get_active_*` getter, decoded via
 * `schema` and projected to `{minerId, role}`. CRASH-SAFE:
 * resolves to `[]` on any failure (mirrors discoverActiveValidatorMinerIds).
 */
async function discoverRole(
  client: SuiClient,
  config: NetworkConfig,
  target: string,
  registryObjectId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
  role: number,
  logger: Logger,
): Promise<LivenessCandidate[]> {
  try {
    const tx = new Transaction();
    tx.moveCall({ target, arguments: [tx.object(registryObjectId)] });
    const r = (await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;

    if (r.error) {
      logger.warn({ target, err: r.error }, 'liveness-sweep discovery devInspect error');
      return [];
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) {
      logger.warn({ target }, 'liveness-sweep discovery devInspect returned no values');
      return [];
    }

    const infos = bcs.vector(schema).parse(Uint8Array.from(bytes)) as Array<{ miner_id: string }>;
    return infos.map((i) => ({
      minerId: normalizeSuiAddress(i.miner_id),
      role,
    }));
  } catch (err) {
    logger.warn({ target, err }, 'liveness-sweep discovery failed');
    return [];
  }
}

/** Discover all active nodes across all four role registries. */
export async function discoverAllActiveNodes(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<LivenessCandidate[]> {
  const pkg = config.packageId;
  const [validators, relays, signaling, cps] = await Promise.all([
    discoverRole(
      client, config,
      `${pkg}::validator_registry::get_active_validators`,
      config.validatorRegistryId, ValidatorInfoSchema, ROLE_VALIDATOR, logger,
    ),
    discoverRole(
      client, config,
      `${pkg}::relay_registry::get_active_relays`,
      config.relayRegistryId, RelayNodeInfoSchema, ROLE_RELAY, logger,
    ),
    discoverRole(
      client, config,
      `${pkg}::signaling_registry::get_active_nodes`,
      config.signalingRegistryId, SignalingNodeInfoSchema, ROLE_SIGNALING, logger,
    ),
    discoverRole(
      client, config,
      `${pkg}::control_plane_registry::get_active_cps`,
      config.cpRegistryId, CPNodeInfoSchema, ROLE_CP, logger,
    ),
  ]);
  return [...validators, ...relays, ...signaling, ...cps];
}

/** module name -> the heartbeat event's own `::TypeName` suffix, for filtering. */
const HEARTBEAT_EVENT_MODULES: ReadonlyArray<{ module: string; eventSuffix: string }> = [
  { module: 'relay_registry', eventSuffix: '::RelayHeartbeat' },
  { module: 'signaling_registry', eventSuffix: '::SignalingHeartbeat' },
  { module: 'control_plane_registry', eventSuffix: '::CPHeartbeat' },
  { module: 'validator_registry', eventSuffix: '::ValidatorHeartbeat' },
];

/**
 * Tracks each miner's most-recently-OBSERVED heartbeat event, in real wall-clock
 * time (`event.timestampMs`, not the on-chain epoch the event also carries) — the
 * mechanism the "5 minutes no response" SLA is actually measured against. Backed
 * by four EventPollers (one per role), each with its own cursor file; on a fresh
 * boot with no cursor, EventPoller replays full history from genesis, which
 * self-seeds `lastSeenMs` for every node's most recent heartbeat before this
 * process started watching live.
 */
class HeartbeatTracker {
  private readonly lastSeenMs = new Map<string, number>();
  private readonly pollers: EventPoller[];

  constructor(graphqlClient: SuiGraphQLClient, config: NetworkConfig, pollIntervalMs: number, logger: Logger) {
    this.pollers = HEARTBEAT_EVENT_MODULES.map(
      ({ module, eventSuffix }) =>
        new EventPoller({
          client: graphqlClient,
          packageId: config.originalPackageId ?? config.packageId,
          module,
          pollingIntervalMs: pollIntervalMs,
          cursorPath: cursorDir(`liveness-${module}-heartbeat.json`),
          logger: logger.child({ poller: module }),
        }),
    );
    // Bind eventSuffix per poller for the handler below.
    this.pollers.forEach((poller, i) => {
      const { eventSuffix } = HEARTBEAT_EVENT_MODULES[i]!;
      void poller.start(async (event) => {
        if (!event.type?.endsWith(eventSuffix)) return;
        const parsed = event.parsedJson as { miner_id?: string } | undefined;
        if (!parsed?.miner_id) return;
        const minerId = normalizeSuiAddress(parsed.miner_id);
        const seenAtMs = Number(event.timestampMs ?? Date.now());
        const prev = this.lastSeenMs.get(minerId);
        if (prev === undefined || seenAtMs > prev) this.lastSeenMs.set(minerId, seenAtMs);
      });
    });
  }

  /**
   * Most recent real-time heartbeat-event timestamp for `minerId`, or `undefined`
   * if none has ever been observed (a freshly registered/never-heartbeated node,
   * or history not yet replayed) — callers should NOT treat "undefined" as stale.
   */
  lastSeen(minerId: string): number | undefined {
    return this.lastSeenMs.get(minerId);
  }

  /** First-observation default: called once per newly discovered, never-seen node. */
  seed(minerId: string, atMs: number): void {
    if (!this.lastSeenMs.has(minerId)) this.lastSeenMs.set(minerId, atMs);
  }

  stop(): void {
    for (const poller of this.pollers) poller.stop();
  }
}

/** Cast `cast_liveness_vote` against `targetMinerId`, signed by this validator's main wallet. */
async function castLivenessVote(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  targetMinerId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::liveness_voting::cast_liveness_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.livenessVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.validatorRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.signalingRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.pure.id(targetMinerId),
        ],
      });
    },
    'cast-liveness-vote',
    logger,
  );
  return result !== null;
}

// ── GraphQL: resolve a miner_id's StakePosition shared-object id ──

const STAKE_POSITION_QUERY = `
  query FindStakePositions($type: String!, $after: String) {
    objects(filter: { type: $type }, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        address
        asMoveObject { contents { json } }
      }
    }
  }
`;

interface StakePositionQueryResult {
  objects: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ address: string; asMoveObject: { contents: { json: unknown } } | null }>;
  };
}

/**
 * Scan all shared `StakePosition` objects of this deployment's ORIGINAL package
 * (the struct's type is pinned to the defining package forever, same rationale
 * as NetworkConfig.originalPackageId / EventPoller) looking for one whose
 * `miner_id` field matches `targetMinerId`. Returns `null` if not found or the
 * query fails (crash-safe — caller skips the ejection attempt this tick).
 */
export async function findStakePositionId(
  graphqlClient: SuiGraphQLClient,
  config: NetworkConfig,
  targetMinerId: string,
  logger: Logger,
  maxPages = 20,
): Promise<string | null> {
  const type = `${config.originalPackageId ?? config.packageId}::staking::StakePosition`;
  let cursor: string | null = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const result: GraphQLQueryResult<StakePositionQueryResult> = await graphqlClient.query<
        StakePositionQueryResult,
        { type: string; after: string | null }
      >({ query: STAKE_POSITION_QUERY, variables: { type, after: cursor } });

      const conn = result.data?.objects;
      if (!conn) break;

      for (const node of conn.nodes) {
        const json = node.asMoveObject?.contents.json as { miner_id?: string } | undefined;
        if (json?.miner_id === targetMinerId) return node.address;
      }

      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  } catch (err) {
    logger.warn({ err, targetMinerId }, 'liveness-sweep: findStakePositionId GraphQL query failed');
    return null;
  }
  return null;
}

/** Submit `registration::execute_ejection` for a target whose quorum has already been approved. */
async function executeEjection(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  stakePositionId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::registration::execute_ejection`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.livenessVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.signalingRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(stakePositionId),
        ],
      });
    },
    'execute-ejection',
    logger,
  );
  return result !== null;
}

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
          recordWorkerDownVote(candidate.minerId);
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
