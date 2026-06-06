/**
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
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import { ensureWarmPipe, type RoomTopology } from './relay-role-manager.js';

// ── Announce contract ──────────────────────────────────────────────────

/**
 * The inter-relay producer-announce frame.
 * Sent primary → standby when the primary pipes a producer for a room.
 */
export interface PipeProducerAnnounce {
  type: 'pipe-producer';
  roomId: string;
  /** The PRIMARY's real mediasoup producer ID (post pipeToRouter). */
  producerId: string;
  kind: msTypes.MediaKind;
}

/** Type guard for an inbound JSON frame on the relay WS server. */
export function isPipeProducerAnnounce(msg: unknown): msg is PipeProducerAnnounce {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m['type'] === 'pipe-producer' &&
    typeof m['roomId'] === 'string' &&
    typeof m['producerId'] === 'string' &&
    (m['kind'] === 'audio' || m['kind'] === 'video')
  );
}

/**
 * Build the announce frame the PRIMARY sends to the standby.
 * Called by the primary's wiring layer when a producer is created/piped.
 */
export function buildPipeProducerAnnounce(
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
): PipeProducerAnnounce {
  return {
    type: 'pipe-producer',
    roomId,
    producerId: producer.id,
    kind: producer.kind,
  };
}

// ── Primary-side announcer (index.ts glue) ──────────────────────────────

/**
 * Minimal sink for the outbound inter-relay link. The wiring layer (index.ts)
 * backs this with the WS connection to the standby (a `ws` WebSocket's `.send`).
 * Kept as an interface so the announcer is unit-testable with a mock sender.
 */
export interface InterRelaySender {
  send(data: string): void;
}

/**
 * Builds the `announceProducer` callback for an InterRelayContext on the PRIMARY.
 * Serializes the locked frame and pushes it via the sender. Best-effort:
 * sender errors (link down) are swallowed so the primary's produce path never
 * crashes because the standby link is momentarily unavailable.
 */
export function createInterRelayAnnouncer(
  sender: InterRelaySender,
): (roomId: string, producer: Pick<msTypes.Producer, 'id' | 'kind'>) => void {
  return (roomId, producer) => {
    const frame = buildPipeProducerAnnounce(roomId, producer);
    try {
      sender.send(JSON.stringify(frame));
    } catch {
      // Best-effort — link down must not break the primary's produce path.
      // The standby re-syncs on its next reconnect (link reconnect is the
      // wiring layer's concern). Swallowed silently here (no logger coupling);
      // the wiring layer logs link health.
    }
  };
}

/**
 * Minimal duck-type of a `ws` WebSocket the live inter-relay sink needs.
 * Kept narrow (readyState + send) so the sender is unit-testable with a plain
 * object and stays decoupled from the `ws` import in index.ts.
 */
export interface InterRelaySocketLike {
  readyState: number;
  send(data: string): void;
}

/** `ws` WebSocket.OPEN — the only readyState on which a send is attempted. */
const WS_OPEN = 1;

/**
 * BENCH-2 / G1: builds the LIVE inter-relay sender used on the PRIMARY.
 *
 * The prior index.ts sink was a no-op log stub — `announceProducer` serialized
 * a frame that never left the process, so the standby never received a real
 * producerId. This sink ACTUALLY TRANSMITS: it pulls the current accepted
 * standby socket from `getSocket()` (the wiring layer sets it when the standby
 * opens its inter-relay link) and `.send()`s the frame when the socket is OPEN.
 *
 * Best-effort by contract (mirrors createInterRelayAnnouncer's swallow):
 *   - no socket attached yet (standby not connected) → drop, no throw;
 *   - socket not OPEN (connecting / closed)          → drop, no throw;
 *   - socket.send throws (link died mid-flight)       → propagated to the
 *     announcer's try/catch, which swallows it (produce path never crashes).
 *
 * @param getSocket - returns the live standby socket, or null when none.
 * @param logger    - optional structured logger; logs drop reasons at debug.
 */
