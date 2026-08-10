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

import '@dvconf/shared/otel-bootstrap';
import 'dotenv/config';
import { join } from 'node:path';
import {
  createSuiClient,
  createGraphQLClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  EventPoller,
  InMemoryRelayEndpointCache,
  subscribeRelayEndpoints,
} from '@dvconf/shared';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createPromotionHandlers } from './relay-promotion.js';
import { createMediasoupManager } from './mediasoup-manager.js';
import { createSignalingServer } from './signaling/index.js';
import { MetricsTracker } from './metrics.js';
import { PeerStatsWindow } from './stats-window.js';
import { startMetricsServer, type ProbeState } from './metrics-server.js';
import { startHealthMonitor } from './health-monitor-wiring.js';
import { createPipeLivenessObserver, buildPipeProducerAnnounce } from '@dvconf/inter-relay-client';
import { recordFailoverPhase } from './failover-metrics.js';
import { buildRelayWiring, stopStandbyHeartbeatBox } from './relay-wiring-context.js';
import { createRoomEventHandler } from './relay-room-events.js';
import { setupRelayShutdown } from './relay-shutdown.js';

const logger = createLogger('relay-daemon');

const WS_PORT = parseInt(process.env['WS_PORT'] ?? '4000', 10);

// Only start the server when run directly (not imported in tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  (async () => {
    // Load chain configuration
    const config = loadNetworkConfig();
    const client = createSuiClient(config.rpcUrl);
    // Event queries only (roomPoller below) -- see createGraphQLClient's docstring.
    const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');
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
    const { minerCapId } = await ensureRegistered(client, signer, config, endpointUrl, region, logger, graphqlClient);

    // Step 2: Create mediasoup Workers
    const manager = await createMediasoupManager(logger);

    // Step 3: Create metrics tracker
    const metrics = new MetricsTracker();
    // Call-quality feature: shared with BOTH createSignalingServer (clears a
    // peer's cached stats on disconnect) and startMetricsServer (reads them
    // for /metrics/prom) -- one instance per process, mirroring `metrics` above.
    const statsWindow = new PeerStatsWindow();

    // Step 4: Start WebSocket signaling server.
    // The bulk of the inter-relay coordination wiring (env flags, TURN
    // context, mutable state boxes, interRelayContext, fanToTreeNeighbors)
    // lives in relay-wiring-context.ts; see buildRelayWiring's docstring.
    const wiring = buildRelayWiring({ logger, endpointUrl, signer });
    const {
      turnContext,
      interRelayContext,
      signalingRef,
      standbyWarmPipe,
      standbyHeartbeats,
      interRelaySockets,
      standbyLinkManager,
      relayEndpointCacheRef,
      roomTreePosition,
      roomAssignedRelays,
      standbyLink,
    } = wiring;

    const {
      wss,
      getRoomCount,
      getRoomParticipantCounts,
      setAccepting,
      closeRooms,
      fanLocalProducer,
      getRoom,
      registerReverseMinted,
      reannounceLocalProducersUp,
      prewarmRoom,
      stopWsHeartbeat,
    } =
      createSignalingServer(
        manager,
        metrics,
        logger,
        turnContext,
        interRelayContext,
        // REQ-RMS-028 (L1.3-b): SHARE the per-peer socket map so the server's
        // tagged-peer attach + the primary's per-peer send use ONE map.
        interRelaySockets,
        statsWindow,
      );
    // REQ-RMS-027 (L1.3-b): late-bind the fan so onLocalProducer can reach it.
    signalingRef.fanLocalProducer = fanLocalProducer;
    // REQ-RMS-034 (part-3 reverse leg): late-bind the room lookup + reverse-mint
    // registrar so onReverseAnnounce (built in relay-wiring-context.ts) can
    // reach them once the server is live (same box pattern as fanLocalProducer).
    signalingRef.getRoom = getRoom;
    signalingRef.registerReverseMinted = registerReverseMinted;
    // REQ-RMS-037: late-bind the standby UP re-announce. SUPERSEDED for the link-flap /
    // reopen case by StandbyWarmPipeCoordinator.resendReverseAnnounces (static-mesh-hardening
    // D3, wired via the standbyLinkManager onOpen in relay-wiring-context.ts) — a flap must
    // RE-DELIVER stored announce frames, not re-drive this path (reverseConsumedIds would skip
    // every already-consumed producer). Kept as an ops/manual utility; not wired to a
    // production reopen trigger.
    signalingRef.reannounceLocalProducersUp = reannounceLocalProducersUp;
    // REQ-RMS-034: bind the reverse UP-announcer on the standby coordinator. Uses
    // the SAME UP link seam as the pipe-connect frame (standbyLinkManager.send),
    // NOT a primary per-peer send. The frame carries peerRelayId + rtpParameters
    // (REQ-RMS-026) so the primary mints the right per-(room,peer) hub copy.
    // T-B (REQ-RMS-044/046): the reverse announcer now also carries the loop-guard budget +
    // immutable origin UP. Undefined on the shipped reverse path → buildPipeProducerAnnounce
    // omits both → byte-stable frame.
    standbyWarmPipe.setReverseAnnouncer((roomId, prod, producerPeerId, peerRelayId, rtpParameters, hopTtl, originProducerId) =>
      standbyLinkManager.send(
        JSON.stringify(
          buildPipeProducerAnnounce(roomId, prod, producerPeerId, peerRelayId, rtpParameters, hopTtl, originProducerId),
        ),
      ),
    );

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
      pipeBytesObserved: 0,
    };

    // Step 5: Start metrics HTTP server (default port 4001).
    // RO-020: thread the probe-state provider so /api/probe reflects the
    // standby's current role + warm-pipe liveness.
    const metricsServer = startMetricsServer(
      metrics,
      logger,
      () => probeLiveness,
      // Call-quality feature (POST /stats/report admission check): resolve the
      // live room state via the same late-bound signalingRef box getRoom uses
      // elsewhere (index.ts is assembled before createSignalingServer runs).
      (roomId) => signalingRef.getRoom?.(roomId),
      () => manager.getWorkerDiedCount(),
      () => manager.workers,
      statsWindow,
      () => getRoomParticipantCounts(),
    );

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
    // "promote" phase (t2): edge-detect rtcpAlive false->true right here, since
    // createPipeLivenessObserver lives in the shared inter-relay-client package
    // and must stay app-agnostic. lastNotAliveAt tracks the most recent instant
    // rtcpAlive was known false; a transition to true reports its own local
    // duration -- see failover-metrics.ts for why this is independent, not a
    // cross-file t0->t2 correlation.
    let rtcpWasAlive = false;
    let lastNotAliveAt = Date.now();
    const pipeLiveness = createPipeLivenessObserver({
      getPipeConsumer: () => standbyWarmPipe.currentPipeConsumer(),
      // REQ-RMS-025 byte-proof: also read the pipe TRANSPORT bytes (bytesReceived+
      // Sent) so /api/probe reports `pipe_bytes_observed` — a DIRECT live measure
      // that cross-relay active-forward RTP crossed (the keepalive consumer is
      // paused, so rtcpAlive alone under-reports the active-forward path).
      getPipeTransport: () => standbyWarmPipe.currentPipeTransport(),
      setLiveness: (next) => {
        probeLiveness.pipeConsumerAlive = next.pipeConsumerAlive;
        probeLiveness.rtcpAlive = next.rtcpAlive;
        probeLiveness.pipeBytesObserved = next.pipeBytesObserved ?? 0;
        if (next.rtcpAlive && !rtcpWasAlive) {
          recordFailoverPhase('promote', (Date.now() - lastNotAliveAt) / 1000);
        }
        if (!next.rtcpAlive) {
          lastNotAliveAt = Date.now();
        }
        rtcpWasAlive = next.rtcpAlive;
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
    relayEndpointCacheRef.current = relayEndpointCache;
    const stopRelayEndpoints = await subscribeRelayEndpoints(
      graphqlClient,
      config.packageId,
      relayEndpointCache,
      logger,
      { modules: ['relay_registry'] },
    );

    // Step 7: Poll room_manager events for MCU room assignments.
    const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);
    const myMinerId = signer.toSuiAddress();

    // Pre-warm standby: rooms this relay currently holds the standby role for
    // (populated below), periodically re-confirmed so a room that missed its
    // one-time pairing-time pre-warm (e.g. a transient failure) self-heals.
    // ensureRoomPrewarmed (via prewarmRoom) is idempotent — a safe no-op once
    // the room already exists.
    const standbyPrewarmRooms = new Map<string, 'sfu' | 'mcu'>();
    const standbyRewarmIntervalMs = parseInt(process.env['STANDBY_REWARM_INTERVAL_MS'] ?? '30000', 10);
    setInterval(() => {
      for (const [roomId, mode] of standbyPrewarmRooms) {
        void prewarmRoom(roomId, mode).catch((err) => {
          logger.warn({ err, roomId }, 'Standby re-warm sweep: pre-warm failed');
        });
      }
    }, standbyRewarmIntervalMs);

    // REQ-RO-006 — the shared "this relay is now primary for roomId" transition
    // + the standby-side fast local ping loop that can trigger it. Extracted to
    // relay-promotion.ts (mirrors reverse-announce-handler.ts's factory shape)
    // so it's unit-testable without index.ts's daemon-`main` side effects — see
    // that module's docstring for the full two-trigger/idempotency contract.
    const { promoteToPrimary, startStandbyHeartbeat, stopStandbyHeartbeat } = createPromotionHandlers({
      standbyWarmPipe,
      interRelayContext,
      probeLiveness,
      standbyPrewarmRooms,
      standbyHeartbeats,
      logger,
    });
    // relay-wiring-context.ts's interRelayContext.releaseRoom bridges to this
    // stopStandbyHeartbeat via a late-bound box (mirrors signalingRef).
    stopStandbyHeartbeatBox.current = stopStandbyHeartbeat;

    const roomPoller = new EventPoller({
      client: graphqlClient,
      packageId: config.originalPackageId ?? config.packageId,
      module: 'room_manager_events',
      pollingIntervalMs: pollIntervalMs,
      // DATA_DIR (mirrors ChainEventListener's own default), NOT process.cwd(),
      // so a container recreate (redeploy) doesn't force a full event-history
      // replay from genesis.
      cursorPath: join(process.env['DATA_DIR'] ?? '.', '.cursors', 'room_manager.json'),
      logger: logger.child({ poller: 'room_manager' }),
    });
    roomPoller.start(
      createRoomEventHandler({
        myMinerId,
        interRelayContext,
        probeLiveness,
        roomTreePosition,
        roomAssignedRelays,
        relayEndpointCacheRef,
        standbyLink,
        standbyLinkManager,
        standbyPrewarmRooms,
        prewarmRoom,
        startStandbyHeartbeat,
        stopStandbyHeartbeat,
        promoteToPrimary,
        logger,
      }),
    );

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
    // Assembled in relay-shutdown.ts; see setupRelayShutdown's docstring.
    await setupRelayShutdown({
      logger,
      client,
      graphqlClient,
      config,
      minerCapId,
      setAccepting,
      closeRooms,
      stopHealthMonitor,
      standbyLinkManager,
      stopRelayEndpoints: () => stopRelayEndpoints(),
      pipeLiveness,
      roomPoller,
      stopHeartbeat,
      stopWsHeartbeat,
      metricsServer,
      manager,
      wss,
    });
  })().catch((err) => {
    logger.fatal({ err }, 'Relay daemon crashed during startup');
    process.exit(1);
  });
}
