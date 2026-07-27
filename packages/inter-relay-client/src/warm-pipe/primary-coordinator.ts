/**
 * Primary-side pipe half (Phase 5.3 spike — the missing production half) and
 * the primary warm-pipe coordinator (F1 — REQ-RO-001/002/008), including its
 * reverse (standby → primary) leg (REQ-RMS-034/037).
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import { pipeSrtpEnabled, produceLocalFromPipe } from '../relay-role-manager.js';
import {
  meshKey,
  primaryPortKey,
  roomPeerRelayIds,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
} from './pipe-protocol.js';

// ── Primary-side pipe half (Phase 5.3 spike — the missing production half) ──

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
    // T-B (REQ-RMS-044/046) — additive trailing loop-guard budget + immutable origin threaded
    // from onProducer's pending entry into the DOWN announce. Undefined on the shipped forward
    // path → buildPipeProducerAnnounce omits both → byte-stable frame.
    hopTtl?: number,
    originProducerId?: string,
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
    // T-B (REQ-RMS-043/044/046, T7 I-1) — the IMMUTABLE origin + inbound loop-guard budget carried on
    // the queued reverse announce, threaded through the DRAIN so the tree hub-fan re-forwards on the
    // origin (NOT the fresh per-hop mint) with the real budget (NOT a reseeded full diameter). Both
    // OPTIONAL → the immediate path + shipped star drain stay byte-stable (fired 4-arg when absent).
    originProducerId?: string,
    hopTtl?: number,
  ) => void;
  /**
   * T6 (REQ-RMS-046, cascade-tree) — when true, the reverse hub mint uses a FRESH local id
   * per hop (produceLocalFromPipe freshId) so a producer that crosses two internal nodes on
   * the UP leg never collides. OPTIONAL → undefined/false keeps the shipped same-id reverse
   * mint (byte-stable). Per-leg reverseMintedIds dedup (on the announced producerId, which
   * is the stable key on the reverse path) is unchanged. index.ts passes RMS_TREE_ACTIVE.
   */
  treeActive?: boolean;
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
  pendingProducers: Array<
    Pick<msTypes.Producer, 'id' | 'kind'> & {
      producerPeerId?: string;
      // T-B (REQ-RMS-044/046) — the loop-guard budget + immutable origin carried per pending
      // producer so drain() threads them into the DOWN announce. Optional → the shipped forward
      // path queues them undefined (byte-stable frame).
      hopTtl?: number;
      originProducerId?: string;
    }
  >;
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
      // T-B (REQ-RMS-043/044/046, T7 I-1) — the IMMUTABLE origin + inbound hop budget carried on the
      // queued announce (same inbound-announce source the immediate reverse path reads), so a queued-
      // then-drained mint threads them into onReverseMinted → registerReverseMinted. Undefined on the
      // shipped star / pre-tree path → the drain fires onReverseMinted 4-arg (byte-stable).
      originProducerId?: string;
      hopTtl?: number;
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
   * Stashes them + reserves the per-room port. `router` is OPTIONAL and additive:
   * the production wiring threads the room router (via signalingRef.getRoom(roomId)
   * .router) so the WAN PRODUCER-FIRST order can mint the pipe HERE; callers that
   * omit it (the legacy single-host tests + pre-mesh call sites) keep the original
   * record-only behavior byte-for-byte.
   *
   * WAN PRODUCER-FIRST (the live deadlock): when the ALL-LOCAL producer arrives
   * FIRST it is queued with standbyParams===null, so onProducer's mint block is
   * skipped. Historically onStandbyConnectParams had NO router and only drained if
   * ALREADY connected → neither handler ever minted → the producer stayed queued
   * forever (pipe_bytes 0, "no producer within 30000ms"). Now, when the params
   * arrive WITH a router AND a producer is already queued AND the pipe isn't built
   * yet, we mint+connect+reply-DOWN via ensurePrimaryPipe and drain the queue — the
   * symmetric dual of ensureReverseLeg's forward drain.
   */
  async onStandbyConnectParams(
    roomId: string,
    params: PipeConnectParams,
    peerRelayId: string = DEFAULT_PEER_RELAY_ID,
    // Additive trailing router — the room's mediasoup router, threaded by the
    // production wiring. Undefined → the pre-mesh record-only path (byte-stable).
    router?: msTypes.Router,
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
    // WAN PRODUCER-FIRST: params arrived after a queued producer and the pipe is
    // not built yet. With a router in hand, mint+connect+reply-DOWN here so the
    // queued producer finally drains (the mint block used to live only in
    // onProducer's params-present branch, which the producer-first order skipped).
    if (router !== undefined && s.pipeTransport === null && s.pendingProducers.length > 0) {
      await this.ensurePrimaryPipe(roomId, router, s, peerRelayId);
    }
    // If a producer is queued AND we are now (or already were) minted+connected —
    // params re-send OR the WAN mint just above — drain now. The common params-
    // first order mints+drains on onProducer.
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
    // T-B (REQ-RMS-044/046) — additive trailing loop-guard budget + immutable origin. The tree
    // DOWN-fan (index.ts fanToTreeNeighbors → onPrimaryProducer) threads them so they reach the
    // DOWN announce; queued per-entry so a later drain preserves them. Undefined on the shipped
    // forward path → byte-stable frame.
    hopTtl?: number,
    originProducerId?: string,
  ): Promise<void> {
    const s = this.getState(roomId, peerRelayId);
    // REQ-RMS-029: queue a SELF-CONTAINED entry carrying the ORIGINAL publisher
    // peerId so the drain can thread it into the cascade announce (undefined on
    // the DEFAULT/legacy leg → byte-stable frame). Per-entry, not per-state.
    s.pendingProducers.push({ id: producer.id, kind: producer.kind, producerPeerId, hopTtl, originProducerId });

    if (s.standbyParams === null) {
      // params-not-yet: keep queued; a later onStandbyConnectParams → onProducer
      // re-drive (the standby re-sends on link attach) completes the pair.
      this.deps.logger?.debug(
        { roomId, producerId: producer.id },
        'F1: primary coordinator queued producer — awaiting standby pipe-connect params',
      );
      return;
    }

    // Mint + connect ONCE (REQ-RO-009 idempotent binding). Extracted into
    // ensurePrimaryPipe so onStandbyConnectParams can mint it too on the WAN
    // PRODUCER-FIRST order (see that method).
    await this.ensurePrimaryPipe(roomId, router, s, peerRelayId);

    await this.drain(roomId, s, peerRelayId);
  }

  /**
   * Mint + connect the primary's FORWARD pipe transport ONCE and reply DOWN with
   * the primary's own bound port (the §2 handshake reply) — the shared body both
   * onProducer AND onStandbyConnectParams use. A no-op when the transport is
   * already bound (REQ-RO-009 idempotent binding: createPipeTransport is called at
   * most once per leg). Requires the caller to have already stashed s.standbyParams
   * (both call sites guard that) — it is the standby's connect target.
   *
   * WAN PRODUCER-FIRST (the live deadlock): on a real WAN the producer is all-local
   * on the primary so onProducer fires FIRST with standbyParams===null → the block
   * below is skipped and the producer is queued. The standby's cross-WAN params
   * arrive a few ms later; onStandbyConnectParams — now threaded the room router —
   * calls THIS to mint the pipe so the queued producer finally drains. The mirror
   * of ensureReverseLeg's forward drain, but for the FORWARD mint path.
   */
  private async ensurePrimaryPipe(
    roomId: string,
    router: msTypes.Router,
    s: PrimaryPipeState,
    peerRelayId: string,
  ): Promise<void> {
    if (s.pipeTransport !== null || s.standbyParams === null) return;
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
      // T-B (REQ-RMS-044/046) — carry the loop-guard budget + immutable origin DOWN. Widen the
      // announce to 7-arg ONLY when a tree hop actually set them; the shipped forward path (both
      // undefined) keeps its original 5-arg call so it is byte-identical end-to-end (the frame,
      // AND the coordinator's own announce arity — REQ-RMS-029 assertions hold). The builder omits
      // both anyway, so the ONLY effect of the guard is not perturbing the shipped call shape.
      const scopedPeer = peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId;
      if (producer.hopTtl === undefined && producer.originProducerId === undefined) {
        this.deps.announcer(
          roomId,
          { id: pipedConsumer.id, kind: pipedConsumer.kind },
          producer.producerPeerId,
          scopedPeer,
          pipedConsumer.rtpParameters,
        );
      } else {
        this.deps.announcer(
          roomId,
          { id: pipedConsumer.id, kind: pipedConsumer.kind },
          producer.producerPeerId,
          scopedPeer,
          pipedConsumer.rtpParameters,
          producer.hopTtl,
          producer.originProducerId,
        );
      }
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
      // T-B (REQ-RMS-043/044/046, T7 I-1) — carried onto the reverseMintPending entry so the DRAIN
      // (Path B) preserves them for the tree hub-fan. reverseMint/mintOne never READ them (the mint is
      // origin-agnostic); they only ride the queue. Undefined on the shipped path → byte-stable.
      originProducerId?: string;
      hopTtl?: number;
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
      // T6 — tree mode mints a FRESH local id per hop (freshId); default keeps the
      // shipped same-id reverse mint byte-stable. Dedup above stays on the announced id.
      return await produceLocalFromPipe(transport, announced, { freshId: this.deps.treeActive === true });
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
          // T-B (REQ-RMS-043/044/046, T7 I-1) — ALSO thread the IMMUTABLE origin + inbound hop budget
          // the entry carried, so the tree hub-fan re-forwards on the origin (not the fresh mint id)
          // with the real budget (not a reseeded full diameter). Guard-widen: the shipped star / pre-
          // tree drain (both undefined) keeps the EXACT 4-arg call the coordinator arity test pins.
          if (a.originProducerId === undefined && a.hopTtl === undefined) {
            this.deps.onReverseMinted?.(roomId, p, peerRelayId, a.producerPeerId);
          } else {
            this.deps.onReverseMinted?.(roomId, p, peerRelayId, a.producerPeerId, a.originProducerId, a.hopTtl);
          }
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
