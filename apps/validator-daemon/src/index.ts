/**
 * Validator Daemon -- Entry point.
 *
 * The validator daemon:
 * 1. Auto-registers on-chain if VALIDATOR_CAP_ID is not set
 * 2. Generates a session wallet (Ed25519Keypair) distinct from the main wallet
 * 3. Runs a periodic measurement loop collecting simulated metrics
 * 4. Constructs dual-key signed SessionProofs and submits on-chain
 * 5. Listens for validator_registry events via EventPoller
 * 6. Discovers RoomEscrow objects via EscrowCreated events (IC-3)
 * 7. Discovers rooms via RoomCreated/RoomClosed events for dynamic room lifecycle
 * 8. Triggers reward distribution when rooms close and proofs are collected
 *
 * CRITICAL: Never log session wallet private key. Only log the address.
 */

import 'dotenv/config';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  generateSessionKeypair,
  EventPoller,
  createLogger,
  economicLayerModuleName,
  MIN_PROOFS_FOR_DISTRIBUTION,
} from '@dvconf/shared';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type { EscrowCreated, RoomCreated, RoomClosed, RoomAssigned } from '@dvconf/shared';
import { ensureRegistered } from './auto-register.js';
import { collectMeasurements } from './measurements.js';
import { fetchRelayMetrics } from './probe.js';
import {
  buildSessionProof,
  dualKeySign,
  serializeProofBcs,
  logProofSummary,
  submitSessionProof,
} from './session-proof.js';
import { waitForProofs, triggerDistribution, lookupRelayStakeId } from './reward-trigger.js';

const logger = createLogger('validator-daemon');

/** Configuration for the measurement loop. */
export interface ValidatorConfig {
  /** Interval between measurement cycles in ms (default: 60000). */
  measurementIntervalMs: number;
  /** Validator miner ID (from registration). */
  validatorMinerId: string;
}

/** Tracked state per active room. */
export interface ActiveRoom {
  /** Escrow object ID for this room (discovered via EscrowCreated). */
  escrowId?: string;
  /** Relay's StakePosition object ID for reward distribution. */
  relayStakeId?: string;
  /** Relay miner ID assigned to this room (from RoomAssigned event). */
  relayMinerId?: string;
}

/** Internal state for the running daemon. */
export interface DaemonState {
  client: SuiClient;
  mainKeypair: Ed25519Keypair;
  sessionKeypair: Ed25519Keypair;
  sessionAddress: string;
  config: NetworkConfig;
  validatorCapId: string;
  measurementTimer: ReturnType<typeof setInterval> | null;
  eventPoller: EventPoller | null;
  escrowPoller: EventPoller | null;
  roomPoller: EventPoller | null;
  escrowMap: Map<string, string>;
  activeRooms: Map<string, ActiveRoom>;
  running: boolean;
}

/**
 * Start the validator daemon.
 *
 * Exported for testing -- returns the daemon state for lifecycle control.
 */
