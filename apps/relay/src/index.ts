/**
 * DVConf Relay Daemon
 *
 * mediasoup-based SFU/MCU relay node for decentralized video conferencing.
 * Registers on-chain in RelayRegistry, runs mediasoup Workers,
 * accepts client WebSocket connections for mediasoup signaling,
 * and reports load via heartbeat.
 *
 * Chain-aware: registers in RelayRegistry, sends heartbeat + load updates.
 * Requirements: RELAY-05
 */

import 'dotenv/config';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  EventPoller,
  InMemoryRelayEndpointCache,
  subscribeRelayEndpoints,
  readIsPaused,
  readCapMinerId,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  runGracefulShutdown,
  readGracefulShutdownConfig,
  type GracefulShutdownPlan,
  type GracefulShutdownConfig,
  type ShutdownReason,
} from '@dvconf/chain-event-listener';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  HealthMonitor,
  makeChainReporter,
  readCooldownMs,
  type ThresholdEnv,
} from '@dvconf/health-monitor';
import { buildHealthSignals, type RelayHealthDeps } from './health-signals.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createMediasoupManager } from './mediasoup-manager.js';
import { createSignalingServer, type TurnContext, type InterRelayContext } from './signaling.js';
import { MetricsTracker } from './metrics.js';
import { startMetricsServer, type ProbeState } from './metrics-server.js';
import { closeRelayProbe } from './room-handler.js';
import { deriveCoturnUrl } from './coturn-url.js';
import { fetchTurnCredential } from './turn-fetcher.js';
import type { types as msTypes } from 'mediasoup';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  createWsInterRelaySender,
  StandbyWarmPipeCoordinator,
  PrimaryPipeCoordinator,
  handleInboundInterRelayFrame,
  buildPipeConnectFrame,
  DEFAULT_PEER_RELAY_ID,
  type InterRelaySocketLike,
  type PipeConnectParams,
} from '@dvconf/inter-relay-client';
import { createInterRelaySocketMap } from './inter-relay-socket-map.js';
import { openInterRelayLink, createStandbyLinkManager } from '@dvconf/inter-relay-client';
import {
  determineRole,
  parsePipePortRange,
  createPipePortAllocator,
  createPipeLivenessObserver,
  type RoomTopology,
} from '@dvconf/inter-relay-client';
import { resolvePrimaryEndpoint } from './relay-endpoint-resolver.js';

const logger = createLogger('relay-daemon');

const WS_PORT = parseInt(process.env['WS_PORT'] ?? '4000', 10);
/** G3.2b: Bearer token the standby presents on the inter-relay link (and the
 *  primary's signaling server validates). Undefined → single-host / unauthed. */
const INTER_RELAY_TOKEN = process.env['INTER_RELAY_TOKEN'];

/**
 * P17 M2a-P11 — assemble + start the relay's F61 HealthMonitor (DOH-014/016/017/018).
 *
 * Single seam that binds the HARD GATE: `operator := signer.toSuiAddress()` — the
 * SAME `signer` makeChainReporter signs the tx with — so `operator == ctx.sender()`
 * holds and `report_node_degradation` does not abort (E_NOT_OPERATOR,
 * node_health.move:81). variant 'miner' (relay holds a MinerCap; node_type=2 is
 * derived on-chain from the cap role). Returns a `stop` for the shutdown teardown.
 * Exported (not inline) so the wiring is unit-testable (health-monitor-wiring.test.ts).
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  minerCapId: string;
  deps: RelayHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, minerCapId, deps, logger, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: minerCapId,
    operator,
    variant: 'miner',
    logger,
  });
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(deps, env),
    reporter,
    logger,
    cooldownMs: readCooldownMs(env),
  });
  monitor.start();
  return { monitor, stop: () => monitor.stop() };
}

/**
 * P17 M2b-P8 (DOH-021/024) — the relay's teardown closures, injected into
 * {@link buildRelayShutdownPlan}. Each maps a relay resource onto one of
 * runGracefulShutdown's ordered groups (drain → reactive → liveness LAST).
 */
