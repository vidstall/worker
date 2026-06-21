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

import { timingSafeEqual } from 'node:crypto';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import { ensureWarmPipe, type RoomTopology } from './relay-role-manager.js';

// ── Cross-daemon inter-relay link auth (G3.2b) ──────────────────────────

/**
 * WebSocket subprotocol the standby advertises on the inter-relay upgrade
 * (`Sec-WebSocket-Protocol`). A label the primary selects via `handleProtocols`
 * so both ends carry `ws.protocol === INTER_RELAY_SUBPROTOCOL` — a secondary
 * signal alongside the Bearer token (the token is the actual auth).
 */
export const INTER_RELAY_SUBPROTOCOL = 'dvconf-inter-relay.v1';

/**
 * Validate the `Authorization: Bearer <token>` header presented on an
 * inter-relay WS upgrade against the configured INTER_RELAY_TOKEN.
 *
 * Constant-time on the token CONTENT via `crypto.timingSafeEqual` (the
 * cp-daemon `checkBearer` precedent uses `===`, which leaks via early-exit —
 * G3-SUBSPEC pins timingSafeEqual here). A length difference is itself a
 * mismatch (the token length is not the secret), so we short-circuit before
 * timingSafeEqual (which throws on unequal-length buffers).
 *
 * This only TAGS a peer as inter-relay — it is NEVER used to reject a client
 * upgrade. A client connects with no Authorization header (returns false →
 * untagged → its `pipe-producer` frames are dropped at the dispatch gate).
 * Returns false when no token is configured (empty `expectedToken`): tagging
 * must never validate against an empty secret (the dispatch gate handles the
 * "token unset" case separately).
 */
export function isValidInterRelayToken(
  authHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (expectedToken === '') return false;
  if (typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length);
  if (presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
  /**
   * REQ-RO-018 — the peerId of the publisher whose stream this piped producer
   * carries. OPTIONAL on the wire (additive / back-compat: pre-F1 frames omit
   * it and still validate). The standby threads it to the client so post-cutover
   * E2EE re-attach binds to the REAL producer's per-producer key.
   */
  producerPeerId?: string;
  /**
   * REQ-RMS-008 — the peer RELAY this piped producer is announced to/from in a
   * cascade. OPTIONAL on the wire (additive / back-compat, exactly like
   * producerPeerId?): pre-mesh F1 frames omit it. Keys the coordinator state +
   * port allocator per (roomId, peerRelayId) so K_r relays can serve one room.
   */
  peerRelayId?: string;
}

/** Type guard for an inbound JSON frame on the relay WS server. */
export function isPipeProducerAnnounce(msg: unknown): msg is PipeProducerAnnounce {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m['type'] === 'pipe-producer' &&
    typeof m['roomId'] === 'string' &&
    typeof m['producerId'] === 'string' &&
    (m['kind'] === 'audio' || m['kind'] === 'video') &&
    (m['producerPeerId'] === undefined || typeof m['producerPeerId'] === 'string')
    &&
    (m['peerRelayId'] === undefined || typeof m['peerRelayId'] === 'string')
  );
}

/**
 * Build the announce frame the PRIMARY sends to the standby.
 * Called by the primary's wiring layer when a producer is created/piped.
 */
export function buildPipeProducerAnnounce(
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId?: string,
  peerRelayId?: string,
): PipeProducerAnnounce {
  return {
    type: 'pipe-producer',
    roomId,
    producerId: producer.id,
    kind: producer.kind,
    ...(producerPeerId !== undefined ? { producerPeerId } : {}),
    ...(peerRelayId !== undefined ? { peerRelayId } : {}),
  };
}

// ── Connect-param exchange contract (pipe-connect, REQ-RO-006) ─────────

