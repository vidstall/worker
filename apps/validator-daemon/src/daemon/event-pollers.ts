/**
 * Validator Daemon -- event-poller wiring.
 *
 * Extracted from the former `index.ts` monolith's `startDaemon`: registers the
 * validator_registry / EscrowCreated / RoomCreated+RoomClosed+RoomAssigned
 * EventPollers, then brings up the liveness-sweep loop. Called by
 * `bootstrap.ts`'s `startDaemon`.
 */

import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { EventPoller, economicLayerModuleName, readCapMinerId } from '@dvconf/shared';
import type { Logger } from '@dvconf/shared';
import type { EscrowCreated, RoomCreated, RoomClosed, RoomAssigned } from '@dvconf/shared';
import { startLivenessSweep } from '../liveness-sweep.js';
import { handleRoomClosed } from './measurement-cycle.js';
import type { DaemonState } from './state.js';

/**
 * Start the validator_registry / EscrowCreated / RoomCreated+RoomClosed+RoomAssigned
 * event pollers, plus the liveness-sweep loop. Populates `state.eventPoller`,
 * `state.escrowPoller`, `state.roomPoller`, and `state.livenessSweep`.
 *
 * Extracted verbatim from `startDaemon` (former index.ts ~787-945); parameters
 * are exactly what that block closed over.
 */
export async function startEventPollers(
  state: DaemonState,
  graphqlClient: SuiGraphQLClient,
  validatorMinerId: string,
  pollIntervalMs: number,
  log: Logger,
): Promise<void> {
  const { client, config, mainKeypair, validatorCapId, escrowMap, activeRooms } = state;

  // Start event poller for validator_registry events
  const eventPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
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
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
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
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
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
        // Phase 18: Don't auto-add. Wait for RoomAssigned with our validator ID.
        log.info(
          { roomId: parsed.room_id, creator: (parsed as any).creator },
          `RoomCreated -- room=${parsed.room_id} (waiting for assignment)`,
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

    // BUG-INT-001: Handle RoomAssigned to populate relay slots dynamically.
    // RO-019a: read BOTH relay slots (primary + standby) from relay_ids; the
    // standby id is already in-event (relay_ids[1]) -- guard the length so a
    // single-relay assignment leaves standbyRelayId undefined.
    if (event.type.endsWith('::RoomAssigned')) {
      const parsed = event.parsedJson as unknown as RoomAssigned;
      const relayIds: string[] = parsed.relay_ids ?? [];
      const primaryRelayId = relayIds[0];
      const standbyRelayId = relayIds.length > 1 ? relayIds[1] : undefined;
      const validatorIds: string[] = parsed.validator_ids ?? [];

      // Phase 18: Only track rooms where we are an assigned validator
      if (parsed.room_id && primaryRelayId && validatorIds.includes(validatorMinerId)) {
        const room = activeRooms.get(parsed.room_id) ?? {};
        room.primaryRelayId = primaryRelayId;
        room.standbyRelayId = standbyRelayId;
        // REQ-CFA-023 (M3 chunk 1, D-CFA-24): persist the in-event co-auditor set (already
        // parsed above for the self-membership test, previously discarded) so the canary
        // validator pool can per-relay room-scope (buildRelayScopedValidatorPool, M4a chunk 1
        // D-CFA-30). ZERO new chain cost.
        // A re-assignment REPLACES the set (latest assignment is authoritative);
        // promote_relay/swap_relay never reach this arm, so the set is stable under a relay
        // swap (W-M3-STALE — mirrors validator-pool.ts::applyRoomAssigned, the unit-tested seam).
        room.validatorIds = [...validatorIds];

        if (!activeRooms.has(parsed.room_id)) {
          activeRooms.set(parsed.room_id, room);
        }

        log.info(
          { roomId: parsed.room_id, primaryRelayId, standbyRelayId },
          `RoomAssigned -- assigned to room=${parsed.room_id}, primary=${primaryRelayId}, standby=${standbyRelayId ?? 'none'}`,
        );
      } else if (parsed.room_id) {
        log.debug(
          { roomId: parsed.room_id, validatorIds, ownId: validatorMinerId },
          `RoomAssigned -- not assigned to room=${parsed.room_id}, ignoring`,
        );
      }
    }
  });

  // "i expect that job belong to validator" -- validator-driven liveness enforcement:
  // discovers stale relay/signaling/cp-daemon/validator nodes, casts cast_liveness_vote
  // toward a validator-quorum, and cranks execute_ejection once NodeEjectionApproved
  // fires. Independent cadence from the canary cell loop; CRASH-SAFE (see liveness-sweep.ts).
  try {
    const livenessOwnMinerId = (await readCapMinerId(client, validatorCapId, log)) ?? validatorMinerId;
    state.livenessSweep = startLivenessSweep({
      client,
      graphqlClient,
      config,
      signer: mainKeypair,
      minerCapId: validatorCapId,
      ownMinerId: livenessOwnMinerId,
      logger: log.child({ component: 'liveness-sweep' }),
    });
  } catch (err) {
    log.error({ err }, 'liveness sweep failed to start (daemon continues)');
  }
}