export async function startDaemon(overrides?: {
  client?: SuiClient;
  mainKeypair?: Ed25519Keypair;
  config?: NetworkConfig;
  logger?: Logger;
}): Promise<DaemonState> {
  const log = overrides?.logger ?? logger;

  // Load configuration
  const config = overrides?.config ?? loadNetworkConfig();
  const client = overrides?.client ?? createSuiClient(config.rpcUrl);
  const mainKeypair = overrides?.mainKeypair ?? loadKeypair('SUI_PRIVATE_KEY');

  const mainAddress = mainKeypair.getPublicKey().toSuiAddress();

  // Auto-register if needed
  const { validatorCapId } = await ensureRegistered(client, mainKeypair, config, log);

  // Generate session wallet -- fresh Ed25519Keypair, NOT derived from main wallet
  const { keypair: sessionKeypair, address: sessionAddress } = generateSessionKeypair();

  log.info(
    { mainAddress, sessionAddress },
    `Validator daemon started -- main wallet: ${mainAddress}, session wallet: ${sessionAddress}`,
  );

  // Escrow map: roomId -> escrowObjectId (discovered via EscrowCreated events, IC-3)
  const escrowMap = new Map<string, string>();

  // Active rooms: roomId -> { escrowId, relayStakeId }
  const activeRooms = new Map<string, ActiveRoom>();

  // Daemon state
  const state: DaemonState = {
    client,
    mainKeypair,
    sessionKeypair,
    sessionAddress,
    config,
    validatorCapId,
    measurementTimer: null,
    eventPoller: null,
    escrowPoller: null,
    roomPoller: null,
    escrowMap,
    activeRooms,
    running: true,
  };

  // Read measurement config from env
  const measurementIntervalMs = parseInt(process.env['MEASUREMENT_INTERVAL_MS'] ?? '60000', 10);
  const validatorMinerId = validatorCapId;
  const pollIntervalMs = 10_000;

  // Start periodic measurement loop -- cycles through all active rooms
  state.measurementTimer = setInterval(() => {
    if (!state.running) return;
    void runMeasurementCycle(state, validatorMinerId, log);
  }, measurementIntervalMs);

  // Run one cycle immediately
  void runMeasurementCycle(state, validatorMinerId, log);

  // Start event poller for validator_registry events
  const eventPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/validator-events.json',
    logger: log,
  });

  state.eventPoller = eventPoller;

  await eventPoller.start(async (event) => {
    log.info(
      { type: event.type, parsedJson: event.parsedJson },
      `Validator event received: ${event.type}`,
    );
  });

  // Start event poller for economic_layer EscrowCreated events (IC-3)
  const escrowPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: economicLayerModuleName,
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/economic-events.json',
    logger: log,
  });

  state.escrowPoller = escrowPoller;

  await escrowPoller.start(async (event) => {
    // IC-3: EscrowCreated Event Contract
    if (event.type.endsWith('::EscrowCreated')) {
      const parsed = event.parsedJson as unknown as EscrowCreated;
      if (parsed.room_id && parsed.escrow_id) {
        escrowMap.set(parsed.room_id, parsed.escrow_id);

        // Update active room record with escrow ID
        const room = activeRooms.get(parsed.room_id);
        if (room) {
          room.escrowId = parsed.escrow_id;
        } else {
          activeRooms.set(parsed.room_id, { escrowId: parsed.escrow_id });
        }

        log.info(
          { roomId: parsed.room_id, escrowId: parsed.escrow_id },
          `EscrowCreated discovered -- room=${parsed.room_id}, escrow=${parsed.escrow_id}`,
        );
      }
    }

    // Log other economic layer events
    if (event.type.endsWith('::SessionProofSubmitted')) {
      log.info(
        { parsedJson: event.parsedJson },
        `SessionProofSubmitted event: ${event.type}`,
      );
    }
  });

  // Start event poller for room_manager RoomCreated/RoomClosed events
  const roomPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'room_manager',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/room_manager.json',
    logger: log.child({ poller: 'room_manager' }),
  });

  state.roomPoller = roomPoller;

  await roomPoller.start(async (event) => {
    if (event.type.endsWith('::RoomCreated')) {
      const parsed = event.parsedJson as unknown as RoomCreated;
      if (parsed.room_id) {
        // Add to active rooms for measurement cycling
        if (!activeRooms.has(parsed.room_id)) {
          activeRooms.set(parsed.room_id, {});
        }
        log.info(
          { roomId: parsed.room_id, creator: parsed.creator },
          `RoomCreated -- room=${parsed.room_id} added to active measurement set`,
        );
      }
    }

    if (event.type.endsWith('::RoomClosed')) {
      const parsed = event.parsedJson as unknown as RoomClosed;
      if (parsed.room_id) {
        log.info(
          { roomId: parsed.room_id },
          `RoomClosed -- room=${parsed.room_id}, checking for reward distribution`,
        );

        // Handle room close -> reward distribution
        void handleRoomClosed(state, parsed.room_id, log);
      }
    }

    // BUG-INT-001: Handle RoomAssigned to populate relayStakeId dynamically
    if (event.type.endsWith('::RoomAssigned')) {
      const parsed = event.parsedJson as unknown as RoomAssigned;
      if (parsed.room_id && parsed.relay_id) {
        const room = activeRooms.get(parsed.room_id) ?? {};
        room.relayMinerId = parsed.relay_id;

        if (!activeRooms.has(parsed.room_id)) {
          activeRooms.set(parsed.room_id, room);
        }

        log.info(
          { roomId: parsed.room_id, relayId: parsed.relay_id },
          `RoomAssigned -- room=${parsed.room_id}, relay=${parsed.relay_id}`,
        );

        // Look up the relay's StakePosition via devInspect + getOwnedObjects
        try {
          const stakeId = await lookupRelayStakeId(
            state.client,
            state.config,
            parsed.relay_id,
            log,
          );
          if (stakeId) {
            room.relayStakeId = stakeId;
            log.info(
              { roomId: parsed.room_id, relayId: parsed.relay_id, stakeId },
              `Relay StakePosition discovered for room=${parsed.room_id}`,
            );
          } else {
            log.warn(
              { roomId: parsed.room_id, relayId: parsed.relay_id },
              `Could not find relay StakePosition for room=${parsed.room_id}`,
            );
          }
        } catch (err) {
          log.warn(
            { err, roomId: parsed.room_id, relayId: parsed.relay_id },
            `Failed to lookup relay StakePosition for room=${parsed.room_id}`,
          );
        }
      }
    }
  });

  return state;
}

