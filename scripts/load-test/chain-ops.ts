/**
 * Load-test on-chain operations: room lifecycle (create/escrow/assignment/close), relay
 * metrics fetch, and reward-distribution polling. Split out of `../load-test.ts` (pure code
 * movement — nothing here changes behavior).
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  executeWithRetry,
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';

// ── Helpers ───────────────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll a condition until it returns a truthy value or timeout. */
export async function pollUntil<T>(
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

export interface RoomInfo {
  roomId: string;
  escrowId: string | null;
}

export async function createRoom(
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
          tx.pure.u64(4), // expected_participants (was MISSING — pre-existing arg drift)
          tx.pure.u8(0), // room_class_hint = small (NEW REQ-RMS-016)
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

export async function createEscrow(
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

export async function waitForAssignment(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<{ relayId: string }> {
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

        // get_room_assignment's sole return value is now assigned_relays: vector<ID>
        // (was a tuple with a signaling Option<ID> before the standalone signaling
        // node type's removal). BCS vector<address>: 1 ULEB128 length byte (small
        // vectors) followed by 32-byte addresses back to back.
        const returnValues = result.results?.[0]?.returnValues;
        if (!returnValues || returnValues.length < 1) return null;

        const bytes = returnValues[0]![0] as unknown as number[];
        if (!bytes || bytes.length < 1 || bytes[0] === 0) return null; // empty vector = unassigned

        const relayBytes = bytes.slice(1, 33);
        if (relayBytes.length < 32) return null;
        const relayAddr = '0x' + Buffer.from(relayBytes).toString('hex');

        return { relayId: relayAddr };
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

export async function closeRoom(
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

// ── Relay metrics fetching ────────────────────────────────────────────

export interface RelayMetrics {
  bytesForwarded: string;
  uniquePeers: number;
  packetsLost: number;
  jitter: number;
  duration: number;
  activePeers: number;
}

export async function fetchRelayMetrics(
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

export interface RewardResult {
  proofCount: number;
  rewardsDistributed: boolean;
  relayReward: string;
  validatorPool: string;
  cpPool: string;
}

export async function waitForRewards(
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