export interface RelayShutdownDeps {
  logger: Logger;
  /** (1) Stop accepting new client sockets (P6 createSignalingServer accessor). */
  setAccepting: (accepting: boolean) => void;
  /** (2) drain — close client rooms (P6 accessor); inter-relay peers stay exempt. */
  closeRooms: () => void;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener pollers. */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the G3.2b inter-relay link + reconnect suppression. */
  stopStandbyLink: () => void;
  /** (3) reactive — the G3.2a relay-endpoint cache poller. */
  stopRelayEndpoints: () => Promise<void>;
  /** (3) reactive — the Step-7 room_manager business poller. */
  stopRoomPoller: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the relay live). */
  stopHeartbeat: () => void;
  /** (4) LAST — /api/probe state box. */
  closeRelayProbe: () => void;
  /** (4) LAST — the metrics HTTP server (/healthz + /api/probe + /metrics). */
  closeMetricsServer: () => void;
  /** (4) LAST — mediasoup Workers. */
  closeMediasoup: () => void;
  /** (4) LAST — the client WebSocket server (resolves when fully closed). */
  closeWss: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * P17 M2b-P8 (DOH-021/024) — assemble the relay's ordered graceful-shutdown plan,
 * encoding the two cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops in
 *         `stopReactive` (with the watcher + ChainEventListener + the G3.2b
 *         inter-relay link + the G3.2a endpoint poller + the room poller), NOT first.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz + /api/probe +
 *         mediasoup + wss) so the chain sees the relay LIVE through the whole drain
 *         (D-DOH-M2-F60-3 split-brain fix: a relay that stops heartbeating mid-drain
 *         is marked stale + permissionlessly promoted by its standby).
 * F1=Option A: the relay /healthz stays heartbeat-safe (always-2xx) — it is the
 * LAST thing torn down, never 503'd on a replay-degrade (P7 left it CORS-only).
 * Exported (not inline) so the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildRelayShutdownPlan(
  reason: string,
  deps: RelayShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: deps.setAccepting,
    drain: async () => {
      deps.closeRooms();
    },
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      deps.stopStandbyLink();
      await deps.stopRelayEndpoints();
      deps.stopRoomPoller();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      deps.closeRelayProbe();
      deps.closeMetricsServer();
      deps.closeMediasoup();
      await deps.closeWss();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * P17 M2b-P8 (DOH-020/024) — assemble + start the relay's F60 SelfShutdownWatcher.
 *
 * The relay is the only SLASHABLE daemon → arms = { slash, degraded, paused } (all).
 * `ownMinerId` = the cap's `miner_id` FIELD (the ID carried by
 * `RelaySlashed.relay_miner_id` + `NodeDegraded.miner_id`), read off-chain via
 * {@link readCapMinerId} — NOT the cap OBJECT id. The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * Exported so the arms + self-filter id + isPaused wiring is unit-testable.
 */
export async function startRelaySelfShutdownWatcher(args: {
  client: SuiClient;
  config: NetworkConfig;
  minerCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, minerCapId, listener, onSelfShutdown, logger } = args;
  const ownMinerId = await readCapMinerId(client, minerCapId, logger);
  if (ownMinerId === null) {
    logger.warn(
      { minerCapId },
      'startRelaySelfShutdownWatcher: could not resolve own miner_id — slash/degraded self-filter will not match (paused arm stays active)',
    );
  }
  const watcher = new SelfShutdownWatcher({
    listener,
    ownMinerId: ownMinerId ?? '',
    arms: { slash: true, degraded: true, paused: true },
    onSelfShutdown,
    logger,
    isPaused: () => readIsPaused(client, config.packageId, config.networkRegistryId, logger),
  });
  await watcher.start();
  return { watcher, stop: () => watcher.stop() };
}