/**
 * Handle a RoomClosed event: wait for proofs then trigger distribution.
 */
async function handleRoomClosed(
  state: DaemonState,
  roomId: string,
  log: Logger,
): Promise<void> {
  const escrowId = state.escrowMap.get(roomId);
  if (!escrowId) {
    log.info(
      { roomId },
      `No escrow found for closed room=${roomId} -- skipping reward distribution`,
    );
    // Remove from active rooms
    state.activeRooms.delete(roomId);
    return;
  }

  const room = state.activeRooms.get(roomId);
  const relayStakeId = room?.relayStakeId ?? process.env['RELAY_STAKE_ID'];

  if (!relayStakeId) {
    log.warn(
      { roomId, escrowId },
      `No relay stake ID known for room=${roomId} -- cannot distribute rewards`,
    );
    state.activeRooms.delete(roomId);
    return;
  }

  try {
    // Wait for sufficient session proofs to be submitted
    const hasProofs = await waitForProofs(
      state.client,
      escrowId,
      MIN_PROOFS_FOR_DISTRIBUTION,
      60_000,
      log,
    );

    if (hasProofs) {
      await triggerDistribution(
        state.client,
        state.mainKeypair,
        state.config,
        escrowId,
        roomId,
        relayStakeId,
        log,
      );
    } else {
      log.warn(
        { roomId, escrowId },
        `Insufficient proofs for room=${roomId} -- skipping reward distribution`,
      );
    }
  } catch (err) {
    log.error({ err, roomId, escrowId }, `Reward distribution failed for room=${roomId}`);
  }

  // Remove from active rooms after processing
  state.activeRooms.delete(roomId);
  state.escrowMap.delete(roomId);
}

/**
 * Run a single measurement cycle:
 * 1. Cycle through all active rooms (or fallback to env ROOM_ID)
 * 2. Collect measurements for relay
 * 3. Fetch relay metrics for real unique_peers count
 * 4. Build SessionProof
 * 5. BCS serialize + dual-key sign (IC-2, IC-4)
 * 6. Submit on-chain if escrow is known, otherwise log only
 */
async function runMeasurementCycle(
  state: DaemonState,
  validatorMinerId: string,
  log: Logger,
): Promise<void> {
  // Determine which rooms to measure
  const roomIds: string[] = [];
  if (state.activeRooms.size > 0) {
    for (const roomId of state.activeRooms.keys()) {
      roomIds.push(roomId);
    }
  } else {
    // Fallback to single ROOM_ID from env
    roomIds.push(process.env['ROOM_ID'] ?? 'unassigned');
  }

  for (const roomId of roomIds) {
    try {
      await measureRoom(state, roomId, validatorMinerId, log);
    } catch (err) {
      log.error({ err, roomId }, `Measurement cycle failed for room=${roomId}`);
    }
  }
}

