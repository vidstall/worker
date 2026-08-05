/**
 * Bot-side connection-quality reporter — mirrors services/client/client/src/
 * hooks/useConnectionStats.ts's getStats()-polling + POST-to-relay logic
 * (REQ-MCS-VIZ), so the bot's send transport shows up in cli/observer's
 * user/ metrics the same way a real browser participant does. Without this,
 * the relay only ever sees the bot's SERVER-observed RTC stats
 * (dvconf_rtc_*, apps/relay/src/rtc-quality-metrics.ts) — the bot never
 * self-reports the client-side dvconf_relay_peer_* sample
 * cli/observer/metrics_user.py::collect_user_sample() actually reads, so
 * `user/<peerId>.json` never gets written for a bot session.
 *
 * Deliberately duplicated (not imported) from the client package: apps/bot
 * is a separate Node/pnpm workspace with no existing dependency on the
 * browser React app, and extractRawSample()/computeDeltaStats() are a
 * small, stable, already-unit-tested pure surface, not worth a
 * cross-package plumbing exercise for. Keep the math byte-identical to
 * useConnectionStats.ts if that file ever changes.
 */
import type { Logger } from '@dvconf/shared';

/** Matches relay's STATS_REPORT_MIN_INTERVAL_MS
 *  (apps/relay/src/metrics-server.ts) -- reporting faster just gets
 *  rate-limited (silently 204'd), same as the browser client's poll rate. */
const POLL_INTERVAL_MS = 2000;

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

interface RawExtract {
  rtt: number;
  packetLoss: number;
  jitter: number;
  bytesSent: number;
  bytesReceived: number;
  resolutionWidth: number | null;
  resolutionHeight: number | null;
  framerate: number | null;
  totalEncodeTime: number;
  framesEncoded: number;
  totalDecodeTime: number;
  framesDecoded: number;
  freezeCount: number;
  pauseCount: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
  timestampMs: number;
}

/** Walk a getStats() report and pull the fields this reporter needs --
 *  byte-identical extraction logic to useConnectionStats.ts's
 *  extractRawSample(), minus totalFreezesDurationMs (client-panel-only,
 *  not part of relay's PeerQualitySample body). Pure — unit-tested
 *  directly, same as the client's version. */
export function extractRawSample(report: RTCStatsReport): RawExtract {
  let rtt = 0;
  let packetLoss = 0;
  let jitter = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  let resolutionWidth: number | null = null;
  let resolutionHeight: number | null = null;
  let framerate: number | null = null;
  let totalEncodeTime = 0;
  let framesEncoded = 0;
  let totalDecodeTime = 0;
  let framesDecoded = 0;
  let freezeCount = 0;
  let pauseCount = 0;
  let jitterBufferDelay = 0;
  let jitterBufferEmittedCount = 0;
  let timestampMs = 0;

  report.forEach((stat) => {
    const s = stat as Record<string, unknown>;
    if (s['type'] === 'candidate-pair' && s['nominated']) {
      rtt = Math.round((num(s['currentRoundTripTime']) ?? 0) * 1000);
    }
    if (s['type'] === 'outbound-rtp') {
      bytesSent += num(s['bytesSent']) ?? 0;
      if (s['kind'] === 'video') {
        totalEncodeTime = num(s['totalEncodeTime']) ?? 0;
        framesEncoded = num(s['framesEncoded']) ?? 0;
        timestampMs = num(s['timestamp']) ?? timestampMs;
      }
    }
    if (s['type'] === 'inbound-rtp') {
      bytesReceived += num(s['bytesReceived']) ?? 0;
      if (s['kind'] === 'video') {
        const lost = num(s['packetsLost']) ?? 0;
        const received = num(s['packetsReceived']) ?? 0;
        const total = lost + received;
        packetLoss = total > 0 ? Math.round((lost / total) * 1000) / 10 : 0;
        jitter = Math.round((num(s['jitter']) ?? 0) * 1000);
        resolutionWidth = num(s['frameWidth']) ?? resolutionWidth;
        resolutionHeight = num(s['frameHeight']) ?? resolutionHeight;
        framerate = num(s['framesPerSecond']) ?? framerate;
        totalDecodeTime = num(s['totalDecodeTime']) ?? 0;
        framesDecoded = num(s['framesDecoded']) ?? 0;
        freezeCount = num(s['freezeCount']) ?? 0;
        pauseCount = num(s['pauseCount']) ?? 0;
        jitterBufferDelay = num(s['jitterBufferDelay']) ?? 0;
        jitterBufferEmittedCount = num(s['jitterBufferEmittedCount']) ?? 0;
        timestampMs = num(s['timestamp']) ?? timestampMs;
      }
    }
  });

  return {
    rtt, packetLoss, jitter, bytesSent, bytesReceived,
    resolutionWidth, resolutionHeight, framerate,
    totalEncodeTime, framesEncoded, totalDecodeTime, framesDecoded,
    freezeCount, pauseCount,
    jitterBufferDelay, jitterBufferEmittedCount, timestampMs,
  };
}

