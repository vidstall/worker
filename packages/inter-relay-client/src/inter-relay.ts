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
import {
  ensureWarmPipe,
  produceLocalFromPipe,
  pipeSrtpEnabled,
  type RoomTopology,
} from './relay-role-manager.js';

// ── Cross-daemon inter-relay link auth (G3.2b) ──────────────────────────

/**
 * WebSocket subprotocol the standby advertises on the inter-relay upgrade
 * (`Sec-WebSocket-Protocol`). A label the primary selects via `handleProtocols`
 * so both ends carry `ws.protocol === INTER_RELAY_SUBPROTOCOL` — a secondary
 * signal alongside the Bearer token (the token is the actual auth).
 */
export const INTER_RELAY_SUBPROTOCOL = 'dvconf-inter-relay.v1';

/**
 * REQ-RMS-008 — sentinel peerRelayId for the legacy single-peer F1 path. A frame
 * with no peerRelayId (pre-mesh) keys under this so the M1 single-standby path is
 * byte-for-byte unchanged; cascade frames carry a real peerRelayId. Every method
 * that gained an OPTIONAL trailing `peerRelayId` defaults to THIS, so a caller
 * that passes nothing keys consistently under one stable composite key end-to-end
 * (record/resolve/states/clear) and never mid-flow key-mismatches.
 */
export const DEFAULT_PEER_RELAY_ID = '__default__';

/**
 * Composite coordinator/registry key: `${roomId}::${peerRelayId}`. The `::`
 * separator can't collide with a roomId/peerRelayId (mediasoup ids + room ids are
 * opaque strings; we never embed `::`). On the DEFAULT peer this is still a single
 * stable bucket, so the legacy single-standby path is unchanged.
 */
function meshKey(roomId: string, peerRelayId: string): string {
  return `${roomId}::${peerRelayId}`;
}

/**
 * REQ-RMS-008 — the per-leg PIPE_PORT allocator key. On the DEFAULT peer it
 * degrades to the LEGACY `${roomId}:primary` form (so the existing warm-pipe
 * allocator slot + index.ts releaseRoom + warmpipe-rtp integration are
 * byte-stable); a real cascade peer widens it to `${roomId}:${peerRelayId}:primary`
 * so each (room, peerRelay) leg holds its own distinct port slot (per the
 * createPipePortAllocator REQ-RMS-007 generalization comment).
 */
function primaryPortKey(roomId: string, peerRelayId: string): string {
  return peerRelayId === DEFAULT_PEER_RELAY_ID
    ? `${roomId}:primary`
    : `${roomId}:${peerRelayId}:primary`;
}

/**
 * B6b (REQ-RMS-036) — the DISTINCT peerRelayId suffixes, across the given
 * per-meshKey maps, whose key's ROOM segment EXACTLY equals `roomId`. The room-wide
 * `clearRoom` teardown on each coordinator collects candidate legs from ALL of its
 * maps (not just `states`) so a QUEUED-but-never-connected leg — an announce that
 * landed in reverseMintPending / reversePending before its `states` entry ever
 * formed — is also dropped. Same lastIndexOf('::') separator-boundary + EXACT
 * segment-equality convention as InterRelayProducerRegistry.clearRoom: peerRelayId
 * is `::`-free, so the LAST `::` is the separator, and equality (NOT a prefix) means
 * clearRoom('room') never matches 'roomAB::...'.
 */
