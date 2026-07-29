/**
 * Role voting utilities — waitForRoleAssignment + applyVotedRole.
 * Used by all daemons in voting-mode registration.
 */
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig } from '../types/chain.js';
import type { Logger } from 'pino';
import { executeWithRetry } from './tx.js';
import { Transaction } from '@mysten/sui/transactions';
import type { Counter } from 'prom-client';
import type { Registry } from '../metrics-prom.js';
import { createCounter } from '../metrics-prom.js';

// Academic-eval decentralization metric, the completion-side counterpart to
// role-voter.ts's dvconf_role_votes_cast_total -- one per role_voting.move's
// 2/3 CP supermajority actually resulting in a completed on-chain role
// assignment. Same opt-in module-level pattern as tx.ts's registerTxMetrics.
let roleAssignmentCounter: Counter<string> | null = null;

/** Wire `dvconf_role_assignments_total{service}` into `registry` -- call once at startup on the voted-on side (relay/signaling/validator-daemon). */
export function registerRoleAssignmentMetrics(registry: Registry, service: string): void {
  roleAssignmentCounter = createCounter(
    registry,
    'dvconf_role_assignments_total',
    'Successful apply_voted_role transactions completed by this instance',
    ['service'],
  );
  roleAssignmentMetricsService = service;
}
let roleAssignmentMetricsService = '';

/**
 * Poll for role assignment matching our miner ID.
 * Checks the RoleVoteBox.assigned_roles table via devInspect.
 * Returns the assigned role code when found, or throws on timeout.
 */
export async function waitForRoleAssignment(
  client: SuiClient,
  config: NetworkConfig,
  minerId: string,
  logger: Logger,
  timeoutMs = 120_000,
  pollIntervalMs = 3_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  logger.info({ minerId }, 'Waiting for role assignment via CP voting...');

  while (Date.now() < deadline) {
    try {
      // Check assigned_roles in RoleVoteBox via devInspect
      const tx = new Transaction();
      tx.moveCall({
        target: `${config.packageId}::role_voting::get_assigned_role`,
        arguments: [
          tx.object(config.roleVoteBoxId),
          tx.pure.id(minerId),
        ],
      });
      const result = await client.devInspectTransactionBlock({
        transactionBlock: tx as any,
        sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });

      // Parse Option<u8> return — if Some, we have our role
      const returnValues = result.results?.[0]?.returnValues;
      if (returnValues && returnValues.length > 0) {
        const bytes = new Uint8Array(returnValues[0][0] as number[]);
        // BCS Option<u8>: first byte is 0 (None) or 1 (Some), second byte is the value
        if (bytes.length >= 2 && bytes[0] === 1) {
          const role = bytes[1];
          logger.info({ minerId, role }, 'Role assigned by voting');
          return role;
        }
      }
    } catch (err) {
      logger.debug({ err }, 'devInspect for role assignment failed, retrying...');
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Role assignment timeout after ${timeoutMs}ms for miner ${minerId}`);
}

/**
 * Apply a voted role — calls registration::apply_voted_role on-chain.
 * Updates MinerCap + MinerProfile + StakePosition atomically.
 */
export async function applyVotedRole(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  stakePositionId: string,
  logger: Logger,
): Promise<void> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        // F47 Phase 1.5 (REQ-RV-005): arg order MUST match the Move param order in
        // registration::apply_voted_role. The 4 role registries were added so the
        // entry can clean up the miner's stale OLD-role registry entry on a transition.
        // ctx is auto-injected by the runtime and is NOT passed here.
        arguments: [
          tx.object(config.networkRegistryId),    // registry
          tx.object(config.minerStoreId),         // store
          tx.object(config.roleVoteBoxId),        // vote_box
          tx.object(config.signalingRegistryId),  // signaling_reg
          tx.object(config.relayRegistryId),      // relay_reg
          tx.object(config.validatorRegistryId),  // validator_reg
          tx.object(config.cpRegistryId),         // cp_reg
          tx.object(minerCapId),                  // cap
          tx.object(stakePositionId),             // stake
        ],
      });
    },
    'apply-voted-role',
    logger,
  );

  if (!result) {
    throw new Error('apply_voted_role TX failed after retries');
  }

  roleAssignmentCounter?.inc({ service: roleAssignmentMetricsService });
  logger.info({ minerCapId }, 'Voted role applied successfully');
}
