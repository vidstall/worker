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
import type { NetworkConfig, Logger, WrtcNonstandard } from '@dvconf/shared';
import { loadWrtcNonstandard } from '@dvconf/shared';
import {
  registerUser,
  createRoom,
  createEscrow,
  resolveRoomRelayUrl,
  getStandbyRelayUrls,
  CREATE_ROOM_POLL_OPTS,
  JOIN_ROOM_POLL_OPTS,
} from './chain.js';
import { BotPeer } from './bot-peer.js';
import { createStandbyFlapGate, wsToProbeUrl } from './standby-flap-gate.js';
import { probeVideoDimensions, startVideoSource, startAudioSource, type MediaTrack } from './media/ffmpeg-source.js';
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
  /** True once a relay death couldn't be recovered (no standby assigned, or
   *  the standby was also unhealthy/unreachable) — the session keeps running
   *  in whatever last-known-good state it had, but media has stopped flowing. */
  isDegraded(): boolean;
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
  onFfmpegRespawn?: (track: MediaTrack) => void;
  onFfmpegStderrData?: (track: MediaTrack) => void;
  onFrameDrop?: (track: MediaTrack) => void;
  /** Fires when a pacing loop fed a placeholder (silence for audio, a
   *  repeated frame for video) in place of a genuinely missing chunk
   *  (ffmpeg itself behind schedule, not just a delayed timer tick).
   *  `index.ts` wires this to `dvconf_bot_underruns_total{track}`. */
  onUnderrun?: (track: MediaTrack) => void;
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
    onUnderrun,
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

  // Hoisted above peer construction so handleRelayDeath's closure (wired into
  // the very first BotPeer below) can read it — a user-initiated stop() sets
  // this BEFORE closing the peer, so its own resulting WS close can never
  // trigger a bogus cutover attempt (see handleRelayDeath's first check).
  let stopped = false;
  // Guards against overlapping cutover attempts (defensive — in practice only
  // one relay is ever "current" at a time, so at most one onRelayClosed fires).
  let cutoverInFlight = false;
  // True once a relay death couldn't be recovered (no standby, or the standby
  // was also unhealthy) — surfaced via BotSession.isDegraded()/GET /bots.
  let degraded = false;

  /**
   * Fired when the currently-active relay's WS closes (expected — the relay
   * died) — attempt an immediate cutover to the room's standby, mirroring the
   * browser client's fix for the same problem (services/client's useRelay.ts).
   * Re-resolves assigned_relays fresh from chain each call, so a SECOND death
   * (of the now-active former-standby) naturally picks up whatever the
   * on-chain CP-quorum replacement-voting has since voted in — AND, even
   * before that promotion has landed on-chain, tries every OTHER assigned
   * standby in order (not just assigned_relays[1]) rather than only ever
   * retrying the one that just died. Fails fast (no retry loop) once every
   * candidate is exhausted — this is a test harness, a clear degraded signal
   * is more useful than retrying forever.
   */
  const handleRelayDeath = async (): Promise<void> => {
    if (stopped || cutoverInFlight) return;
    cutoverInFlight = true;
    try {
      logger.warn(
        { module: 'bot-session', sessionId: id, roomId },
        'primary relay WS closed — attempting standby cutover',
      );
      const standbyUrls = await getStandbyRelayUrls(client, networkConfig, roomId, logger);
      if (standbyUrls.length === 0) {
        logger.error(
          { module: 'bot-session', sessionId: id, roomId },
          'relay died and no standby is assigned — bot session degraded',
        );
        degraded = true;
        return;
      }
      // Try each candidate in order, attempting a REAL connect (not just the
      // health probe) before giving up on it. getStandbyRelayUrls re-resolves
      // the SAME fixed assigned-relay order every call, so on a SECOND death
      // (of the relay we just cut over to), candidate[0] is that just-died
      // relay again — and createStandbyFlapGate's probe is FAIL-OPEN (a
      // timeout/reject reads as "healthy"), so a truly-dead relay routinely
      // passes the gate. Without a per-candidate connect attempt + fallback,
      // picking-then-committing to the first gate-passing candidate meant a
      // single connect failure from that stale-healthy dead relay aborted the
      // WHOLE cutover, leaving every OTHER genuinely-healthy standby untried
      // (confirmed live twice: once via a 502 from a dead relay's edge proxy,
      // once via a TLS EPROTO/"SSL alert internal error" from a redeployed
      // relay). Mirrors the browser client's runOneCutoverPass
      // (standby-cutover.ts), which already retries the next candidate on a
      // real connect failure.
      let cutOver = false;
      for (const candidate of standbyUrls) {
        const gate = createStandbyFlapGate({ probeUrl: `${wsToProbeUrl(candidate)}/api/probe` });
        if (!(await gate.check())) {
          logger.warn(
            { module: 'bot-session', sessionId: id, roomId, candidate },
            'standby candidate reported unhealthy — trying next assigned relay',
          );
          continue;
        }
        try {
          const newPeer = new BotPeer({
            relayUrl: candidate,
            roomId,
            peerId: `bot-${id}`,
            roomPassword: botConfig.roomPassword,
            logger,
            onRelayClosed: () => {
              void handleRelayDeath();
            },
            heartbeatIntervalMs: botConfig.wsHeartbeatIntervalMs,
          });
          await newPeer.connect();
          if (videoSource) await newPeer.produceVideo(videoSource.createTrack());
          if (audioSource) await newPeer.produceAudio(audioSource.createTrack());
          // The OLD peer's ws already closed itself (that's why we're here) —
          // this just tears down its transports/stats-reporter. A WS 'close'
          // event fires exactly once per socket, so this does NOT re-trigger
          // onRelayClosed.
          peer.close();
          peer = newPeer;
          degraded = false;
          cutOver = true;
          logger.info(
            { module: 'bot-session', sessionId: id, roomId, standbyUrl: candidate },
            'bot session cut over to standby relay',
          );
          break;
        } catch (err) {
          logger.warn(
            { module: 'bot-session', sessionId: id, roomId, candidate, err },
            'standby candidate connect/produce failed — trying next assigned relay',
          );
        }
      }
      if (!cutOver) {
        logger.error(
          { module: 'bot-session', sessionId: id, roomId, standbyUrls },
          'every assigned standby failed health probe or connect — bot session degraded',
        );
        degraded = true;
      }
    } catch (err) {
      logger.error(
        { module: 'bot-session', sessionId: id, roomId, err },
        'standby cutover failed — bot session degraded',
      );
      degraded = true;
    } finally {
      cutoverInFlight = false;
    }
  };

  let peer = new BotPeer({
    relayUrl,
    roomId,
    peerId: `bot-${id}`,
    roomPassword: botConfig.roomPassword,
    logger,
    onRelayClosed: () => {
      void handleRelayDeath();
    },
    heartbeatIntervalMs: botConfig.wsHeartbeatIntervalMs,
  });
  logger.info({ module: 'bot-session', sessionId: id, relayUrl }, 'joining relay…');
  await timePhase('ws_connect', () => peer.connect());
  logger.info({ module: 'bot-session', sessionId: id, mediaMode: opts.mediaMode }, 'joined relay, starting media…');

  const stopFns: Array<() => void> = [];
  // Lifted out of the media_start block below so handleRelayDeath can mint
  // fresh tracks (.createTrack()) from the SAME still-running ffmpeg pacing
  // loop on cutover, instead of restarting ffmpeg — mirrors the browser fix's
  // reuse of localStreamRef.current instead of re-acquiring getUserMedia.
  let videoSource: InstanceType<WrtcNonstandard['RTCVideoSource']> | null = null;
  let audioSource: InstanceType<WrtcNonstandard['RTCAudioSource']> | null = null;

  if (wantsVideo(opts.mediaMode) || wantsAudio(opts.mediaMode)) {
    await timePhase('media_start', async () => {
      const nonstandard = await loadWrtcNonstandard();
      // Shared across both tracks so their independent pacing loops target
      // the same absolute timeline instead of drifting apart -- see
      // computeDueCount in ffmpeg-source.ts.
      const mediaStartedAt = Date.now();

      if (wantsVideo(opts.mediaMode)) {
        const dims = await probeVideoDimensions(mp4Path);
        videoSource = new nonstandard.RTCVideoSource();
        stopFns.push(
          startVideoSource({
            mp4Path,
            dims,
            videoSource,
            logger,
            mediaStartedAt,
            onFrameDrop,
            onStderrData: onFfmpegStderrData,
            onRespawn: onFfmpegRespawn,
            onUnderrun,
          }),
        );
        await peer.produceVideo(videoSource.createTrack());
      }

      if (wantsAudio(opts.mediaMode)) {
        audioSource = new nonstandard.RTCAudioSource();
        stopFns.push(
          startAudioSource({
            mp4Path,
            audioSource,
            logger,
            mediaStartedAt,
            onFrameDrop,
            onStderrData: onFfmpegStderrData,
            onRespawn: onFfmpegRespawn,
            onUnderrun,
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
    isDegraded: () => degraded,
    startedAt: Date.now(),
    stop,
  };
}
