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
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { loadWrtcNonstandard } from '@dvconf/shared';
import {
  registerUser,
  createRoom,
  createEscrow,
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
  /**
   * Optional. devnet's public fullnode returns empty `events` on the
   * JSON-RPC execute response (event-shaped reads are deprecated there);
   * when provided, `createRoom`'s RoomCreated lookup is backfilled via
   * GraphQL instead of the (empty) JSON-RPC response.
   */
  graphqlClient?: SuiGraphQLClient;
  /**
   * Optional per-phase duration callback (ms) for the academic-eval
   * scalability dashboard's join-latency breakdown -- kept as a plain
   * callback rather than importing a `prom-client` type directly, so this
   * module (and its unit tests, which mock the whole `@dvconf/shared`
   * import) stay decoupled from the metrics registry. `index.ts` wires this
   * to `dvconf_bot_join_phase_seconds`.
   */
  onJoinPhase?: (phase: string, ms: number) => void;
  /**
   * Monitoring-redesign gap #1: ffmpeg pipeline health counters, same
   * decoupled-callback shape as `onJoinPhase` above. `index.ts` wires these
   * to `dvconf_bot_ffmpeg_respawns_total`/`_stderr_lines_total`/
   * `dvconf_bot_frame_drops_total`.
   */
  onFfmpegRespawn?: () => void;
  onFfmpegStderrData?: () => void;
  onFrameDrop?: () => void;
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
  const {
    client,
    signer,
    networkConfig,
    botConfig,
    logger,
    onJoinPhase,
    graphqlClient,
    onFfmpegRespawn,
    onFfmpegStderrData,
    onFrameDrop,
  } = deps;

  if (opts.roomMode === 'join' && (!opts.roomId || opts.roomId.trim() === '')) {
    throw new Error('startBotSession: roomId is required when roomMode is "join"');
  }

  const id = randomUUID();
  const mp4Path = opts.mp4Path ?? botConfig.mp4Path;

  // Each phase below is already a sequential, isolated await bracketed by
  // log calls -- timing is a pure addition, no control-flow change.
  const timePhase = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      onJoinPhase?.(phase, Date.now() - t0);
    }
  };

  logger.info({ module: 'bot-session', sessionId: id }, 'registering user on-chain (idempotent)…');
  await timePhase('register', () => registerUser(client, signer, networkConfig, logger));

  let roomId: string;
  let relayUrl: string;

  if (opts.roomMode === 'create') {
    logger.info({ module: 'bot-session', sessionId: id }, 'creating room on-chain…');
    const created = await timePhase('create_room', () =>
      createRoom(
        client,
        signer,
        networkConfig,
        { expectedParticipants: botConfig.expectedParticipants },
        logger,
        graphqlClient,
      ),
    );
    roomId = created.roomId;
    logger.info({ module: 'bot-session', sessionId: id, roomId }, 'room created — depositing escrow…');
    await timePhase('create_escrow', () => createEscrow(client, signer, networkConfig, roomId, logger));
    logger.info(
      { module: 'bot-session', sessionId: id, roomId },
      'escrow deposited — polling for relay assignment (cp-daemon must be running)…',
    );
    relayUrl = await timePhase('resolve_relay', () =>
      resolveRoomRelayUrl(client, networkConfig, roomId, logger, CREATE_ROOM_POLL_OPTS),
    );
  } else {
    roomId = opts.roomId!;
    logger.info(
      { module: 'bot-session', sessionId: id, roomId },
      'joining existing room — resolving current relay assignment…',
    );
    relayUrl = await timePhase('resolve_relay', () =>
      resolveRoomRelayUrl(client, networkConfig, roomId, logger, JOIN_ROOM_POLL_OPTS),
    );
  }

  const joinUrl = `${botConfig.clientUrl}/rooms/${roomId}?pw=${botConfig.roomPassword}`;

  const peer = new BotPeer({
    relayUrl,
    roomId,
    peerId: `bot-${id}`,
    roomPassword: botConfig.roomPassword,
    logger,
  });
  logger.info({ module: 'bot-session', sessionId: id, relayUrl }, 'joining relay…');
  await timePhase('ws_connect', () => peer.connect());
  logger.info({ module: 'bot-session', sessionId: id, mediaMode: opts.mediaMode }, 'joined relay, starting media…');

  const stopFns: Array<() => void> = [];

  if (wantsVideo(opts.mediaMode) || wantsAudio(opts.mediaMode)) {
    await timePhase('media_start', async () => {
      const nonstandard = await loadWrtcNonstandard();

      if (wantsVideo(opts.mediaMode)) {
        const dims = await probeVideoDimensions(mp4Path);
        const videoSource = new nonstandard.RTCVideoSource();
        stopFns.push(
          startVideoSource({
            mp4Path,
            dims,
            videoSource,
            logger,
            onFrameDrop,
            onStderrData: onFfmpegStderrData,
            onRespawn: onFfmpegRespawn,
          }),
        );
        await peer.produceVideo(videoSource.createTrack());
      }

      if (wantsAudio(opts.mediaMode)) {
        const audioSource = new nonstandard.RTCAudioSource();
        stopFns.push(
          startAudioSource({
            mp4Path,
            audioSource,
            logger,
            onFrameDrop,
            onStderrData: onFfmpegStderrData,
            onRespawn: onFfmpegRespawn,
          }),
        );
        await peer.produceAudio(audioSource.createTrack());
      }
    });
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
