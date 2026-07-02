/**
 * Relay role manager — warm-pipe + paused standby consumer.
 *
 * Identifies whether this relay daemon is the primary or standby for a room
 * by reading assigned_relays[] from the RoomAssigned chain event. Primary
 * creates a Router and accepts producers. Standby lazily opens pipeToRouter
 * from primary on the FIRST peer join (C7 mitigation) and creates a pipe
 * Consumer that is immediately paused (RTCP keepalive only, ~80% BW saving).
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 * ADR: ADR-0009 (relay-overlap-redundancy M1)
 */

import type { types as msTypes } from 'mediasoup';

// ── Types ──────────────────────────────────────────────────────────────

export type RelayRole = 'primary' | 'standby';

/** B1-SRTP (WAN-precursor): gate the F1 PipeTransport SRTP wrap. Single source of truth; default OFF. */
export function pipeSrtpEnabled(): boolean {
  return process.env['PIPE_SRTP'] === '1';
}

/**
 * Per-room topology state held by the relay daemon.
 * pipeConsumer is null until the first peer joins (lazy warm-pipe, C7).
 */
export interface RoomTopology {
  roomId: string;
  role: RelayRole;
  /** WebSocket endpoint of the primary relay (used by standby to open the pipe). */
  primaryEndpoint: string;
  /** WebSocket endpoint of this relay. */
  standbyEndpoint: string;
  /** Port allocated from PIPE_PORT_RANGE for the PlainTransport pipe. */
  pipePort: number;
  /**
   * The pipe Consumer on the standby relay.
   * null = lazy pipe not yet opened (pre first-peer-join).
   * non-null = paused Consumer (RTCP keepalive only, REQ-RO-005).
   */
  pipeConsumer: msTypes.Consumer | null;
  /**
   * The PipeTransport created on the standby to receive piped media.
   * null until ensureWarmPipe opens the pipe. RETAINED here so a teardown or a
   * coordinator not-ready re-run can close it — without this handle the
   * transport leaks idle on the router (N2) and a re-run on a fixed pipePort
   * risks EADDRINUSE (N3). G3.1 leak fix.
   */
  pipeTransport: msTypes.PipeTransport | null;
}

export interface PipePortRange {
  min: number;
  max: number;
}

// ── determineRole ──────────────────────────────────────────────────────

/**
 * Identifies the role of this relay for a room from the RoomAssigned event payload.
 *
 * Contract: assigned_relays[0] = primary, [1..N-1] = standby.
 * Reads .length — never hardcodes 2 (future-proof for K>2).
 *
 * Throws if ownRelayId is not found in the list (mis-assigned event — caller
 * should log and skip this room).
 */
export function determineRole(assignedRelays: string[], ownRelayId: string): RelayRole {
  const idx = assignedRelays.indexOf(ownRelayId);
  if (idx === -1) {
    throw new Error(
      `determineRole: ownRelayId "${ownRelayId}" not found in assignedRelays [${assignedRelays.join(', ')}]`,
    );
  }
  return idx === 0 ? 'primary' : 'standby';
}

// ── parsePipePortRange ─────────────────────────────────────────────────

/**
 * Parses the PIPE_PORT_RANGE env var (format: "40000-40100").
 * Returns default {min:40000, max:40100} when envValue is undefined.
 */
export function parsePipePortRange(envValue: string | undefined): PipePortRange {
  const raw = envValue ?? '40000-40100';
  const parts = raw.split('-');
  if (parts.length !== 2) {
    throw new Error(
      `parsePipePortRange: invalid format "${raw}" — expected "min-max" (e.g. "40000-40100")`,
    );
  }
  const min = parseInt(parts[0]!, 10);
  const max = parseInt(parts[1]!, 10);
  if (isNaN(min) || isNaN(max) || min >= max) {
    throw new Error(
      `parsePipePortRange: invalid port values min=${min} max=${max}`,
    );
  }
  return { min, max };
}

// ── createPipePortAllocator (REQ-RO-009) ──────────────────────────────

