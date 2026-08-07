/**
 * Room-scoped health-vote watcher — the validator-side reaction leg of
 * room_health_alerts.move's fast, room-scoped dead-worker detection (see that
 * module's doc). Distinct from liveness-sweep.ts's global, self-directed
 * staleness voting: this module only reacts to `WorkerDownReported` events for
 * rooms where THIS validator is one of the room's 3 `room_health_validators`
 * (set at pairing-proposal time — see room_manager_pairing.move), and only
 * after its OWN independent reachability probe of the target agrees.
 *
 * Mirrors liveness-sweep.ts's `ejectionPoller` block: a single EventPoller on
 * the satellite `_events` module, filtering by event type, resolving what it
 * needs off-chain, then submitting one follow-up TX via `executeWithRetry`.
 *
 * PROBE COVERAGE GAP (mirrors the client-side scoping note in
 * useWorkerHealthCheck's design): only `relay_registry` and
 * `signaling_registry` expose `endpoint_url` on-chain — `control_plane_registry`
 * does not (confirmed via schema grep), so a cp-role target cannot be
 * independently HTTP-probed by this daemon at all. Rather than vote blind
 * (trusting the client-alert leg alone, which has its own known trust gap —
 * see room_health_alerts.move's module doc), cp-role WorkerDownReported events
 * are logged only, same log-and-alert posture cp-daemon's
 * worker-confirmed-dead-listener.ts already takes for non-relay
 * WorkerConfirmedDead targets.
 */

import { join } from 'node:path';
import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
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

const MOD = 'room-health-vote-watcher';

const cursorDir = (name: string): string => join(process.env.DATA_DIR ?? '.', '.cursors', name);

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** Mirrors dvconf::constants role codes (role_relay=2, role_signaling=4). */
const ROLE_RELAY = 2;
const ROLE_SIGNALING = 4;

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2500;

// relay_registry.move — field order mirrors the deployed Move struct.
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

// signaling_registry.move — field order mirrors the deployed Move struct.
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

interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

function decodeUtf8(bytes: number[]): string {
  return Buffer.from(bytes).toString('utf8');
}

/** Read `<role registry>::get_active_*` and resolve `targetMinerId`'s endpoint_url, or null. */
async function resolveTargetEndpoint(
  client: SuiClient,
  config: NetworkConfig,
  targetRole: number,
  targetMinerId: string,
  logger: Logger,
): Promise<string | null> {
  const roleConfig =
    targetRole === ROLE_RELAY
      ? { target: `${config.packageId}::relay_registry::get_active_relays`, registryId: config.relayRegistryId, schema: RelayNodeInfoSchema }
      : targetRole === ROLE_SIGNALING
        ? { target: `${config.packageId}::signaling_registry::get_active_nodes`, registryId: config.signalingRegistryId, schema: SignalingNodeInfoSchema }
        : null;
  if (!roleConfig) return null;

  try {
    const tx = new Transaction();
    tx.moveCall({ target: roleConfig.target, arguments: [tx.object(roleConfig.registryId)] });
    const r = (await client.devInspectTransactionBlock({ transactionBlock: tx, sender: ZERO })) as DevInspectLike;
    if (r.error) {
      logger.warn({ module: MOD, err: r.error }, 'resolveTargetEndpoint devInspect failed');
      return null;
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) return null;

    const decoded = bcs.vector(roleConfig.schema).parse(Uint8Array.from(bytes)) as Array<{
      miner_id: string;
      endpoint_url: number[];
    }>;
    const match = decoded.find((n) => normalizeSuiAddress(n.miner_id) === normalizeSuiAddress(targetMinerId));
    return match ? decodeUtf8(match.endpoint_url) : null;
  } catch (err) {
    logger.warn({ module: MOD, err }, 'resolveTargetEndpoint failed');
    return null;
  }
}

