/**
 * E2E load test script for DVConf session lifecycle.
 *
 * Tests the full flow: room creation -> escrow -> CP assignment ->
 * client connections -> data transfer -> room close -> validator proofs ->
 * reward distribution.
 *
 * Usage:
 *   pnpm load-test [--sessions N] [--clients N] [--duration N]
 *
 * Requirements: Phase 14 Task 10
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import WebSocket from 'ws';
import pino from 'pino';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  executeWithRetry,
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';

// ── CLI argument parsing ──────────────────────────────────────────────

function parseArgs(): { sessions: number; clients: number; duration: number } {
  const args = process.argv.slice(2);
  let sessions = 1;
  let clients = 3;
  let duration = 30;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--sessions' && next) {
      sessions = parseInt(next, 10);
      i++;
    } else if (arg === '--clients' && next) {
      clients = parseInt(next, 10);
      i++;
    } else if (arg === '--duration' && next) {
      duration = parseInt(next, 10);
      i++;
    }
  }

  return { sessions, clients, duration };
}

// ── Helpers ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a condition until it returns a truthy value or timeout. */
async function pollUntil<T>(
  fn: () => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number,
  label: string,
  logger: Logger,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    logger.debug({ label }, 'Polling...');
    await sleep(intervalMs);
  }
  throw new Error(`Timeout waiting for: ${label}`);
}

// ── On-chain operations ───────────────────────────────────────────────

interface RoomInfo {
  roomId: string;
  escrowId: string | null;
}

async function createRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<string> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(config.userRegistryId),
          tx.pure.u8(0), // relay_mode: SFU
        ],
      });
    },
    'create-room',
    logger,
  );

  if (!result) {
    throw new Error('Failed to create room');
  }

  // Extract room ID from created objects
  const roomId = extractCreatedObjectByType(result, '::room_manager::Room');
  if (!roomId) {
    throw new Error('Could not extract Room ID from TX effects');
  }

  logger.info({ roomId, digest: result.digest }, 'Room created');
  return roomId;
}

async function createEscrow(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<string | null> {
  const escrowAmount = 1_000_000_000n; // 1 DVCONF

  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(escrowAmount)]);
      tx.moveCall({
        target: `${config.packageId}::economic_layer::create_escrow`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.pure.address(roomId),
          payment!,
        ],
      });
    },
    'create-escrow',
    logger,
  );

  if (!result) {
    logger.warn({ roomId }, 'Failed to create escrow — continuing without it');
    return null;
  }

  const escrowId = extractCreatedObjectByType(result, '::economic_layer::Escrow');
  logger.info({ roomId, escrowId, digest: result.digest }, 'Escrow created');
  return escrowId;
}

