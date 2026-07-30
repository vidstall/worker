/**
 * One-shot dev/demo bot — the old pre-server default behavior, kept as a
 * thin script for local convenience (`pnpm --filter bot run dev:once`) so
 * you don't need to run the HTTP control server + curl a `POST /bots` just
 * to smoke-test the bot against a local relay/cp-daemon.
 *
 * Imports `startBotSession` directly from `session.ts` — no logic is
 * duplicated here, this only wires config + a single call + SIGTERM/SIGINT.
 *
 * Overridable via env for local dev flexibility:
 *   ROOM_MODE  — 'create' (default) | 'join'
 *   ROOM_ID    — required when ROOM_MODE=join
 *   MEDIA_MODE — 'listen' | 'camera' | 'mic' | 'both' (default)
 *
 * CRITICAL: never log the private key.
 */
import { createSuiClient, createGraphQLClient, loadNetworkConfig, loadKeypair, createLogger } from '@dvconf/shared';
import { loadBotConfig } from './config.js';
import { startBotSession, type MediaMode, type RoomMode } from './session.js';

const VALID_ROOM_MODES: ReadonlySet<string> = new Set(['create', 'join']);
const VALID_MEDIA_MODES: ReadonlySet<string> = new Set(['listen', 'camera', 'mic', 'both']);

function readRoomMode(): RoomMode {
  const raw = process.env['ROOM_MODE'] ?? 'create';
  if (!VALID_ROOM_MODES.has(raw)) {
    throw new Error(`ROOM_MODE must be "create" or "join", got: ${raw}`);
  }
  return raw as RoomMode;
}

function readMediaMode(): MediaMode {
  const raw = process.env['MEDIA_MODE'] ?? 'both';
  if (!VALID_MEDIA_MODES.has(raw)) {
    throw new Error(`MEDIA_MODE must be one of listen/camera/mic/both, got: ${raw}`);
  }
  return raw as MediaMode;
}

async function main(): Promise<void> {
  const logger = createLogger('bot-run-once');
  const botConfig = loadBotConfig();
  const networkConfig = loadNetworkConfig();
  const signer = loadKeypair('PRIVATE_KEY');
  const client = createSuiClient(networkConfig.rpcUrl);
  const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');

  const roomMode = readRoomMode();
  const roomId = process.env['ROOM_ID'];
  if (roomMode === 'join' && !roomId) {
    throw new Error('ROOM_ID is required when ROOM_MODE=join');
  }
  const mediaMode = readMediaMode();

  const session = await startBotSession(
    { roomMode, roomId, mediaMode },
    { client, signer, networkConfig, botConfig, logger, graphqlClient },
  );
  logger.info(
    { module: 'bot-run-once', roomId: session.roomId, joinUrl: session.joinUrl },
    'bot session live — press Ctrl+C to stop',
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ module: 'bot-run-once', signal }, 'shutting down…');
    session.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
