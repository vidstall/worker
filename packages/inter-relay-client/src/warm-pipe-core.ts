/**
 * Relay role manager — warm-pipe core primitives: mint the standby's
 * PipeTransport, lazily establish the warm pipe + paused keepalive consumer,
 * mint the standby's LOCAL active-forward producer, and the tier-2
 * intra-box cross-worker spill pipe.
 *
 * Pure extraction from relay-role-manager.ts (which is now a barrel — see its
 * module doc).
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 * ADR: ADR-0009 (relay-overlap-redundancy M1)
 */

import type { types as msTypes } from 'mediasoup';
import { pipeSrtpEnabled, type RoomTopology } from './relay-role.js';

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