async function waitForAssignment(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<{ relayId: string; signalingId: string }> {
  return pollUntil(
    async () => {
      try {
        const tx = new Transaction();
        tx.moveCall({
          target: `${config.packageId}::room_manager::get_room_assignment`,
          arguments: [
            tx.object(config.roomManagerId),
            tx.pure.address(roomId),
          ],
        });

        const result = await client.devInspectTransactionBlock({
          transactionBlock: tx,
          sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
        });

        // Parse return values — (Option<ID>, Option<ID>)
        const returnValues = result.results?.[0]?.returnValues;
        if (!returnValues || returnValues.length < 2) return null;

        // BCS-encoded Option<ID>: first byte 0=None, 1=Some followed by 32 bytes
        const relayBytes = returnValues[0]![0] as unknown as number[];
        const signalingBytes = returnValues[1]![0] as unknown as number[];

        if (!relayBytes || relayBytes[0] !== 1) return null;
        if (!signalingBytes || signalingBytes[0] !== 1) return null;

        // Extract the 32-byte address after the Option tag byte
        const relayAddr = '0x' + Buffer.from(relayBytes.slice(1)).toString('hex');
        const signalingAddr = '0x' + Buffer.from(signalingBytes.slice(1)).toString('hex');

        return { relayId: relayAddr, signalingId: signalingAddr };
      } catch (err) {
        logger.debug({ err }, 'devInspect failed, retrying');
        return null;
      }
    },
    3000,  // poll every 3s
    120_000, // 2 min timeout
    `CP assignment for room ${roomId}`,
    logger,
  );
}

async function closeRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<void> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::close_room`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.pure.address(roomId),
        ],
      });
    },
    'close-room',
    logger,
  );

  if (!result) {
    logger.error({ roomId }, 'Failed to close room');
    return;
  }

  logger.info({ roomId, digest: result.digest }, 'Room closed');
}

// ── Simulated client ──────────────────────────────────────────────────

interface ClientResult {
  peerId: string;
  connected: boolean;
  connectTimeMs: number;
  messagesSent: number;
  bytesSent: bigint;
  error: string | null;
}

async function simulateClient(
  relayWsUrl: string,
  roomId: string,
  peerId: string,
  durationSec: number,
  logger: Logger,
): Promise<ClientResult> {
  const result: ClientResult = {
    peerId,
    connected: false,
    connectTimeMs: 0,
    messagesSent: 0,
    bytesSent: 0n,
    error: null,
  };

  const connectStart = Date.now();

  return new Promise<ClientResult>((resolve) => {
    let ws: WebSocket;
    let sendInterval: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (sendInterval) clearInterval(sendInterval);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'leave' }));
          ws.close();
        }
      } catch { /* ignore cleanup errors */ }
      resolve(result);
    };

    try {
      ws = new WebSocket(relayWsUrl);

      ws.on('open', () => {
        result.connectTimeMs = Date.now() - connectStart;
        result.connected = true;

        // Send join message matching relay signaling protocol
        ws.send(JSON.stringify({
          type: 'join',
          roomId,
          peerId,
        }));

        logger.debug({ peerId, connectTimeMs: result.connectTimeMs }, 'Client connected');

        // After join, start sending fake RTP-like data every 100ms
        sendInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            if (sendInterval) clearInterval(sendInterval);
            return;
          }

          // Fake RTP-like payload (random bytes, ~1KB per packet)
          const payload = Buffer.alloc(1024);
          for (let i = 0; i < payload.length; i++) {
            payload[i] = Math.floor(Math.random() * 256);
          }

          ws.send(payload);
          result.messagesSent++;
          result.bytesSent += BigInt(payload.length);
        }, 100);

        // Stop after duration
        setTimeout(finish, durationSec * 1000);
      });

      ws.on('error', (err: Error) => {
        result.error = err.message;
        logger.warn({ peerId, err: err.message }, 'Client WebSocket error');
        finish();
      });

      ws.on('close', () => {
        if (!resolved) {
          logger.debug({ peerId }, 'Client WebSocket closed early');
          finish();
        }
      });

      // Safety timeout — always resolve
      setTimeout(() => {
        if (!resolved) {
          result.error = 'Timeout exceeded';
          finish();
        }
      }, (durationSec + 10) * 1000);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      finish();
    }
  });
}

// ── Relay metrics fetching ────────────────────────────────────────────

interface RelayMetrics {
  bytesForwarded: string;
  uniquePeers: number;
  packetsLost: number;
  jitter: number;
  duration: number;
  activePeers: number;
}

async function fetchRelayMetrics(
  metricsUrl: string,
  roomId: string,
  logger: Logger,
): Promise<RelayMetrics | null> {
  try {
    const res = await fetch(`${metricsUrl}/metrics/${roomId}`);
    if (!res.ok) {
      logger.debug({ status: res.status }, 'Metrics endpoint returned non-200');
      return null;
    }
    return (await res.json()) as RelayMetrics;
  } catch (err) {
    logger.debug({ err }, 'Failed to fetch relay metrics');
    return null;
  }
}

// ── Wait for rewards ─────────────────────────────────────────────────

interface RewardResult {
  proofCount: number;
  rewardsDistributed: boolean;
  relayReward: string;
  validatorPool: string;
  cpPool: string;
}

async function waitForRewards(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<RewardResult> {
  const result: RewardResult = {
    proofCount: 0,
    rewardsDistributed: false,
    relayReward: '0',
    validatorPool: '0',
    cpPool: '0',
  };

  // Poll events for SessionProofSubmitted and RewardsDistributed
  try {
    await pollUntil(
      async () => {
        // Query SessionProofSubmitted events for this room
        const proofEvents = await client.queryEvents({
          query: {
            MoveEventType: `${config.packageId}::economic_layer::SessionProofSubmitted`,
          },
          limit: 50,
        });

        const roomProofs = proofEvents.data.filter((e) => {
          const parsed = e.parsedJson as Record<string, unknown> | undefined;
          return parsed?.['room_id'] === roomId;
        });

        result.proofCount = roomProofs.length;

        // Query RewardsDistributed events for this room
        const rewardEvents = await client.queryEvents({
          query: {
            MoveEventType: `${config.packageId}::economic_layer::RewardsDistributed`,
          },
          limit: 50,
        });

        const roomRewards = rewardEvents.data.filter((e) => {
          const parsed = e.parsedJson as Record<string, unknown> | undefined;
          return parsed?.['room_id'] === roomId;
        });

        if (roomRewards.length > 0) {
          result.rewardsDistributed = true;
          const reward = roomRewards[0]!.parsedJson as Record<string, string>;
          result.relayReward = reward['relay_reward'] ?? '0';
          result.validatorPool = reward['validator_pool'] ?? '0';
          result.cpPool = reward['cp_pool'] ?? '0';
          return true;
        }

        return null;
      },
      5000,   // poll every 5s
      60_000, // 1 min timeout
      `rewards for room ${roomId}`,
      logger,
    );
  } catch {
    logger.warn({ roomId, proofCount: result.proofCount }, 'Reward distribution not observed within timeout');
  }

  return result;
}

// ── Session runner ────────────────────────────────────────────────────

interface SessionResult {
  roomId: string;
  escrowId: string | null;
  assignment: { relayId: string; signalingId: string } | null;
  clients: ClientResult[];
  relayMetrics: RelayMetrics | null;
  rewards: RewardResult | null;
  totalDurationMs: number;
  success: boolean;
  error: string | null;
}

async function runSession(
  sessionIndex: number,
  clientCount: number,
  durationSec: number,
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<SessionResult> {
  const sessionLogger = logger.child({ session: sessionIndex });
  const sessionStart = Date.now();
  const result: SessionResult = {
    roomId: '',
    escrowId: null,
    assignment: null,
    clients: [],
    relayMetrics: null,
    rewards: null,
    totalDurationMs: 0,
    success: false,
    error: null,
  };

  try {
    // 1. Create room
    sessionLogger.info('Creating room...');
    result.roomId = await createRoom(client, signer, config, sessionLogger);

    // 2. Create escrow
    sessionLogger.info('Creating escrow...');
    result.escrowId = await createEscrow(client, signer, config, result.roomId, sessionLogger);

    // 3. Wait for CP assignment
    sessionLogger.info('Waiting for CP assignment...');
    result.assignment = await waitForAssignment(client, config, result.roomId, sessionLogger);
    sessionLogger.info(
      { relayId: result.assignment.relayId, signalingId: result.assignment.signalingId },
      'Room assigned',
    );

    // 4. Spawn simulated clients
    // The relay WebSocket is on port 4000 by default
    const relayWsUrl = `ws://127.0.0.1:4000`;
    const metricsUrl = `http://127.0.0.1:4001`;

    sessionLogger.info({ clientCount, durationSec }, 'Spawning simulated clients...');
    const clientPromises: Promise<ClientResult>[] = [];
    for (let i = 0; i < clientCount; i++) {
      const peerId = `load-test-s${sessionIndex}-c${i}-${Date.now()}`;
      clientPromises.push(
        simulateClient(relayWsUrl, result.roomId, peerId, durationSec, sessionLogger),
      );
      // Stagger connections by 200ms
      await sleep(200);
    }

    result.clients = await Promise.all(clientPromises);

    // 5. Fetch relay metrics
    sessionLogger.info('Fetching relay metrics...');
    result.relayMetrics = await fetchRelayMetrics(metricsUrl, result.roomId, sessionLogger);

    // 6. Close room
    sessionLogger.info('Closing room...');
    await closeRoom(client, signer, config, result.roomId, sessionLogger);

    // 7. Wait for validator proofs + reward distribution
    sessionLogger.info('Waiting for validator proofs and rewards...');
    result.rewards = await waitForRewards(client, config, result.roomId, sessionLogger);

    result.success = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    sessionLogger.error({ err: result.error }, 'Session failed');
  }

  result.totalDurationMs = Date.now() - sessionStart;
  return result;
}

