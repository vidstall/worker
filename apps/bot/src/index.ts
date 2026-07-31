/**
 * Bot daemon — HTTP control-server entrypoint.
 *
 * Starts the `server.ts` HTTP control API (`GET /healthz`, `POST /bots`,
 * `GET /bots`, `DELETE /bots/:id`) so an admin dashboard can launch/list/stop
 * fake-participant bot sessions on demand — each session registers (idempotent)
 * and either creates a NEW on-chain room or joins an EXISTING one by roomId,
 * resolves that room's real relay endpoint on-chain, joins it, and produces
 * whichever of video/audio the requested media mode calls for.
 *
 * For local dev convenience, a single one-shot bot (the old default behavior)
 * can still be run directly without the HTTP layer via `src/run-once.ts`
 * (wired as the `dev:once` package script) — it imports `startBotSession`
 * straight from `session.ts` so there's no logic duplicated here.
 *
 * CRITICAL: never log the private key.
 */
import '@dvconf/shared/otel-bootstrap';
import {
  createSuiClient,
  createGraphQLClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  createMetricsRegistry,
  startPromMetricsServer,
  createConcurrencyGauge,
  createDurationHistogram,
  createCounter,
} from '@dvconf/shared';
import { loadBotConfig } from './config.js';
import { startBotSession, type BotSession, type BotSessionOptions } from './session.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const logger = createLogger('bot');
  const botConfig = loadBotConfig();
  const networkConfig = loadNetworkConfig();
  const signer = loadKeypair('PRIVATE_KEY');
  const client = createSuiClient(networkConfig.rpcUrl);
  // Event queries only (RoomCreated lookup in createRoom) -- see
  // createGraphQLClient's docstring: devnet's public fullnode returns empty
  // `events` on JSON-RPC execute responses, so room creation backfills via
  // GraphQL instead.
  const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');

  // Worker-metrics: Prometheus scrape endpoint (CPU/RSS/heap via
  // collectDefaultMetrics + dvconf_active_sessions sourced from the live
  // `sessions` map), same pattern as signaling/cp-daemon/validator-daemon.
  // Created before `startSession` below so its histogram can be closed over.
  const promRegistry = createMetricsRegistry('bot');
  const concurrencyGauge = createConcurrencyGauge(promRegistry, 'bot');
  const joinPhaseHistogram = createDurationHistogram(
    promRegistry,
    'dvconf_bot_join_phase_seconds',
    'Wall-clock duration of each startBotSession phase (register/create_room/resolve_relay/ws_connect/media_start)',
    ['phase'],
  );
  // Monitoring-redesign gap #4: session count/failure rate had no metric of
  // their own beyond the phase-latency breakdown above. session.ts stays
  // decoupled from the metrics registry by design (see its onJoinPhase doc
  // comment) -- both counters are fully observable from this call boundary
  // (start = the call itself, error = the returned promise rejecting), so no
  // new callback/deps plumbing into session.ts is needed.
  const sessionsTotalCounter = createCounter(
    promRegistry,
    'dvconf_bot_sessions_total',
    'Bot sessions started by this daemon',
    [],
  );
  const sessionErrorsTotalCounter = createCounter(
    promRegistry,
    'dvconf_bot_session_errors_total',
    'Bot sessions that failed to start (startBotSession rejected)',
    [],
  );
  // Monitoring-redesign gap #1: ffmpeg pipeline health had no metrics at all
  // (respawns/stderr chatter/frame drops were only ever logged, never
  // counted). session.ts stays decoupled from the registry, same as
  // onJoinPhase above -- these are just 3 more callbacks.
  const ffmpegRespawnsTotalCounter = createCounter(
    promRegistry,
    'dvconf_bot_ffmpeg_respawns_total',
    'ffmpeg child-process respawns (unexpected exit) across all bot sessions',
    [],
  );
  const ffmpegStderrLinesTotalCounter = createCounter(
    promRegistry,
    'dvconf_bot_ffmpeg_stderr_lines_total',
    'Cumulative ffmpeg stderr data events (count only, content never surfaced)',
    [],
  );
  const frameDropsTotalCounter = createCounter(
    promRegistry,
    'dvconf_bot_frame_drops_total',
    'Video/audio frames dropped due to consumer backpressure',
    [],
  );

  const startSession = (opts: BotSessionOptions): Promise<BotSession> => {
    sessionsTotalCounter.inc();
    return startBotSession(opts, {
      client,
      signer,
      networkConfig,
      botConfig,
      logger,
      graphqlClient,
      onJoinPhase: (phase, ms) => joinPhaseHistogram.observe({ phase }, ms / 1000),
      onFfmpegRespawn: () => ffmpegRespawnsTotalCounter.inc(),
      onFfmpegStderrData: () => ffmpegStderrLinesTotalCounter.inc(),
      onFrameDrop: () => frameDropsTotalCounter.inc(),
    }).catch((err: unknown) => {
      sessionErrorsTotalCounter.inc();
      throw err;
    });
  };

  const { server, sessions } = startServer(
    { port: botConfig.port, controlToken: botConfig.controlToken, startSession },
    logger,
  );

  const promMetrics = await startPromMetricsServer({
    port: botConfig.metricsPort,
    service: 'bot',
    registry: promRegistry,
    token: process.env['METRICS_AUTH_TOKEN'],
    logger,
  });
  logger.info({ port: promMetrics.port }, 'prom metrics listening');
  const stopConcurrencyGaugeUpdates = setInterval(() => {
    concurrencyGauge.setActiveSessions(sessions.size);
  }, 5000);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ module: 'bot', signal, activeSessions: sessions.size }, 'shutting down…');
    clearInterval(stopConcurrencyGaugeUpdates);
    for (const session of sessions.values()) {
      session.stop();
    }
    sessions.clear();
    server.close(() => process.exit(0));
    // Fallback in case server.close() hangs on an open keep-alive connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
