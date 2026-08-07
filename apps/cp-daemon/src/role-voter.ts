/**
 * Role voting module — periodic polling for unassigned miners.
 *
 * Tracks unassigned miners discovered via MinerRegistered events (role=0/User).
 * Reads active_count from all 4 registries via devInspect, computes scarcest role,
 * and casts vote TXs on-chain via RoleVoteBox.
 *
 * Implements VOTE-02, VOTE-05, VOTE-06.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import {
  executeWithRetry,
  MinerRole,
  createCounter,
  createDurationHistogram,
  type NetworkConfig,
  type Logger,
  type Registry,
} from '@dvconf/shared';

/** `vector<ID>` decodes to an array of 0x-addresses. */
const IdVectorSchema = bcs.vector(bcs.Address);

// Academic-eval decentralization metric: the Move contract requires a 2/3
// CP supermajority (role_voting.move's base_threshold_bps = 6667) before a
// miner gets assigned a role -- this counter makes that voting ACTIVITY
// visible over time on the dashboard (votes cast, not the on-chain quorum
// tally itself, which would need a devInspect read per sample instead of
// a cheap local increment). Same opt-in module-level pattern as
// packages/shared/src/chain/tx.ts's registerTxMetrics.
let roleVoteCounter: ReturnType<typeof createCounter> | null = null;

// Monitoring-redesign gap #2: dvconf_role_votes_cast_total only counts votes
// cast, not how long a miner sat unassigned before this CP got to it --
// tracked per-miner via minerDiscoveredAt below (populated wherever a miner
// first enters unassignedMiners, either the live event path or the
// self-heal reconcile backfill).
let roleVoteLatencyHistogram: ReturnType<typeof createDurationHistogram> | null = null;
const minerDiscoveredAt = new Map<string, number>();

/** Wire `dvconf_role_votes_cast_total` and `dvconf_role_vote_latency_seconds` into `registry` -- call once at cp-daemon startup. */
export function registerRoleVoterMetrics(registry: Registry): void {
  roleVoteCounter = createCounter(
    registry,
    'dvconf_role_votes_cast_total',
    'Successful cast_role_vote transactions submitted by this CP',
    [],
  );
  roleVoteLatencyHistogram = createDurationHistogram(
    registry,
    'dvconf_role_vote_latency_seconds',
    'Time from a miner first being seen as unassigned to this CP casting its role vote',
    [],
  );
}

/** Role constant mapping (matches Move constants.move). */
const ROLE_RELAY = MinerRole.Relay;       // 2
const ROLE_VALIDATOR = MinerRole.Validator; // 1
const ROLE_CP = MinerRole.CP;             // 3
const ROLE_SIGNALING = MinerRole.Signaling; // 4

/** Registry active counts snapshot. */
export interface RegistryCounts {
  relay: bigint;
  validator: bigint;
  cp: bigint;
  signaling: bigint;
}

/** Set of miner IDs we have already voted on (avoid duplicate vote errors). */
const votedMiners = new Set<string>();

/** Set of unassigned miner IDs discovered from MinerRegistered events (role=0). */
const unassignedMiners = new Set<string>();

/** F47 RV-010 — miners marked re-vote-eligible (from RevoteEligibleMarked events). */
const revoteCandidates = new Set<string>();

/** Decode a BCS u64 (LE bytes) into a bigint. */
function decodeU64(bytes: number[]): bigint {
  let value = 0n;
  for (let i = 0; i < Math.min(bytes.length, 8); i++) {
    value |= BigInt(bytes[i]!) << BigInt(i * 8);
  }
  return value;
}

