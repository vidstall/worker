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

// Baked into the Docker image (apps/bot/assets/001.mp4, COPY'd by the
// Dockerfile) so a session works out of the box without the operator having
// to supply MP4_PATH -- it's still overridable per-session via POST /bots'
// `mp4Path`, or globally via the MP4_PATH env var for local dev.
const DEFAULT_MP4_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', '001.mp4');

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
  };
}