/**
 * Per-room + per-role PIPE_PORT allocator over [min..max].
 *
 * The warm pipe used a single hardcoded `pipePortRange.min` for every room —
 * so a 2nd room hit EADDRINUSE binding its PipeTransport. This allocator hands
 * each KEY a distinct free port and recycles on release.
 *
 * Keyed per room AND per role (`roomId` for the standby, `${roomId}:primary`
 * for the primary) so a same-host primary+standby never collide (D3).
 *
 * REQ-RMS-007 generalization: the key namespace is an OPAQUE string, so the
 * primary leg generalizes additively to `${roomId}:${peerRelayId}:primary` once
 * a room spills across MULTIPLE peer relays (mesh M2) — each (room, peerRelay)
 * pair then holds its own distinct port slot without colliding. The M1 single-
 * peer callers keep using `${roomId}:primary` unchanged (peerRelayId omitted),
 * so this allocator's contract is byte-stable for the existing warm-pipe path.
 *
 * Idempotent per key — `allocate(key)` twice returns the SAME port and consumes
 * only ONE slot (preserves the N3 not-ready re-run invariant: a coordinator
 * re-run rebinds on the SAME pipePort, never leaking a second).
 *
 * `release(key)` frees the slot (room close / `coordinator.clear`). Releasing an
 * unknown key is a no-op. Throws when the range is exhausted.
 */
export function createPipePortAllocator(range: PipePortRange): {
  allocate(key: string): number;
  release(key: string): void;
  size(): number;
} {
  const assigned = new Map<string, number>();
  const free: number[] = [];
  for (let p = range.min; p <= range.max; p++) {
    free.push(p);
  }

  return {
    allocate(key: string): number {
      // Idempotent per key — N3 re-run rebinds the same port, no second slot.
      const existing = assigned.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const port = free.shift();
      if (port === undefined) {
        throw new Error(
          `createPipePortAllocator: port range [${range.min}-${range.max}] exhausted (${assigned.size} keys assigned)`,
        );
      }
      assigned.set(key, port);
      return port;
    },
    release(key: string): void {
      const port = assigned.get(key);
      if (port === undefined) {
        // Unknown key — no-op (idempotent release; double-release is safe).
        return;
      }
      assigned.delete(key);
      free.push(port);
    },
    size(): number {
      return assigned.size;
    },
  };
}

// ── createStandbyPipeTransport ─────────────────────────────────────────

/**
 * Mint the STANDBY's PipeTransport handle so the F1 live handshake can read
 * tuple.localPort, announce it (pipe-connect), and connect() it to the primary's
 * reply BEFORE consuming. Mirrors createPrimaryPipeTransport (inter-relay.ts)
 * exactly: listenIp 0.0.0.0 + ANNOUNCED_IP announcedIp (default 127.0.0.1 for
 * local/bench), the dedicated pipe port, enableRtx/enableSrtp:false (single-host
 * loopback — cross-host needs enableSrtp:true, a documented STRETCH).
 *
 * Additive — ensureWarmPipe still defaults to creating its OWN transport when no
 * handle is passed (the legacy 4-arg path). The caller that needs the handle
 * mints it here and passes it to ensureWarmPipe's optional 5th param.
 */
export async function createStandbyPipeTransport(
  router: msTypes.Router,
  pipePort: number,
): Promise<msTypes.PipeTransport> {
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
  return router.createPipeTransport({
    listenIp: { ip: '0.0.0.0', announcedIp },
    port: pipePort,
    enableRtx: false,
    enableSrtp: pipeSrtpEnabled(),
  } as Parameters<msTypes.Router['createPipeTransport']>[0]);
}

// ── ensureWarmPipe ─────────────────────────────────────────────────────

/**
 * Lazily establishes pipeToRouter from primary to this standby relay,
 * then creates a pipe Consumer that is immediately paused (RTCP only).
 *
 * REQ-RO-004: called on FIRST peer join (not at room-create time).
 * REQ-RO-005: pipe Consumer created with paused=true semantics via consumer.pause().
 *
 * Idempotent — if topology.pipeConsumer already exists, returns it immediately
 * without opening a second pipe transport (safe to call multiple times).
 *
 * Primary relay: returns null (primary does not pipe to itself).
 *
 * @param topology   - Room topology state (mutated: pipeConsumer set on success).
 * @param router     - The mediasoup Router on the standby relay.
 * @param pipePort   - Local port for the PlainTransport pipe (from PIPE_PORT_RANGE).
 * @param producerId - The real pipe-producer ID, resolved from the inter-relay
 *                     announce (see inter-relay.ts). When OMITTED (no producer
 *                     announced yet) the transport is bound + retained and the
 *                     call DEFERS — returns null without consuming (C1). The
 *                     standby's onAnnounce re-runs with the real id once it arrives.
 * @returns The paused Consumer, or null for primary / deferred (no producerId).
 */