export function createWsInterRelaySender(
  getSocket: () => InterRelaySocketLike | null | undefined,
  logger?: Logger,
): InterRelaySender {
  return {
    send(data: string): void {
      const socket = getSocket();
      if (!socket) {
        logger?.debug('G1: inter-relay announce dropped — no standby link attached yet');
        return;
      }
      if (socket.readyState !== WS_OPEN) {
        logger?.debug(
          { readyState: socket.readyState },
          'G1: inter-relay announce dropped — standby link not OPEN',
        );
        return;
      }
      // Let send() throw propagate to createInterRelayAnnouncer's try/catch.
      socket.send(data);
    },
  };
}

// ── Standby-side producer registry ─────────────────────────────────────

/**
 * Per-room record of the announced primary producers.
 * The standby consults this to resolve the real producerId when it opens its
 * warm pipe (replacing the `pipe-producer-${roomId}` placeholder) and when a
 * client asks the standby to consume.
 */
export interface AnnouncedProducer {
  producerId: string;
  kind: msTypes.MediaKind;
}

/**
 * Registry of producers announced by the primary, keyed by roomId.
 * Held by the STANDBY daemon. One room may have multiple producers (audio +
 * video, or multiple peers) — we keep them all, keyed by producerId to dedup.
 */
export class InterRelayProducerRegistry {
  /** roomId → (producerId → AnnouncedProducer). */
  private readonly byRoom = new Map<string, Map<string, AnnouncedProducer>>();

  /**
   * Records an announced producer. Idempotent — re-announcing the same
   * producerId for a room is a no-op (dedup guards against duplicate-pipe).
   */
  record(announce: PipeProducerAnnounce): void {
    let room = this.byRoom.get(announce.roomId);
    if (!room) {
      room = new Map();
      this.byRoom.set(announce.roomId, room);
    }
    room.set(announce.producerId, {
      producerId: announce.producerId,
      kind: announce.kind,
    });
  }

  /**
   * Resolves the first announced producer for a room.
   * Returns null if no producer has been announced yet (standby should keep
   * the consumer paused / reply "not ready" to a client consume request).
   *
   * For the warm-pipe Consumer, the standby pipes the room's producer(s); the
   * "first" producer is sufficient to establish the pipe Consumer lifecycle
   * (REQ-RO-005). Multi-producer fan-out is M2 scope.
   */
  resolve(roomId: string): AnnouncedProducer | null {
    const room = this.byRoom.get(roomId);
    if (!room || room.size === 0) return null;
    const first = room.values().next();
    return first.done ? null : first.value;
  }

  /** All announced producers for a room (for multi-producer consume). */
  resolveAll(roomId: string): AnnouncedProducer[] {
    const room = this.byRoom.get(roomId);
    if (!room) return [];
    return Array.from(room.values());
  }

  /** Drops a room's records (on room close / worker.died rebuild). */
  clear(roomId: string): void {
    this.byRoom.delete(roomId);
  }

  /** Test/diagnostic — total rooms tracked. */
  get roomCount(): number {
    return this.byRoom.size;
  }
}

// ── Standby warm-pipe coordinator (BENCH-2 / G1) ────────────────────────

/**
 * Per-room bookkeeping the coordinator needs to drive the not-ready re-run.
 * `producerId` is the id the LAST ensureWarmPipe consumed for the room — either
 * the resolved real id or the `pipe-producer-pending-<roomId>` placeholder.
 */
interface WarmPipeState {
  topology: RoomTopology;
  router: msTypes.Router;
  pipePort: number;
  /** The producerId consumed by the most recent ensureWarmPipe for this room. */
  consumedProducerId: string;
  /** True while we are still on the placeholder (announce not yet resolved). */
  pending: boolean;
}

/** Mirrors the placeholder ensureWarmPipe falls back to (relay-role-manager). */
function placeholderProducerId(roomId: string): string {
  return `pipe-producer-pending-${roomId}`;
}

