/**
 * Standby warm-pipe coordinator — orchestrates the STANDBY's warm pipe so it
 * consumes the PRIMARY's REAL producer (BENCH-2 / G1), including the reverse
 * (standby → primary) leg (REQ-RMS-034/037).
 *
 * The reverse leg's method group lives in standby-coordinator-reverse.ts as
 * free functions taking an explicit deps object; this class keeps thin wrapper
 * methods around them. Standalone types live in standby-coordinator-types.ts.
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import {
  ensureWarmPipe,
  produceLocalFromPipe,
  type RoomTopology,
} from '../relay-role-manager.js';
import {
  meshKey,
  DEFAULT_PEER_RELAY_ID,
  roomPeerRelayIds,
  type PipeConnectParams,
} from './pipe-protocol.js';
import type { InterRelayProducerRegistry } from './producer-registry.js';
import {
  type WarmPipeState,
  placeholderProducerId,
  type ReverseUpAnnouncer,
} from './standby-coordinator-types.js';
import {
  type ReverseLegDeps,
  type ReversePendingEntry,
  type SentReverseAnnounceEntry,
  onLocalClientProducer as onLocalClientProducerImpl,
  drainReverse as drainReverseImpl,
  roomsWithStoredAnnounces as roomsWithStoredAnnouncesImpl,
  resendReverseAnnounces as resendReverseAnnouncesImpl,
} from './standby-coordinator-reverse.js';

// Re-exported so existing `from '.../standby-coordinator.js'` imports (incl.
// warm-pipe/index.ts) keep resolving these unchanged.
export type { ReverseUpAnnouncer } from './standby-coordinator-types.js';

// ── Standby warm-pipe coordinator (BENCH-2 / G1) ────────────────────────

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
   * T6/B4 (REQ-RMS-046) — origins already minted for a room, keyed by roomId →
   * Set<originProducerId>. Per-ROOM (NOT meshKey) so a transient cross-edge double-parent
   * collapses to ONE key: under RMS_TREE_ACTIVE each hop mints a FRESH local id, so the
   * per-hop `producedIds` set (keyed by meshKey) can't stop the same origin arriving on
   * two parent edges from double-producing. Only the immutable originProducerId is stable
   * across edges. Tree-mode ONLY; the flag-off path keeps using producedIds. Cleared with
   * the room in clear().
   */
  private readonly producedOrigins = new Map<string, Set<string>>();

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
  private readonly reversePending = new Map<string, ReversePendingEntry[]>();
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
   * + `reversePending` + `sentReverseAnnounces` for that key, or a re-consume onto the NEW
   * pipe is silently dropped (the id stays marked against the dead transport) AND a later
   * resendReverseAnnounces re-delivers the OLD pipe's now-stale consumer id + rtpParameters
   * (REQ-RMS-037 D3 — the store holds the piped-consumer frame, which the replacement
   * invalidates; drop or re-record that leg's entries in the same swap). Not wired now: that
   * close+replace is NOT on the reverse leg's live path (A2 scope), and `onAnnounce`'s
   * C3 path REUSES the bound transport instead of replacing it.
   */
  private readonly reverseConsumedIds = new Map<string, Set<string>>();

  /**
   * REQ-RMS-037 (D3, static-mesh-hardening) — args of every reverse announce already
   * SENT, keyed roomId -> (peerRelayId + origin/producer id) -> args. The standby link
   * send is fire-and-forget (silent drop while the WS is down, inter-relay-link.ts:172-183),
   * so on link RE-open the wiring layer calls resendReverseAnnounces(roomId): the stored args
   * are re-announced VERBATIM and the primary's reverseMintedIds dedup (mintOne) makes the
   * re-delivery idempotent. NEVER re-consumes the pipe (reverseConsumedIds untouched). Cleared
   * with the leg in clear() (same lifecycle as reverseConsumedIds). RETENTION: an entry for an
   * ENDED producer lingers until its leg/room is cleared (no per-producer close hook here) —
   * bounded by the room lifecycle, and re-delivering a dead id on reopen is a harmless no-op
   * (the primary's reverseMintedIds dedup + mediasoup dropping an unknown producer absorb it).
   */
  private readonly sentReverseAnnounces = new Map<string, Map<string, SentReverseAnnounceEntry>>();

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
      // T-B (REQ-RMS-042/044/046) — the internal-node received-DOWN re-forward. The wiring layer
      // (index.ts) uses these to re-forward the freshly-minted producer DOWN the tree via
      // fanToTreeNeighbors: `originProducerId` is the IMMUTABLE origin (NOT this hop's fresh mint id)
      // and `inboundHopTtl` is the budget carried on the announce this mint was drained from. Both
      // OPTIONAL + trailing → the shipped 4-arg callers (index.ts star path + the arity-pinned
      // inter-relay-warmpipe assertions) stay byte-stable; the fire site guard-widens to 6-arg only
      // when a tree hop actually set them.
      originProducerId?: string,
      inboundHopTtl?: number,
    ) => void,
    private readonly activeForward: boolean = false,
    /**
     * T6 (REQ-RMS-046) — cascade-tree data plane. When true, the forward drain mints a
     * FRESH local id per hop (produceLocalFromPipe freshId) and dedups PER-ROOM on the
     * immutable originProducerId (B4). Default false (mirrors activeForward) → the shipped
     * star path is byte-stable: same-id mint + per-meshKey producedIds dedup. index.ts
     * opts in via RMS_TREE_ACTIVE.
     */
    private readonly treeActive: boolean = false,
    /**
     * Lane-B inter-relay `t_hop_network` sampler (REQ-WLM-08). When provided, starts a
     * `roundTripTime`-based interval poller on each freshly-minted piped producer and wires
     * `stop()` to the producer `'close'` event so it self-cleans. Null/undefined when
     * `BENCH_LATENCY` is unset → zero-cost branch (byte-identical production behaviour).
     *
     * Accepts the raw `fromRelayId` (the `peerRelayId` of the source) and returns a stop fn;
     * the wiring layer (index.ts) closes over the local `toRelay` identity in a thin closure.
     */
    private readonly startPipeProducerSampler?: (
      producer: msTypes.Producer,
      fromRelayId: string,
    ) => () => void,
  ) {}

  /** Builds the explicit deps object the reverse-leg free functions take (never closed over). */
  private reverseDeps(): ReverseLegDeps {
    return {
      states: this.states,
      reverseConsumedIds: this.reverseConsumedIds,
      reversePending: this.reversePending,
      sentReverseAnnounces: this.sentReverseAnnounces,
      reverseAnnouncer: this.reverseAnnouncer,
      logger: this.logger,
    };
  }

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
    // T6/B4 — select the dedup surface by mode. Tree mode dedups PER-ROOM on the
    // immutable originProducerId (a FRESH local id is minted per hop, so the per-hop id
    // is not a stable key across two parent edges — a transient double-parent would
    // otherwise double-produce). The shipped star path dedups per (room,peer) on the
    // producerId with a same-id mint → byte-stable (REQ-RMS-048). Both branches share
    // the SAME mint + error/retry discipline below (only the set + key differ).
    let produced: Set<string>;
    if (this.treeActive) {
      let originsForRoom = this.producedOrigins.get(roomId);
      if (!originsForRoom) {
        originsForRoom = new Set<string>();
        this.producedOrigins.set(roomId, originsForRoom);
      }
      produced = originsForRoom;
    } else {
      const key = meshKey(roomId, peerRelayId);
      let byKey = this.producedIds.get(key);
      if (!byKey) {
        byKey = new Set<string>();
        this.producedIds.set(key, byKey);
      }
      produced = byKey;
    }
    for (const announced of this.registry.resolveAll(roomId, peerRelayId)) {
      if (announced.rtpParameters === undefined) {
        // Legacy primary — no rtpParameters to produce from. Skip (keepalive intact).
        continue;
      }
      // Dedup key: tree mode keys on the IMMUTABLE origin (falls back to the per-hop id
      // when a pre-tree/absent-origin frame arrives → still correct single-hop); the
      // shipped path keys on the producerId (byte-stable, same-id mint below).
      // M1 — the per-room set may therefore hold BOTH origin-ids and (fallback) per-hop
      // ids; both are globally-unique mediasoup uuids, so they never collide across kinds.
      const dedupId = this.treeActive
        ? (announced.originProducerId ?? announced.producerId)
        : announced.producerId;
      if (produced.has(dedupId)) {
        // Already minted on a prior ensure/onAnnounce — no double-produce.
        continue;
      }
      let producer: msTypes.Producer;
      try {
        producer = await produceLocalFromPipe(transport, {
          producerId: announced.producerId,
          kind: announced.kind,
          rtpParameters: announced.rtpParameters,
        }, { freshId: this.treeActive });
      } catch (err) {
        // Fix 1 — discriminate a benign duplicate-id throw (idempotent belt-and-
        // suspenders: a concurrent re-run already minted this id) from a TRANSIENT
        // failure (worker hiccup / produce racing a rebuilt transport's connect).
        const message = String((err as Error)?.message ?? err);
        const dup = /already exists|duplicate/i.test(message);
        if (dup) {
          // Mark + skip so we never retry a known-minted id (dedupId: origin in tree
          // mode, per-hop producerId on the shipped path).
          produced.add(dedupId);
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
      produced.add(dedupId);
      this.logger?.info(
        { roomId, producerId: producer.id, kind: producer.kind, peerRelayId },
        'REQ-RMS-025: standby minted a LOCAL producer from the cross-process pipe (active forward)',
      );
      // Lane-B: start t_hop_network sampler on the freshly-minted piped producer.
      // BENCH_LATENCY unset → startPipeProducerSampler is undefined → no-op.
      if (this.startPipeProducerSampler !== undefined) {
        const stop = this.startPipeProducerSampler(producer, peerRelayId);
        // '@close' is the mediasoup internal close event on Producer (used by signaling.ts).
        producer.on('@close', stop);
      }
      // Fix 4 — a throwing L1.3 callback must NOT abort the loop or skip the
      // remaining producers (this one is already minted + marked).
      // T-B (REQ-RMS-042/044/046) — thread the IMMUTABLE origin + inbound hop budget so the wiring
      // layer can re-forward this freshly-minted producer DOWN the tree. Guard-widen: the shipped
      // star path (no origin/hop on the announce) keeps the EXACT 4-arg call the inter-relay-warmpipe
      // arity assertions pin (byte-stable); a tree hop (either field set) widens to 6-arg.
      try {
        if (announced.originProducerId === undefined && announced.hopTtl === undefined) {
          this.onLocalProducer?.(roomId, producer, announced.producerPeerId, peerRelayId);
        } else {
          this.onLocalProducer?.(
            roomId, producer, announced.producerPeerId, peerRelayId,
            announced.originProducerId, announced.hopTtl,
          );
        }
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
    // T6/B4/I1 — the PER-ROOM origin dedup set (keyed by roomId, NOT meshKey) is NOT
    // dropped here: this is per-LEG teardown, and in a tree a room has multiple live legs.
    // Wiping the room's origin set on a single-leg clear would let a re-drive on a
    // SURVIVING sibling leg re-mint a still-live origin — and under freshId=true there is
    // no "already exists" throw to catch it (silent double-produce, the exact case B4
    // guards). Its lifecycle is room-scoped → dropped in clearRoom() instead. Retaining
    // the set across a single-leg clear costs at most bounded memory (origin ids are
    // globally-unique mediasoup uuids, so a reused roomId gets fresh origins → no
    // false-skip).
    // part-3 reverse leg — the leg's pipe transport is being torn down: drop the
    // reverse consume-dedup + any queued local producers so a later room/leg with
    // the same key re-consumes onto a fresh pipe cleanly.
    this.reverseConsumedIds.delete(key);
    this.reversePending.delete(key);
    // REQ-RMS-037 (D3) — drop this leg's stored reverse announces (same lifecycle as
    // reverseConsumedIds): a later room/leg reusing the key must not resend dead frames.
    // clearRoom's roomPeerRelayIds enumerates this peer via reverseConsumedIds (co-populated
    // in reverseConsumeAndAnnounce), so this per-leg drop is reached room-wide too — the
    // roomId-keyed store canNOT go in roomPeerRelayIds's meshKey source list (wrong key shape).
    const roomStore = this.sentReverseAnnounces.get(roomId);
    if (roomStore) {
      for (const [k, e] of roomStore) if (e.peerRelayId === peerRelayId) roomStore.delete(k);
      if (roomStore.size === 0) this.sentReverseAnnounces.delete(roomId);
    }
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
    // T6/B4/I1 — the origin dedup set is keyed per-ROOM, so its teardown belongs HERE
    // (room-wide close), AFTER every leg is cleared — NOT in the per-leg clear() above,
    // which would drop a still-in-use room's origins when only one sibling leg tears down.
    this.producedOrigins.delete(roomId);
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
  //
  // The method bodies live in standby-coordinator-reverse.ts as free functions
  // taking an explicit ReverseLegDeps object; these are thin wrappers.

  /** REQ-RMS-034 — bind the reverse UP-announcer (wiring layer, index.ts). */
  setReverseAnnouncer(fn: ReverseUpAnnouncer): void {
    this.reverseAnnouncer = fn;
  }

  /**
   * REQ-RMS-034 — a STANDBY-homed local client produced. See
   * standby-coordinator-reverse.ts#onLocalClientProducer for the full contract.
   * `_router` is accepted for signature symmetry with the forward onStandbyProducer
   * hook (A1) but unused — the standby consumes onto its RETAINED
   * topology.pipeTransport, not a fresh router transport.
   */
  async onLocalClientProducer(
    roomId: string,
    _router: msTypes.Router,
    producer: Pick<msTypes.Producer, 'id' | 'kind'>,
    producerPeerId?: string,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
    // T-B (REQ-RMS-044/046) — additive trailing loop-guard budget + immutable origin. The
    // tree UP-fan (index.ts fanToTreeNeighbors → onStandbyProducer) threads them so they reach
    // the reverse announce UP. Undefined on the shipped local-client path → byte-stable frame.
    hopTtl?: number,
    originProducerId?: string,
  ): Promise<void> {
    await onLocalClientProducerImpl(
      roomId, producer, producerPeerId, peerRelayId, hopTtl, originProducerId, this.reverseDeps(),
    );
  }

  /**
   * REQ-RMS-037 — drain producers queued before the reverse pipe was connected.
   * Called by onPrimaryConnectParams AFTER transport.connect() succeeds. No-op when
   * the leg has no bound transport yet (defensive).
   */
  async drainReverse(roomId: string, peerRelayId: string = DEFAULT_PEER_RELAY_ID): Promise<void> {
    await drainReverseImpl(roomId, peerRelayId, this.reverseDeps());
  }

  /** REQ-RMS-037 (D3) — rooms that currently hold stored reverse announces (for reopen resend). */
  roomsWithStoredAnnounces(): string[] {
    return roomsWithStoredAnnouncesImpl(this.sentReverseAnnounces);
  }

  /**
   * REQ-RMS-037 (D3) — re-announce every stored frame for a room after a link RE-open.
   * Pure re-SEND: no pipe re-consume, reverseConsumedIds untouched; the primary's
   * reverseMintedIds dedup makes duplicates a no-op (Task 1 precondition proof).
   */
  resendReverseAnnounces(roomId: string): void {
    resendReverseAnnouncesImpl(roomId, {
      sentReverseAnnounces: this.sentReverseAnnounces,
      reverseAnnouncer: this.reverseAnnouncer,
      logger: this.logger,
    });
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
