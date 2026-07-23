/**
 * Bot daemon configuration — env parsing.
 *
 * On-chain object IDs / SUI_NETWORK / PRIVATE_KEY are loaded via
 * `@dvconf/shared`'s `loadNetworkConfig()`/`loadKeypair()` (same convention as
 * every other daemon, e.g. `apps/relay`) rather than reinvented here.
 */
import 'dotenv/config';

export interface BotConfig {
  /** Path to the MP4 file the bot loops as its published video/audio. */
  mp4Path: string;
  /** Room admission password. Default "123" per the demo requirement. */
  roomPassword: string;
  /** `expected_participants` passed to `room_manager::create_room`. */
  expectedParticipants: number;
  /** Relay WS URL, e.g. ws://localhost:4000. Static — the bot joins exactly
   *  one relay for one room, so it does not need the client's on-chain
   *  relay-discovery machinery. */
  relayUrl: string;
  /** Base URL of the client webapp, used to build the shareable join link. */
  clientUrl: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadBotConfig(): BotConfig {
  return {
    mp4Path: requireEnv('MP4_PATH'),
    roomPassword: process.env['ROOM_PASSWORD'] || '123',
    expectedParticipants: Number(process.env['EXPECTED_PARTICIPANTS'] ?? '4'),
    relayUrl: process.env['RELAY_URL'] || 'ws://localhost:4000',
    clientUrl: process.env['CLIENT_URL'] || 'http://localhost:5173',
  };
}
