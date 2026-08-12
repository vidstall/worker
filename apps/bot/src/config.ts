/**
 * Bot daemon configuration — env parsing.
 *
 * On-chain object IDs / SUI_NETWORK / PRIVATE_KEY are loaded via
 * `@dvconf/shared`'s `loadNetworkConfig()`/`loadKeypair()` (same convention as
 * every other daemon, e.g. `apps/relay`) rather than reinvented here.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import 'dotenv/config';

// Baked into the Docker image (apps/bot/assets/002.mp4, COPY'd by the
// Dockerfile) so a session works out of the box without the operator having
// to supply MP4_PATH -- it's still overridable per-session via POST /bots'
// `mp4Path`, or globally via the MP4_PATH env var for local dev.
const DEFAULT_MP4_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', '002.mp4');

export interface BotConfig {
  /** Path to the MP4 file the bot loops as its published video/audio (session
   *  default — a `POST /bots` request may override it per-session). */
  mp4Path: string;
  /** Room admission password. Default "123" per the demo requirement. */
  roomPassword: string;
  /** `expected_participants` passed to `room_manager::create_room`. */
  expectedParticipants: number;
  /** Base URL of the client webapp, used to build the shareable join link. */
  clientUrl: string;
  /** HTTP control-server port. Default 8095 (cp-daemon=8091, validator=8101,
   *  relay=4000/4001, signaling=8080/8082 are already taken). */
  port: number;
  /** Bearer token required on `/bots*` routes. Empty string = auth disabled
   *  (a loud warning is logged at startup — see index.ts). */
  controlToken: string;
  /** Prometheus metrics server port (separate listener from `port` above,
   *  same pattern as cp-daemon/validator-daemon/signaling). Default 8096. */
  metricsPort: number;
  /** RelayClient WS ping/pong liveness interval (ms) -- same knob/default as
   *  the relay's own WS_HEARTBEAT_INTERVAL_MS, reused here since it's the
   *  client-side counterpart of the same liveness concept in a different
   *  process. Default 30000. */
  wsHeartbeatIntervalMs: number;
  /** Observer Prometheus Pushgateway base URL (e.g.
   *  https://pushgateway.<ip>.sslip.io) -- lets stats-reporter.ts push this
   *  bot's dvconf_relay_peer_* quality samples the same direct-to-
   *  Pushgateway way services/client/client/src/lib/metrics-push.ts already
   *  does for real browser clients, instead of the deprecated relay
   *  `/stats/report` bridge (which required knowing the CURRENT relay's
   *  URL, so a standby cutover silently dropped samples -- see
   *  metrics-push.ts's docstring). Injected by
   *  cli/infra/ansible.py's _pushgateway_extra_vars() via
   *  run_container.yml. Empty string = not configured, push silently
   *  no-ops (see metrics-push.ts). */
  pushgatewayUrl: string;
  /** Bearer token for the Pushgateway push above -- same
   *  METRICS_AUTH_TOKEN this daemon already reads for its OWN /metrics/prom
   *  auth (index.ts), reused rather than a second secret. */
  metricsAuthToken: string;
}

export function loadBotConfig(): BotConfig {
  return {
    mp4Path: process.env['MP4_PATH'] || DEFAULT_MP4_PATH,
    roomPassword: process.env['ROOM_PASSWORD'] || '123',
    expectedParticipants: Number(process.env['EXPECTED_PARTICIPANTS'] ?? '4'),
    clientUrl: process.env['CLIENT_URL'] || 'http://localhost:5173',
    port: Number(process.env['PORT'] ?? '8095'),
    controlToken: process.env['BOT_CONTROL_TOKEN'] ?? '',
    metricsPort: Number(process.env['BOT_METRICS_PORT'] ?? '8096'),
    wsHeartbeatIntervalMs: Number(process.env['WS_HEARTBEAT_INTERVAL_MS'] ?? '30000'),
    pushgatewayUrl: process.env['PUSHGATEWAY_URL'] ?? '',
    metricsAuthToken: process.env['METRICS_AUTH_TOKEN'] ?? '',
  };
}
