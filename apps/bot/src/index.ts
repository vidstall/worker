/**
 * Bot daemon — entry point.
 *
 * Acts as a fake participant: registers + creates a real on-chain room
 * (password-gated at the relay layer, default "123"), then joins that room's
 * relay and publishes a looping MP4 file as its video/audio, so a real user
 * who opens the room's join link and enters the password sees the bot's
 * video playing.
 *
 * CRITICAL: never log the private key.
 */
import { createSuiClient, loadNetworkConfig, loadKeypair, createLogger, loadWrtcNonstandard } from '@dvconf/shared';
import { loadBotConfig } from './config.js';
import { registerAndCreateRoom } from './chain.js';
import { BotPeer } from './bot-peer.js';
import { probeVideoDimensions, startVideoSource, startAudioSource } from './media/ffmpeg-source.js';

async function main(): Promise<void> {
  const logger = createLogger('bot');
  const botConfig = loadBotConfig();
  const networkConfig = loadNetworkConfig();
  const signer = loadKeypair('PRIVATE_KEY');
  const client = createSuiClient(networkConfig.rpcUrl);

  logger.info({ module: 'bot' }, 'registering + creating room on-chain…');
  const { roomId } = await registerAndCreateRoom(
    client,
    signer,
    networkConfig,
    { expectedParticipants: botConfig.expectedParticipants },
    logger,
  );
  const joinUrl = `${botConfig.clientUrl}/rooms/${roomId}?pw=${botConfig.roomPassword}`;
  logger.info({ module: 'bot', roomId, joinUrl }, `room created — join at: ${joinUrl}`);

  logger.info({ module: 'bot' }, 'probing MP4 dimensions/fps…');
  const dims = await probeVideoDimensions(botConfig.mp4Path);
  logger.info({ module: 'bot', ...dims }, 'probed MP4');

  const peer = new BotPeer({
    relayUrl: botConfig.relayUrl,
    roomId,
    peerId: `bot-${roomId}`,
    roomPassword: botConfig.roomPassword,
  });
  logger.info({ module: 'bot' }, 'joining relay…');
  await peer.connect();
  logger.info({ module: 'bot' }, 'joined relay, starting media…');

  const nonstandard = await loadWrtcNonstandard();
  const videoSource = new nonstandard.RTCVideoSource();
  const audioSource = new nonstandard.RTCAudioSource();

  const stopVideo = startVideoSource({ mp4Path: botConfig.mp4Path, dims, videoSource, logger });
  const stopAudio = startAudioSource({ mp4Path: botConfig.mp4Path, audioSource, logger });

  await peer.produceVideo(videoSource.createTrack());
  await peer.produceAudio(audioSource.createTrack());
  logger.info({ module: 'bot' }, 'producing video + audio — bot is live');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ module: 'bot', signal }, 'shutting down…');
    stopVideo();
    stopAudio();
    peer.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