/** Combine a send-transport extract and a recv-transport extract into one
 *  sample -- send and recv are separate RTCPeerConnections in mediasoup's
 *  architecture (BotPeer now has both, see bot-peer.ts), so a single
 *  transport's getStats() report never contains both outbound-rtp AND
 *  inbound-rtp entries; each side's extractRawSample() call only ever
 *  populates its own half of RawExtract, the other half staying at its
 *  zero/null default. Fields are disjoint by construction (outbound-only:
 *  bytesSent/totalEncodeTime/framesEncoded/rtt; inbound-only: everything
 *  else) so picking whichever side actually measured each field is safe --
 *  no ambiguity between "measured zero" and "not applicable" to resolve.
 *  `timestampMs` takes the recv side's value: the jitter/decode-latency
 *  deltas this sample ultimately feeds are anchored to the receive-side
 *  clock. Pure -- unit-tested directly. */
export function mergeRawExtract(send: RawExtract, recv: RawExtract): RawExtract {
  return {
    rtt: send.rtt,
    packetLoss: recv.packetLoss,
    jitter: recv.jitter,
    bytesSent: send.bytesSent,
    bytesReceived: recv.bytesReceived,
    resolutionWidth: recv.resolutionWidth,
    resolutionHeight: recv.resolutionHeight,
    framerate: recv.framerate,
    totalEncodeTime: send.totalEncodeTime,
    framesEncoded: send.framesEncoded,
    totalDecodeTime: recv.totalDecodeTime,
    framesDecoded: recv.framesDecoded,
    freezeCount: recv.freezeCount,
    pauseCount: recv.pauseCount,
    jitterBufferDelay: recv.jitterBufferDelay,
    jitterBufferEmittedCount: recv.jitterBufferEmittedCount,
    timestampMs: recv.timestampMs || send.timestampMs,
  };
}

interface CumulativeSample {
  timestampMs: number;
  bytesSent: number;
  bytesReceived: number;
  totalEncodeTime: number;
  framesEncoded: number;
  totalDecodeTime: number;
  framesDecoded: number;
  jitterBufferDelay: number;
  jitterBufferEmittedCount: number;
}

/** Cumulative-counter delta / elapsed-ms -> a rate. 0 when there's no prior sample. */
function rate(cur: number, prev: number, elapsedMs: number, multiplier: number): number {
  if (elapsedMs <= 0) return 0;
  return ((cur - prev) * multiplier) / (elapsedMs / 1000);
}

/** Per-unit delta ratio (mirrors useConnectionStats.ts's deltaRatio): null
 *  when no new units arrived since the last poll. */
function deltaRatio(curTotal: number, prevTotal: number, curUnits: number, prevUnits: number): number | null {
  const dUnits = curUnits - prevUnits;
  if (dUnits <= 0) return null;
  return ((curTotal - prevTotal) * 1000) / dUnits;
}

export interface PeerStatsDelta {
  rtt: number;
  packetLoss: number;
  jitter: number;
  bitrateUpBps: number;
  bitrateDownBps: number;
  resolutionWidth: number | null;
  resolutionHeight: number | null;
  framerate: number | null;
  encodeLatencyMs: number | null;
  decodeLatencyMs: number | null;
  freezeCount: number;
  pauseCount: number;
  packetReorderingRateApprox: number | null;
}

/** Combine a fresh raw extract with the previous poll's cumulative sample
 *  into a full delta sample -- byte-identical math to
 *  useConnectionStats.ts's computeDeltaStats(). Pure — unit-tested. */