/** GETs `<endpoint host>/healthz` with a short timeout — mirrors relay-liveness-probe.ts's probeRelayHealthz. */
async function probeHealthz(endpointUrl: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<boolean> {
  let healthzUrl: string;
  try {
    const parsed = new URL(endpointUrl);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
    healthzUrl = `${scheme}//${parsed.host}/healthz`;
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(healthzUrl, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Read `room_manager::get_room_health_validators(manager, room_id)` via devInspect. */
async function readRoomHealthValidators(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<string[]> {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::room_manager::get_room_health_validators`,
      arguments: [tx.object(config.roomManagerId), tx.pure.id(roomId)],
    });
    const r = (await client.devInspectTransactionBlock({ transactionBlock: tx, sender: ZERO })) as DevInspectLike;
    if (r.error) {
      logger.warn({ module: MOD, roomId, err: r.error }, 'readRoomHealthValidators devInspect failed');
      return [];
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) return [];
    const ids = bcs.vector(bcs.Address).parse(Uint8Array.from(bytes)) as string[];
    return ids.map((id) => normalizeSuiAddress(id));
  } catch (err) {
    logger.warn({ module: MOD, roomId, err }, 'readRoomHealthValidators failed');
    return [];
  }
}

/** Submit `room_health_alerts::cast_health_vote`, signed by this validator's main wallet. */
async function castHealthVote(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  alertBoxId: string,
  minerCapId: string,
  roomId: string,
  targetMinerId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::room_health_alerts::cast_health_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(alertBoxId),
          tx.object(config.validatorRegistryId),
          tx.object(minerCapId),
          tx.pure.id(roomId),
          tx.pure.id(targetMinerId),
        ],
      });
    },
    'cast-health-vote',
    logger,
  );
  return result !== null;
}

export interface RoomHealthVoteWatcherOptions {
  client: SuiClient;
  graphqlClient: SuiGraphQLClient;
  config: NetworkConfig;
  signer: Ed25519Keypair;
  minerCapId: string;
  ownMinerId: string;
  logger?: Logger;
  pollIntervalMs?: number;
}

export interface RoomHealthVoteWatcherHandle {
  stop: () => void;
}

/**
 * Start the room health-vote watcher. No-ops (does not throw) if
 * `config.roomHealthAlertBoxId` is unset (see NetworkConfig's doc) — additive
 * feature, a deployment that hasn't published room_health_alerts.move yet
 * should keep running without it.
 */
export function startRoomHealthVoteWatcher(opts: RoomHealthVoteWatcherOptions): RoomHealthVoteWatcherHandle {
  const {
    client, graphqlClient, config, signer, minerCapId, ownMinerId,
    logger = createLogger(MOD),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = opts;

  if (!config.roomHealthAlertBoxId) {
    logger.info({ module: MOD }, 'roomHealthAlertBoxId unset — room health-vote watcher disabled');
    return { stop: () => {} };
  }
  const alertBoxId = config.roomHealthAlertBoxId;

  let running = true;
  // Hard skip: this validator has already cast a vote for this (room, target) and it hasn't
  // resolved yet (mirrors liveness-sweep.ts's `votedFor` set — re-submitting a vote already
  // recorded on-chain deterministically aborts with E_ALREADY_VOTED).
  const votedFor = new Set<string>();
  const key = (roomId: string, targetMinerId: string): string => `${roomId}:${normalizeSuiAddress(targetMinerId)}`;

  const poller = new EventPoller({
    client: graphqlClient,
    // NOT config.originalPackageId -- room_health_alerts was added in a later
    // upgrade than the package's first-ever publish (same rationale as
    // liveness-sweep.ts's ejectionPoller).
    packageId: config.roomHealthAlertsOriginPackageId ?? config.originalPackageId ?? config.packageId,
    module: 'room_health_alerts_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('room-health-vote-watcher-events.json'),
    logger: logger.child({ poller: 'room_health_alerts' }),
  });

  void poller.start(async (event) => {
    if (!running) return;

    if (event.type?.endsWith('::WorkerConfirmedDead')) {
      const parsed = event.parsedJson as { room_id?: string; target_miner_id?: string } | undefined;
      if (parsed?.room_id && parsed.target_miner_id) {
        votedFor.delete(key(parsed.room_id, parsed.target_miner_id));
      }
      return;
    }

    if (!event.type?.endsWith('::WorkerDownReported')) return;
    const parsed = event.parsedJson as
      | { room_id?: string; target_miner_id?: string; target_role?: number | string }
      | undefined;
    const roomId = parsed?.room_id;
    const targetMinerId = parsed?.target_miner_id;
    const targetRole = parsed?.target_role !== undefined ? Number(parsed.target_role) : undefined;
    if (!roomId || !targetMinerId || targetRole === undefined) return;

    const dedupKey = key(roomId, targetMinerId);
    if (votedFor.has(dedupKey)) return;

    if (targetRole !== ROLE_RELAY && targetRole !== ROLE_SIGNALING) {
      // No endpoint_url on control_plane_registry -> no independent probe possible.
      // Log-and-alert only, same posture as the cp-daemon WorkerConfirmedDead listener's
      // non-relay handling (see module doc's PROBE COVERAGE GAP).
      logger.warn(
        { module: MOD, roomId, targetMinerId, targetRole },
        'WorkerDownReported for a role this daemon cannot independently probe — not voting',
      );
      return;
    }

    const healthValidators = await readRoomHealthValidators(client, config, roomId, logger);
    if (!healthValidators.includes(normalizeSuiAddress(ownMinerId))) {
      return; // not this room's health-validator set — nothing to do
    }

    const endpointUrl = await resolveTargetEndpoint(client, config, targetRole, targetMinerId, logger);
    if (!endpointUrl) {
      logger.warn(
        { module: MOD, roomId, targetMinerId, targetRole },
        'WorkerDownReported: could not resolve target endpoint — skipping this occurrence',
      );
      return;
    }

    const reachable = await probeHealthz(endpointUrl);
    if (reachable) {
      logger.info(
        { module: MOD, roomId, targetMinerId, endpointUrl },
        'WorkerDownReported: independent probe found target reachable — not voting',
      );
      return;
    }

    logger.info(
      { module: MOD, roomId, targetMinerId, targetRole, endpointUrl },
      'WorkerDownReported: independent probe agrees target is unreachable — casting health vote',
    );
    const ok = await castHealthVote(client, signer, config, alertBoxId, minerCapId, roomId, targetMinerId, logger);
    if (ok) {
      votedFor.add(dedupKey);
      recordWorkerDownVote(targetMinerId);
      logger.info({ module: MOD, roomId, targetMinerId }, 'cast_health_vote succeeded');
    } else {
      logger.warn({ module: MOD, roomId, targetMinerId }, 'cast_health_vote failed');
    }
  });

  return {
    stop: () => {
      running = false;
      poller.stop();
    },
  };
}
