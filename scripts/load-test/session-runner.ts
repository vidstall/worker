/**
 * Load-test session orchestration (drives one full room lifecycle through the on-chain ops +
 * simulated clients) and the final results report. Split out of `../load-test.ts` (pure code
 * movement — nothing here changes behavior).
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import {
  sleep,
  createRoom,
  createEscrow,
  waitForAssignment,
  closeRoom,
  fetchRelayMetrics,
  waitForRewards,
  type RelayMetrics,
  type RewardResult,
} from './chain-ops.js';
import { simulateClient, type ClientResult } from './simulate-client.js';

// ── Session runner ────────────────────────────────────────────────────

export interface SessionResult {
  roomId: string;
  escrowId: string | null;
  assignment: { relayId: string } | null;
  clients: ClientResult[];
  relayMetrics: RelayMetrics | null;
  rewards: RewardResult | null;
  totalDurationMs: number;
  success: boolean;
  error: string | null;
}

export async function runSession(
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
      { relayId: result.assignment.relayId },
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

export function printReport(sessions: SessionResult[], logger: Logger): void {
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