/**
 * The symmetric inter-relay connect-param frame.
 *
 * Exchanged BOTH ways: the standby announces its bound `{ip, port}` UP to the
 * primary; the primary replies DOWN with its own tuple. Each PipeTransport
 * needs the OTHER's `tuple.localPort` (known only after createPipeTransport)
 * before `connect()` — this frame carries it.
 *
 * Mirrors PipeProducerAnnounce exactly: flat JSON, string-literal discriminant,
 * typeof-every-field guard, NO version/correlation id (the codebase's
 * fire-and-forget convention; ordering robustness lives in the coordinator's
 * pending/re-drive, not a correlation id). `srtpParameters` is OPTIONAL —
 * undefined on the single-host loopback pipe (enableSrtp:false); present only
 * cross-host (enableSrtp:true). Shares the PipeConnectParams payload shape
 * (declared below, the params the caller passes to buildPipeConnectFrame).
 */
export interface PipeConnectFrame {
  type: 'pipe-connect';
  roomId: string;
  ip: string;
  port: number;
  srtpParameters?: msTypes.SrtpParameters;
  /**
   * REQ-RMS-008 — the peer RELAY this connect-param exchange pairs with in a
   * cascade. OPTIONAL on the wire (additive / back-compat, exactly like
   * srtpParameters?): pre-mesh F1 frames omit it. Keys the per-(room,peerRelay)
   * pipe so K_r relays can each carry a distinct leg of one room.
   */
  peerRelayId?: string;
}

/** Type guard for an inbound pipe-connect frame on the inter-relay link. */
export function isPipeConnectFrame(msg: unknown): msg is PipeConnectFrame {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m['type'] === 'pipe-connect' &&
    typeof m['roomId'] === 'string' &&
    typeof m['ip'] === 'string' &&
    typeof m['port'] === 'number'
    &&
    (m['peerRelayId'] === undefined || typeof m['peerRelayId'] === 'string')
  );
}

/**
 * Build the pipe-connect frame an endpoint sends to its peer.
 * Consumes the PipeConnectParams (`{ip, port, srtpParameters?}`) the endpoint
 * read from its own PipeTransport `tuple`. `srtpParameters` is forwarded only
 * when present (single-host loopback leaves it undefined → omitted from JSON).
 */
