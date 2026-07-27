/**
 * Warm-pipe module — barrel export.
 *
 * Inter-relay producer-announce coordination (G1 wiring).
 *
 * In the warm-pipe model, the PRIMARY and STANDBY relays are SEPARATE daemon
 * processes. The standby's pipe Consumer (see relay-role-manager.ensureWarmPipe)
 * needs the PRIMARY's real pipe-producer ID — which only exists AFTER the primary
 * runs pipeToRouter() for a room's producer. This is cross-process coordination.
 *
 * Contract (the "pipe-producer" announce):
 *   When the primary pipes a producer for a room, it announces
 *     { type: 'pipe-producer', roomId, producerId, kind }
 *   to its paired standby over a dedicated inter-relay WebSocket link.
 *
 * Transport choice (lowest-friction, consistent with as-built):
 *   - The standby OPENS a WS connection to the primary (it already knows the
 *     primary's WS endpoint from RoomTopology.primaryEndpoint; it also already
 *     pings the primary's /healthz in relay-heartbeat.ts). The primary pushes
 *     announce frames down this link.
 *   - We reuse the SAME `ws` library + JSON-frame convention as signaling.ts —
 *     no new dependency, no new port (the primary's existing WS server accepts
 *     an inter-relay subprotocol/message-type alongside client signaling).
 *   - A `pipe-producer` announce is just another JSON message type on the relay
 *     WS server, distinguished from client `join`/`produce`/`consume` by `type`.
 *
 * This module is transport-agnostic at the unit boundary: it exposes a registry
 * + a frame handler. The actual WS plumbing is injected by the wiring layer
 * (signaling.ts / index.ts), so this stays mock-testable.
 *
 * LIVE two-relay verification is DEFERRED to the bench (Phase 5.3). Unit-level
 * coverage of the announce handler + producerId resolution is the bar here.
 *
 * Requirements: REQ-RO-004 (G1 integration wiring)
 *
 * This barrel was split out of a single `inter-relay.ts` into per-concern
 * files (pipe-protocol / sender / producer-registry / standby-coordinator /
 * reparent-harness / primary-coordinator) for readability; no runtime
 * behaviour changed.
 */

export {
  INTER_RELAY_SUBPROTOCOL,
  DEFAULT_PEER_RELAY_ID,
  isValidInterRelayToken,
  isPipeProducerAnnounce,
  buildPipeProducerAnnounce,
  isPipeConnectFrame,
  buildPipeConnectFrame,
} from './pipe-protocol.js';
export type {
  PipeProducerAnnounce,
  PipeConnectFrame,
  PipeConnectParams,
} from './pipe-protocol.js';

export {
  createInterRelayAnnouncer,
  createWsInterRelaySender,
} from './sender.js';
export type {
  InterRelaySender,
  InterRelaySocketLike,
} from './sender.js';

export {
  InterRelayProducerRegistry,
  handleInboundInterRelayFrame,
} from './producer-registry.js';
export type {
  AnnouncedProducer,
  InboundInterRelayContext,
} from './producer-registry.js';

export { StandbyWarmPipeCoordinator } from './standby-coordinator.js';
export type { ReverseUpAnnouncer } from './standby-coordinator.js';

export { makeReparentHarness } from './reparent-harness.js';
export type { ReparentEffects, ReparentHarness } from './reparent-harness.js';

export {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
  PrimaryPipeCoordinator,
} from './primary-coordinator.js';
export type {
  PipePortAllocatorLike,
  PrimaryPipeCoordinatorDeps,
} from './primary-coordinator.js';