export async function ensureWarmPipe(
  topology: RoomTopology,
  router: msTypes.Router,
  pipePort: number,
  producerId?: string,
  pipeTransport?: msTypes.PipeTransport,
): Promise<msTypes.Consumer | null> {
  // Primary relay does not call pipeToRouter
  if (topology.role === 'primary') {
    return null;
  }

  // Idempotency guard — pipe already established
  if (topology.pipeConsumer !== null) {
    return topology.pipeConsumer;
  }

  // N3 leak fix: a prior not-ready run (the StandbyWarmPipeCoordinator re-run)
  // resets pipeConsumer to null while leaving its PipeTransport bound. Close the
  // stale transport before rebinding so we neither leak it nor hit EADDRINUSE on
  // a fixed pipePort. Only applies to a transport WE created (create-own path);
  // a caller-passed transport (F1 handshake) is owned by the caller, so we never
  // close it here — we only retain it for teardown (N2).
  let transport: msTypes.PipeTransport;
  if (pipeTransport !== undefined) {
    // Caller minted the transport (createStandbyPipeTransport) so it could read
    // tuple.localPort + connect() it before consuming. Consume onto it as-is.
    transport = pipeTransport;
  } else {
    if (topology.pipeTransport !== null) {
      topology.pipeTransport.close();
      topology.pipeTransport = null;
    }
    // Create a PipeTransport on the standby router to receive piped media.
    // listenIp '0.0.0.0' with the dedicated pipe port from PIPE_PORT_RANGE;
    // announcedIp is the deploy-routable address the primary connects back to,
    // externalized via ANNOUNCED_IP (default loopback for local/bench). Mirrors
    // the room-handler.ts WebRTC-transport pattern.
    const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
    transport = await router.createPipeTransport({
      listenIp: { ip: '0.0.0.0', announcedIp },
      port: pipePort,
      enableRtx: false,
      enableSrtp: pipeSrtpEnabled(),
    } as Parameters<msTypes.Router['createPipeTransport']>[0]);
  }

  // N2 leak fix: retain the transport so teardown / a coordinator re-run can
  // close it (an un-retained transport leaks idle on the router until exit).
  topology.pipeTransport = transport;

  // C1 (RMS-live cross-relay DEADLOCK fix) — DEFER when no producer announced yet.
  // The standby's FIRST ensure runs on first-peer-join, BEFORE the primary has
  // announced any producer (the live ordering). With no real producerId there is
  // NOTHING to consume: consuming a `pipe-producer-pending-<roomId>` sentinel
  // throws "Producer … not found" on REAL mediasoup (only mocks tolerated it,
  // which is why the hermetic suite hid the live deadlock). The transport is
  // already bound + retained on topology.pipeTransport ABOVE, so index.ts can
  // announce its {ip,port} UP. Return null (deferred) and let
  // StandbyWarmPipeCoordinator.onAnnounce re-run with the REAL producerId once the
  // announce arrives. The resolved-id path below (failover/keepalive consumer,
  // REQ-RO-005, relay-worker-recovery) is UNCHANGED.
  if (producerId === undefined) {
    return null;
  }

  // Consume from the pipe transport — the producer (the standby's LOCAL producer
  // minted by produceLocalFromPipe in the active-forward path, or the primary's
  // piped producer in single-process tests) lives on this router by now. The
  // caller (StandbyWarmPipeCoordinator) resolves the real producerId from the
  // inter-relay announce registry (inter-relay.ts) and passes it here.
  const consumer = await transport.consume({
    producerId,
  } as Parameters<msTypes.PipeTransport['consume']>[0]);

  // REQ-RO-005: pause immediately — RTCP keepalive only, saves ~80% pipe BW.
  // F55-safe: pause() is the same primitive used by the F55 paused-flag invariant.
  await consumer.pause();

  // Store on topology for idempotency + later resume on cutover
  topology.pipeConsumer = consumer;

  return consumer;
}

