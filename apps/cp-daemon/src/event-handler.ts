/**
 * Event handler for CP daemon — processes relay/room/CP/voting events from Sui chain.
 *
 * Maintains in-memory relay and validator state maps populated from events. On
 * RoomCreated + EscrowCreated, runs scoring and submits pairing proposal via
 * submit_pairing_proposal (PAIR-01, relay-only -- the standalone signaling
 * node type was removed from the contract).
 *
 * Tracks votedRooms to prevent duplicate proposals (PAIR-03).
 * Handles RoomAssigned events to clear voted rooms (PAIR-03).
 * MCU-aware scoring: 2x load weight for MCU rooms (MCU-05, MCU-06).
 *
 * `handleEvent` is a THIN DISPATCHER (god-file split): the individual case-arm
 * bodies live in `./event-handlers/*.ts`, each taking the shared `EventHandlerCtx`
 * bundle (assembled once per dispatch below) as their first argument. `RoleTransitioned`,
 * `RelayPromoted`, and the `default` arm stay here (small + no sibling-file coupling).
 */

import { randomUUID } from 'node:crypto';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiEvent } from '@mysten/sui/client';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type {
  RoomCreated,
  EscrowCreated,
  RoleTransitioned,
} from '@dvconf/shared';
import {
  PVR_WEIGHTS,
  type NodeCandidate,
  type ScoringWeights,
} from './scoring.js';
import { type AttestedLoad } from './coverage-load-reader.js';
import { votedRooms } from './room-assignment.js';
import { clearRevoteCandidate } from './role-voter.js';
import type { TurnIssuer } from './turn-issuer.js';
import type { CapTokenIssuer } from './cap-token/index.js';
import {
  handleRelayRegistered,
  handleRelayLoadUpdated,
  handleRelayRTTUpdated,
  handleRelayHeartbeat,
  handleRelaySlashed,
  handleSecretRotated,
} from './event-handlers/relay-lifecycle.js';
import { handleEscrowCreated } from './event-handlers/room-assignment.js';
import {
  handleValidatorRegistered,
  handleRoomCreated,
  handleRoomAssigned,
  handleCapabilityIssued,
  handleRoleAssigned,
  handleRoleChanged,
  handleMinerRegistered,
  handleRevoteEligibleMarked,
} from './event-handlers/validator-signaling-role.js';

// ── RelayPromoted observer types (CONTRACTS C8, REQ-RO-009) ─────────────────

/** Shape of the RelayPromoted on-chain event (room_manager.move, Phase 1 RO-003). */
export interface RelayPromotedEvent {
  type: 'RelayPromoted';
  room_id: string;
  old_primary: string;
  new_primary: string;
  epoch: number;
}

/** Observer interface for RelayPromoted chain events. */
export interface RelayPromotedObserver {
  onRelayPromoted(event: RelayPromotedEvent, traceId: string): Promise<void>;
}

/** Default scoring weights — re-exported from scoring.ts for convenience. */
export const DEFAULT_WEIGHTS: ScoringWeights = PVR_WEIGHTS;

/** The optional TX/service context threaded through every event-handler case arm. */
export interface EventHandlerTxContext {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  turnIssuer?: TurnIssuer;
  capTokenIssuer?: CapTokenIssuer;
  relayPromotedObserver?: RelayPromotedObserver;
}

/**
 * The explicit shared-state bundle every extracted `event-handlers/*.ts` case-arm
 * function takes as its first parameter (god-file split). `handleEvent` assembles
 * ONE `EventHandlerCtx` per dispatch (below) from its own parameters/closure — this
 * mirrors the `SignalingServerState`-style explicit-state pattern used elsewhere in
 * this codebase (e.g. `apps/relay/src/room-handler.ts`), since `handleEvent` itself
 * threads its state as individual positional params rather than one pre-existing
 * context object.
 *
 * `redispatch` lets the `RelayRegistered`/`RoomCreated` case arms replay a
 * synthesized `EscrowCreated` event through the FULL `handleEvent` dispatcher
 * (recursion via a callback, so the case-arm files never import `handleEvent`
 * directly — no circular import between `event-handler.ts` and `event-handlers/*.ts`).
 */
export interface EventHandlerCtx {
  relayState: Map<string, NodeCandidate>;
  pendingRooms: Map<string, RoomCreated>;
  logger: Logger;
  weights: ScoringWeights;
  txContext?: EventHandlerTxContext;
  pendingEscrows?: Map<string, EscrowCreated>;
  validatorState?: Map<string, NodeCandidate>;
  attestedLoad?: Map<string, AttestedLoad>;
  currentEpoch?: bigint;
  /** REQ-RMS-015 — optional canary-flag predicate; relays it flags are excluded from placement (additive/back-compat, undefined => M1 path). */
  byzantineFlag?: (minerId: string) => boolean;
  /** Re-dispatch a (possibly synthesized) event through the full `handleEvent` dispatcher. */
  redispatch: (event: SuiEvent) => void;
}