export function buildPipeConnectFrame(
  roomId: string,
  params: PipeConnectParams,
  peerRelayId?: string,
): PipeConnectFrame {
  const frame: PipeConnectFrame = {
    type: 'pipe-connect',
    roomId,
    ip: params.ip,
    port: params.port,
  };
  if (params.srtpParameters !== undefined) {
    frame.srtpParameters = params.srtpParameters;
  }
  if (peerRelayId !== undefined) {
    frame.peerRelayId = peerRelayId;
  }
  return frame;
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
): (
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId?: string,
) => void {
  return (roomId, producer, producerPeerId) => {
    const frame = buildPipeProducerAnnounce(roomId, producer, producerPeerId);
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
  /** REQ-RO-018 — publisher peerId, when the announce carried it (additive). */
  producerPeerId?: string;
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
      ...(announce.producerPeerId !== undefined
        ? { producerPeerId: announce.producerPeerId }
        : {}),
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

// ── Standby inbound link handler (G3.2b) ────────────────────────────────

/** Context the standby's inbound inter-relay link handler needs. */
export interface InboundInterRelayContext {
  /** Standby-side registry the announced producer is recorded into. */
  registry: InterRelayProducerRegistry;
  /**
   * Optional re-run hook — `StandbyWarmPipeCoordinator.onAnnounce(roomId)`. Fired
   * AFTER the record so the coordinator re-runs the warm pipe with the now-real
   * producerId (placeholder cutover). Omitted in pure-registry unit tests.
   */
  onAnnounce?: (roomId: string) => void | Promise<void>;
  /**
   * F1 (REQ-RO-003/006 standby half) — the primary's DOWN pipe-connect reply
   * arrived on the link the standby opened. The handler feeds {ip,port[,srtp]}
   * here so the standby connect()s its already-bound PipeTransport (design §2
   * step 5). Optional — omitted in pure-registry unit tests.
   */
  onConnectParams?: (roomId: string, params: PipeConnectParams) => void | Promise<void>;
  logger?: Logger;
}

/**
 * G3.2b — the STANDBY's inbound handler for a frame arriving on the inter-relay
 * WS link it OPENED to the primary (the primary pushes `pipe-producer` announces
 * down this link). Distinct from the server-side `handlePipeProducerAnnounce` in
 * signaling.ts (the in-process bench path): this runs on the standby's OUTBOUND
 * `ws` client socket (wired in inter-relay-link.ts / index.ts).
 *
 * Records a valid announce into the registry, then fires `onAnnounce(roomId)` so
 * the coordinator cuts the warm pipe over to the real producerId. Malformed /
 * non-announce frames are ignored (no throw — a noisy primary must not crash the
 * standby). Returns true iff a valid announce was recorded.
 */
export async function handleInboundInterRelayFrame(
  raw: string | Buffer,
  ctx: InboundInterRelayContext,
): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    ctx.logger?.debug('G3.2b: inbound inter-relay frame is not JSON — ignoring');
    return false;
  }
  // F1 (REQ-RO-003/006 standby half): an inbound pipe-connect is the primary's
  // DOWN reply — route it to onConnectParams so the standby connect()s its
  // already-bound transport, then return (it is not an announce).
  if (isPipeConnectFrame(parsed)) {
    if (ctx.onConnectParams) {
      await ctx.onConnectParams(parsed.roomId, {
        ip: parsed.ip,
        port: parsed.port,
        ...(parsed.srtpParameters !== undefined ? { srtpParameters: parsed.srtpParameters } : {}),
      });
    }
    ctx.logger?.debug(
      { roomId: parsed.roomId, ip: parsed.ip, port: parsed.port },
      'G3.2b: inbound pipe-connect reply — routed to onConnectParams',
    );
    return true;
  }
  if (!isPipeProducerAnnounce(parsed)) {
    ctx.logger?.debug(
      { frameType: (parsed as { type?: unknown })?.type },
      'G3.2b: inbound inter-relay frame is not a pipe-producer announce — ignoring',
    );
    return false;
  }
  ctx.registry.record(parsed);
  if (ctx.onAnnounce) await ctx.onAnnounce(parsed.roomId);
  return true;
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

  /**
   * F1 (REQ-RO-003, design §2 step 5) — the primary's DOWN pipe-connect reply
   * arrived. Connect the standby's ALREADY-BOUND PipeTransport (minted by
   * createStandbyPipeTransport + retained on topology.pipeTransport via
   * ensureWarmPipe) to the primary's params. Safe no-op when the room has no
   * bound transport yet (the standby re-announces UP on reconnect; the primary
   * re-replies; the coordinator re-drives). enableSrtp:false on the single-host
   * loopback → srtpParameters undefined.
   */
  async onPrimaryConnectParams(roomId: string, params: PipeConnectParams): Promise<void> {
    const state = this.states.get(roomId);
    const transport = state?.topology.pipeTransport;
    if (!transport) {
      this.logger?.debug(
        { roomId, primaryPort: params.port },
        'F1: standby onPrimaryConnectParams — no bound transport yet, ignoring (re-drive on reconnect)',
      );
      return;
    }
    await transport.connect({
      ip: params.ip,
      port: params.port,
      ...(params.srtpParameters !== undefined ? { srtpParameters: params.srtpParameters } : {}),
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    this.logger?.info(
      { roomId, primaryPort: params.port },
      'F1: standby PipeTransport connected to primary reply params (handshake complete)',
    );
  }

  /**
   * F6 accessor (REQ-RO-010/011 wiring) — the CURRENT standby pipe consumer the
   * liveness observer polls (topology.pipeConsumer), or null when none. The
   * optional roomId selects a room; omitted = the single tracked room (the K=2
   * single-room demo scope). Returns null for an unknown/absent room.
   */
  currentPipeConsumer(roomId?: string): msTypes.Consumer | null {
    if (roomId !== undefined) {
      return this.states.get(roomId)?.topology.pipeConsumer ?? null;
    }
    // No-arg convenience: the first (single-room) tracked state.
    const first = this.states.values().next();
    return first.done ? null : (first.value.topology.pipeConsumer ?? null);
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

// ── Primary-side warm-pipe coordinator (F1 — REQ-RO-001/002/008) ─────────

/**
 * Duck-type of `createPipePortAllocator`'s return (sibling cluster). Kept as an
 * interface so the PrimaryPipeCoordinator is unit-testable with a stub allocator
 * and does NOT depend on the allocator's concrete impl (clusters compose without
 * ordering coupling).
 */
export interface PipePortAllocatorLike {
  allocate(key: string): number;
  release(key: string): void;
  size(): number;
}

/** Injected collaborators for the PrimaryPipeCoordinator (all unit-mockable). */
export interface PrimaryPipeCoordinatorDeps {
  /**
   * Pushes the PIPED-consumer announce to the standby. Backed by
   * createInterRelayAnnouncer (inter-relay.ts) in the wiring layer. Receives the
   * PIPED consumer (its .id is the id the standby must consume) — NOT the source
   * producer.
   */
  announcer: (roomId: string, producer: Pick<msTypes.Producer, 'id' | 'kind'>) => void;
  /** Per-(room,role) port allocator. Keyed `${roomId}:primary` for the primary leg. */
  portAllocator: PipePortAllocatorLike;
  /**
   * Sends the primary's OWN pipe-connect params DOWN to the standby (the reply
   * leg of the §2 handshake). Backed by the interRelaySender in the wiring layer.
   */
  paramSender: (roomId: string, params: PipeConnectParams) => void;
  logger?: Logger;
}

/** Per-room primary-pipe state (module-private; mirrors WarmPipeState shape). */
interface PrimaryPipeState {
  /** The primary's PipeTransport once minted; null until both router + params seen. */
  pipeTransport: msTypes.PipeTransport | null;
  /** True once the transport has been connect()'d to the standby's params. */
  connected: boolean;
  /**
   * Producers seen before the pair was connectable. Drained (piped + announced)
   * once connected — REQ-RO-008 either-order tolerance. We keep only the fields
   * the announce + pipe need (id, kind) so a plain mock is a valid pending entry.
   */
  pendingProducers: Array<Pick<msTypes.Producer, 'id' | 'kind'>>;
  /** The standby's pipe-connect params once received; null until they arrive. */
  standbyParams: PipeConnectParams | null;
  /** The allocator port held for `${roomId}:primary` (for release on clear). */
  pipePort: number | null;
}

/**
 * F1 — the PRIMARY half mirror of StandbyWarmPipeCoordinator. Drives
 * createPrimaryPipeTransport + pipeProducerOntoPrimaryTransport so REAL RTP
 * crosses the inter-relay pipe, and announces the PIPED consumer id (REQ-RO-002)
 * — never producer.id.
 *
 * Either-order tolerance (REQ-RO-008, no correlation id): per-room state holds
 * {pipeTransport, connected, pendingProducers[], standbyParams}. RTP is NEVER
 * piped onto an unconnected transport — a producer arriving before the standby's
 * params is QUEUED and drained once the pair connects; params arriving after a
 * producer trigger the same drain. The transport is minted lazily on the FIRST
 * event that has BOTH a router (from onProducer) AND the standby params, so
 * createPipeTransport is called at most ONCE per room (REQ-RO-009 idempotent
 * binding via the allocator + the pipeTransport!=null guard).
 *
 * All logic in this exported factory class (REQ-RO-012); index.ts only assembles.
 */
export class PrimaryPipeCoordinator {
  private readonly states = new Map<string, PrimaryPipeState>();

  constructor(private readonly deps: PrimaryPipeCoordinatorDeps) {}

  private getState(roomId: string): PrimaryPipeState {
    let s = this.states.get(roomId);
    if (!s) {
      s = {
        pipeTransport: null,
        connected: false,
        pendingProducers: [],
        standbyParams: null,
        pipePort: null,
      };
      this.states.set(roomId, s);
    }
    return s;
  }

  /**
   * The standby's pipe-connect params arrived (the UP leg of the handshake).
   * Stashes them; does NOT mint the transport yet (minting needs the router,
   * which only onProducer carries). If a producer was already queued AND we have
   * a router stashed via a prior onProducer, the drain runs there — here we only
   * record + (cheaply) reserve the per-room port so a later onProducer binds it.
   */
  async onStandbyConnectParams(roomId: string, params: PipeConnectParams): Promise<void> {
    const s = this.getState(roomId);
    s.standbyParams = params;
    if (s.pipePort === null) {
      s.pipePort = this.deps.portAllocator.allocate(`${roomId}:primary`);
    }
    this.deps.logger?.debug(
      { roomId, standbyPort: params.port, primaryPort: s.pipePort },
      'F1: primary coordinator received standby pipe-connect params',
    );
    // If a producer is queued AND we have already minted+connected (params is a
    // re-send), drain now. The common params-first order mints on onProducer.
    if (s.connected && s.pipeTransport !== null && s.pendingProducers.length > 0) {
      await this.drain(roomId, s);
    }
  }

  /**
   * A real producer is created on the primary for this room. Queues it, then
   * (if the standby params are present) lazily mints+connects the pipe transport
   * ONCE and drains all pending producers — piping each + announcing its PIPED id.
   */
  async onProducer(
    roomId: string,
    router: msTypes.Router,
    producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  ): Promise<void> {
    const s = this.getState(roomId);
    s.pendingProducers.push(producer);

    if (s.standbyParams === null) {
      // params-not-yet: keep queued; a later onStandbyConnectParams → onProducer
      // re-drive (the standby re-sends on link attach) completes the pair.
      this.deps.logger?.debug(
        { roomId, producerId: producer.id },
        'F1: primary coordinator queued producer — awaiting standby pipe-connect params',
      );
      return;
    }

    // Mint + connect ONCE (REQ-RO-009 idempotent binding).
    if (s.pipeTransport === null) {
      if (s.pipePort === null) {
        s.pipePort = this.deps.portAllocator.allocate(`${roomId}:primary`);
      }
      const transport = await createPrimaryPipeTransport(router, s.pipePort);
      s.pipeTransport = transport;
      await transport.connect({
        ip: s.standbyParams.ip,
        port: s.standbyParams.port,
        srtpParameters: s.standbyParams.srtpParameters,
      } as Parameters<msTypes.PipeTransport['connect']>[0]);
      s.connected = true;

      // Reply DOWN with the primary's OWN bound port (the §2 handshake reply).
      const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
      this.deps.paramSender(roomId, {
        ip: announcedIp,
        port: transport.tuple.localPort,
      });
      this.deps.logger?.info(
        { roomId, primaryPort: transport.tuple.localPort, standbyPort: s.standbyParams.port },
        'F1: primary pipe transport minted + connected to standby',
      );
    }

    await this.drain(roomId, s);
  }

  /**
   * Pipe every queued producer onto the connected transport and announce its
   * PIPED consumer id (REQ-RO-002). Safe to call repeatedly — it shifts the
   * queue, so an already-piped producer is never re-piped.
   */
  private async drain(roomId: string, s: PrimaryPipeState): Promise<void> {
    if (!s.connected || s.pipeTransport === null) return;
    while (s.pendingProducers.length > 0) {
      const producer = s.pendingProducers.shift()!;
      const pipedConsumer = await pipeProducerOntoPrimaryTransport(
        s.pipeTransport,
        producer.id,
      );
      // Announce the PIPED id (pipedConsumer.id), NOT producer.id (REQ-RO-002).
      this.deps.announcer(roomId, { id: pipedConsumer.id, kind: pipedConsumer.kind });
      this.deps.logger?.info(
        { roomId, sourceProducerId: producer.id, pipedConsumerId: pipedConsumer.id },
        'F1: piped producer onto primary pipe + announced PIPED consumer id',
      );
    }
  }

  /** Drops a room's state, closes the transport, releases the port (REQ-RO-009). */
  clear(roomId: string): void {
    const s = this.states.get(roomId);
    if (!s) return;
    if (s.pipeTransport !== null) {
      try {
        s.pipeTransport.close();
      } catch {
        // Best-effort close — must not block teardown.
      }
    }
    if (s.pipePort !== null) {
      this.deps.portAllocator.release(`${roomId}:primary`);
    }
    this.states.delete(roomId);
  }
}