// ── produceLocalFromPipe (REQ-RMS-025 — standby ACTIVE forward) ─────────────

/**
 * REQ-RMS-025 — ACTIVE forward. After the warm pipe is connected, mint a LOCAL
 * producer on the standby's room router FROM the piped producer so the standby's
 * own clients can consume it. The `rtpParameters` come from the primary's announce
 * (REQ-RMS-026) — they carry the pipe's REMAPPED SSRC, so the standby produce
 * ingests the forwarded RTP correctly (the source's rtpParameters would NOT, the
 * SSRC differs across the pipe).
 *
 * Mirrors the manual `standbyPipe.produce({...})` step in the warm-pipe SPIKE
 * (warmpipe-rtp.integration.test.ts) — the production helper for it. RETURNS the
 * local Producer for the caller (StandbyWarmPipeCoordinator) to register + fan
 * (L1.3); it imports NOTHING from apps/relay (no notifyNewProducer / RoomState
 * coupling). The paused keepalive consumer (ensureWarmPipe, REQ-RO-005) is left
 * untouched — a producer + a consumer on the same pipe transport coexist (the
 * warm-pipe SPIKE proves it).
 */
export async function produceLocalFromPipe(
  transport: msTypes.PipeTransport,
  announced: { producerId: string; kind: msTypes.MediaKind; rtpParameters: msTypes.RtpParameters },
  opts: { freshId?: boolean } = {},
): Promise<msTypes.Producer> {
  // T6 (REQ-RMS-046): tree mode mints a FRESH local id per hop (omit id) so a producer
  // crossing two internal nodes never collides; the client binds on the ORIGINAL
  // producerPeerId (Task 2 / design §6.2). Default (freshId=false) keeps the shipped
  // same-id mint → the RMS_ACTIVE_FORWARD path stays byte-stable (REQ-RMS-048): the
  // integration guards that assert `producer.id === announced.producerId` still hold.
  return transport.produce({
    ...(opts.freshId ? {} : { id: announced.producerId }),
    kind: announced.kind,
    rtpParameters: announced.rtpParameters,
  } as Parameters<msTypes.PipeTransport['produce']>[0]);
}

// ── pipeRoomToSecondWorker (REQ-RMS-007 — tier-2 intra-box cross-worker spill) ──

/**
 * Tier-2 spill: pipe an EXISTING room's producer from its current worker's router
 * to a SECOND worker's router WITHIN one process, raising per-room capacity toward
 * C_relay before any network cascade. Uses mediasoup's high-level
 * `router.pipeToRouter()` — the cheapest same-process path (proven by the
 * REQ-RMS-007 spike). No manual {ip,port} handshake, no inter-relay WS (that is
 * tier-3, REQ-RMS-008). Returns the pipe Consumer minted on the SOURCE router
 * (its kind mirrors the producer); the piped producer is now consumable on
 * `secondRouter` under the SAME producerId.
 *
 * Additive — does NOT touch ensureWarmPipe / the F1 warm-pipe path.
 *
 * RETURNS BOTH legs of the hop ({ pipeProducer, pipeConsumer }) — mirroring
 * mediasoup's own PipeToRouterResult. The `pipeProducer` (minted on the
 * DESTINATION router) lets a caller witness the producer as it arrived
 * downstream — e.g. REQ-RMS-011 reads pipeProducer.rtpParameters.encodings to
 * prove the FULL simulcast ladder survived the cascade hop. The `pipeConsumer`
 * (minted on the SOURCE router) is the legacy single-leg the M1 callers used.
 */
export async function pipeRoomToSecondWorker(
  sourceRouter: msTypes.Router,
  secondRouter: msTypes.Router,
  producerId: string,
): Promise<{ pipeProducer: msTypes.Producer; pipeConsumer: msTypes.Consumer }> {
  // No cast: { producerId, router } matches PipeToRouterOptions directly, so let
  // TS verify the call shape (unlike createPipeTransport, whose extra fields the
  // mediasoup d.ts lacks — that one still needs its cast).
  const { pipeProducer, pipeConsumer } = await sourceRouter.pipeToRouter({
    producerId,
    router: secondRouter,
  });
  // mediasoup types both as optional (PipeToRouterResult.pipe{Producer,Consumer}?),
  // but piping a Producer ALWAYS mints BOTH (a producer on the destination router
  // + a consumer on the source router). Narrow + fail loud if mediasoup ever
  // returns none (would mean the producerId was unknown).
  if (pipeConsumer === undefined) {
    throw new Error(`pipeRoomToSecondWorker: pipeToRouter returned no pipeConsumer for producer ${producerId}`);
  }
  if (pipeProducer === undefined) {
    throw new Error(`pipeRoomToSecondWorker: pipeToRouter returned no pipeProducer for producer ${producerId}`);
  }
  return { pipeProducer, pipeConsumer };
}