// ── Report ────────────────────────────────────────────────────────────

function printReport(sessions: SessionResult[], logger: Logger): void {
  logger.info('='.repeat(60));
  logger.info('LOAD TEST RESULTS');
  logger.info('='.repeat(60));

  let allSuccess = true;

  for (const session of sessions) {
    logger.info('-'.repeat(40));
    logger.info({ roomId: session.roomId }, `Session`);
    logger.info({ success: session.success, durationMs: session.totalDurationMs }, 'Status');

    if (session.error) {
      logger.error({ error: session.error }, 'Error');
      allSuccess = false;
    }

    // Client connection stats
    const connected = session.clients.filter((c) => c.connected).length;
    const avgConnectTime =
      session.clients.length > 0
        ? Math.round(
            session.clients.reduce((sum, c) => sum + c.connectTimeMs, 0) / session.clients.length,
          )
        : 0;
    const totalBytesSent = session.clients.reduce((sum, c) => sum + c.bytesSent, 0n);
    const totalMessages = session.clients.reduce((sum, c) => sum + c.messagesSent, 0);

    logger.info(
      {
        connected: `${connected}/${session.clients.length}`,
        avgConnectTimeMs: avgConnectTime,
        totalMessagesSent: totalMessages,
        totalBytesSent: totalBytesSent.toString(),
      },
      'Client stats',
    );

    // Client errors
    const clientErrors = session.clients.filter((c) => c.error);
    if (clientErrors.length > 0) {
      for (const ce of clientErrors) {
        logger.warn({ peerId: ce.peerId, error: ce.error }, 'Client error');
      }
      allSuccess = false;
    }

    // Relay metrics
    if (session.relayMetrics) {
      logger.info(
        {
          bytesForwarded: session.relayMetrics.bytesForwarded,
          uniquePeers: session.relayMetrics.uniquePeers,
          activePeers: session.relayMetrics.activePeers,
          packetsLost: session.relayMetrics.packetsLost,
          duration: session.relayMetrics.duration,
        },
        'Relay metrics',
      );
    } else {
      logger.warn('No relay metrics available');
    }

    // Rewards
    if (session.rewards) {
      logger.info(
        {
          proofCount: session.rewards.proofCount,
          rewardsDistributed: session.rewards.rewardsDistributed,
          relayReward: session.rewards.relayReward,
          validatorPool: session.rewards.validatorPool,
          cpPool: session.rewards.cpPool,
        },
        'Reward distribution',
      );
    } else {
      logger.warn('No reward data available');
    }
  }

  logger.info('='.repeat(60));
  logger.info(
    {
      totalSessions: sessions.length,
      successful: sessions.filter((s) => s.success).length,
      failed: sessions.filter((s) => !s.success).length,
    },
    'SUMMARY',
  );

  if (!allSuccess) {
    logger.error('Some sessions had errors — see above for details');
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sessions: sessionCount, clients: clientCount, duration } = parseArgs();

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' },
    },
  }) as unknown as Logger;

  logger.info(
    { sessions: sessionCount, clients: clientCount, duration },
    'Starting load test',
  );

  // Load config and create client
  const config = loadNetworkConfig();
  const network = process.env['SUI_NETWORK'] ?? 'localnet';
  const client = createSuiClient(network);
  const signer = loadKeypair('SIGNER_KEY');

  const signerAddress = signer.getPublicKey().toSuiAddress();
  logger.info({ network, signerAddress, packageId: config.packageId }, 'Connected to chain');

  // Run sessions (concurrently if multiple)
  const sessionPromises: Promise<SessionResult>[] = [];
  for (let i = 0; i < sessionCount; i++) {
    sessionPromises.push(
      runSession(i, clientCount, duration, client, signer, config, logger),
    );
    // Stagger session starts by 1s
    if (i < sessionCount - 1) {
      await sleep(1000);
    }
  }

  const results = await Promise.all(sessionPromises);

  // Print report
  printReport(results, logger);

  // Exit code
  const allSuccess = results.every((r) => r.success);
  process.exit(allSuccess ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exit(1);
});