/** Read a u64 field from a miner's on-chain profile via devInspect. */
async function readMinerField(
  client: SuiClient,
  packageId: string,
  minerStoreId: string,
  minerId: string,
  fn: string,
  sender: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::miner_store::${fn}`,
    arguments: [tx.object(minerStoreId), tx.pure.id(minerId)],
  });

  try {
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender,
    });
    const returnValues = result.results?.[0]?.returnValues;
    if (!returnValues || returnValues.length === 0) return 0n;
    const bytes = returnValues[0]![0];
    if (!bytes || bytes.length === 0) return 0n;
    return decodeU64(bytes);
  } catch {
    return 0n;
  }
}

/**
 * Read a miner's bandwidth_mbps from on-chain MinerProfile via devInspect.
 * Returns the bandwidth value; 0 means non-relay (signaling/CP/validator).
 */
async function readMinerBandwidth(
  client: SuiClient, packageId: string, minerStoreId: string, minerId: string, sender: string,
): Promise<bigint> {
  return readMinerField(client, packageId, minerStoreId, minerId, 'get_miner_bandwidth', sender);
}

/**
 * Read a miner's cpu_cores from on-chain MinerProfile via devInspect.
 * Signaling registers with cpu_cores > 0; validators register with cpu_cores == 0.
 */
async function readMinerCpuCores(
  client: SuiClient, packageId: string, minerStoreId: string, minerId: string, sender: string,
): Promise<bigint> {
  return readMinerField(client, packageId, minerStoreId, minerId, 'get_miner_cpu_cores', sender);
}

/**
 * Read the number of active nodes from a registry via devInspect.
 */
async function readActiveCount(
  client: SuiClient,
  packageId: string,
  module: string,
  fn: string,
  registryId: string,
  sender: string,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::${module}::${fn}`,
    arguments: [tx.object(registryId)],
  });

  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender,
  });

  const returnValues = result.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length === 0) return 0n;

  // Return value is BCS-encoded u64 (8 bytes LE)
  const bytes = returnValues[0]![0];
  if (!bytes || bytes.length === 0) return 0n;

  let value = 0n;
  for (let i = 0; i < Math.min(bytes.length, 8); i++) {
    value |= BigInt(bytes[i]!) << BigInt(i * 8);
  }
  return value;
}

/**
 * Read all 4 registry active counts.
 */
async function readRegistryCounts(
  client: SuiClient,
  config: NetworkConfig,
  sender: string,
): Promise<RegistryCounts> {
  const [relay, validator, cp, signaling] = await Promise.all([
    readActiveCount(client, config.packageId, 'relay_registry', 'active_count', config.relayRegistryId, sender),
    readActiveCount(client, config.packageId, 'validator_registry', 'active_count', config.validatorRegistryId, sender),
    readActiveCount(client, config.packageId, 'control_plane_registry', 'active_cp_count', config.cpRegistryId, sender),
    readActiveCount(client, config.packageId, 'signaling_registry', 'active_signaling_count', config.signalingRegistryId, sender),
  ]);
  return { relay, validator, cp, signaling };
}

/**
 * Compute which role is scarcest based on registry counts.
 *
 * Returns the role constant (u8) for the role with fewest active nodes.
 * Ties broken by priority: validator > signaling > relay > cp.
 */
function computeScarcestRole(counts: RegistryCounts): number {
  const roles: Array<{ role: number; count: bigint }> = [
    { role: ROLE_VALIDATOR, count: counts.validator },
    { role: ROLE_SIGNALING, count: counts.signaling },
    { role: ROLE_RELAY, count: counts.relay },
    { role: ROLE_CP, count: counts.cp },
  ];

  // Sort ascending by count (scarcest first), tie-break by array order (priority)
  roles.sort((a, b) => {
    if (a.count < b.count) return -1;
    if (a.count > b.count) return 1;
    return 0;
  });

  return roles[0]!.role;
}

/**
 * F47 RV-010 — compute the best role for a re-vote candidate. Reuses the initial-vote
 * scarcity selection (scarcest role wins, same tie-break) so re-votes rebalance the
 * network toward the role most in need.
 */
export function computeBestRoleForRevote(counts: RegistryCounts): number {
  return computeScarcestRole(counts);
}

/**
 * Cast a vote TX for a miner to be assigned to the scarcest role.
 */