/**
 * BENCH-2 / G1 — orchestrates the STANDBY warm pipe so it consumes the PRIMARY's
 * REAL producer (replacing the `pipe-producer-pending-<roomId>` placeholder).
 *
 * This is the wiring the bench needs that did NOT exist before: on the first
 * peer join the standby resolves the primary's producerId from the announce
 * registry and passes it to ensureWarmPipe; if the announce hasn't arrived yet
 * the placeholder is used AND the room is remembered so a later announce
 * triggers a re-run (the not-ready re-run contract documented at
 * relay-role-manager.ts L143-146):
 *
 *   1. ensure(topology, router, pipePort)
 *        → resolve(roomId); call ensureWarmPipe with the real id when present,
 *          else the placeholder (ensureWarmPipe's own fallback). Remember the
 *          room either way.
 *   2. onAnnounce(roomId, topology, router, pipePort)
 *        → if the room is still on the placeholder AND the registry now resolves
 *          a real id, reset topology.pipeConsumer = null and re-run
 *          ensureWarmPipe with the real id (a fresh paused Consumer, REQ-RO-005).
 *
 * ensureWarmPipe's signature + paused-consumer semantics are UNCHANGED — this
 * class only resolves + passes the producerId and drives the re-run. It does
 * not bypass or duplicate ensureWarmPipe.
 */
export class StandbyWarmPipeCoordinator {
  private readonly states = new Map<string, WarmPipeState>();

  constructor(
    private readonly registry: InterRelayProducerRegistry,
    private readonly logger?: Logger,
  ) {}

  /**
   * First-peer-join entry. Resolves the real producerId from the announce
   * registry (null → placeholder fallback) and calls ensureWarmPipe. Idempotent
   * at the ensureWarmPipe level (its pipeConsumer guard); we additionally track
   * the room so a later announce can re-run when we are still on the placeholder.
   */
  async ensure(
    topology: RoomTopology,
    router: msTypes.Router,
    pipePort: number,
  ): Promise<msTypes.Consumer | null> {
    const announced = this.registry.resolve(topology.roomId);
    const realId = announced?.producerId;
    const pending = realId === undefined;
    const consumedProducerId = realId ?? placeholderProducerId(topology.roomId);

    // Only record state for the standby (ensureWarmPipe returns null for primary).
    if (topology.role === 'standby') {
      this.states.set(topology.roomId, {
        topology,
        router,
        pipePort,
        consumedProducerId,
        pending,
      });
    }

    if (realId !== undefined) {
      this.logger?.info(
        { roomId: topology.roomId, producerId: realId },
        'G1: standby warm pipe resolving REAL announced producerId',
      );
    } else {
      this.logger?.debug(
        { roomId: topology.roomId, placeholder: consumedProducerId },
        'G1: standby warm pipe — no producer announced yet, using placeholder (re-run on announce)',
      );
    }

    return ensureWarmPipe(topology, router, pipePort, realId);
  }

  /**
   * Announce-arrival hook. Returns true iff a re-run actually re-consumed the
   * room's pipe with the now-real producerId; false otherwise (no tracked
   * topology / not pending / still unresolved / already real).
   *
   * Optional explicit args let the caller pass the room's live topology/router
   * (the standby's signaling layer holds them); when omitted we fall back to the
   * snapshot captured in ensure().
   */
  async onAnnounce(
    roomId: string,
    topology?: RoomTopology,
    router?: msTypes.Router,
    pipePort?: number,
  ): Promise<boolean> {
    const state = this.states.get(roomId);
    if (!state) {
      // Never ensured for this room — nothing to re-run.
      return false;
    }
    if (!state.pending) {
      // Already consuming the real producer — no double-pipe.
      return false;
    }

    const announced = this.registry.resolve(roomId);
    if (!announced) {
      // Announce fired but still nothing resolvable — stay on the placeholder.
      return false;
    }

    const useTopology = topology ?? state.topology;
    const useRouter = router ?? state.router;
    const usePipePort = pipePort ?? state.pipePort;

    // Not-ready re-run contract: drop the placeholder consumer and re-open the
    // pipe with the real producerId. Resetting pipeConsumer=null bypasses
    // ensureWarmPipe's idempotency guard so it consumes the real id afresh.
    const stale = useTopology.pipeConsumer;
    if (stale) {
      try {
        stale.close();
      } catch {
        // Best-effort close of the placeholder consumer — must not block cutover.
      }
    }
    useTopology.pipeConsumer = null;

    this.logger?.info(
      { roomId, producerId: announced.producerId, kind: announced.kind },
      'G1: announce arrived — re-running warm pipe with REAL producerId (placeholder cutover)',
    );

    const consumer = await ensureWarmPipe(
      useTopology,
      useRouter,
      usePipePort,
      announced.producerId,
    );

    this.states.set(roomId, {
      topology: useTopology,
      router: useRouter,
      pipePort: usePipePort,
      consumedProducerId: announced.producerId,
      pending: false,
    });

    return consumer !== null;
  }

