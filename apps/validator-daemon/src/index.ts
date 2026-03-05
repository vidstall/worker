/**
 * Validator Daemon — Entry point.
 *
 * The validator daemon:
 * 1. Auto-registers on-chain if VALIDATOR_CAP_ID is not set
 * 2. Generates a session wallet (Ed25519Keypair) distinct from the main wallet
 * 3. Runs a periodic measurement loop collecting simulated metrics
 * 4. Constructs dual-key signed SessionProofs each cycle (NOT submitted on-chain)
 * 5. Listens for validator_registry events via EventPoller
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
} from '@dvconf/shared';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { ensureRegistered } from './auto-register.js';
import { collectMeasurements } from './measurements.js';
import {
  buildSessionProof,
  serializeProof,
  dualKeySign,
  logProofSummary,
} from './session-proof.js';

const logger = createLogger('validator-daemon');

/** Configuration for the measurement loop. */
export interface ValidatorConfig {
  /** Interval between measurement cycles in ms (default: 60000). */
  measurementIntervalMs: number;
  /** Relay miner ID to measure (from env or placeholder). */
  relayMinerId: string;
  /** Validator miner ID (from registration). */
  validatorMinerId: string;
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
  running: boolean;
}

/**
 * Start the validator daemon.
 *
 * Exported for testing — returns the daemon state for lifecycle control.
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

  // Generate session wallet — fresh Ed25519Keypair, NOT derived from main wallet
  const { keypair: sessionKeypair, address: sessionAddress } = generateSessionKeypair();

  log.info(
    { mainAddress, sessionAddress },
    `Validator daemon started — main wallet: ${mainAddress}, session wallet: ${sessionAddress}`,
  );

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
    running: true,
  };

  // Read measurement config from env
  const measurementIntervalMs = parseInt(process.env['MEASUREMENT_INTERVAL_MS'] ?? '60000', 10);
  const relayMinerId = process.env['RELAY_MINER_ID'] ?? 'demo-relay';
  const validatorMinerId = validatorCapId;

  // Start periodic measurement loop
  state.measurementTimer = setInterval(() => {
    if (!state.running) return;
    void runMeasurementCycle(
      relayMinerId,
      validatorMinerId,
      sessionAddress,
      mainKeypair,
      sessionKeypair,
      log,
    );
  }, measurementIntervalMs);

  // Run one cycle immediately
  void runMeasurementCycle(
    relayMinerId,
    validatorMinerId,
    sessionAddress,
    mainKeypair,
    sessionKeypair,
    log,
  );

  // Start event poller for validator_registry events
  const eventPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: 10_000,
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

  return state;
}

/**
 * Run a single measurement cycle:
 * 1. Collect measurements for relay
 * 2. Build SessionProof
 * 3. Dual-key sign
 * 4. Log (do NOT submit on-chain)
 */
async function runMeasurementCycle(
  relayMinerId: string,
  validatorMinerId: string,
  sessionWalletAddress: string,
  mainKeypair: Ed25519Keypair,
  sessionKeypair: Ed25519Keypair,
  log: Logger,
): Promise<void> {
  try {
    const measurement = collectMeasurements(relayMinerId);
    const epoch = BigInt(Math.floor(Date.now() / 1000));

    const proof = buildSessionProof(
      'pending-room',  // placeholder — room assignment happens in later phases
      relayMinerId,
      validatorMinerId,
      sessionWalletAddress,
      measurement,
      epoch,
    );

    const proofBytes = serializeProof(proof);
    await dualKeySign(proofBytes, mainKeypair, sessionKeypair);

    logProofSummary(proof);
  } catch (err) {
    log.error({ err }, 'Measurement cycle failed');
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

  l.info('Validator daemon shut down');
}

// ── Main entry point ──────────────────────────────────────────────────

/* istanbul ignore next — CLI entry point */
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