async function castVote(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  minerId: string,
  role: number,
  logger: Logger,
): Promise<void> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      // F47 D-S70-4 (2026-05): cast_role_vote is canonically 10-arg — there is NO
      // `stake: &StakePosition` param. An earlier plan added one, but it was REVERTED:
      // a CP-signed cast cannot reference the miner's OWNED StakePosition (Sui owned-
      // object input rule). The stake guards therefore live on the miner-signed side:
      // stake-binding (role_voting.move:717) + role threshold (:713) are enforced in
      // `registration::apply_voted_role`, not here. This call matches the deployed
      // 10-arg entry; no stake arg to add.
      tx.moveCall({
        // Package split (see services/contract/role-voting): role_voting
        // now lives in its own package, not config.packageId.
        target: `${config.roleVotingPackageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),    // &NetworkRegistry
          tx.object(config.roleVoteBoxId),        // &mut RoleVoteBox
          tx.object(config.minerStoreId),          // &MinerStore
          tx.object(config.cpRegistryId),          // &ControlPlaneRegistry
          tx.object(config.relayRegistryId),       // &RelayRegistry
          tx.object(config.validatorRegistryId),   // &ValidatorRegistry
          tx.object(config.signalingRegistryId),   // &SignalingRegistry
          tx.object(cpCapId),                      // &ControlPlaneCap
          tx.pure.id(minerId),                     // miner_id: ID
          tx.pure.u8(role),                        // role: u8
        ],
      });
    },
    'cast-role-vote',
    logger,
  );
  if (result) roleVoteCounter?.inc();
}

/**
 * Add a miner to the unassigned set (called from event handler on MinerRegistered with role=0).
 */
export function trackUnassignedMiner(minerId: string): void {
  if (!unassignedMiners.has(minerId)) {
    minerDiscoveredAt.set(minerId, Date.now());
  }
  unassignedMiners.add(minerId);
}

/**
 * Reconcile the in-memory unassigned-miner queue against on-chain truth.
 *
 * trackUnassignedMiner is only ever invoked from a live MinerRegistered event.
 * If this CP-daemon process starts (or restarts) after that event already
 * fired — e.g. mid-deploy, or because a miner's daemon crash-looped through
 * a registration retry earlier — the miner is invisible to the in-memory
 * queue forever, since the event won't fire again. This periodically reads
 * miner_store::get_unassigned_miners (role=User) and backfills any miner_id
 * not already tracked or voted, so the daemon self-heals without relying on
 * having been alive for the exact moment of registration.
 */
async function reconcileUnassignedMiners(
  client: SuiClient,
  config: NetworkConfig,
  sender: string,
  logger: Logger,
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::miner_store::get_unassigned_miners`,
    arguments: [tx.object(config.minerStoreId)],
  });

  try {
    const result = await client.devInspectTransactionBlock({ transactionBlock: tx, sender });
    const bytes = result.results?.[0]?.returnValues?.[0]?.[0];
    if (!bytes || bytes.length === 0) return;

    const ids = IdVectorSchema.parse(Uint8Array.from(bytes)) as string[];
    let discovered = 0;
    for (const id of ids) {
      if (!unassignedMiners.has(id) && !votedMiners.has(id)) {
        minerDiscoveredAt.set(id, Date.now());
        unassignedMiners.add(id);
        discovered++;
      }
    }
    if (discovered > 0) {
      logger.info(
        { discovered, totalUnassigned: ids.length },
        'Reconciled unassigned miners from on-chain state — backfilled miners missed by event stream',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to reconcile unassigned miners from on-chain state');
  }
}

/**
 * Clear a miner from the voted set and unassigned set
 * (called when RoleAssigned event is received).
 */
export function clearVotedMiner(minerId: string): void {
  votedMiners.delete(minerId);
  unassignedMiners.delete(minerId);
  minerDiscoveredAt.delete(minerId);
}

/**
 * F47 RV-010 — add a miner to the re-vote candidate set
 * (called from the event handler on `RevoteEligibleMarked`).
 */
export function trackRevoteCandidate(minerId: string): void {
  revoteCandidates.add(minerId);
}

/**
 * F47 RV-010 — remove a miner from the re-vote candidate AND voted sets
 * (called on `RoleTransitioned`, so a future re-mark can vote again).
 */
export function clearRevoteCandidate(minerId: string): void {
  revoteCandidates.delete(minerId);
  votedMiners.delete(minerId);
}

/** F47 RV-010 — snapshot of current re-vote candidates (tests / observability). */
export function getRevoteCandidates(): string[] {
  return Array.from(revoteCandidates);
}

/**
 * Start the role voting loop.
 *
 * Periodically checks for unassigned miners (tracked from events),
 * computes the scarcest role, and casts vote TXs.
 *
 * @returns A stop function that clears the interval.
 */
export function startRoleVoting(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  logger: Logger,
  intervalMs: number,
): () => void {
  logger.info({ intervalMs }, 'Starting role voting loop');
  const sender = signer.toSuiAddress();

  const roleNames: Record<number, string> = {
    [ROLE_RELAY]: 'relay',
    [ROLE_VALIDATOR]: 'validator',
    [ROLE_CP]: 'cp',
    [ROLE_SIGNALING]: 'signaling',
  };

  const poll = async (): Promise<void> => {
    try {
      // 0. Reconcile against on-chain truth — backfills any miner whose
      // MinerRegistered event was missed (e.g. this daemon started after
      // the event fired). See reconcileUnassignedMiners doc comment.
      await reconcileUnassignedMiners(client, config, sender, logger);

      // 1. Check for unassigned miners + re-vote candidates (RV-010)
      const pendingMiners = Array.from(unassignedMiners).filter(id => !votedMiners.has(id));
      const pendingRevotes = Array.from(revoteCandidates).filter(id => !votedMiners.has(id));
      if (pendingMiners.length === 0 && pendingRevotes.length === 0) {
        logger.debug('No unvoted unassigned miners or re-vote candidates found');
        return;
      }

      // 2. Read registry counts
      const counts = await readRegistryCounts(client, config, sender);
      logger.info(
        {
          relay: counts.relay.toString(),
          validator: counts.validator.toString(),
          cp: counts.cp.toString(),
          signaling: counts.signaling.toString(),
          pendingCount: pendingMiners.length,
          revoteCount: pendingRevotes.length,
        },
        'Role voting: registry counts loaded',
      );

      // 3-4. For each unassigned miner, infer its intended role from metadata:
      //   bandwidth > 0 → relay
      //   bandwidth == 0, cpu_cores > 0 → signaling
      //   bandwidth == 0, cpu_cores == 0 → validator

      for (const minerId of pendingMiners) {
        let role: number;

        // Read miner metadata to infer daemon type
        const bandwidth = await readMinerBandwidth(client, config.packageId, config.minerStoreId, minerId, sender);
        if (bandwidth > 0n) {
          role = ROLE_RELAY;
          logger.info({ minerId, bandwidth: bandwidth.toString() }, 'Inferred relay daemon from bandwidth');
        } else {
          const cpuCores = await readMinerCpuCores(client, config.packageId, config.minerStoreId, minerId, sender);
          if (cpuCores > 0n) {
            role = ROLE_SIGNALING;
            logger.info({ minerId, cpuCores: cpuCores.toString() }, 'Inferred signaling daemon from cpu_cores > 0');
          } else {
            role = ROLE_VALIDATOR;
            logger.info({ minerId }, 'Inferred validator daemon from bandwidth=0, cpu_cores=0');
          }
        }

        logger.info(
          { assignedRole: roleNames[role] ?? String(role), minerId },
          `Voting role for miner: ${roleNames[role] ?? role}`,
        );

        try {
          await castVote(client, signer, config, cpCapId, minerId, role, logger);
          votedMiners.add(minerId);
          const discoveredAt = minerDiscoveredAt.get(minerId);
          if (discoveredAt !== undefined) {
            roleVoteLatencyHistogram?.observe((Date.now() - discoveredAt) / 1000);
            minerDiscoveredAt.delete(minerId);
          }

          logger.info(
            { minerId, role: roleNames[role] ?? String(role) },
            'Role vote cast successfully',
          );
        } catch (err) {
          logger.warn({ err, minerId }, 'Failed to cast role vote');
        }
      }

      // 5. F47 RV-010 — re-vote pass: cast the scarcest role for marked candidates
      // (cleared from revoteCandidates on RoleTransitioned). Reuses castVote, the
      // canonical 10-arg cast_role_vote (no stake param — D-S70-4 moved the stake
      // guards to the miner-signed apply_voted_role; see the castVote marker above).
      for (const minerId of pendingRevotes) {
        const role = computeBestRoleForRevote(counts);
        logger.info(
          { minerId, assignedRole: roleNames[role] ?? String(role), revote: true },
          `Re-voting role for marked miner: ${roleNames[role] ?? role}`,
        );
        try {
          await castVote(client, signer, config, cpCapId, minerId, role, logger);
          votedMiners.add(minerId);
          logger.info(
            { minerId, role: roleNames[role] ?? String(role), revote: true },
            'Re-vote cast successfully',
          );
        } catch (err) {
          logger.warn({ err, minerId, revote: true }, 'Failed to cast re-vote');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Role voting poll cycle failed');
    }
  };

  // Run first poll immediately
  void poll();

  const handle = setInterval(() => {
    void poll();
  }, intervalMs);

  return () => {
    clearInterval(handle);
    logger.info('Role voting loop stopped');
  };
}