/**
 * Maps event type suffix to a known handler.
 * Event types are formatted as `{packageId}::{module}::{EventName}`.
 */
export function extractEventName(eventType: string): string {
  const parts = eventType.split('::');
  return parts[parts.length - 1] ?? eventType;
}

/**
 * Decode a Move `vector<u8>` field regardless of transport shape: JSON-RPC's
 * `parsedJson` renders it as a number array, GraphQL's `contents.json` renders
 * the same field as a base64 string instead (see relay-endpoint-cache.ts's
 * decodeVectorU8 — same bug class, different call site).
 */
export function decodeVectorU8ToNumbers(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      return Array.from(Buffer.from(value, 'base64'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * W-P2 (D-W9) — fire-and-forget a cap-token issuer dispatch. `handleEvent` is a
 * synchronous void function (the poller awaits the handler, but each arm runs
 * sync); the issuer's `onX` handlers are async + already wrap their own bodies in
 * try/catch, so we do not await here. The `.catch` is a defensive backstop that
 * keeps any unexpected rejection from becoming an unhandled promise rejection.
 */
export function dispatchCapToken(
  p: Promise<void>,
  logger: Logger,
  ctx: Record<string, unknown>,
): void {
  p.catch((err) => logger.error({ err, ...ctx }, 'cap-token issuer dispatch failed'));
}

/**
 * Handle a single Sui event, updating relay/validator state and scoring as needed.
 *
 * Room assignment is deferred until EscrowCreated is received. Flow:
 *   RoomCreated -> store in pendingRooms
 *   EscrowCreated -> match room_id -> score relays + validators -> submit proposal
 */
export function handleEvent(
  event: SuiEvent,
  relayState: Map<string, NodeCandidate>,
  pendingRooms: Map<string, RoomCreated>,
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  txContext?: EventHandlerTxContext,
  pendingEscrows?: Map<string, EscrowCreated>,
  validatorState?: Map<string, NodeCandidate>,
  attestedLoad?: Map<string, AttestedLoad>,
  currentEpoch?: bigint,
  /** REQ-RMS-015 — optional canary-flag predicate; relays it flags are excluded from placement (additive/back-compat, undefined => M1 path). */
  byzantineFlag?: (minerId: string) => boolean,
): void {
  const eventName = extractEventName(event.type);
  const data = event.parsedJson as Record<string, unknown>;

  const ctx: EventHandlerCtx = {
    relayState,
    pendingRooms,
    logger,
    weights,
    txContext,
    pendingEscrows,
    validatorState,
    attestedLoad,
    currentEpoch,
    byzantineFlag,
    redispatch: (ev: SuiEvent) =>
      handleEvent(
        ev, relayState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState,
        attestedLoad, currentEpoch, byzantineFlag,
      ),
  };

  switch (eventName) {
    case 'RelayRegistered':
      handleRelayRegistered(event, data, ctx);
      break;

    case 'RelayLoadUpdated':
      handleRelayLoadUpdated(event, data, ctx);
      break;

    case 'RelayRTTUpdated':
      handleRelayRTTUpdated(event, data, ctx);
      break;

    case 'RelayHeartbeat':
      handleRelayHeartbeat(event, data, ctx);
      break;

    case 'RelaySlashed':
      handleRelaySlashed(event, data, ctx);
      break;

    case 'SecretRotated':
      handleSecretRotated(event, data, ctx);
      break;

    case 'ValidatorRegistered':
      handleValidatorRegistered(event, data, ctx);
      break;

    case 'RoomCreated':
      handleRoomCreated(event, data, ctx);
      break;

    case 'EscrowCreated':
      handleEscrowCreated(event, data, ctx);
      break;

    case 'RoomAssigned':
      handleRoomAssigned(event, data, ctx);
      break;

    case 'CapabilityIssued':
      handleCapabilityIssued(event, data, ctx);
      break;

    case 'RoleAssigned':
      handleRoleAssigned(event, data, ctx);
      break;

    case 'RoleChanged':
      handleRoleChanged(event, data, ctx);
      break;

    case 'MinerRegistered':
      handleMinerRegistered(event, data, ctx);
      break;

    case 'RevoteEligibleMarked':
      handleRevoteEligibleMarked(event, data, ctx);
      break;

    case 'RoleTransitioned': {
      // F47 RV-010: a re-vote completed (role changed) → clear the candidate.
      const e = data as unknown as RoleTransitioned;
      clearRevoteCandidate(e.miner_id);
      logger.info(
        { minerId: e.miner_id, oldRole: e.old_role, newRole: e.new_role },
        'Role transitioned — cleared from re-vote queue',
      );
      break;
    }

    case 'RelayPromoted': {
      // M1 Phase 3.1 (REQ-RO-009) — chain-authoritative promotion event (C8).
      // Emitted by room_manager::promote_relay after on-chain staleness assert.
      // Drives client re-discovery via the injected RelayPromotedObserver.
      const e = data as unknown as { room_id: string; old_primary: string; new_primary: string; epoch: number };
      const traceId = randomUUID();
      const evt: RelayPromotedEvent = {
        type: 'RelayPromoted',
        room_id: e.room_id,
        old_primary: e.old_primary,
        new_primary: e.new_primary,
        epoch: e.epoch,
      };
      logger.info(
        {
          trace_id: traceId,
          module: 'event-handler',
          action: 'relay-promoted',
          context: { roomId: e.room_id, oldPrimary: e.old_primary, newPrimary: e.new_primary, epoch: e.epoch },
        },
        'RelayPromoted — relay promotion observed; forwarding to observer',
      );
      if (txContext?.relayPromotedObserver !== undefined) {
        // Fire-and-forget — same pattern as dispatchCapToken (D-W9)
        txContext.relayPromotedObserver
          .onRelayPromoted(evt, traceId)
          .catch((err) =>
            logger.error(
              { trace_id: traceId, module: 'event-handler', err },
              'RelayPromoted observer dispatch failed',
            ),
          );
      } else {
        logger.debug(
          { trace_id: traceId, module: 'event-handler', context: { roomId: e.room_id } },
          'RelayPromoted received but no observer registered',
        );
      }
      break;
    }

    default: {
      logger.debug({ eventType: event.type, eventName }, 'Unknown event type, skipping');
      break;
    }
  }
}

/**
 * Create an event handler function bound to its own relay and validator state maps.
 *
 * Returns the handler and state maps for testing/inspection.
 */
export function createEventHandler(
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  txContext?: EventHandlerTxContext,
  // REQ-RMS-005/019 — capacity-aware admission context (additive, optional). The daemon wiring
  // populates `attestedLoad` from fetchAttestedLoad on the canary cadence and `currentEpoch`
  // from the chain; both are injected + defaulted so existing callers/tests are unaffected.
  capacityCtx?: {
    attestedLoad?: Map<string, AttestedLoad>;
    currentEpoch?: () => bigint | undefined;
    /**
     * REQ-RMS-015 — fresh canary-flag predicate per dispatch (mirrors currentEpoch's
     * thunk shape so the latest verify-loop accumulator is read each event). The daemon
     * wiring binds it to isRelayFlaggedByCanary(acc, id, budget, MIN_ROUNDS_FOR_CUMULATIVE).
     * Undefined => no exclusion (M1 path). The live accumulator producer is demo/M4b scope.
     */
    byzantineFlag?: () => ((minerId: string) => boolean) | undefined;
  },
): {
  handler: (event: SuiEvent) => Promise<void>;
  relayState: Map<string, NodeCandidate>;
  validatorState: Map<string, NodeCandidate>;
  pendingRooms: Map<string, RoomCreated>;
  pendingEscrows: Map<string, EscrowCreated>;
  retryPendingAssignments: () => void;
} {
  const relayState = new Map<string, NodeCandidate>();
  const validatorState = new Map<string, NodeCandidate>();
  const pendingRooms = new Map<string, RoomCreated>();
  const pendingEscrows = new Map<string, EscrowCreated>();

  const handler = async (event: SuiEvent): Promise<void> => {
    handleEvent(
      event, relayState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState,
      capacityCtx?.attestedLoad, capacityCtx?.currentEpoch?.(), capacityCtx?.byzantineFlag?.(),
    );
  };

  /**
   * Periodic sweep for rooms whose EscrowCreated processing was attempted
   * but never reached a successful submitProposal (E_INVALID_BALLOT-style
   * transient chain-state races, or a CP that was down/crash-looping when
   * the original events fired and only later replayed them from genesis --
   * see cli/infra.py / the `.cursors` EventPoller persistence gap). Any room
   * still sitting in BOTH pendingRooms and pendingEscrows hasn't succeeded
   * yet; re-dispatch a synthetic EscrowCreated for it, same mechanism the
   * RoomCreated handler already uses for its own early-escrow race.
   */
  const retryPendingAssignments = (): void => {
    for (const [roomId, escrowEvent] of pendingEscrows) {
      const roomEvent = pendingRooms.get(roomId);
      if (!roomEvent) continue; // still genuinely waiting on RoomCreated
      if (votedRooms.has(roomId)) {
        pendingRooms.delete(roomId);
        pendingEscrows.delete(roomId);
        continue;
      }
      logger.info({ roomId }, 'Retrying pairing proposal for a room that failed a prior attempt');
      handleEvent(
        {
          type: `${txContext?.config.packageId}::economic_layer::EscrowCreated`,
          parsedJson: escrowEvent as unknown as Record<string, unknown>,
        } as unknown as SuiEvent,
        relayState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState,
        capacityCtx?.attestedLoad, capacityCtx?.currentEpoch?.(), capacityCtx?.byzantineFlag?.(),
      );
    }
  };

  return { handler, relayState, validatorState, pendingRooms, pendingEscrows, retryPendingAssignments };
}
