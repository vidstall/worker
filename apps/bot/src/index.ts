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
import { createSuiClient, loadNetworkConfig, loadKeypair, createLogger } from '@dvconf/shared';
import { loadBotConfig } from './config.js';
import { startBotSession, type BotSession, type BotSessionOptions } from './session.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const logger = createLogger('bot');
  const botConfig = loadBotConfig();
  const networkConfig = loadNetworkConfig();
  const signer = loadKeypair('PRIVATE_KEY');
  const client = createSuiClient(networkConfig.rpcUrl);

  const startSession = (opts: BotSessionOptions): Promise<BotSession> =>
    startBotSession(opts, { client, signer, networkConfig, botConfig, logger });

  const { server, sessions } = startServer(
    { port: botConfig.port, controlToken: botConfig.controlToken, startSession },
    logger,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ module: 'bot', signal, activeSessions: sessions.size }, 'shutting down…');
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
