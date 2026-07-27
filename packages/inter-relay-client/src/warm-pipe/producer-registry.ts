/**
 * Standby-side producer registry — records producers the primary announces,
 * and the inbound inter-relay link frame handler that feeds it.
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import {
  meshKey,
  DEFAULT_PEER_RELAY_ID,
  type PipeProducerAnnounce,
  isPipeProducerAnnounce,
  isPipeConnectFrame,
  type PipeConnectParams,
} from './pipe-protocol.js';

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
  /**
   * REQ-RMS-046 (cascade-tree, B4) — the IMMUTABLE origin producerId threaded unchanged
   * across hops. Copied off the inbound announce so the forward drain can dedup PER-ROOM
   * on it (the local producerId now differs per hop under RMS_TREE_ACTIVE, so the per-hop
   * id is NOT a stable dedup key across two parent edges). Undefined on a pre-tree frame.
   */
  originProducerId?: string;
  /** REQ-RMS-044 (cascade-tree) — loop-guard hop budget carried from the announce (additive). */
  hopTtl?: number;
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
      // B4 — carry the immutable origin id + hop budget to the drain so it can dedup
      // PER-ROOM on originProducerId (the per-hop local id now differs under
      // RMS_TREE_ACTIVE). Optional → a pre-tree frame records them undefined (byte-stable).
      ...(announce.originProducerId !== undefined
        ? { originProducerId: announce.originProducerId }
        : {}),
      ...(announce.hopTtl !== undefined ? { hopTtl: announce.hopTtl } : {}),
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

