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
} from '@dvconf/shared';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createMediasoupManager } from './mediasoup-manager.js';
import { createSignalingServer, type TurnContext, type InterRelayContext } from './signaling.js';
import { MetricsTracker } from './metrics.js';
import { startMetricsServer, type ProbeState } from './metrics-server.js';
import { closeRelayProbe } from './room-handler.js';
import { deriveCoturnUrl } from './coturn-url.js';
import { fetchTurnCredential } from './turn-fetcher.js';
import { WebSocket } from 'ws';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  createWsInterRelaySender,
  StandbyWarmPipeCoordinator,
  type InterRelaySocketLike,
} from './inter-relay.js';
import { determineRole } from './relay-role-manager.js';
import { resolvePrimaryEndpoint } from './relay-endpoint-resolver.js';

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

    // G1 inter-relay coordination context. The registry is shared; role +
    // outbound link are populated lazily by the RoomAssigned poller (Step 7)
    // once this relay learns its role + the paired relay's endpoint. The
    // standby OPENS a WS link to the primary to receive `pipe-producer`
    // announces; the primary pushes announces over the link the standby opened.
    //
    // NOTE: this is the wiring layer (not unit-tested — mirrors the isMainModule
    // guard). The announce contract + producerId resolution are unit-tested in
    // inter-relay.test.ts / inter-relay-wiring.test.ts. LIVE two-relay
    // verification is DEFERRED to the bench (Phase 5.3, held for advisor gate 1).
    const interRelayRegistry = new InterRelayProducerRegistry();
    /**
     * BENCH-2 / G1: the LIVE accepted standby socket on the PRIMARY. Held in a
     * mutable box and read by the WS sender on every announce. The RoomAssigned
     * poller (Step 7) sets this when the standby opens its inter-relay link to
     * the primary (relay-ID → endpoint resolution remains the bench's job).
     * Until a socket is attached the sender drops best-effort (no throw).
     */
    const interRelayLink: { socket: InterRelaySocketLike | null } = { socket: null };
    /**
     * G3.2a: the STANDBY's resolved PRIMARY endpoint URL — the INTERIM holder for
     * the value the ROADMAP phrases as `topology.primaryEndpoint`. A standby
     * `RoomTopology` is not constructed in production yet (it is handed in at the
     * bench — see `void standbyWarmPipe` above), so the resolved URL is stashed
     * here for now; G3.2b will feed it into `RoomTopology.primaryEndpoint` (the
     * field `inter-relay.ts` already consumes) when it builds the live topology.
     * The RoomAssigned poller (Step 7) resolves `relayIds[0]` → primaryUrl via the
     * shared endpoint cache and writes it here. `null` until a standby assignment
     * resolves (or while the primary's endpoint has not yet been observed on chain).
     * Write-only this lane (no reader until the G3.2b socket open).
     *
     * NOTE for G3.2b: this is a single per-DAEMON box (mirrors `interRelayLink`),
     * not per-room. A relay that is primary for room A AND standby for room B at
     * once needs per-room keying (Map<roomId, url>) so the live dial does not pick
     * up a stale primary across role/room transitions — decide that when wiring the
     * reader.
     */
    const standbyLink: { primaryUrl: string | null } = { primaryUrl: null };
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
    const standbyWarmPipe = new StandbyWarmPipeCoordinator(interRelayRegistry, logger);
    void standbyWarmPipe; // standby topology/router handed in at the live bench
    /** Primary-side producer announcer (unit-tested factory). */
    const pushAnnounce = createInterRelayAnnouncer(interRelaySender);
    const interRelayContext: InterRelayContext = {
      // Default to 'primary'; corrected per-room by the RoomAssigned poller.
      role: 'primary',
      registry: interRelayRegistry,
      announceProducer: (roomId, producer) => {
        pushAnnounce(roomId, producer);
      },
    };

    const { wss, getRoomCount } = createSignalingServer(
      manager,
      metrics,
      logger,
      turnContext,
      interRelayContext,
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
    };

    // Step 5: Start metrics HTTP server (default port 4001).
    // RO-020: thread the probe-state provider so /api/probe reflects the
    // standby's current role + warm-pipe liveness.
    const metricsServer = startMetricsServer(metrics, logger, () => probeLiveness);

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

    // Step 6.5 (G3.2a): relay-side endpoint cache. A standby relay resolves the
    // PRIMARY relay's WS URL (relayIds[0]) from chain to open the inter-relay
    // pipe (the live socket open is G3.2b). The shared `subscribeRelayEndpoints`
    // poller (reused from signaling, now in @dvconf/shared) populates the cache
    // from `RelayRegistered` events — the relay only needs the relay-ID → URL
    // arm (it already learns relay_ids from its own room poller below), but the
    // poller also harmlessly mirrors the room→relays map (idempotent, in-memory
    // cursor independent of the Step-7 room poller's file cursor).
    const relayEndpointCache = new InMemoryRelayEndpointCache();
    const stopRelayEndpoints = await subscribeRelayEndpoints(
      client,
      config.packageId,
      relayEndpointCache,
      logger,
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
            // PRIMARY: install the announcer over the inter-relay link to the
            // standby. The standby OPENS the link (it knows the primary's
            // endpoint); the primary pushes announces over the accepted socket.
            //
            // DEFERRED-LIVE (bench Phase 5.3): the relay-ID -> endpoint URL
            // resolution (via relay_registry::get_active_relays(), per
            // CONTEXT D-RO-3) + the accepted-socket bookkeeping are wired at
            // the live bench. BENCH-2: the announce SINK now genuinely transmits
            // (createWsInterRelaySender) — the bench only needs to set
            // `interRelayLink.socket` to the accepted standby `ws` socket and the
            // primary's real producerId announces flow over it. The announcer
            // factory + WS send contract are unit-tested
            // (inter-relay-warmpipe.test.ts createWsInterRelaySender).
            logger.info(
              { roomId, relayMode, role },
              'G1: relay is PRIMARY for room — announcer installs on standby link (live-wire at bench)',
            );
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
            standbyLink.primaryUrl = primaryUrl; // will be consumed by the G3.2b live socket open
            void WebSocket; // referenced; live link opened at bench (G3.2b)
            logger.info(
              { roomId, relayMode, role, primaryUrl, resolved: primaryUrl !== null },
              primaryUrl !== null
                ? 'G1: relay is STANDBY for room — resolved primary endpoint (G3.2a); inter-relay link opened at bench (G3.2b)'
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

    // Graceful shutdown with worker cleanup
    const chainShutdown = () => {
      logger.info('Shutting down relay daemon...');
      stopHeartbeat();
      void stopRelayEndpoints(); // G3.2a: stop the relay-endpoint cache poller
      closeRelayProbe();
      metricsServer.close();
      manager.close();
      wss.close(() => {
        logger.info('Relay daemon closed');
        process.exit(0);
      });
      // Force exit after 5s if graceful close hangs
      setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGTERM', chainShutdown);
    process.on('SIGINT', chainShutdown);
  })().catch((err) => {
    logger.fatal({ err }, 'Relay daemon crashed during startup');
    process.exit(1);
  });
}
