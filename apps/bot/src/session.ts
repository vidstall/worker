/**
 * BotSession — a reusable, parameterized version of the bot's one-shot flow
 * (extracted from the old index.ts), driving:
 *   register (idempotent) → create-or-join a room → resolve the room's REAL
 *   relay endpoint on-chain → join that relay → produce whichever of
 *   video/audio the requested media mode calls for.
 *
 * Multiple sessions can run concurrently in one process (server.ts holds a
 * `Map<string, BotSession>`), so nothing here is process-global except the
 * lazy `@roamhq/wrtc` nonstandard-surface cache in wrtc-globals.ts (which is
 * safe to share).
 */
import { randomUUID } from 'node:crypto';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { loadWrtcNonstandard } from '@dvconf/shared';
import {
  registerUser,
  createRoom,
  resolveRoomRelayUrl,
  CREATE_ROOM_POLL_OPTS,
  JOIN_ROOM_POLL_OPTS,
} from './chain.js';
import { BotPeer } from './bot-peer.js';
import { probeVideoDimensions, startVideoSource, startAudioSource } from './media/ffmpeg-source.js';
import type { BotConfig } from './config.js';

export type RoomMode = 'create' | 'join';
export type MediaMode = 'listen' | 'camera' | 'mic' | 'both';

export interface BotSessionOptions {
  roomMode: RoomMode;
  /** Required when roomMode === 'join'. */
  roomId?: string;
  mediaMode: MediaMode;
  /** Falls back to the daemon-level config default when omitted. */
  mp4Path?: string;
}

export interface BotSession {
  id: string;
  roomId: string;
  mediaMode: MediaMode;
  joinUrl: string;
  startedAt: number;
  stop(): void;
}

export interface StartBotSessionDeps {
  client: SuiClient;
  signer: Ed25519Keypair;
  networkConfig: NetworkConfig;
  botConfig: BotConfig;
  logger: Logger;
}

function wantsVideo(mediaMode: MediaMode): boolean {
  return mediaMode === 'camera' || mediaMode === 'both';
}

function wantsAudio(mediaMode: MediaMode): boolean {
  return mediaMode === 'mic' || mediaMode === 'both';
}

export async function startBotSession(
  opts: BotSessionOptions,
  deps: StartBotSessionDeps,
): Promise<BotSession> {
  const { client, signer, networkConfig, botConfig, logger } = deps;

  if (opts.roomMode === 'join' && (!opts.roomId || opts.roomId.trim() === '')) {
    throw new Error('startBotSession: roomId is required when roomMode is "join"');
  }

  const id = randomUUID();
  const mp4Path = opts.mp4Path ?? botConfig.mp4Path;

  logger.info({ module: 'bot-session', sessionId: id }, 'registering user on-chain (idempotent)…');
  await registerUser(client, signer, networkConfig, logger);

  let roomId: string;
  let relayUrl: string;

  if (opts.roomMode === 'create') {
    logger.info({ module: 'bot-session', sessionId: id }, 'creating room on-chain…');
    const created = await createRoom(
      client,
      signer,
      networkConfig,
      { expectedParticipants: botConfig.expectedParticipants },
      logger,
    );
    roomId = created.roomId;
    logger.info(
      { module: 'bot-session', sessionId: id, roomId },
      'room created — polling for relay assignment (cp-daemon must be running)…',
    );
    relayUrl = await resolveRoomRelayUrl(client, networkConfig, roomId, logger, CREATE_ROOM_POLL_OPTS);
  } else {
    roomId = opts.roomId!;
    logger.info(
      { module: 'bot-session', sessionId: id, roomId },
      'joining existing room — resolving current relay assignment…',
    );
    relayUrl = await resolveRoomRelayUrl(client, networkConfig, roomId, logger, JOIN_ROOM_POLL_OPTS);
  }

  const joinUrl = `${botConfig.clientUrl}/rooms/${roomId}?pw=${botConfig.roomPassword}`;

  const peer = new BotPeer({
    relayUrl,
    roomId,
    peerId: `bot-${id}`,
    roomPassword: botConfig.roomPassword,
  });
  logger.info({ module: 'bot-session', sessionId: id, relayUrl }, 'joining relay…');
  await peer.connect();
  logger.info({ module: 'bot-session', sessionId: id, mediaMode: opts.mediaMode }, 'joined relay, starting media…');

  const stopFns: Array<() => void> = [];

  if (wantsVideo(opts.mediaMode) || wantsAudio(opts.mediaMode)) {
    const nonstandard = await loadWrtcNonstandard();

    if (wantsVideo(opts.mediaMode)) {
      const dims = await probeVideoDimensions(mp4Path);
      const videoSource = new nonstandard.RTCVideoSource();
      stopFns.push(startVideoSource({ mp4Path, dims, videoSource, logger }));
      await peer.produceVideo(videoSource.createTrack());
    }

    if (wantsAudio(opts.mediaMode)) {
      const audioSource = new nonstandard.RTCAudioSource();
      stopFns.push(startAudioSource({ mp4Path, audioSource, logger }));
      await peer.produceAudio(audioSource.createTrack());
    }
  }

  logger.info(
    { module: 'bot-session', sessionId: id, roomId, mediaMode: opts.mediaMode, joinUrl },
    `bot session live — join at: ${joinUrl}`,
  );

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    logger.info({ module: 'bot-session', sessionId: id }, 'stopping bot session…');
    for (const stopFn of stopFns) stopFn();
    peer.close();
  };

  return {
    id,
    roomId,
    mediaMode: opts.mediaMode,
    joinUrl,
    startedAt: Date.now(),
    stop,
  };
}