  /** Drops a room's coordinator state (room close / worker rebuild). */
  clear(roomId: string): void {
    this.states.delete(roomId);
  }
}

// ── Primary-side pipe half (Phase 5.3 spike — the missing production half) ──

/**
 * Connect parameters one PipeTransport endpoint must hand to its peer so the
 * pair can carry RTP. In production these are EXCHANGED over the inter-relay
 * WS link (the standby announces its `{ip, port}` to the primary, or vice
 * versa). `srtpParameters` is only present when `enableSrtp:true` — we use
 * unencrypted loopback/private-network pipes so it is undefined here.
 */
export interface PipeConnectParams {
  ip: string;
  port: number;
  srtpParameters?: msTypes.SrtpParameters;
}

/**
 * The PRIMARY half of the warm pipe — the piece that did NOT exist before
 * (only the STANDBY half lived in relay-role-manager.ensureWarmPipe).
 *
 * `ensureWarmPipe` builds a PipeTransport on the STANDBY and `consume()`s a
 * producerId that lives on the PRIMARY. For RTP to actually cross between two
 * SEPARATE daemon processes the primary must ALSO:
 *
 *   1. createPipeTransport on its own router (this helper),
 *   2. exchange + `connect({ip, port, srtpParameters})` BOTH ends (the standby's
 *      params arrive over the inter-relay WS link; the caller drives connect),
 *   3. `pipeTransport.consume({producerId})` the room's real producer onto the
 *      pipe (pipeProducerOntoPrimaryTransport) — THIS mints the piped producer
 *      the standby then sees and is what puts RTP on the wire.
 *
 * mediasoup's high-level `router.pipeToRouter({producerId, router})` does all
 * of this automatically, but ONLY for two routers in the SAME process. In
 * production primary + standby are distinct processes, so this manual pairing
 * is required.
 *
 * Additive — does NOT change ensureWarmPipe's signature or behaviour. Pure
 * mediasoup wiring (no logger coupling): the caller owns link-health logging.
 */
export async function createPrimaryPipeTransport(
  router: msTypes.Router,
  pipePort: number,
): Promise<msTypes.PipeTransport> {
  // announcedIp = deploy-routable address the standby connects back to,
  // externalized via ANNOUNCED_IP (default loopback for local/bench). Mirrors
  // the room-handler.ts WebRTC-transport pattern.
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
  return router.createPipeTransport({
    listenIp: { ip: '0.0.0.0', announcedIp },
    port: pipePort,
    enableRtx: false,
    enableSrtp: false,
  } as Parameters<msTypes.Router['createPipeTransport']>[0]);
}

/**
 * Consume the room's real producer onto the primary's already-connected pipe
 * transport. The returned Consumer's `.id` is the producerId the piped
 * producer carries on the standby router — exactly the id the primary must
 * announce (buildPipeProducerAnnounce) so the standby's ensureWarmPipe
 * consumes the REAL producer rather than the `pipe-producer-pending-*`
 * placeholder.
 */
export async function pipeProducerOntoPrimaryTransport(
  pipeTransport: msTypes.PipeTransport,
  producerId: string,
): Promise<msTypes.Consumer> {
  return pipeTransport.consume({ producerId } as Parameters<
    msTypes.PipeTransport['consume']
  >[0]);
}