export function computeDeltaStats(
  cur: RawExtract,
  prev: CumulativeSample | null,
  fallbackElapsedMs: number,
): PeerStatsDelta {
  const elapsedMs = prev
    ? (cur.timestampMs && prev.timestampMs ? cur.timestampMs - prev.timestampMs : fallbackElapsedMs)
    : 0;

  const bitrateUpBps = prev ? Math.round(rate(cur.bytesSent, prev.bytesSent, elapsedMs, 8)) : 0;
  const bitrateDownBps = prev ? Math.round(rate(cur.bytesReceived, prev.bytesReceived, elapsedMs, 8)) : 0;

  const encodeLatencyMs = prev
    ? deltaRatio(cur.totalEncodeTime, prev.totalEncodeTime, cur.framesEncoded, prev.framesEncoded)
    : null;
  const decodeLatencyMs = prev
    ? deltaRatio(cur.totalDecodeTime, prev.totalDecodeTime, cur.framesDecoded, prev.framesDecoded)
    : null;
  const packetReorderingRateApprox = prev
    ? deltaRatio(
        cur.jitterBufferDelay, prev.jitterBufferDelay,
        cur.jitterBufferEmittedCount, prev.jitterBufferEmittedCount,
      )
    : null;

  return {
    rtt: cur.rtt,
    packetLoss: cur.packetLoss,
    jitter: cur.jitter,
    bitrateUpBps,
    bitrateDownBps,
    resolutionWidth: cur.resolutionWidth,
    resolutionHeight: cur.resolutionHeight,
    framerate: cur.framerate,
    encodeLatencyMs,
    decodeLatencyMs,
    freezeCount: cur.freezeCount,
    pauseCount: cur.pauseCount,
    packetReorderingRateApprox,
  };
}

interface ConnectionLifecycle {
  connectionSetupMs: number | null;
  iceSuccessRate: number | null;
  reconnectionTimeMs: number | null;
}

/** Map a computed delta sample + connection-lifecycle bookkeeping into the
 *  exact body relay's POST /stats/report expects (PeerQualitySample,
 *  apps/relay/src/stats-window.ts) -- mirrors RoomPage.tsx's REQ-MCS-VIZ POST
 *  payload construction field-for-field, including the same 0/false
 *  fallback for fields not yet available early in a session (relay's
 *  parseStatsReportBody 400s the whole report if any field isn't a finite
 *  number / iceSuccess isn't a boolean). Pure — unit-tested. */
export function buildReportSample(
  delta: PeerStatsDelta,
  lifecycle: ConnectionLifecycle,
): Record<string, number | boolean> {
  return {
    latencyMs: delta.rtt,
    packetLoss: delta.packetLoss,
    jitterMs: delta.jitter,
    bitrateUpKbps: delta.bitrateUpBps / 1000,
    bitrateDownKbps: delta.bitrateDownBps / 1000,
    resolutionWidth: delta.resolutionWidth ?? 0,
    resolutionHeight: delta.resolutionHeight ?? 0,
    framerate: delta.framerate ?? 0,
    packetReorderingRate: delta.packetReorderingRateApprox ?? 0,
    encodeLatencyMs: delta.encodeLatencyMs ?? 0,
    decodeLatencyMs: delta.decodeLatencyMs ?? 0,
    freezeCount: delta.freezeCount,
    pauseCount: delta.pauseCount,
    connectionSetupMs: lifecycle.connectionSetupMs ?? 0,
    iceSuccess: (lifecycle.iceSuccessRate ?? 0) > 0,
    reconnectMs: lifecycle.reconnectionTimeMs ?? 0,
    // Always 0: not yet computed. BotPeer does now have inbound audio/video
    // stats to work with (see bot-peer.ts's recv transport), but deriving a
    // real audio-vs-video presentation-timing offset from them is a
    // separate piece of work, deliberately out of scope for the change that
    // added consuming (see stats-reporter's dual-transport merge above) --
    // not a structural limitation like it used to be.
    avSyncDriftMs: 0,
  };
}

/** wss://... -> https://..., ws://... -> http://... -- same swap RoomPage.tsx
 *  does before hitting /stats/report: the relay's SAME public origin
 *  (Caddy path-routes /stats/report alongside the WS upgrade on :443), not
 *  a separate metrics port with no published mapping. */
export function relayHttpOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

export interface StatsReporterOptions {
  relayUrl: string;
  roomId: string;
  peerId: string;
  logger?: Logger;
}

/** The subset of mediasoup-client's `Transport` this reporter needs --
 *  duck-typed the same way useConnectionStats.ts's TransportLike is, so
 *  this file has no direct mediasoup-client import (keeps it testable with
 *  a plain mock object). */
export interface StatsTransportLike {
  getStats(): Promise<RTCStatsReport>;
  readonly connectionState: string;
  on(event: 'connectionstatechange', listener: (state: string) => void): unknown;
}