// ── createPipeLivenessObserver ─────────────────────────────────────────

/**
 * Liveness flags written by {@link createPipeLivenessObserver} into the
 * daemon's /api/probe state box (index.ts probeLiveness). Plain booleans —
 * no mediasoup types cross this seam (mirrors metrics-server ProbeState).
 */
export interface PipeLivenessFlags {
  /** The standby's warm-pipe consumer is open (exists + not closed). */
  pipeConsumerAlive: boolean;
  /**
   * A real RTCP/packet counter ADVANCE was observed across >=2 getStats()
   * samples. NEVER true on the first sample (no prior to compare) and never
   * true for a paused-but-static counter (REQ-RO-011 anti-over-claim).
   */
  rtcpAlive: boolean;
  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay PIPE
   * TRANSPORT (bytesReceived + bytesSent), summed across its stats. Unlike
   * rtcpAlive (which watches the PAUSED keepalive consumer), this counts ALL RTP
   * the primary piped across for the active-forward path — a DIRECT live measure
   * that cross-relay media actually crossed (>0 => bytes traversed the pipe).
   * 0 when no getPipeTransport dep is wired (additive / back-compat).
   */
  pipeBytesObserved?: number;
}

/**
 * Dependencies injected into {@link createPipeLivenessObserver}. Keeping the
 * consumer behind a getter (not a captured reference) lets the observer see
 * the LIVE pipe consumer as the coordinator swaps it, and clear liveness when
 * it goes null/closed (worker.died, cutover teardown).
 */
export interface PipeLivenessObserverDeps {
  /** Resolve the CURRENT standby pipe consumer (null when none). */
  getPipeConsumer: () => msTypes.Consumer | null;
  /**
   * REQ-RMS-025 byte-proof (OPTIONAL, additive) — resolve the CURRENT standby
   * inter-relay pipe TRANSPORT (null when none). When provided, each poll reads
   * its getStats() and reports the cumulative bytesReceived+bytesSent as
   * `pipeBytesObserved` (a DIRECT live measure that cross-relay RTP crossed).
   * Omitted by failover-only callers => pipeBytesObserved stays 0.
   */
  getPipeTransport?: () => msTypes.PipeTransport | null;
  /** Write the resolved flags into the /api/probe state box. */
  setLiveness: (flags: PipeLivenessFlags) => void;
  /** Poll cadence (ms). Default 2000. */
  intervalMs?: number;
  /** Samples required to confirm an advance. Default 2 (this-vs-prior). */
  requiredSamples?: number;
}

/** Handle returned by {@link createPipeLivenessObserver}. */
export interface PipeLivenessObserver {
  start(): void;
  stop(): void;
}

/**
 * Sum every cumulative mediasoup counter that moves when real RTP/RTCP is on
 * the pipe (a ConsumerStat is RtpStreamSendStats). Any monotonic increase
 * across two samples => genuine activity. byteCount alone could be 0 on a
 * tiny-RTCP-only path, so we OR several counters; all are non-decreasing.
 */
function readPipeStatCounter(
  stats: ReadonlyArray<{
    packetCount?: number;
    byteCount?: number;
    nackCount?: number;
    pliCount?: number;
    firCount?: number;
  }>,
): number {
  let total = 0;
  for (const s of stats) {
    total +=
      (s.packetCount ?? 0) +
      (s.byteCount ?? 0) +
      (s.nackCount ?? 0) +
      (s.pliCount ?? 0) +
      (s.firCount ?? 0);
  }
  return total;
}