// Only start the server when run directly (not imported in tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  (async () => {
    // Load chain configuration
    const config = loadNetworkConfig();
    const client = createSuiClient(config.rpcUrl);
    const signer = loadKeypair('PRIVATE_KEY');

    const endpointUrl = process.env['RELAY_ENDPOINT_URL'] ?? `ws://127.0.0.1:${WS_PORT}`;
    const region = process.env['REGION'] ?? 'local';
    const relayMode = process.env['RELAY_MODE'] ?? 'sfu';

    const address = signer.toSuiAddress();
    logger.info(
      { address, rpcUrl: config.rpcUrl, packageId: config.packageId, endpointUrl, region, relayMode },
      'Relay daemon starting',
    );

    // Step 1: Auto-register on-chain
    const { minerCapId } = await ensureRegistered(client, signer, config, endpointUrl, region, logger);

    // Step 2: Create mediasoup Workers
    const manager = await createMediasoupManager(logger);

    // Step 3: Create metrics tracker
    const metrics = new MetricsTracker();

    // Step 4: Start WebSocket signaling server.
    // S30.C: build optional TurnContext when ENABLE_TURN_DELIVERY=1 +
    // CP_DAEMON_RPC_URL + TURN_RPC_TOKEN are set. The signaling layer
    // delegates the credential fetch per createTransport so it stays
    // decoupled from the cp-daemon RPC plumbing.
    const turnContext: TurnContext | undefined =
      process.env['ENABLE_TURN_DELIVERY'] === '1' &&
      process.env['CP_DAEMON_RPC_URL'] &&
      process.env['TURN_RPC_TOKEN']
        ? (() => {
            const coturnUrl = deriveCoturnUrl(endpointUrl);
            if (!coturnUrl) {
              logger.warn(
                { endpointUrl },
                'ENABLE_TURN_DELIVERY=1 but endpointUrl unparseable; TURN disabled',
              );
              return undefined;
            }
            const cpRpcUrl = process.env['CP_DAEMON_RPC_URL']!;
            const token = process.env['TURN_RPC_TOKEN']!;
            const stunUrl = process.env['STUN_URL'] ?? 'stun:stun.l.google.com:19302';
            const myMinerId = signer.toSuiAddress();
            logger.info(
              { coturnUrl, cpRpcUrl, stunUrl },
              'TURN delivery enabled; relay will inline iceServers in transportCreated',
            );
            return {
              buildIceServers: async (peerId: string) => {
                const cred = await fetchTurnCredential({
                  cpRpcUrl,
                  token,
                  targetMinerId: myMinerId,
                  userId: peerId,
                });
                if (cred === null) return null;
                return [
                  { urls: stunUrl },
                  {
                    urls: [coturnUrl],
                    username: cred.username,
                    credential: cred.password,
                  },
                ];
              },
            };
          })()
        : undefined;

    // G1/G3.2b inter-relay coordination context. The registry is shared; role +
    // links are populated lazily by the RoomAssigned poller (Step 7) once this
    // relay learns its role + the paired relay's endpoint. The standby OPENS a
    // live WS link to the primary (G3.2b openStandbyLink) to receive
    // `pipe-producer` announces; the primary pushes announces over the accepted
    // socket (attachPeerSocket → interRelayLink.socket).
    //
    // NOTE: this index.ts wiring is not unit-tested (mirrors the isMainModule
    // guard) but the pieces it assembles ARE: the announce contract + producerId
    // resolution + auth tag/dispatch gate + inbound handler + link dial
    // (inter-relay*.test.ts, inter-relay-auth*.test.ts, inter-relay-link.test.ts).
    // The cross-HOST RTP media path (PipeTransport connect-param exchange) is NOT
    // here — it is the bench's manual pairing (warmpipe-rtp.integration.test.ts),
    // BENCH-3 scope (advisor-gate W1/W4). G3.2b wires the producerId-announce
    // coordination + the paused warm-pipe lifecycle cross-daemon, not WAN RTP.
    const interRelayRegistry = new InterRelayProducerRegistry();
    /**
     * G1/G3.2b: the LIVE accepted standby socket on the PRIMARY. Held in a mutable
     * box and read by the WS sender on every announce. Set by the signaling
     * server's `attachPeerSocket` callback when a tagged inter-relay peer (the
     * standby's authenticated link) connects; reset to null on its close. Until a
     * socket is attached the sender drops best-effort (no throw). Single
     * per-daemon box (per-room keying is the carry-forward — see standbyLink).
     */
    const interRelayLink: { socket: InterRelaySocketLike | null } = { socket: null };
    /**
     * G3.2a/b: the STANDBY's resolved PRIMARY endpoint URL. The RoomAssigned
     * poller (Step 7) resolves `relayIds[0]` → primaryUrl via the shared endpoint
     * cache and writes it here. G3.2b READS it in two places: the standby arm
     * dials the live inter-relay link (`openStandbyLink`), and `onStandbyRoomReady`
     * feeds it into `RoomTopology.primaryEndpoint`. `null` until a standby
     * assignment resolves (or while the primary's endpoint is not yet on chain).
     *
     * Single per-DAEMON box (mirrors `interRelayLink`), not per-room. A relay that
     * is primary for room A AND standby for room B at once needs per-room keying
     * (Map<roomId, url>) so the live dial does not pick up a stale primary across
     * role/room transitions — the documented G3.2b carry-forward (single-room K=2
     * demo scope holds today).
     */
    const standbyLink: { primaryUrl: string | null } = { primaryUrl: null };
    /**
     * REQ-RMS-028 (L1.3-b, Bridge A) — the per-peer inter-relay socket map, OWNED
     * here and SHARED into createSignalingServer (its tagged-peer attach writes
     * cascade legs into it). The PRIMARY reads it to route per-peer announce/param
     * sends: `socketFor` resolves a cascade peerRelayId to its own live socket, and
     * the DEFAULT peer (undefined / DEFAULT_PEER_RELAY_ID) to the legacy
     * interRelayLink.socket so the single-standby path stays byte-identical.
     */
    const interRelaySockets = createInterRelaySocketMap();
    const socketFor = (p?: string): InterRelaySocketLike | null =>
      p && p !== DEFAULT_PEER_RELAY_ID ? interRelaySockets.get(p) : interRelayLink.socket;
    const sendToPeer = (p: string | undefined, data: string): void => {
      try {
        // REUSE the OPEN/null-guarded WS sender per-peer (drops best-effort).
        createWsInterRelaySender(() => socketFor(p), logger).send(data);
      } catch {
        /* OPEN/null guarded by the sender; a momentary link-down must not throw. */
      }
    };
    /**
     * Outbound inter-relay link sink — now a REAL transmitter (was a no-op log
     * stub that never put bytes on the wire). When a standby socket is attached
     * and OPEN, the announce frame is actually sent; otherwise dropped best-effort.
     */
    const interRelaySender = createWsInterRelaySender(() => interRelayLink.socket, logger);
    /**
     * STANDBY warm-pipe coordinator (BENCH-2 / G1). Resolves the primary's real
     * producerId from the announce registry on first peer join + drives the
     * not-ready re-run on announce arrival. The standby's signaling layer hands
     * it the room topology/router at the bench; instantiated here so the wiring
     * owns a single coordinator backed by the shared registry.
     */
    // REQ-RMS-027 (L1.3-b, Bridge B) — late-bound handle to the signaling layer's
    // fanLocalProducer. interRelayContext (and standbyWarmPipe below) are built
    // BEFORE createSignalingServer returns, and onLocalProducer is a readonly ctor
    // param with no setter, so we box the fn and assign it once the server starts.
    // The callback only fires after the server is live, so the box is always set
    // in time (mirrors the post-construction interRelayContext.role mutation).
    const signalingRef: {
      fanLocalProducer:
        | ((roomId: string, peerId: string, producer: msTypes.Producer) => void)
        | null;
    } = { fanLocalProducer: null };
    const standbyWarmPipe = new StandbyWarmPipeCoordinator(
      interRelayRegistry,
      logger,
      // REQ-RMS-027: a standby minted a LOCAL forwarded producer → fan it to this
      // relay's OWN local clients. Bind to the ORIGINAL publisher (producerPeerId)
      // when the announce carried it, else the cascade peerRelayId.
      (roomId, producer, producerPeerId, peerRelayId) =>
        signalingRef.fanLocalProducer?.(roomId, producerPeerId ?? peerRelayId, producer),
    );

    // ── G3.2b: live cross-daemon inter-relay LINK glue ───────────────────────
    // isMainModule wiring that assembles the unit-tested pieces: openInterRelayLink
    // (the live dial), createStandbyLinkManager (the dedup/reconnect state machine),
    // handleInboundInterRelayFrame (inbound routing), StandbyWarmPipeCoordinator,
    // the signaling-side attach/dispatch gate. PIPE_PORT_RANGE.min is the standby
    // pipe port for the single-room demo; multi-room port allocation + per-room link
    // keying are the documented carry-forward (single-box interRelayLink/standbyLink).
    const pipePortRange = parsePipePortRange(process.env['PIPE_PORT_RANGE']);
    // F1 (REQ-RO-009): per-(room, role) PIPE_PORT allocator over [min..max].
    // Idempotent per key (preserves the N3 re-run invariant); released on room
    // close. Replaces the single hardcoded pipePortRange.min (EADDRINUSE for >1
    // room). Keyed `${roomId}` (standby) + `${roomId}:primary` (primary) so a
    // same-host primary+standby pair never collide. Mesh carry-forward (§12): the
    // key generalizes to per-(roomId, peerRelayId) additively.
    const pipePortAllocator = createPipePortAllocator(pipePortRange);
    const reconnectMs = parseInt(process.env['INTER_RELAY_RECONNECT_MS'] ?? '3000', 10);

    // The standby's outbound link lifecycle (dedup + reconnect) lives in the
    // unit-tested createStandbyLinkManager; index.ts only supplies the live socket
    // factory (openInterRelayLink) + the inbound-frame → registry/cutover routing.
    const standbyLinkManager = createStandbyLinkManager({
      open: (url) =>
        openInterRelayLink({
          url,
          ...(INTER_RELAY_TOKEN ? { token: INTER_RELAY_TOKEN } : {}),
          onFrame: (raw) =>
            handleInboundInterRelayFrame(raw, {
              registry: interRelayRegistry,
              onAnnounce: (roomId) => {
                void standbyWarmPipe.onAnnounce(roomId);
              },
              // F1 (REQ-RO-003/008): the primary's DOWN pipe-connect reply.
              // Feed its {ip,port} into the standby's already-bound PipeTransport
              // so the link is connect()'d BEFORE the announce arrives (the
              // coordinator drains pending producers once both ends connect).
              onConnectParams: (roomId, params) => {
                void standbyWarmPipe.onPrimaryConnectParams(roomId, params);
              },
              logger,
            }),
          logger,
        }),
      reconnectMs,
      logger,
    });

    /** Primary-side producer announcer (unit-tested factory). */
    const pushAnnounce = createInterRelayAnnouncer(interRelaySender);
    // F1 (REQ-RO-001/002/008): the PRIMARY half driver. Mints + connects the
    // primary PipeTransport, pipes the room's real producer onto it, and announces
    // the PIPED consumer id (NOT producer.id) via pushAnnounce. Holds per-room
    // {pipeTransport|null, connected, pendingProducers[], standbyParams|null} and
    // drains pendingProducers once the standby's connect params arrive — tolerates
    // either arrival order (producer-first or params-first). All logic is in the
    // factory; index.ts only injects the announcer + port allocator + the
    // standby->primary param sender (the link's new send() path).
    const primaryPipe = new PrimaryPipeCoordinator({
      // REQ-RMS-008: the coordinator's announcer dep is (roomId, producer, peerRelayId?,
      // rtpParameters?) — its drain threads the cascade peer as the 3rd arg and (REQ-RMS-026)
      // the piped consumer's rtpParameters as the 4th. createInterRelayAnnouncer's closure is
      // (roomId, producer, producerPeerId?, peerRelayId?, rtpParameters?), so map the
      // coordinator's peerRelayId into the 4th slot (producerPeerId undefined — a PIPED
      // consumer carries no publisher peerId) and rtpParameters into the 5th slot.
      //   • peerRelayId is DEFAULT-gated in drain (DEFAULT → undefined) → omitted on the
      //     legacy/default path → that part of the frame stays byte-stable.
      //   • rtpParameters is supplied UNCONDITIONALLY by drain (a real Consumer always has
      //     it) → the live single-standby (DEFAULT) frame intentionally NOW carries it
      //     (REQ-RMS-026, additive — a standby that ignores it still parses via the unchanged
      //     guard); it is NOT byte-identical to the pre-REQ-RMS-026 frame. Builder-level
      //     byte-identity holds only when the 5th arg is OMITTED (the in-process
      //     announceProducer path below, which passes no rtpParameters).
      // REQ-RMS-028 (L1.3-b): route the cascade announce to the RIGHT per-peer
      // socket via sendToPeer (DEFAULT peer → the legacy interRelayLink.socket).
      // REUSE createInterRelayAnnouncer to build the locked frame (peerRelayId +
      // rtpParameters) and hand its bytes to sendToPeer.
      announcer: (roomId, producer, peerRelayId, rtpParameters) =>
        createInterRelayAnnouncer({ send: (data) => sendToPeer(peerRelayId, data) })(
          roomId,
          producer,
          undefined,
          peerRelayId,
          rtpParameters,
        ),
      portAllocator: pipePortAllocator,
      // REQ-RMS-028 (L1.3-b): the DOWN pipe-connect reply routes to the SAME
      // per-peer socket (C contract is (roomId, params[, peerRelayId])).
      paramSender: (roomId, params, peerRelayId) =>
        sendToPeer(peerRelayId, JSON.stringify(buildPipeConnectFrame(roomId, params))),  // buildPipeConnectFrame imported in this file
      logger,
    });
    const interRelayContext: InterRelayContext = {
      // Default to 'primary'; corrected per-room by the RoomAssigned poller.
      role: 'primary',
      registry: interRelayRegistry,
      announceProducer: (roomId, producer, producerPeerId) => {
        pushAnnounce(roomId, producer, producerPeerId);
      },
      // G3.2b PRIMARY: the signaling server hands us the accepted standby socket
      // (tagged inter-relay) so the announce sender transmits over it; null on detach.
      attachPeerSocket: (socket) => {
        interRelayLink.socket = socket;
      },
      // F1 (REQ-RO-001/002/008) PRIMARY: a real producer was created for a room
      // this relay is primary for. Hand it to the coordinator, which mints+connects
      // the primary pipe (port from the allocator, key `${roomId}:primary`), pipes
      // the producer, and announces the PIPED consumer id. Drains immediately if
      // the standby's connect params already arrived, else queues (pending).
      // REQ-RMS-028 (L1.3-b): forward the cascade peerRelayId so the coordinator
      // mints a per-peer pipe leg (DEFAULT/undefined → the legacy single leg).
      onPrimaryProducer: (roomId, router, producer, peerRelayId) =>
        void primaryPipe.onProducer(roomId, router, producer, peerRelayId),
      // F1 (REQ-RO-003/008): the standby's UP pipe-connect frame, delivered through
      // the SAME interRelayPeers token gate as pipe-producer announces. PRIMARY
      // feeds it to the coordinator, which binds + connect()s the primary pipe to
      // these params, then replies DOWN with its own tuple (paramSender) and drains
      // any pending producers.
      onConnectParams: (roomId, params) => {
        void primaryPipe.onStandbyConnectParams(roomId, params);
      },
      // G3.2b STANDBY: on the first peer join for a standby room, build the room's
      // topology + open the paused warm pipe in the LIVE signaling path. F1: the
      // pipe port is now ALLOCATED per room (REQ-RO-009) instead of the single
      // hardcoded min, and the standby announces its bound {ip,port} UP to the
      // primary over the link's new send() path so both ends connect() before RTP.
      onStandbyRoomReady: (roomId, router) => {
        const pipePort = pipePortAllocator.allocate(roomId);
        const topology: RoomTopology = {
          roomId,
          role: 'standby',
          primaryEndpoint: standbyLink.primaryUrl ?? '',
          standbyEndpoint: endpointUrl,
          pipePort,
          pipeConsumer: null,
          pipeTransport: null,
        };
        void standbyWarmPipe
          .ensure(topology, router, pipePort)
          .then(() => {
            // F1 (REQ-RO-003): announce the standby's bound {ip,port} UP to the
            // primary so it can connect() its end. ANNOUNCED_IP default 127.0.0.1
            // (single-host/localnet scope, design §9.5; enableSrtp:false). Best-
            // effort: send() is OPEN-guarded — dropped if the link is not yet up
            // (the standby re-announces on reconnect; the coordinator re-drives).
            const ip = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
            const params: PipeConnectParams = { ip, port: pipePort };
            standbyLinkManager.send(JSON.stringify(buildPipeConnectFrame(roomId, params)));
          })
          .catch((err) => logger.error({ err, roomId }, 'G3.2b: standby warm-pipe ensure failed'));
      },
      // F1 (REQ-RO-009): room teardown — release the standby pipe port and drop
      // both coordinator states, so a reused roomId starts fresh and the port
      // range does not leak. Routed through the context (mirrors registry.clear)
      // so signaling.ts stays decoupled from the allocator/coordinator handles.
      //
      // REQ-RMS-008: the `${roomId}:primary` slot is released by
      // primaryPipe.clear(roomId) itself — its DEFAULT-peer primaryPortKey
      // degrades to exactly `${roomId}:primary` (inter-relay.ts:78-82), and clear
      // releases that key (inter-relay.ts:1061, proven by
      // inter-relay-primary-coordinator.test.ts:240 + warmpipe-rtp integration
      // :714). So PrimaryPipeCoordinator is the SOLE owner of that slot's
      // lifecycle — we no longer double-release it here, avoiding two owners of one
      // key as the M2 cascade lands real per-peer primary legs.
      releaseRoom: (roomId) => {
        pipePortAllocator.release(roomId);
        primaryPipe.clear(roomId);
        standbyWarmPipe.clear(roomId);
      },
    };

    const { wss, getRoomCount, setAccepting, closeRooms, fanLocalProducer } =
      createSignalingServer(
        manager,
        metrics,
        logger,
        turnContext,
        interRelayContext,
        // REQ-RMS-028 (L1.3-b): SHARE the per-peer socket map so the server's
        // tagged-peer attach + the primary's per-peer send use ONE map.
        interRelaySockets,
      );
    // REQ-RMS-027 (L1.3-b): late-bind the fan so onLocalProducer can reach it.
    signalingRef.fanLocalProducer = fanLocalProducer;

    // RO-020: standby-liveness state box read by GET /api/probe. `role` is the
    // live value the RoomAssigned poller (Step 7) sets per room; the pipe/RTCP
    // liveness flags are set when the standby's warm pipe is established. Like
    // the rest of the inter-relay wiring (interRelayLink.socket), the live
    // pipe-consumer hookup is DEFERRED to the bench (G3.2b) — the box defaults
    // to not-live so an un-wired standby honestly answers ok:false (validator
    // gates duration_seconds = 0). The provider/response logic is unit-tested
    // in metrics-server.test.ts.
    const probeLiveness: ProbeState = {
      role: 'unknown',
      pipeConsumerAlive: false,
      rtcpAlive: false,
    };

    // Step 5: Start metrics HTTP server (default port 4001).
    // RO-020: thread the probe-state provider so /api/probe reflects the
    // standby's current role + warm-pipe liveness.
    const metricsServer = startMetricsServer(metrics, logger, () => probeLiveness);

    // F1 (REQ-RO-010/011): honest probe-liveness flip. Polls getStats() on the
    // standby's pipe consumer; sets pipeConsumerAlive on existence, rtcpAlive ONLY
    // on a non-zero RTCP/packet ADVANCE across >=2 samples (never set-on-create);
    // clears both false on null/closed. The setter closures write the SAME
    // probeLiveness box GET /api/probe reads. This is the single switch that moves
    // a standby from on-chain duration_seconds=0 (unpaid) to >0 (reward-eligible)
    // via the already-wired validator gate — it must NOT pay a cold standby
    // (design §6; OQ-2 fallback (a): if a PAUSED consumer's RTCP never advances,
    // rtcpAlive stays provably-false → standby honestly unpaid). buildProbeResponse
    // / ProbeState are UNCHANGED (no metrics-server contract change).
    const pipeLiveness = createPipeLivenessObserver({
      getPipeConsumer: () => standbyWarmPipe.currentPipeConsumer(),
      setLiveness: (next) => {
        probeLiveness.pipeConsumerAlive = next.pipeConsumerAlive;
        probeLiveness.rtcpAlive = next.rtcpAlive;
      },
    });
    pipeLiveness.start();

    // Step 6: Start heartbeat loop (30s default)
    const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
    const stopHeartbeat = startHeartbeat(
      client,
      signer,
      config,
      minerCapId,
      metrics,
      getRoomCount,
      heartbeatIntervalMs,
      logger,
    );

    // Step 6.4 (DOH-014/016/017/018): start the F61 self-degradation HealthMonitor.
    // A SECOND chain-submitting loop alongside the heartbeat (additive — heartbeat,
    // /api/probe + metricsServer untouched). The deps bag wires the live signal
    // sources: per-worker getResourceUsage() CPU delta (MAX, async), the MetricsTracker
    // global packet-loss aggregate, and the MediasoupManager worker-died counter.
    const { stop: stopHealthMonitor } = startHealthMonitor({
      client,
      signer,
      config,
      minerCapId,
      logger,
      deps: {
        getWorkerResourceUsages: () =>
          Promise.all(
            manager.workers.map(async (w) => {
              const ru = await w.getResourceUsage();
              return { pid: w.pid, ru_utime: ru.ru_utime, ru_stime: ru.ru_stime };
            }),
          ),
        getPacketLossBps: () => metrics.getGlobalPacketLossBps(),
        getWorkerDiedCount: () => manager.getWorkerDiedCount(),
      },
    });

    // Step 6.5 (G3.2a/b): relay-side endpoint cache. A standby relay resolves the
    // PRIMARY relay's WS URL (relayIds[0]) from chain to open the live inter-relay
    // link (G3.2b openStandbyLink). The shared `subscribeRelayEndpoints` poller
    // populates the cache from `RelayRegistered` events. G3.2b carry-forward: the
    // relay only needs the relay-ID → URL arm (it learns relay_ids from its own
    // room poller below), so it polls `relay_registry` ONLY — dropping the
    // redundant room_manager poll the G3.2a extraction left in (opts.modules).
    const relayEndpointCache = new InMemoryRelayEndpointCache();
    const stopRelayEndpoints = await subscribeRelayEndpoints(
      client,
      config.packageId,
      relayEndpointCache,
      logger,
      { modules: ['relay_registry'] },
    );

    // Step 7: Poll room_manager events for MCU room assignments
    const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);
    const myMinerId = signer.toSuiAddress();
    const roomPoller = new EventPoller({
      client,
      packageId: config.packageId,
      module: 'room_manager',
      pollingIntervalMs: pollIntervalMs,
      cursorPath: '.cursors/room_manager.json',
      logger: logger.child({ poller: 'room_manager' }),
    });
    roomPoller.start(async (event) => {
      const eventName = event.type.split('::').pop() ?? '';
      if (eventName === 'RoomAssigned') {
        const data = event.parsedJson as Record<string, unknown>;
        const relayIds = data['relay_ids'] as string[] | undefined;
        const relayMode = data['relay_mode'] as number | undefined;
        const roomId = data['room_id'] as string | undefined;
        if (relayIds && relayIds.includes(myMinerId)) {
          // G1: determine this relay's role for the room (primary = relay_ids[0],
          // standby = [1..]; reads .length, never hardcodes 2). Drives the
          // inter-relay producer-announce direction.
          let role: 'primary' | 'standby' = 'primary';
          try {
            role = determineRole(relayIds, myMinerId);
          } catch (err) {
            logger.warn({ err, roomId, relayIds }, 'G1: could not determine relay role for room');
          }
          interRelayContext.role = role;
          // RO-020: reflect the live role on the /api/probe state box.
          probeLiveness.role = role;

          if (role === 'primary') {
            // F1: PRIMARY for this room. The live pipe is driven at the produce
            // event (interRelayContext.onPrimaryProducer → PrimaryPipeCoordinator):
            // it mints+connects the primary pipe, pipes the producer, and announces
            // the PIPED consumer id over the accepted standby socket. No work here
            // beyond recording the role.
            logger.info({ roomId, relayMode, role }, 'G1: relay is PRIMARY for room');
          } else {
            // STANDBY: resolve the primary's WS endpoint so the inter-relay link
            // can be opened to it. G3.2a (HERE): resolve relayIds[0] -> primaryUrl
            // from the shared endpoint cache (populated by subscribeRelayEndpoints,
            // Step 6.5) and stash it for the live socket open. G3.2b (bench/live):
            // `new WebSocket(primaryUrl)` + feed inbound `pipe-producer` frames
            // into the signaling server's handler. BENCH-2: on first peer join the
            // standby calls standbyWarmPipe.ensure(topology, router, pipePort)
            // (resolves the real producerId, else placeholder) and on each inbound
            // announce standbyWarmPipe.onAnnounce(roomId) re-runs the warm pipe with
            // the real id. The record + resolve + re-run contract is unit-tested
            // (inter-relay-warmpipe.test.ts); resolvePrimaryEndpoint is unit-tested
            // (relay-endpoint-resolver.test.ts).
            const primaryUrl = resolvePrimaryEndpoint(relayEndpointCache, relayIds);
            standbyLink.primaryUrl = primaryUrl;
            // G3.2b: OPEN the live inter-relay link to the primary. The primary
            // pushes pipe-producer announces down it; each cuts the warm pipe over
            // to the real producerId. The paused warm pipe is opened on first peer
            // join (onStandbyRoomReady). Skipped until the URL resolves from chain.
            if (primaryUrl !== null) standbyLinkManager.connectTo(primaryUrl);
            logger.info(
              { roomId, relayMode, role, primaryUrl, resolved: primaryUrl !== null },
              primaryUrl !== null
                ? 'G3.2b: relay is STANDBY for room — opened live inter-relay link to primary'
                : 'G1: relay is STANDBY for room — primary endpoint not yet resolvable from cache (chain not yet observed); retries on next assignment',
            );
          }

          if (relayMode === 1) {
            logger.info(
              { roomId, relayMode },
              'MCU pipeline initialized for room — composite output mode',
            );
          } else {
            logger.info(
              { roomId, relayMode },
              'SFU room assigned — individual stream forwarding',
            );
          }
        }
      }
    });

    const metricsPort = parseInt(process.env['METRICS_PORT'] ?? '4001', 10);
    logger.info(
      {
        heartbeatIntervalMs,
        minerCapId,
        port: WS_PORT,
        metricsPort,
        workers: manager.workers.length,
        mode: relayMode,
      },
      'Relay daemon started — chain-aware mode',
    );

    // ── P17 M2b-P8 (DOH-020/021/024): F60 reactive lifecycle ──────────────────
    // The SelfShutdownWatcher self-terminates the relay on a self-targeted on-chain
    // RelaySlashed / NodeDegraded(level 2) or a network pause; both it and a
    // SIGTERM/SIGINT funnel through the SAME ordered runGracefulShutdown (P5) — the
    // blind setTimeout(exit, 5000) is replaced by the 30s-drain / 60s-force-kill
    // sequence with C-A (HealthMonitor → reactive) + C-B (heartbeat/healthz → LAST).
    const gracefulCfg = readGracefulShutdownConfig();
    const chainListener = new ChainEventListener({
      client,
      packageId: config.packageId,
      logger: logger.child({ component: 'self-shutdown-listener' }),
    });
    let selfShutdownWatcher: SelfShutdownWatcher | undefined;

    const runRelayShutdown = (reason: string): void => {
      void runGracefulShutdown(
        buildRelayShutdownPlan(reason, {
          logger,
          setAccepting,
          closeRooms,
          stopHealthMonitor, // C-A: relocated from FIRST into stopReactive
          stopWatcher: () => selfShutdownWatcher?.stop(),
          stopChainListener: () => chainListener.stop(),
          stopStandbyLink: () => standbyLinkManager.shutdown(),
          stopRelayEndpoints: () => stopRelayEndpoints(),
          stopRoomPoller: () => {
            pipeLiveness.stop(); // F1: stop the probe-liveness poll alongside the room poller
            roomPoller.stop();
          },
          stopHeartbeat, // C-B: relocated from EARLY into the LAST group
          closeRelayProbe,
          closeMetricsServer: () => metricsServer.close(),
          closeMediasoup: () => manager.close(),
          closeWss: () =>
            new Promise<void>((resolve) =>
              wss.close(() => {
                logger.info('Relay daemon closed');
                resolve();
              }),
            ),
          exit: (code) => process.exit(code),
          config: gracefulCfg,
        }),
      );
    };

    // Relay = the only slashable daemon → arms { slash, degraded, paused }.
    ({ watcher: selfShutdownWatcher } = await startRelaySelfShutdownWatcher({
      client,
      config,
      minerCapId,
      listener: chainListener,
      onSelfShutdown: (reason) => {
        logger.error({ reason }, 'self-shutdown triggered — initiating graceful shutdown');
        runRelayShutdown(reason);
      },
      logger,
    }));

    process.on('SIGTERM', () => runRelayShutdown('SIGTERM'));
    process.on('SIGINT', () => runRelayShutdown('SIGINT'));
  })().catch((err) => {
    logger.fatal({ err }, 'Relay daemon crashed during startup');
    process.exit(1);
  });
}