/** The two transports a bot session can report from -- `recv` is optional
 *  only for backward-compatible/test callers; BotPeer always supplies both
 *  now that it consumes other peers (see bot-peer.ts). */
export interface StatsReporterTransports {
  send: StatsTransportLike;
  recv?: StatsTransportLike | null;
}

/** Start polling both transports' `getStats()` every POLL_INTERVAL_MS,
 *  merging them into one sample (see mergeRawExtract's doc -- send and recv
 *  are separate RTCPeerConnections in mediasoup's architecture, so this is
 *  NOT two independent reports; a second independent POST per tick would
 *  overwrite the relay's per-field gauges with an incomplete report each
 *  time), and POSTing the merged sample to the relay's /stats/report side
 *  channel -- fire-and-forget, same as RoomPage.tsx's REQ-MCS-VIZ reporting
 *  effect. Failures (network, relay down, room already closed) are logged
 *  and otherwise ignored -- reporting quality metrics must never be able to
 *  disrupt the bot's actual media session. Connection-lifecycle bookkeeping
 *  (setup time / ICE success rate / reconnect time) is wired to the send
 *  transport only -- both transports typically establish at nearly the same
 *  time in practice, and splitting lifecycle tracking across two transports
 *  isn't needed for the receiver-side quality fields (jitter etc.) this
 *  dual-transport support exists for. Returns a stop() that clears the
 *  interval; BotPeer.close() calls this. */
export function startStatsReporter(transports: StatsReporterTransports, opts: StatsReporterOptions): () => void {
  const base = relayHttpOrigin(opts.relayUrl);
  const createdAt = Date.now();
  let setupMs: number | null = null;
  let iceAttempts = 0;
  let iceSuccesses = 0;
  let disconnectedAt: number | null = null;
  let reconnectionMs: number | null = null;
  let prev: CumulativeSample | null = null;

  const onStateChange = (state: string): void => {
    if (state === 'connecting') {
      iceAttempts += 1;
    } else if (state === 'connected') {
      iceSuccesses += 1;
      if (setupMs === null) setupMs = Date.now() - createdAt;
      if (disconnectedAt !== null) {
        reconnectionMs = Date.now() - disconnectedAt;
        disconnectedAt = null;
      }
    } else if (state === 'disconnected' || state === 'failed') {
      if (disconnectedAt === null) disconnectedAt = Date.now();
    }
  };
  transports.send.on('connectionstatechange', onStateChange);

  const tick = async (): Promise<void> => {
    if (transports.send.connectionState === 'closed') return;
    let sendReport: RTCStatsReport;
    try {
      sendReport = await transports.send.getStats();
    } catch (err) {
      opts.logger?.warn({ module: 'bot-stats-reporter', err }, 'getStats() failed');
      return;
    }
    const sendRaw = extractRawSample(sendReport);

    let raw = sendRaw;
    const recv = transports.recv;
    if (recv && recv.connectionState !== 'closed') {
      try {
        const recvReport = await recv.getStats();
        raw = mergeRawExtract(sendRaw, extractRawSample(recvReport));
      } catch (err) {
        opts.logger?.warn({ module: 'bot-stats-reporter', err }, 'recv getStats() failed');
      }
    }

    const delta = computeDeltaStats(raw, prev, POLL_INTERVAL_MS);
    prev = {
      timestampMs: raw.timestampMs,
      bytesSent: raw.bytesSent,
      bytesReceived: raw.bytesReceived,
      totalEncodeTime: raw.totalEncodeTime,
      framesEncoded: raw.framesEncoded,
      totalDecodeTime: raw.totalDecodeTime,
      framesDecoded: raw.framesDecoded,
      jitterBufferDelay: raw.jitterBufferDelay,
      jitterBufferEmittedCount: raw.jitterBufferEmittedCount,
    };
    const sample = buildReportSample(delta, {
      connectionSetupMs: setupMs,
      iceSuccessRate: iceAttempts > 0 ? Math.min(1, iceSuccesses / iceAttempts) : null,
      reconnectionTimeMs: reconnectionMs,
    });

    try {
      await fetch(`${base}/stats/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: opts.roomId, peerId: opts.peerId, sample }),
      });
    } catch (err) {
      opts.logger?.warn({ module: 'bot-stats-reporter', err }, 'POST /stats/report failed');
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  return () => {
    clearInterval(interval);
  };
}