function roomPeerRelayIds(
  roomId: string,
  maps: ReadonlyArray<ReadonlyMap<string, unknown>>,
): string[] {
  const peers = new Set<string>();
  for (const map of maps) {
    for (const key of map.keys()) {
      const sep = key.lastIndexOf('::'); // separator: peerRelayId after it is `::`-free
      if (sep === -1 || key.slice(0, sep) !== roomId) continue; // exact room segment only
      peers.add(key.slice(sep + 2));
    }
  }
  return [...peers];
}

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
  /**
   * REQ-RMS-026 — the SSRC-remapped RtpParameters of the piped consumer.
   * OPTIONAL on the wire (additive / back-compat: pre-REQ-RMS-026 frames omit
   * it). Needed so the standby can call transport.produce() with the correct
   * codec + encoding parameters after piping.
   */
  rtpParameters?: msTypes.RtpParameters;
  /**
   * REQ-RMS-044 (cascade-tree) — loop-guard hop budget. Additive/back-compat (default-omit),
   * init TreeLayout.diameter at the origin, decremented per hop, dropped at <= 0.
   */
  hopTtl?: number;
  /**
   * REQ-RMS-046 (cascade-tree) — the IMMUTABLE origin producerId (first hop's id), threaded
   * unchanged across hops. Per-room dedup key (the local producerId now differs per hop).
   */
  originProducerId?: string;
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
    &&
    (m['rtpParameters'] === undefined
      || (typeof m['rtpParameters'] === 'object' && m['rtpParameters'] !== null))
    &&
    (m['hopTtl'] === undefined || typeof m['hopTtl'] === 'number')
    &&
    (m['originProducerId'] === undefined || typeof m['originProducerId'] === 'string')
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
  rtpParameters?: msTypes.RtpParameters,
  hopTtl?: number,
  originProducerId?: string,
): PipeProducerAnnounce {
  return {
    type: 'pipe-producer',
    roomId,
    producerId: producer.id,
    kind: producer.kind,
    ...(producerPeerId !== undefined ? { producerPeerId } : {}),
    ...(peerRelayId !== undefined ? { peerRelayId } : {}),
    ...(rtpParameters !== undefined ? { rtpParameters } : {}),
    ...(hopTtl !== undefined ? { hopTtl } : {}),
    ...(originProducerId !== undefined ? { originProducerId } : {}),
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
 *
 * REQ-RMS-008 — the returned closure gained a trailing OPTIONAL `peerRelayId`
 * (4th arg) forwarded into the frame's peerRelayId field, so this LIVE backing of
 * PrimaryPipeCoordinator.deps.announcer carries the cascade peer on the wire. All
 * trailing args default to undefined → the legacy single-standby path emits a
 * byte-identical frame (builder OMITS undefined fields). The two live call sites
 * thread the slots they have: the legacy in-process bench announce passes
 * `producerPeerId` (3rd arg, peerRelayId omitted); the coordinator drain (via the
 * index.ts adapter) NOW threads BOTH the ORIGINAL publisher's `producerPeerId`
 * (3rd arg) AND the cascade `peerRelayId` (4th arg) on the CASCADE/mesh path
 * (REQ-RMS-029 — the publisher id travels alongside the PIPED consumer id so a
 * cross-relay consume binds to the real publisher, not the cascade relayId). On
 * the DEFAULT/legacy single-standby leg the drain leaves producerPeerId undefined
 * → that part of the frame stays byte-stable.
 *
 * REQ-RMS-026 — the closure also forwards a trailing OPTIONAL `rtpParameters`
 * (5th arg) into the frame so the live primary→standby wire carries the piped
 * consumer's RtpParameters (the standby needs them for transport.produce()). Like
 * the other trailing args it defaults to undefined → the builder omits the field
 * → a legacy frame is byte-identical.
 */
export function createInterRelayAnnouncer(
  sender: InterRelaySender,
): (
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId?: string,
  peerRelayId?: string,
  rtpParameters?: msTypes.RtpParameters,
) => void {
  return (roomId, producer, producerPeerId, peerRelayId, rtpParameters) => {
    const frame = buildPipeProducerAnnounce(roomId, producer, producerPeerId, peerRelayId, rtpParameters);
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
  /** REQ-RMS-026 — the piped consumer's RtpParameters, when the announce carried it (additive). */
  rtpParameters?: msTypes.RtpParameters;
}

/**
 * Registry of producers announced by the primary, keyed by roomId.
 * Held by the STANDBY daemon. One room may have multiple producers (audio +
 * video, or multiple peers) — we keep them all, keyed by producerId to dedup.
 */
export class InterRelayProducerRegistry {
  /**
   * REQ-RMS-008 — keyed by meshKey(roomId, peerRelayId) so K_r peer relays can
   * each announce a DISTINCT leg of one room without their producers leaking into
   * each other's bucket. A legacy announce (no peerRelayId) keys under
   * DEFAULT_PEER_RELAY_ID — a single stable bucket, byte-identical to the prior
   * roomId-only behaviour for the M1 single-standby path.
   */
  private readonly byRoom = new Map<string, Map<string, AnnouncedProducer>>();

  /**
   * Records an announced producer under (roomId, peerRelayId ?? DEFAULT).
   * Idempotent — re-announcing the same producerId for a (room, peer) is a no-op
   * (dedup guards against duplicate-pipe).
   */
  record(announce: PipeProducerAnnounce): void {
    const key = meshKey(announce.roomId, announce.peerRelayId ?? DEFAULT_PEER_RELAY_ID);
    let room = this.byRoom.get(key);
    if (!room) {
      room = new Map();
      this.byRoom.set(key, room);
    }
    room.set(announce.producerId, {
      producerId: announce.producerId,
      kind: announce.kind,
      ...(announce.producerPeerId !== undefined
        ? { producerPeerId: announce.producerPeerId }
        : {}),
      ...(announce.rtpParameters !== undefined
        ? { rtpParameters: announce.rtpParameters }
        : {}),
    });
  }

  /**
   * Resolves the first announced producer for a (room, peer).
   * Returns null if no producer has been announced yet (standby should keep
   * the consumer paused / reply "not ready" to a client consume request).
   *
   * `peerRelayId` defaults to DEFAULT_PEER_RELAY_ID so the legacy 1-arg call
   * (signaling.ts, the coordinator's single-standby path) is unchanged.
   *
   * For the warm-pipe Consumer, the standby pipes the room's producer(s); the
   * "first" producer is sufficient to establish the pipe Consumer lifecycle
   * (REQ-RO-005).
   */
  resolve(
    roomId: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): AnnouncedProducer | null {
    const room = this.byRoom.get(meshKey(roomId, peerRelayId));
    if (!room || room.size === 0) return null;
    const first = room.values().next();
    return first.done ? null : first.value;
  }

  /**
   * ALL announced producers for a (room, peer). REQ-RMS-008: a cascade pipes
   * EVERY producer the peer announced (>100-user fan-out), and per-peer isolation
   * means one peer's producers never leak into another peer's resolveAll.
   * `peerRelayId` defaults to DEFAULT_PEER_RELAY_ID (legacy single-standby).
   */
  resolveAll(
    roomId: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): AnnouncedProducer[] {
    const room = this.byRoom.get(meshKey(roomId, peerRelayId));
    if (!room) return [];
    return Array.from(room.values());
  }

  /**
   * REQ-RMS-029 — resolve an announced producer by its producerId, filtered to a
   * specific room. handleConsume holds the producerId (the client sends it), so this
   * returns the ORIGINAL publisher's producerPeerId for the SPECIFIC producer — unlike
   * resolve(roomId) which only reads the DEFAULT bucket (missing mesh records) and
   * returns the first entry (not producerId-keyed). Returns null if not found.
   *
   * Cost: O(total buckets) — it iterates `this.byRoom` (daemon-GLOBAL across ALL rooms)
   * and filters to the target room, then does an exact producerId lookup in each matching
   * bucket. A producerId→record index (O(1)) is deliberately DEFERRED to keep DRY: it
   * would be a parallel index over the same data that record()/clear() must also maintain.
   * (If a multi-room carry-forward ever makes this hot, add the index then.)
   *
   * Room-scoping is EXACT via the meshKey separator convention: every bucket key is
   * `meshKey(roomId, peerRelayId)` = `${roomId}::${peerRelayId}`, and `::` never appears
   * inside a roomId/peerRelayId (see meshKey docstring). The separator is therefore the
   * LAST `::` in the key — because everything AFTER it (the peerRelayId) is `::`-free — so
   * we split at `lastIndexOf('::')` and compare the room segment for EQUALITY.
   *
   * NOTE — we use lastIndexOf, NOT a `${roomId}::` prefix NOR indexOf('::'): both
   * false-handle a roomId that legitimately ends in a single `:` (still `::`-free, so it
   * satisfies the meshKey invariant). E.g. roomId `"room1:"` → key `"room1:::relayB"`:
   *   - `"room1:::relayB".startsWith("room1::")` is TRUE  → a query for room `"room1"` would
   *     wrongly match `"room1:"`s producer;
   *   - the FIRST `::` sits at the roomId's own trailing colon, so `indexOf('::')` splits
   *     the segment as `"room1"` → SAME false-match, and it also can't find `"room1:"`s own
   *     record.
   * `lastIndexOf('::')` splits at the true separator → segment `"room1:"` ≠ `"room1"`, so
   * the rooms stay isolated and each resolves its own record. (Residual symmetric edge: a
   * peerRelayId that BEGINS with `:` reintroduces boundary ambiguity — peerRelayIds are
   * operator-assigned relay ids and never do; this is documented, not handled, to avoid
   * storing a redundant roomId on every record.) Scoping by key (not producerId alone)
   * keeps the lookup correct even if a caller reused an id across rooms; within a room the
   * producerId lookup is exact.
   */
  resolveByProducerId(roomId: string, producerId: string): AnnouncedProducer | null {
    for (const [key, bucket] of this.byRoom) {
      const sep = key.lastIndexOf('::'); // the separator: peerRelayId after it is `::`-free
      if (sep === -1 || key.slice(0, sep) !== roomId) continue; // exact room segment only
      const hit = bucket.get(producerId);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Stage B / G2 — EVERY announced producer for a roomId, across ALL peerRelayId
   * buckets (audio + video, every cascade leg). The STANDBY's minted LOCAL
   * producers live ONLY here (they are produced by produceLocalFromPipe with
   * `id == announced.producerId`, NOT by handleProduce), so they are absent from
   * room.peers[*].producers — the array handleJoin re-announce normally reads.
   * handleJoin iterates THIS so a FRESH browser that HOMES to a standby and joins
   * AFTER the producers were minted learns each id and consumes it (handleConsume
   * resolves the same id from this registry, REQ-RMS-029). On a PRIMARY the
   * registry ALSO holds reverse-announced (piped-up) producers from standby clients
   * (recorded unconditionally at handlePipeProducerAnnounce), so on a PRIMARY this
   * returns those piped-up entries and handleJoin re-announces them to fresh
   * primary-homed joiners (DESIGN-1, REQ-RMS-037). The list is non-empty on a
   * primary that has received at least one reverse announce.
   *
   * Room-scoped EXACTLY via the meshKey `::` separator — same `lastIndexOf('::')`
   * convention as resolveByProducerId (see its docstring for the boundary proof).
   */
  listForRoom(roomId: string): AnnouncedProducer[] {
    const out: AnnouncedProducer[] = [];
    for (const [key, bucket] of this.byRoom) {
      const sep = key.lastIndexOf('::'); // separator: peerRelayId after it is `::`-free
      if (sep === -1 || key.slice(0, sep) !== roomId) continue; // exact room segment only
      for (const rec of bucket.values()) out.push(rec);
    }
    return out;
  }

  /**
   * Drops a SINGLE (room, peer) bucket (on worker.died per-peer rebuild or a
   * targeted single-standby teardown). `peerRelayId` defaults to
   * DEFAULT_PEER_RELAY_ID (legacy single-standby path, byte-stable).
   *
   * For a full room close use clearRoom(roomId) -- it drops EVERY per-peer
   * bucket for the room, not just DEFAULT (mirrors metrics.clearSession vs
   * metrics.clearRoom; the part-3 hub-fan reverse-buckets would otherwise leak
   * across a room teardown, DESIGN-1 / REQ-RMS-036).
   */
  clear(roomId: string, peerRelayId: string = DEFAULT_PEER_RELAY_ID): void {
    this.byRoom.delete(meshKey(roomId, peerRelayId));
  }

  /**
   * Room-wide teardown -- drops EVERY (room, peer) bucket for roomId across ALL
   * peerRelayId buckets, not just DEFAULT. `clear(roomId, peer)` drops a SINGLE
   * bucket (single-standby / worker.died per-peer rebuild); this drops them all so
   * a reused roomId starts with zero stale announce records. The per-peer reverse
   * buckets the part-3 hub-fan populates would otherwise leak (DESIGN-1). Same
   * `lastIndexOf('::')` room-scoping convention as listForRoom (see its docstring
   * for the separator-boundary proof).
   */
  clearRoom(roomId: string): void {
    const stale: string[] = [];
    for (const key of this.byRoom.keys()) {
      const sep = key.lastIndexOf('::'); // separator: peerRelayId after it is `::`-free
      if (sep === -1 || key.slice(0, sep) !== roomId) continue; // exact room segment only
      stale.push(key);
    }
    for (const key of stale) this.byRoom.delete(key);
  }

  /** Test/diagnostic — total (room, peer) buckets tracked. */
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
   *
   * C6 (REQ-RMS-008): the SECOND arg is the cascade peerRelayId carried by the
   * frame (the primary echoes the standby's own x-inter-relay-peer-id). The
   * wiring threads it to `StandbyWarmPipeCoordinator.onAnnounce(roomId, …, peerRelayId)`
   * so the announce re-run keys the SAME (room, peer) warm-pipe state ensure()
   * recorded — undefined (legacy frame) → DEFAULT_PEER_RELAY_ID, byte-stable.
   */
  onAnnounce?: (roomId: string, peerRelayId?: string) => void | Promise<void>;
  /**
   * F1 (REQ-RO-003/006 standby half) — the primary's DOWN pipe-connect reply
   * arrived on the link the standby opened. The handler feeds {ip,port[,srtp]}
   * here so the standby connect()s its already-bound PipeTransport (design §2
   * step 5). Optional — omitted in pure-registry unit tests.
   *
   * C6 part-2 (REQ-RMS-008): the THIRD arg is the cascade peerRelayId the primary
   * echoes back on its DOWN reply (= the standby's own x-inter-relay-peer-id). The
   * wiring threads it to `StandbyWarmPipeCoordinator.onPrimaryConnectParams(.., peerRelayId)`
   * so the connect() targets the SAME per-(room,peer) warm-pipe leg ensure() bound —
   * undefined (legacy frame) → DEFAULT_PEER_RELAY_ID, single-standby byte-stable.
   */
  onConnectParams?: (
    roomId: string,
    params: PipeConnectParams,
    peerRelayId?: string,
  ) => void | Promise<void>;
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
      // C6 part-2 (REQ-RMS-008): thread the frame's peerRelayId so the standby
      // connect()s the SAME per-(room,peer) leg. Undefined (legacy) → DEFAULT.
      await ctx.onConnectParams(
        parsed.roomId,
        {
          ip: parsed.ip,
          port: parsed.port,
          ...(parsed.srtpParameters !== undefined ? { srtpParameters: parsed.srtpParameters } : {}),
        },
        parsed.peerRelayId,
      );
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
  // C6 (REQ-RMS-008): thread the frame's peerRelayId so the cutover re-run keys
  // the SAME (room, peer) state ensure() recorded. Undefined (legacy) → DEFAULT.
  if (ctx.onAnnounce) await ctx.onAnnounce(parsed.roomId, parsed.peerRelayId);
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
 * REQ-RMS-034 / 026 (part-3 reverse leg) — pushes a standby's local-client
 * producer UP to the primary over the warm pipe. Mirrors the forward announcer's
 * closure shape `(roomId, producer, producerPeerId?, peerRelayId?, rtpParameters?)`:
 * the `producer` is the PIPED consumer (its `.id` is the id the primary consumes,
 * NOT the source producer's id); `rtpParameters` are the pipe-CONSUMER's REMAPPED
 * params (REQ-RMS-026 — the SSRC differs across the pipe), so the primary's
 * produceLocalFromPipe ingests it correctly. Bound by the wiring layer (index.ts)
 * via setReverseAnnouncer; null until wired (forward/keepalive-only rooms never set
 * it → byte-stable).
 */
export type ReverseUpAnnouncer = (
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId?: string,
  peerRelayId?: string,
  rtpParameters?: msTypes.RtpParameters,
) => void;

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
  /**
   * REQ-RMS-025 — producerIds already minted as LOCAL producers, keyed by
   * meshKey(roomId, peerRelayId). Prevents a re-run (ensure → onAnnounce, or a
   * repeated announce) from double-producing the same id (mediasoup throws on a
   * duplicate producer id). Cleared with the room's state in clear().
   */
  private readonly producedIds = new Map<string, Set<string>>();

  /**
   * REQ-RMS-034 (part-3 reverse leg) — the UP-announcer that pushes a reverse
   * announce to the primary. Bound by setReverseAnnouncer (wiring layer); null
   * until wired so a forward/keepalive-only room is byte-stable (never announces UP).
   */
  private reverseAnnouncer: ReverseUpAnnouncer | null = null;
  /**
   * REQ-RMS-037 — local-client producers seen BEFORE the reverse pipe was
   * connected, keyed by meshKey(roomId, peerRelayId). Drained by drainReverse once
   * onPrimaryConnectParams connects the leg. Cleared with the room's state in clear().
   */
  private readonly reversePending = new Map<
    string,
    Array<{ producer: Pick<msTypes.Producer, 'id' | 'kind'>; producerPeerId?: string }>
  >();
  /**
   * REQ-RMS-034 — producerIds already consumed onto the reverse pipe, keyed by
   * meshKey. Prevents a re-drive (drainReverse / a repeated onLocalClientProducer)
   * from double-consuming the same id.
   *
   * Cleared in PRODUCTION ONLY on leg teardown (clear()). `onPipeTransportReplacedForTest`
   * is TEST-ONLY (it models a transport swap the direct-class unit cannot otherwise
   * trigger). GUARDRAIL: any FUTURE production path that REPLACES an established leg's
   * `topology.pipeTransport` in place — specifically `ensureWarmPipe`'s create-own
   * close+replace (relay-role-manager.ts:252-254) — MUST also clear `reverseConsumedIds`
   * + `reversePending` for that key, or a re-consume onto the NEW pipe is silently
   * dropped (the id stays marked against the dead transport). Not wired now: that
   * close+replace is NOT on the reverse leg's live path (A2 scope), and `onAnnounce`'s
   * C3 path REUSES the bound transport instead of replacing it.
   */
  private readonly reverseConsumedIds = new Map<string, Set<string>>();

  /**
   * @param registry        - the standby's announce registry.
   * @param logger          - optional structured logger.
   * @param onLocalProducer - REQ-RMS-025 — OPTIONAL callback fired AFTER the
   *   standby mints a LOCAL producer from the cross-process pipe (active forward).
   *   The wiring layer (L1.3, index.ts) backs it to register the producer with the
   *   room + fan it to local clients. Kept OPTIONAL so existing 2-arg callers
   *   (index.ts) compile unchanged; surfaces the roomId, the minted Producer, the
   *   original producerPeerId (publisher, when the announce carried it), and the
   *   peerRelayId (which cascade leg minted it).
   * @param activeForward   - L1.4 (RMS SHIP-gate decision): when false (default),
   *   `forwardLocalProducers` is a no-op — the standby keeps ONLY its paused
   *   keepalive consumer (REQ-RO-005, ~80% BW saving), which is the correct
   *   behaviour for the relay-overlap M1 / 2-relay failover path. The wiring layer
   *   (index.ts) opts in by passing `true` via `RMS_ACTIVE_FORWARD='1'` in mesh
   *   mode. Defaulting to false is the fail-safe: an un-flagged coordinator will
   *   never accidentally active-forward in a non-mesh room.
   */
  constructor(
    private readonly registry: InterRelayProducerRegistry,
    private readonly logger?: Logger,
    private readonly onLocalProducer?: (
      roomId: string,
      producer: msTypes.Producer,
      producerPeerId: string | undefined,
      peerRelayId: string,
    ) => void,
    private readonly activeForward: boolean = false,
  ) {}

  /**
   * REQ-RMS-025 — ACTIVE forward. Once the warm pipe is connected (the transport
   * is retained on topology.pipeTransport by ensureWarmPipe), mint a LOCAL producer
   * on the standby's router for EVERY announced producer that carries rtpParameters
   * (REQ-RMS-026), so the standby's own clients can consume the room. Then fire
   * onLocalProducer so the wiring layer registers + fans it.
   *
   * Defensive + additive (the paused keepalive consumer is untouched, never throws
   * out of the loop):
   *   - not a standby (primary owns the source producers)    → SKIP (return);
   *   - no bound pipe transport yet (not-ready)              → SKIP (return);
   *   - an announced entry lacks rtpParameters (legacy primary, pre-REQ-RMS-026)
   *     → SKIP that entry (we can't produce without them);
   *   - an id already minted on a prior run                   → SKIP (idempotent);
   *   - DUPLICATE-id throw (mediasoup "already exists") — the benign idempotency
   *     belt-and-suspenders → mark + SKIP, log at debug;
   *   - any OTHER (transient/real) produce error → do NOT mark, log at warn, SKIP —
   *     the id stays unmarked so the NEXT ensure/onAnnounce self-heals (retries);
   *   - a throwing onLocalProducer callback → log at warn + continue (the producer
   *     is already minted + marked; one bad callback must not skip the rest).
   */
  private async forwardLocalProducers(
    roomId: string,
    topology: RoomTopology,
    peerRelayId: string,
  ): Promise<void> {
    // Mesh-mode gate (RMS M4 L1 SHIP-gate decision): when active-forward is OFF
    // (default), the standby keeps ONLY its paused keepalive consumer
    // (REQ-RO-005, ~80% BW saving) — do NOT mint a local producer.
    // index.ts opts in via RMS_ACTIVE_FORWARD in mesh mode.
    if (!this.activeForward) {
      return;
    }
    // Fix 3 — self-document the standby-only intent ahead of the transport check
    // (don't rely solely on the primary's pipeTransport being null).
    if (topology.role !== 'standby') {
      return;
    }
    const transport = topology.pipeTransport;
    if (!transport) {
      // No bound pipe transport (the standby is still not-ready) — nothing to
      // forward onto. onAnnounce re-drives once the pipe is established.
      return;
    }
    const key = meshKey(roomId, peerRelayId);
    let produced = this.producedIds.get(key);
    if (!produced) {
      produced = new Set<string>();
      this.producedIds.set(key, produced);
    }
    for (const announced of this.registry.resolveAll(roomId, peerRelayId)) {
      if (announced.rtpParameters === undefined) {
        // Legacy primary — no rtpParameters to produce from. Skip (keepalive intact).
        continue;
      }
      if (produced.has(announced.producerId)) {
        // Already minted on a prior ensure/onAnnounce — no double-produce.
        continue;
      }
      let producer: msTypes.Producer;
      try {
        producer = await produceLocalFromPipe(transport, {
          producerId: announced.producerId,
          kind: announced.kind,
          rtpParameters: announced.rtpParameters,
        });
      } catch (err) {
        // Fix 1 — discriminate a benign duplicate-id throw (idempotent belt-and-
        // suspenders: a concurrent re-run already minted this id) from a TRANSIENT
        // failure (worker hiccup / produce racing a rebuilt transport's connect).
        const message = String((err as Error)?.message ?? err);
        const dup = /already exists|duplicate/i.test(message);
        if (dup) {
          // Mark + skip so we never retry a known-minted id.
          produced.add(announced.producerId);
          this.logger?.debug(
            { roomId, producerId: announced.producerId, error: message },
            'REQ-RMS-025: produceLocalFromPipe skipped — producer id already exists (idempotent)',
          );
        } else {
          // Do NOT mark — leave the id unmarked so the next ensure/onAnnounce
          // self-heals (retries). A real fault → warn, not debug.
          this.logger?.warn(
            { roomId, producerId: announced.producerId, error: message },
            'REQ-RMS-025: produceLocalFromPipe failed — leaving id unmarked to retry on the next drive',
          );
        }
        continue;
      }
      produced.add(announced.producerId);
      this.logger?.info(
        { roomId, producerId: producer.id, kind: producer.kind, peerRelayId },
        'REQ-RMS-025: standby minted a LOCAL producer from the cross-process pipe (active forward)',
      );
      // Fix 4 — a throwing L1.3 callback must NOT abort the loop or skip the
      // remaining producers (this one is already minted + marked).
      try {
        this.onLocalProducer?.(roomId, producer, announced.producerPeerId, peerRelayId);
      } catch (cbErr) {
        this.logger?.warn(
          { roomId, producerId: producer.id, error: String((cbErr as Error)?.message ?? cbErr) },
          'REQ-RMS-025: onLocalProducer callback threw — continuing the forward loop',
        );
      }
    }
  }

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
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<msTypes.Consumer | null> {
    const announced = this.registry.resolve(topology.roomId, peerRelayId);
    const realId = announced?.producerId;
    const pending = realId === undefined;
    const consumedProducerId = realId ?? placeholderProducerId(topology.roomId);

    // Only record state for the standby (ensureWarmPipe returns null for primary).
    if (topology.role === 'standby') {
      this.states.set(meshKey(topology.roomId, peerRelayId), {
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

    const consumer = await ensureWarmPipe(topology, router, pipePort, realId);
    // REQ-RMS-025 — ACTIVE forward: if the announce is already resolvable with
    // rtpParameters, mint the standby's LOCAL producer(s) now. No-op while
    // pending (resolveAll empty / no rtpParameters yet) — onAnnounce re-drives it.
    await this.forwardLocalProducers(topology.roomId, topology, peerRelayId);
    return consumer;
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
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<boolean> {
    const state = this.states.get(meshKey(roomId, peerRelayId));
    if (!state) {
      // Never ensured for this (room, peer) — nothing to re-run.
      return false;
    }
    if (!state.pending) {
      // Already cut over to the real producer — no second placeholder swap. BUT a
      // LATER forward announce may carry a NEWLY-produced id (RC-B, REQ-RMS-035):
      // e.g. a peer's 2nd track produced AFTER this leg already cut over. The
      // one-shot cutover below flips pending=false on the FIRST announce, so without
      // this every subsequent forward announce returns here and the new id — though
      // record()'d in the registry — is NEVER minted on the standby router, so the
      // local client can't consume it (live proof: relay-1 minted only the audio
      // producer; the video producer announced after the cutover was dropped → "0
      // inbound video"). Re-drive the FORWARD mint on the LIVE state.topology (it
      // holds the connected pipeTransport — NOT the placeholder). forwardLocalProducers
      // is idempotent (producedIds Set dedups already-minted ids), is a no-op when
      // active-forward is OFF (keepalive-only DEFAULT path → byte-stable) or when no
      // new ids are announced, and handles a duplicate-producer throw gracefully.
      await this.forwardLocalProducers(roomId, state.topology, peerRelayId);
      return false;
    }

    const announced = this.registry.resolve(roomId, peerRelayId);
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

    // C3 (RMS-live cross-relay DEADLOCK fix) — PRODUCE-then-CONSUME.
    // produceLocalFromPipe must mint the standby's LOCAL producer (id ==
    // announced.producerId) on useTopology.pipeTransport BEFORE ensureWarmPipe
    // consumes it: REAL mediasoup `transport.consume({producerId})` requires that
    // producer to already exist on the router. Every passing integration test
    // produces-then-consumes; the live coordinator consumed-then-produced, so on
    // first-peer-join the consume threw "Producer not found" and the warm pipe
    // never came up (the active-forward DEADLOCK). The forward also feeds local
    // clients (REQ-RMS-025); it is a no-op when active-forward is OFF (keepalive-
    // only) — so a gate-OFF standby keeps consuming the announced id as before.
    await this.forwardLocalProducers(roomId, useTopology, peerRelayId);

    // C3 — consume onto the EXISTING bound+connected pipe transport (5-arg) instead
    // of letting ensureWarmPipe close+rebuild it (the 4-arg create-own path). A
    // rebuild here would tear down the transport the standby already announced UP +
    // connected (onPrimaryConnectParams) AND destroy the LOCAL producer just minted
    // on it, re-triggering "Producer not found". Falls back to the create-own path
    // only if no transport is bound yet (defensive; ensure binds it first).
    const reuse = useTopology.pipeTransport ?? undefined;
    const consumer = await ensureWarmPipe(
      useTopology,
      useRouter,
      usePipePort,
      announced.producerId,
      reuse,
    );

    this.states.set(meshKey(roomId, peerRelayId), {
      topology: useTopology,
      router: useRouter,
      pipePort: usePipePort,
      consumedProducerId: announced.producerId,
      pending: false,
    });

    return consumer !== null;
  }

  /**
   * Drops a (room, peer)'s coordinator state (room close / worker rebuild).
   * `peerRelayId` defaults to DEFAULT_PEER_RELAY_ID (legacy single-standby).
   */
  clear(roomId: string, peerRelayId: string = DEFAULT_PEER_RELAY_ID): void {
    const key = meshKey(roomId, peerRelayId);
    this.states.delete(key);
    // REQ-RMS-025 — drop the minted-producer dedup set with the room's state so a
    // later room with the same key re-mints cleanly (the producers themselves are
    // owned + closed by the wiring layer / their transport teardown).
    this.producedIds.delete(key);
    // part-3 reverse leg — the leg's pipe transport is being torn down: drop the
    // reverse consume-dedup + any queued local producers so a later room/leg with
    // the same key re-consumes onto a fresh pipe cleanly.
    this.reverseConsumedIds.delete(key);
    this.reversePending.delete(key);
  }

  /**
   * B6b (REQ-RMS-036) — room-wide teardown. `clear(roomId)` drops only the DEFAULT
   * bucket; this drops EVERY (room, peer) leg across all peerRelayId buckets (states /
   * producedIds / reverseConsumedIds / reversePending) by delegating to clear() per
   * distinct peer, so a reused roomId starts with zero stale cascade legs. Mirrors
   * InterRelayProducerRegistry.clearRoom. Collects candidate peers from ALL maps
   * (incl. reversePending) so a queued-but-never-connected leg is dropped too.
   */
  clearRoom(roomId: string): void {
    for (const peerRelayId of roomPeerRelayIds(roomId, [
      this.states,
      this.producedIds,
      this.reverseConsumedIds,
      this.reversePending,
    ])) {
      this.clear(roomId, peerRelayId);
    }
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
  async onPrimaryConnectParams(
    roomId: string,
    params: PipeConnectParams,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<void> {
    const state = this.states.get(meshKey(roomId, peerRelayId));
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
    // part-3 reverse leg (REQ-RMS-037 ordering) — the pipe is now connected: drain
    // any local-client producers that arrived BEFORE connect (consume-onto-pipe UP
    // + announce UP). No-op when nothing was queued. NOT driven from the forward
    // forwardLocalProducers/onAnnounce path (that would risk re-announcing a minted
    // producer UP = a loop — REQ-RMS-036).
    await this.drainReverse(roomId, peerRelayId);
  }

  /**
   * F6 accessor (REQ-RO-010/011 wiring) — the CURRENT standby pipe consumer the
   * liveness observer polls (topology.pipeConsumer), or null when none. The
   * optional roomId selects a (room, peer) leg; omitted = the single tracked leg
   * (the K=2 single-room demo scope). Returns null for an unknown/absent leg.
   *
   * REQ-RMS-008 hardening: once a room holds MULTIPLE per-(room,peerRelayId) legs
   * (the M2 cascade), the no-arg form is AMBIGUOUS — it would poll an arbitrary
   * leg's consumer (states insertion order). It now WARNs on that ambiguity so a
   * cascade caller that forgot to pass (roomId, peerRelayId) is diagnosable rather
   * than silently observing the wrong leg. It does NOT throw — the liveness poller
   * (index.ts:556) must keep returning a consumer. Pass an explicit (roomId,
   * peerRelayId) to disambiguate (and stay quiet). The single-leg no-arg path (M1
   * single-standby) is byte-unchanged.
   */
  currentPipeConsumer(
    roomId?: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): msTypes.Consumer | null {
    if (roomId !== undefined) {
      return this.states.get(meshKey(roomId, peerRelayId))?.topology.pipeConsumer ?? null;
    }
    // No-arg convenience: the single tracked leg. With >1 leg this is ambiguous
    // (an M2 cascade with multiple peers) — warn and fall back to the first.
    if (this.states.size > 1) {
      this.logger?.warn(
        { legCount: this.states.size },
        'F6: currentPipeConsumer() called with no peerRelayId on a multi-leg room — ' +
          'polling an ARBITRARY leg; pass an explicit (roomId, peerRelayId) to disambiguate',
      );
    }
    const first = this.states.values().next();
    return first.done ? null : (first.value.topology.pipeConsumer ?? null);
  }

  /**
   * REQ-RMS-025 byte-proof — resolve the CURRENT standby pipe TRANSPORT (null when
   * none). Mirrors {@link currentPipeConsumer}: the liveness observer reads its
   * getStats().bytesReceived to prove cross-relay RTP actually crossed the pipe
   * (the keepalive consumer is paused, so its byteCount under-reports). Same no-arg
   * single-leg convenience + multi-leg ambiguity warning.
   */
  currentPipeTransport(
    roomId?: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): msTypes.PipeTransport | null {
    if (roomId !== undefined) {
      return this.states.get(meshKey(roomId, peerRelayId))?.topology.pipeTransport ?? null;
    }
    if (this.states.size > 1) {
      this.logger?.warn(
        { legCount: this.states.size },
        'F6: currentPipeTransport() called with no peerRelayId on a multi-leg room — ' +
          'polling an ARBITRARY leg; pass an explicit (roomId, peerRelayId) to disambiguate',
      );
    }
    const first = this.states.values().next();
    return first.done ? null : (first.value.topology.pipeTransport ?? null);
  }

  // ── part-3 REVERSE leg (REQ-RMS-034 / 026) ──────────────────────────────
  // A STANDBY-homed local client's producer is consumed onto the warm pipe UP
  // toward the primary and announced UP (mirror of the forward consume-onto-pipe).
  // ADDITIVE to the forward path; the reverse UP-announcer fires ONLY from
  // onLocalClientProducer (a real local-client produce) — NEVER from the forward
  // mint path (forwardLocalProducers), so a minted/hub-fanned producer never re-
  // announces UP (loop-safe, REQ-RMS-036; Task B2 asserts this wire output).

  /** REQ-RMS-034 — bind the reverse UP-announcer (wiring layer, index.ts). */
  setReverseAnnouncer(fn: ReverseUpAnnouncer): void {
    this.reverseAnnouncer = fn;
  }

  /**
   * REQ-RMS-034 — a STANDBY-homed local client produced. Consume that producer
   * onto the warm PipeTransport UP toward the primary and announce it UP carrying
   * the pipe-CONSUMER's REMAPPED rtpParameters (REQ-RMS-026). If the pipe transport
   * is not connected yet the producer is QUEUED (reversePending) and drained by
   * drainReverse once onPrimaryConnectParams connects the leg (REQ-RMS-037 ordering)
   * — RTP is NEVER piped onto an unconnected transport. Idempotent per (room,peer):
   * the same producerId is consumed at most once onto a given transport
   * (reverseConsumedIds).
   *
   * `_router` is accepted for signature symmetry with the forward onStandbyProducer
   * hook (A1) but unused here — the standby consumes onto its RETAINED
   * topology.pipeTransport, not a fresh router transport.
   *
   * REQ-RMS-037 (Task B4b) — RECORDED standby asymmetries (single-room demo scope;
   * NOT fixed here, by design):
   *   (1) This gates on `transport === null`, NOT on a `connected` flag — so a
   *       producer can be consumed onto an EXISTING-but-not-yet-connected pipe
   *       transport (consume-before-connect). mediasoup TOLERATES this (the consume
   *       binds and self-heals once the transport connects); RTP is never lost, only
   *       briefly buffered. The primary side has no such window (reverseMint queues
   *       on BOTH leg-absent AND params-absent).
   *   (2) On a transient consume/announce failure, reverseConsumeAndAnnounce un-marks
   *       the id in `reverseConsumedIds` (so a FUTURE onLocalClientProducer retries)
   *       but `drainReverse` does NOT re-queue the failed item into `reversePending`
   *       (line 1307 empties the queue up-front). This is ASYMMETRIC to the primary's
   *       `drainReverseMints`, which re-queues a transient-failed mint. Net: a queued
   *       reverse producer that fails its single drain attempt is recovered only if
   *       the local client produces it again — acceptable under single-room demo
   *       scope where each producer is driven repeatedly by the live media path.
   */
  async onLocalClientProducer(
    roomId: string,
    _router: msTypes.Router,
    producer: Pick<msTypes.Producer, 'id' | 'kind'>,
    producerPeerId?: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<void> {
    const key = meshKey(roomId, peerRelayId);
    const transport = this.states.get(key)?.topology.pipeTransport ?? null;
    if (transport === null) {
      // Not connected yet — QUEUE; drainReverse re-drives on connect (no double-pipe).
      const q = this.reversePending.get(key) ?? [];
      q.push({ producer, producerPeerId });
      this.reversePending.set(key, q);
      return;
    }
    await this.reverseConsumeAndAnnounce(roomId, key, peerRelayId, transport, producer, producerPeerId);
  }

  /**
   * Consume one local producer onto the (connected) reverse pipe transport and
   * announce the piped consumer UP. Dedup per (room,peer): a producerId already
   * consumed onto this leg is skipped (no double-consume). Marks BEFORE the consume
   * so a re-entrant drive cannot double-consume the same id.
   *
   * Error discipline MIRRORS the forward path's Fix 1 (forwardLocalProducers): the
   * consume + announce are wrapped so a TRANSIENT failure (a) un-marks the id (a later
   * re-drive self-heals/retries) and (b) is SWALLOWED — it never propagates out of
   * drainReverse (so one bad queued item does not discard the rest of the drained
   * queue) nor out of onPrimaryConnectParams after transport.connect() already
   * succeeded. A benign duplicate (defensive belt — consume(), unlike the forward
   * produce(), does NOT throw on duplicate, so the `seen` Set is the real dedup) keeps
   * the id marked.
   */
  private async reverseConsumeAndAnnounce(
    roomId: string,
    key: string,
    peerRelayId: string,
    transport: msTypes.PipeTransport,
    producer: Pick<msTypes.Producer, 'id' | 'kind'>,
    producerPeerId?: string,
  ): Promise<void> {
    let seen = this.reverseConsumedIds.get(key);
    if (!seen) {
      seen = new Set<string>();
      this.reverseConsumedIds.set(key, seen);
    }
    if (seen.has(producer.id)) {
      return;
    }
    // Mark BEFORE the await — the re-entrancy guard against two concurrent calls for
    // the SAME id. Un-marked below on a transient failure so a re-drive retries.
    seen.add(producer.id);
    let pipedConsumer: msTypes.Consumer;
    try {
      // REQ-RMS-026 — the announce carries the pipe CONSUMER's rtpParameters (the
      // REMAPPED SSRC across the pipe), NOT the source producer's.
      pipedConsumer = await pipeProducerOntoPrimaryTransport(transport, producer.id);
      this.reverseAnnouncer?.(
        roomId,
        { id: pipedConsumer.id, kind: pipedConsumer.kind },
        producerPeerId,
        peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId,
        pipedConsumer.rtpParameters,
      );
    } catch (err) {
      // Mirror forward Fix 1 — discriminate a benign duplicate (keep marked; a
      // defensive belt since consume() does not throw on duplicate) from a TRANSIENT
      // failure (worker hiccup / consume racing a rebuilt pipe's connect).
      const message = String((err as Error)?.message ?? err);
      const dup = /already exists|duplicate/i.test(message);
      if (dup) {
        // Keep marked + skip so we never re-consume a known id.
        this.logger?.debug(
          { roomId, producerId: producer.id, error: message },
          'REQ-RMS-034: reverse consume-onto-pipe skipped — producer id already consumed (idempotent)',
        );
      } else {
        // Un-mark so the next onLocalClientProducer / drainReverse self-heals
        // (retries). A real fault → warn, not debug. SWALLOW (do NOT rethrow): one
        // bad item must not discard the rest of a drained queue nor escape
        // onPrimaryConnectParams after connect() already succeeded.
        seen.delete(producer.id);
        this.logger?.warn(
          { roomId, producerId: producer.id, error: message },
          'REQ-RMS-034: reverse consume-onto-pipe failed — leaving id unmarked to retry on the next drive',
        );
      }
      return;
    }
    // Log AFTER a successful announce (A1 lesson — keep log fidelity; never before).
    // Records the source producer id → piped consumer id (mirror the forward info shape).
    this.logger?.info(
      {
        roomId,
        producerId: producer.id,
        pipedConsumerId: pipedConsumer.id,
        kind: pipedConsumer.kind,
        peerRelayId,
      },
      'REQ-RMS-034: standby consumed a LOCAL producer onto the reverse pipe + announced UP (reverse hop)',
    );
  }

  /**
   * REQ-RMS-037 — drain producers queued before the reverse pipe was connected.
   * Called by onPrimaryConnectParams AFTER transport.connect() succeeds. No-op when
   * the leg has no bound transport yet (defensive).
   */
  async drainReverse(roomId: string, peerRelayId: string = DEFAULT_PEER_RELAY_ID): Promise<void> {
    const key = meshKey(roomId, peerRelayId);
    const transport = this.states.get(key)?.topology.pipeTransport ?? null;
    if (transport === null) {
      return;
    }
    const pend = this.reversePending.get(key) ?? [];
    this.reversePending.set(key, []);
    for (const p of pend) {
      await this.reverseConsumeAndAnnounce(roomId, key, peerRelayId, transport, p.producer, p.producerPeerId);
    }
  }

  /**
   * TEST SEAM — bind a pipe transport for a (room,peer) leg, mirroring how
   * ensure()/onPrimaryConnectParams retain it on topology.pipeTransport. Lets the
   * direct-class unit exercise onLocalClientProducer/drainReverse without a real
   * Worker (the same test-only role as the currentPipeTransport accessor). A second
   * bind on the same leg REPLACES the transport (the dedup is cleared separately via
   * onPipeTransportReplacedForTest).
   */
  bindPipeTransportForTest(
    roomId: string,
    peerRelayId: string,
    transport: msTypes.PipeTransport,
  ): void {
    const key = meshKey(roomId, peerRelayId);
    const existing = this.states.get(key);
    if (existing) {
      existing.topology.pipeTransport = transport;
      return;
    }
    this.states.set(key, {
      topology: {
        roomId,
        role: 'standby',
        primaryEndpoint: '',
        standbyEndpoint: '',
        pipePort: 0,
        pipeConsumer: null,
        pipeTransport: transport,
      },
      router: null as unknown as msTypes.Router,
      pipePort: 0,
      consumedProducerId: '',
      pending: false,
    });
  }

  /**
   * TEST SEAM — simulate the leg's pipe transport being replaced: clear the reverse
   * consume-dedup so a fresh pipe re-consumes (mirrors the clear() teardown clear).
   */
  onPipeTransportReplacedForTest(roomId: string, peerRelayId: string): void {
    this.reverseConsumedIds.delete(meshKey(roomId, peerRelayId));
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
    enableSrtp: pipeSrtpEnabled(),
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
   *
   * Arg order ALIGNS with createInterRelayAnnouncer's closure
   * `(roomId, producer, producerPeerId?, peerRelayId?, rtpParameters?)`:
   *   - producerPeerId (REQ-RMS-029): the ORIGINAL publishing peer. The drain
   *     threads it on the CASCADE/mesh path so a cross-relay consume binds the
   *     stream/E2EE-key to the real publisher (not the cascade relayId). Left
   *     undefined on the DEFAULT/legacy single-standby leg → that frame stays
   *     byte-stable.
   *   - peerRelayId (REQ-RMS-008): the cascade peer; DEFAULT-gated in drain.
   *   - rtpParameters (REQ-RMS-026): the piped consumer's RtpParameters.
   */
  announcer: (
    roomId: string,
    producer: Pick<msTypes.Producer, 'id' | 'kind'>,
    producerPeerId?: string,
    peerRelayId?: string,
    rtpParameters?: msTypes.RtpParameters,
  ) => void;
  /**
   * Per-(room,peer,role) port allocator. Keyed `${roomId}:primary` for the legacy
   * single-peer primary leg, widening to `${roomId}:${peerRelayId}:primary` for a
   * cascade peer (REQ-RMS-008, via primaryPortKey).
   */
  portAllocator: PipePortAllocatorLike;
  /**
   * Sends the primary's OWN pipe-connect params DOWN to the standby (the reply
   * leg of the §2 handshake). Backed by the interRelaySender in the wiring layer.
   *
   * REQ-RMS-028 (L1.3-b) — gained a trailing OPTIONAL `peerRelayId` so a cascade
   * leg's reply routes to the RIGHT per-peer socket (the wiring layer's sendToPeer
   * resolves it). Defaults to undefined → the DEFAULT single-standby reply path is
   * byte-stable (resolves to the legacy interRelayLink.socket).
   */
  paramSender: (roomId: string, params: PipeConnectParams, peerRelayId?: string) => void;
  /**
   * REQ-RMS-037 (Task B4a) — fires once per reverse mint DRAINED by
   * drainReverseMints (the A6 double-race tail: a reverse announce that arrived
   * while BOTH the leg transport AND the standby params were absent → queued via
   * reverseMint → the immediate `if (minted) registerReverseMinted(...)` path
   * never ran). Wired in the daemon to registerReverseMinted so a queued-then-
   * drained hub producer is STILL fanned to local clients + hub-fanned DOWN,
   * threading the ORIGINAL publisher's producerPeerId carried on the queue entry.
   * OPTIONAL → the immediate (non-queued) reverse path + every existing
   * construction stay byte-stable (this fires only on the drain leg).
   */
  onReverseMinted?: (
    roomId: string,
    minted: msTypes.Producer,
    originRelayId: string,
    producerPeerId?: string,
  ) => void;
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
   * the announce + pipe need (id, kind) so a plain mock is a valid pending entry,
   * PLUS the optional ORIGINAL publisher peerId (REQ-RMS-029). It is PER-ENTRY
   * (not per-state): a multi-user room queues several producers from DIFFERENT
   * publishers on one (room,peer) state, so each pending entry carries its own id.
   */
  pendingProducers: Array<Pick<msTypes.Producer, 'id' | 'kind'> & { producerPeerId?: string }>;
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
  // REQ-RMS-037 — reverse announces queued until the leg transport is connected.
  // B4a: the entry carries the ORIGINAL publisher's producerPeerId so a
  // queued-then-drained mint can be fanned bound to the real publisher (the A6
  // double-race tail) — undefined on the legacy/default path.
  private readonly reverseMintPending = new Map<
    string,
    Array<{
      producerId: string;
      kind: msTypes.MediaKind;
      rtpParameters: msTypes.RtpParameters;
      producerPeerId?: string;
    }>
  >();
  // REQ-RMS-034 — per-leg dedup of reverse-minted producer ids (mint exactly once).
  private readonly reverseMintedIds = new Map<string, Set<string>>();
  // B6b (REQ-RMS-035) — per-leg dedup of FORWARD-piped producer ids (pipe exactly
  // once). onProducer re-queues a producer on every call, so a standby link flap /
  // re-attach re-queues an already-piped id; without this, drain() re-pipes it and
  // mediasoup throws "Consumer already exists". Mirror of reverseMintedIds; cleared
  // with the leg in clear() (the leg's pipe transport is minted ONCE in onProducer
  // and torn down only there, so clear() is the sole forward-transport teardown).
  private readonly forwardPipedIds = new Map<string, Set<string>>();

  constructor(private readonly deps: PrimaryPipeCoordinatorDeps) {}

  private getState(roomId: string, peerRelayId: string): PrimaryPipeState {
    const key = meshKey(roomId, peerRelayId);
    let s = this.states.get(key);
    if (!s) {
      s = {
        pipeTransport: null,
        connected: false,
        pendingProducers: [],
        standbyParams: null,
        pipePort: null,
      };
      this.states.set(key, s);
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
  async onStandbyConnectParams(
    roomId: string,
    params: PipeConnectParams,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<void> {
    const s = this.getState(roomId, peerRelayId);
    s.standbyParams = params;
    if (s.pipePort === null) {
      s.pipePort = this.deps.portAllocator.allocate(primaryPortKey(roomId, peerRelayId));
    }
    this.deps.logger?.debug(
      { roomId, standbyPort: params.port, primaryPort: s.pipePort },
      'F1: primary coordinator received standby pipe-connect params',
    );
    // If a producer is queued AND we have already minted+connected (params is a
    // re-send), drain now. The common params-first order mints on onProducer.
    if (s.connected && s.pipeTransport !== null && s.pendingProducers.length > 0) {
      await this.drain(roomId, s, peerRelayId);
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
    // NB: arg order here is (peerRelayId, producerPeerId) — the OPPOSITE of
    // deps.announcer's (producerPeerId, peerRelayId). drain() bridges the two.
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
    producerPeerId?: string,
  ): Promise<void> {
    const s = this.getState(roomId, peerRelayId);
    // REQ-RMS-029: queue a SELF-CONTAINED entry carrying the ORIGINAL publisher
    // peerId so the drain can thread it into the cascade announce (undefined on
    // the DEFAULT/legacy leg → byte-stable frame). Per-entry, not per-state.
    s.pendingProducers.push({ id: producer.id, kind: producer.kind, producerPeerId });

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
        s.pipePort = this.deps.portAllocator.allocate(primaryPortKey(roomId, peerRelayId));
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
      // B1-SRTP: when PIPE_SRTP=1 the primary's PipeTransport carries SRTP params
      // (the TOP-LEVEL `transport.srtpParameters` getter — NOT `transport.tuple.
      // srtpParameters`, which is undefined). Guarded `!== undefined` spread so a
      // flag-OFF reply omits the field and stays byte-identical to today.
      const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
      // REQ-RMS-028 (L1.3-b): thread `peerRelayId` so the DOWN reply routes to the
      // RIGHT cascade leg's socket (DEFAULT peer → undefined → legacy single link).
      this.deps.paramSender(
        roomId,
        {
          ip: announcedIp,
          port: transport.tuple.localPort,
          ...(transport.srtpParameters !== undefined
            ? { srtpParameters: transport.srtpParameters }
            : {}),
        },
        peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId,
      );
      this.deps.logger?.info(
        { roomId, primaryPort: transport.tuple.localPort, standbyPort: s.standbyParams.port },
        'F1: primary pipe transport minted + connected to standby',
      );
    }

    await this.drain(roomId, s, peerRelayId);
  }

  /**
   * Pipe every queued producer onto the connected transport and announce its
   * PIPED consumer id (REQ-RO-002). Safe to call repeatedly — it shifts the
   * queue, so an already-piped producer is never re-piped. The `peerRelayId` is
   * threaded into the announce so a cascade frame carries it (the builder OMITS
   * it on the DEFAULT peer → the emitted frame stays a legacy frame).
   */
  private async drain(
    roomId: string,
    s: PrimaryPipeState,
    peerRelayId: string,
  ): Promise<void> {
    if (!s.connected || s.pipeTransport === null) return;
    const key = meshKey(roomId, peerRelayId);
    let piped = this.forwardPipedIds.get(key);
    if (!piped) {
      piped = new Set();
      this.forwardPipedIds.set(key, piped);
    }
    while (s.pendingProducers.length > 0) {
      const producer = s.pendingProducers.shift()!;
      // B6b (REQ-RMS-035) — pipe each source producer onto this leg EXACTLY ONCE.
      // onProducer re-queues unconditionally, so a standby link flap/re-attach
      // re-queues an already-piped id; re-piping would make mediasoup throw
      // "Consumer already exists". Mark BEFORE the await (re-entrancy guard) and
      // mirror mintOne's dup-vs-transient discrimination.
      if (piped.has(producer.id)) continue;
      piped.add(producer.id);
      let pipedConsumer: msTypes.Consumer;
      try {
        pipedConsumer = await pipeProducerOntoPrimaryTransport(
          s.pipeTransport,
          producer.id,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already exists|duplicate/i.test(message)) continue; // benign dup -> keep marked, skip
        piped.delete(producer.id); // transient -> un-mark so a later re-drive retries
        throw err;
      }
      // Announce the PIPED id (pipedConsumer.id), NOT producer.id (REQ-RO-002).
      // REQ-RMS-029: the ORIGINAL publisher's producerPeerId travels WITH the
      // piped consumer id so a cross-relay consume binds to the real publisher
      // (undefined on the DEFAULT/legacy leg → byte-stable frame).
      // Pass peerRelayId only for a cascade peer; DEFAULT → omitted (legacy frame).
      // REQ-RMS-026: also pass the piped consumer's rtpParameters so the standby
      // can call transport.produce() with the SSRC-remapped codec parameters.
      this.deps.announcer(
        roomId,
        { id: pipedConsumer.id, kind: pipedConsumer.kind },
        producer.producerPeerId,
        peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId,
        pipedConsumer.rtpParameters,
      );
      this.deps.logger?.info(
        { roomId, sourceProducerId: producer.id, pipedConsumerId: pipedConsumer.id },
        'F1: piped producer onto primary pipe + announced PIPED consumer id',
      );
    }
  }

  // ── Part-3 REVERSE leg (REQ-RMS-034/037) ──────────────────────────────────
  // A standby-homed client's media flows UP the warm pipe to the PRIMARY, which
  // mints a LOCAL hub copy from the announced reverse-pipe consumer (then fans
  // it). The dual of the forward onProducer/drain: mint LOCALLY (no announce),
  // with an announce-before-leg-connected QUEUE (REQ-RMS-037 ordering) + per-leg
  // dedup (REQ-RMS-034 mint exactly once). onReverseAnnounce (A4) calls this.

  /**
   * Mint a LOCAL hub producer on the primary from the announced reverse-pipe
   * consumer. Returns the minted producer, or null if QUEUED (the leg transport
   * is not connected yet) or if it was a no-op dedup. A queued announce is minted
   * later by drainReverseMints when the leg connects (REQ-RMS-037 ordering).
   */
  async reverseMint(
    roomId: string,
    _router: msTypes.Router,
    announced: {
      producerId: string;
      kind: msTypes.MediaKind;
      rtpParameters: msTypes.RtpParameters;
      producerPeerId?: string;
    },
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<msTypes.Producer | null> {
    const key = meshKey(roomId, peerRelayId);
    const transport = this.states.get(key)?.pipeTransport ?? null;
    if (!transport) {
      const q = this.reverseMintPending.get(key) ?? [];
      q.push(announced);
      this.reverseMintPending.set(key, q);
      this.deps.logger?.debug(
        { roomId, peerRelayId, producerId: announced.producerId },
        'R3: reverse announce queued -- awaiting leg transport connect',
      );
      return null;
    }
    return this.mintOne(key, transport, announced);
  }

  /**
   * The shared mint+dedup primitive. Mints EXACTLY ONCE per producerId on this
   * leg (REQ-RMS-034). A benign idempotent dup from mediasoup ("already exists")
   * is swallowed -> null (mirror forward Fix-1). A TRANSIENT produce failure
   * UN-MARKS the id so a later announce can retry (mirror A2 reverse-consume
   * self-heal at inter-relay.ts:1253-1257) then rethrows.
   */
  private async mintOne(
    key: string,
    transport: msTypes.PipeTransport,
    announced: {
      producerId: string;
      kind: msTypes.MediaKind;
      rtpParameters: msTypes.RtpParameters;
      producerPeerId?: string;
    },
  ): Promise<msTypes.Producer | null> {
    let seen = this.reverseMintedIds.get(key);
    if (!seen) {
      seen = new Set();
      this.reverseMintedIds.set(key, seen);
    }
    if (seen.has(announced.producerId)) return null;
    seen.add(announced.producerId);
    try {
      return await produceLocalFromPipe(transport, announced);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already exists|duplicate/i.test(message)) return null; // benign idempotent dup
      seen.delete(announced.producerId); // transient -> allow retry
      throw err;
    }
  }

  /**
   * Drain every queued reverse announce onto the (now-connected) leg transport,
   * minting a local hub producer for each (REQ-RMS-037). Called on leg connect.
   * No-op if the leg transport is still absent. Returns the minted producers.
   *
   * RESILIENT (C1; mirrors A2's "one bad queued item must not discard the rest"
   * lesson at the reverse-consume drain): we snapshot+clear the pending queue,
   * then mint each item INDEPENDENTLY. A transient mintOne throw on item k must
   * NOT abort the loop and lose items k+1..n (they were already cleared from the
   * pending map) -> instead we log, RE-QUEUE the failed item onto the LIVE
   * pending map (safe: we iterate the separate `pend` snapshot), and CONTINUE.
   * mintOne already un-marked the id on a transient throw (seen.delete), so the
   * re-queued retry re-mints; a benign dup still returns null (no double-mint).
   */
  async drainReverseMints(
    roomId: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<msTypes.Producer[]> {
    const key = meshKey(roomId, peerRelayId);
    const transport = this.states.get(key)?.pipeTransport ?? null;
    if (!transport) return [];
    const pend = this.reverseMintPending.get(key) ?? [];
    this.reverseMintPending.set(key, []);
    const out: msTypes.Producer[] = [];
    for (const a of pend) {
      try {
        const p = await this.mintOne(key, transport, a);
        if (p) {
          out.push(p);
          // B4a (REQ-RMS-037) — fan the queued-then-drained mint (the A6 double-
          // race tail: it bypassed the handler's immediate registerReverseMinted
          // because reverseMint returned null when queued). Thread the entry's
          // ORIGINAL producerPeerId so the fan binds to the real publisher. Fires
          // exactly once per successful mint (inside `if (p)`); dedup'd upstream
          // by mintOne's reverseMintedIds set so a benign dup never re-fans.
          this.deps.onReverseMinted?.(roomId, p, peerRelayId, a.producerPeerId);
        }
      } catch (err) {
        this.deps.logger?.warn(
          {
            roomId,
            peerRelayId,
            producerId: a.producerId,
            error: err instanceof Error ? err.message : String(err),
          },
          'R3: reverse mint failed mid-drain - continuing, re-queued for retry',
        );
        const live = this.reverseMintPending.get(key) ?? [];
        live.push(a);
        this.reverseMintPending.set(key, live);
      }
    }
    return out;
  }

  /**
   * Ensure the primary's reverse-leg pipe transport exists by MIRRORING the FULL
   * onProducer handshake -- mint + connect + the §2 paramSender DOWN-reply that
   * carries the primary's OWN bound port (I1: the reply is PART of the handshake;
   * onProducer is the only other paramSender call site, so without it here the
   * standby never learns the primary's port -> half-open pipe -> no reverse
   * media, and a later onProducer sees pipeTransport != null and SKIPS its own
   * reply). Then drains any queued reverse announces. If the standby params are
   * not yet present we CANNOT connect -> log + return; a later
   * onStandbyConnectParams completes the pair.
   *
   * The create-leg branch calls REAL mediasoup (createPrimaryPipeTransport) so it
   * is NOT unit-tested here -- A5's hermetic integration test MUST cover the
   * reverse-announce-arrives-BEFORE-any-forward-producer path (ensureReverseLeg's
   * reason to exist). The already-bound drain-only branch is unit-covered
   * (RED-RA-3b-order / -resilient).
   */
  async ensureReverseLeg(
    roomId: string,
    router: msTypes.Router,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
  ): Promise<void> {
    const s = this.getState(roomId, peerRelayId);
    if (s.pipeTransport === null) {
      if (s.standbyParams === null) {
        this.deps.logger?.debug(
          { roomId, peerRelayId },
          'R3: ensureReverseLeg deferred -- standby pipe-connect params not yet present',
        );
        return;
      }
      if (s.pipePort === null) {
        s.pipePort = this.deps.portAllocator.allocate(primaryPortKey(roomId, peerRelayId));
      }
      // A5 MUST cover this real-mediasoup mint+connect+reply path for the
      // reverse-announce-before-any-forward-producer case (not unit-tested).
      const transport = await createPrimaryPipeTransport(router, s.pipePort);
      s.pipeTransport = transport;
      await transport.connect({
        ip: s.standbyParams.ip,
        port: s.standbyParams.port,
        srtpParameters: s.standbyParams.srtpParameters,
      } as Parameters<msTypes.PipeTransport['connect']>[0]);
      s.connected = true;
      // §2 handshake DOWN-reply with the primary's OWN bound port (byte-mirrors
      // onProducer): without it the standby can't complete the pipe. SRTP field
      // is guard-spread so a flag-OFF reply stays byte-identical; peerRelayId is
      // DEFAULT-gated so the legacy single-standby reply routes to the legacy link.
      const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
      this.deps.paramSender(
        roomId,
        {
          ip: announcedIp,
          port: transport.tuple.localPort,
          ...(transport.srtpParameters !== undefined
            ? { srtpParameters: transport.srtpParameters }
            : {}),
        },
        peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId,
      );
      this.deps.logger?.info(
        { roomId, peerRelayId, primaryPort: transport.tuple.localPort },
        'R3: reverse-leg pipe transport minted + connected to standby + replied DOWN',
      );
    }
    // RC-A (REQ-RMS-035) — this leg uses ONE bidirectional pipeTransport for BOTH
    // forward (primary→standby) and reverse (standby→primary). The forward queue
    // (s.pendingProducers) is flushed by drain(), which is called from onProducer
    // (only if standbyParams were present at produce time) and onStandbyConnectParams
    // (only if already connected). When the leg is instead brought up HERE by the
    // REVERSE path — a reverse announce mints+connects the transport — there is NO
    // later forward onProducer to flush the queue, so the LAST standby to bring up
    // its leg via the reverse path had its forward pendingProducers orphaned (live
    // proof: relay-3's leg minted via ensureReverseLeg but ZERO subsequent forward
    // pipes → it never received the primary's producers). Drain the forward queue
    // too. drain() self-guards (!s.connected || s.pipeTransport === null → return)
    // and is idempotent (forwardPipedIds Set dedup), so it is safe whether or not
    // the transport was just minted, and a no-op when nothing is queued.
    await this.drain(roomId, s, peerRelayId);
    await this.drainReverseMints(roomId, peerRelayId);
  }

  /**
   * Test seam (thin; mirrors the file's existing `*ForTest` seams): bind a leg
   * PipeTransport directly so reverseMint/drainReverseMints can be unit-tested
   * WITHOUT minting real mediasoup transports (that path is A5 integration).
   */
  bindLegTransportForTest(roomId: string, peerRelayId: string, transport: msTypes.PipeTransport): void {
    this.getState(roomId, peerRelayId).pipeTransport = transport;
  }

  /**
   * Drops a (room, peer)'s state, closes the transport, releases the port
   * (REQ-RO-009). `peerRelayId` defaults to DEFAULT_PEER_RELAY_ID so the legacy
   * single-peer caller (index.ts releaseRoom) releases `${roomId}:primary`.
   */
  clear(roomId: string, peerRelayId: string = DEFAULT_PEER_RELAY_ID): void {
    const key = meshKey(roomId, peerRelayId);
    // REQ-RMS-034/037 (M1) — drop the reverse-leg maps UNCONDITIONALLY, BEFORE the
    // `!s` early-return below. reverseMint QUEUES via `states.get` (NOT getState),
    // so an announce that arrived before the leg ever connected sets
    // reverseMintPending yet leaves NO states entry -> if these deletes sat after
    // `if (!s) return` a queued-but-never-connected item would survive teardown and
    // wrongly mint on a later drain. Drop both so a post-teardown re-announce mints
    // afresh (the dedup set + the pending queue are per-leg state).
    this.reverseMintPending.delete(key);
    this.reverseMintedIds.delete(key);
    // B6b (REQ-RMS-035) — drop the forward-pipe dedup with the leg so a reused leg
    // re-pipes its producers onto the fresh transport.
    this.forwardPipedIds.delete(key);
    const s = this.states.get(key);
    if (!s) return;
    if (s.pipeTransport !== null) {
      try {
        s.pipeTransport.close();
      } catch {
        // Best-effort close — must not block teardown.
      }
    }
    if (s.pipePort !== null) {
      this.deps.portAllocator.release(primaryPortKey(roomId, peerRelayId));
    }
    this.states.delete(key);
  }

  /**
   * B6b (REQ-RMS-036) — room-wide teardown. `clear(roomId)` drops only the DEFAULT
   * leg; this drops EVERY (room, peer) leg across all peerRelayId buckets (states /
   * reverseMintPending / reverseMintedIds), closing each leg's transport + releasing
   * its port via clear(). Mirrors InterRelayProducerRegistry.clearRoom. Collects
   * candidate peers from ALL maps (incl. reverseMintPending) so a queued-but-never-
   * connected leg — a reverse announce that arrived before the leg ever connected — is
   * dropped too (else it would wrongly mint on a later drain).
   */
  clearRoom(roomId: string): void {
    for (const peerRelayId of roomPeerRelayIds(roomId, [
      this.states,
      this.reverseMintPending,
      this.reverseMintedIds,
      this.forwardPipedIds,
    ])) {
      this.clear(roomId, peerRelayId);
    }
  }
}