/**
 * Honest probe-liveness observer (REQ-RO-010 / REQ-RO-011).
 *
 * Polls getPipeConsumer().getStats() on an interval and writes
 * {pipeConsumerAlive, rtcpAlive} via setLiveness:
 *   - pipeConsumerAlive = consumer exists AND not closed.
 *   - rtcpAlive = a non-zero counter ADVANCE was seen across >=requiredSamples
 *     samples. NEVER set on the first sample (no baseline) and never true for a
 *     static (paused-unpaid) counter — this is the single switch that moves the
 *     standby from on-chain duration_seconds=0 (never paid) to >0, so it MUST
 *     NOT over-claim a cold/static standby (REQ-RO-011).
 *   - both CLEARED false on null / closed consumer (no stale liveness).
 *
 * Does NOT touch metrics-server (buildProbeResponse / ProbeState unchanged) —
 * it only writes the existing probeLiveness box (OQ-2 fallback-safe). All logic
 * is in this factory; index.ts only assembles (REQ-RO-012).
 */
export function createPipeLivenessObserver(
  deps: PipeLivenessObserverDeps,
): PipeLivenessObserver {
  const intervalMs = deps.intervalMs ?? 2000;
  const requiredSamples = deps.requiredSamples ?? 2;

  let timer: ReturnType<typeof setInterval> | null = null;
  // History of counter readings for the CURRENT live consumer. Reset whenever
  // the consumer goes null/closed so a fresh pipe starts from no-baseline
  // (never set-on-create after a swap).
  let prevCounter: number | null = null;
  let advanceSamples = 0;

  function resetHistory(): void {
    prevCounter = null;
    advanceSamples = 0;
  }

  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay PIPE
   * TRANSPORT (bytesReceived + bytesSent). Independent of the paused keepalive
   * consumer: counts ALL active-forward RTP that crossed. 0 when no transport
   * dep / no bound transport / a transient getStats() failure.
   */
  async function readPipeTransportBytes(): Promise<number> {
    const transport = deps.getPipeTransport?.() ?? null;
    if (transport === null || transport.closed) return 0;
    try {
      const tstats = (await transport.getStats()) as ReadonlyArray<{
        bytesReceived?: number;
        bytesSent?: number;
      }>;
      let total = 0;
      for (const s of tstats) total += (s.bytesReceived ?? 0) + (s.bytesSent ?? 0);
      return total;
    } catch {
      return 0;
    }
  }

  async function poll(): Promise<void> {
    // REQ-RMS-025 byte-proof: read the pipe TRANSPORT bytes independently of the
    // (paused) keepalive consumer — a DIRECT live measure that cross-relay RTP
    // crossed. Reported on EVERY setLiveness call below (additive; 0 when unwired).
    const pipeBytesObserved = await readPipeTransportBytes();

    const consumer = deps.getPipeConsumer();
    // Clear on null/closed — never report stale liveness.
    if (consumer === null || consumer.closed) {
      resetHistory();
      deps.setLiveness({ pipeConsumerAlive: false, rtcpAlive: false, pipeBytesObserved });
      return;
    }

    let counter: number | null = null;
    try {
      const stats = (await consumer.getStats()) as ReadonlyArray<{
        packetCount?: number;
        byteCount?: number;
        nackCount?: number;
        pliCount?: number;
        firCount?: number;
      }>;
      counter = readPipeStatCounter(stats);
    } catch {
      // Transient getStats() failure (transport mid-rebuild): keep the
      // consumer-alive signal but make no liveness claim this tick.
      counter = null;
    }

    if (counter === null) {
      // Consumer exists but no usable sample this tick.
      deps.setLiveness({ pipeConsumerAlive: true, rtcpAlive: false, pipeBytesObserved });
      return;
    }

    // ADVANCE detection across >=requiredSamples. First sample = baseline only
    // (NEVER set-on-create). An increase vs the prior reading counts a sample.
    if (prevCounter !== null && counter > prevCounter) {
      advanceSamples += 1;
    } else if (prevCounter !== null && counter <= prevCounter) {
      // No movement this tick — require contiguous advance, so reset the run.
      advanceSamples = 0;
    }
    prevCounter = counter;

    const rtcpAlive = advanceSamples >= requiredSamples - 1;
    deps.setLiveness({ pipeConsumerAlive: true, rtcpAlive, pipeBytesObserved });
  }

  return {
    start(): void {
      if (timer !== null) return; // idempotent
      resetHistory();
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      resetHistory();
    },
  };
}