/**
 * Measure a single room: collect metrics, build proof, sign, submit.
 */
async function measureRoom(
  state: DaemonState,
  roomId: string,
  validatorMinerId: string,
  log: Logger,
): Promise<void> {
  // Resolve relay miner ID from room's on-chain assignment (via RoomAssigned event)
  const room = state.activeRooms.get(roomId);
  const relayMinerId = room?.relayMinerId;
  if (!relayMinerId) {
    log.debug(
      { roomId },
      `No relay assigned to room=${roomId} yet -- skipping measurement`,
    );
    return;
  }

  const measurement = collectMeasurements(relayMinerId);
  const epoch = BigInt(Math.floor(Date.now() / 1000));

  // Fetch real unique_peers from relay metrics endpoint
  let uniquePeers = 0n;
  const relayMetricsUrl = process.env['RELAY_METRICS_URL'];
  if (relayMetricsUrl) {
    try {
      const relayMetrics = await fetchRelayMetrics(relayMetricsUrl, roomId);
      if (relayMetrics) {
        uniquePeers = relayMetrics.uniquePeers;
        log.debug(
          { roomId, uniquePeers: uniquePeers.toString() },
          `Fetched relay metrics: uniquePeers=${uniquePeers}`,
        );
      }
    } catch (err) {
      log.warn({ err, roomId }, 'Failed to fetch relay metrics, using fallback uniquePeers=0');
    }
  }

  const proof = buildSessionProof(
    roomId,
    relayMinerId,
    validatorMinerId,
    state.sessionAddress,
    measurement,
    epoch,
  );

  // IC-2: BCS serialize for signing (replaces legacy JSON serialization)
  const durationSeconds = measurement.measurementDurationMs / 1000n;
  const bcsMessage = serializeProofBcs(
    proof.roomId,
    proof.relayMinerId,
    measurement.packetsSent,
    measurement.bytesForwarded,
    uniquePeers,
    durationSeconds,
    measurement.avgLatencyMs,
    measurement.packetLossRate,
    measurement.jitterMs,
  );

  await dualKeySign(bcsMessage, state.mainKeypair, state.sessionKeypair);

  logProofSummary(proof);

  // Attempt on-chain submission if escrow is discovered for this room
  const escrowId = state.escrowMap.get(roomId);
  if (escrowId) {
    await submitSessionProof(
      state.client,
      state.sessionKeypair,
      state.mainKeypair,
      state.config,
      escrowId,
      proof,
      log,
    );
  } else {
    log.info(
      { roomId },
      `No escrow found for room=${roomId} -- proof signed but not submitted. Waiting for EscrowCreated event.`,
    );
  }
}

/**
 * Stop the daemon gracefully.
 */
export function stopDaemon(state: DaemonState, log?: Logger): void {
  const l = log ?? logger;
  state.running = false;

  if (state.measurementTimer) {
    clearInterval(state.measurementTimer);
    state.measurementTimer = null;
    l.info('Measurement loop stopped');
  }

  if (state.eventPoller) {
    state.eventPoller.stop();
    state.eventPoller = null;
    l.info('Event poller stopped');
  }

  if (state.escrowPoller) {
    state.escrowPoller.stop();
    state.escrowPoller = null;
    l.info('Escrow poller stopped');
  }

  if (state.roomPoller) {
    state.roomPoller.stop();
    state.roomPoller = null;
    l.info('Room poller stopped');
  }

  l.info('Validator daemon shut down');
}

// -- Main entry point --

/* istanbul ignore next -- CLI entry point */
async function main(): Promise<void> {
  let state: DaemonState | null = null;

  const shutdown = () => {
    if (state) {
      stopDaemon(state);
      state = null;
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    state = await startDaemon();
  } catch (err) {
    logger.error({ err }, 'Validator daemon failed to start');
    process.exit(1);
  }
}

// Only run main when executed directly (not imported for testing)
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  main().catch((err) => {
    logger.error({ err }, 'Unhandled error');
    process.exit(1);
  });
}
