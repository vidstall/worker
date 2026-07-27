/**
 * Warm-pipe wire protocol — subprotocol/token auth, announce contracts
 * (`pipe-producer`, `pipe-connect`), and the internal composite-key helpers
 * shared by the standby/primary coordinators.
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts for the
 * module-level context this split preserves).
 */

import { timingSafeEqual } from 'node:crypto';
import type { types as msTypes } from 'mediasoup';

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
export function meshKey(roomId: string, peerRelayId: string): string {
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
export function primaryPortKey(roomId: string, peerRelayId: string): string {
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
export function roomPeerRelayIds(
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
