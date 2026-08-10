/**
 * HTTP metrics server for relay daemon — shared types + constants.
 *
 * Pure extraction from metrics-server.ts: the request/response body shapes,
 * the RO-020 probe types, and the shared JSON response headers. See
 * metrics-server.ts's module docstring for the full endpoint list.
 */

import type { Gauge } from 'prom-client';
import type { RoomState } from './room-handler.js';
import type { PeerQualitySample, PeerQualityAggregates } from './stats-window.js';

/**
 * Shared response headers (P17 M2b-P7, DOH-029). `access-control-allow-origin: *`
 * lets the browser dashboard's `useDaemonHealthz` hook fetch the relay's /healthz
 * cross-origin (parallel to the shared healthz.ts edit). CORS ONLY — the relay's
 * /healthz stays always-2xx (F1 = Option A; its standby polls it via
 * relay-heartbeat.ts:82 2xx-range, so no isLive-503 is wired here).
 */
export const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
} as const;

/**
 * Snapshot of this relay's standby-liveness state for a /api/probe response.
 *
 * Resolved lazily on each probe so it always reflects current topology (the
 * RoomAssigned poller flips `role`; the warm-pipe coordinator sets the pipe
 * consumer). All fields are plain booleans/strings — no mediasoup types leak
 * across the HTTP boundary.
 */
export interface ProbeState {
  /** 'primary' (relay_ids[0]) or 'standby' (relay_ids[1..]) for this relay. */
  role: 'primary' | 'standby' | 'unknown';
  /**
   * The standby's pipe consumer is open (warm pipe established). A dead/absent
   * pipe consumer => the standby cannot resume media => not live.
   */
  pipeConsumerAlive: boolean;
  /** RTCP keepalive is flowing on the warm pipe (REQ-RO-005). */
  rtcpAlive: boolean;
  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay pipe
   * TRANSPORT (bytesReceived + bytesSent). A DIRECT live measure that cross-relay
   * active-forward RTP crossed (>0 => bytes traversed the pipe), independent of
   * the paused keepalive consumer's rtcpAlive. Defaults to 0 (additive).
   */
  pipeBytesObserved?: number;
}

/**
 * Resolves the current {@link ProbeState}. Injected by the daemon wiring
 * (index.ts) so the metrics server stays decoupled from topology state.
 * Returns `undefined` when probe state is not available (no provider wired).
 */
export type ProbeStateProvider = () => ProbeState | undefined;

/** Liveness JSON returned by GET /api/probe (RO-020 standby contract). */
export interface ProbeResponse {
  /**
   * Standby liveness verdict. true ONLY when role==='standby' AND the pipe
   * consumer is alive AND RTCP keepalive is flowing. The validator gates the
   * standby SessionProof's duration_seconds on this: ok:true => duration > 0;
   * ok:false (or an unanswered probe) => duration_seconds = 0.
   * A primary always answers ok:true (it is the live media path).
   */
  ok: boolean;
  /** This relay's role for the room ('primary' | 'standby' | 'unknown'). */
  role: 'primary' | 'standby' | 'unknown';
  /** Wall-clock timestamp (ms epoch) the probe was answered. */
  ts: number;
  /**
   * SERVER-HANDLING round-trip in ms (time spent building this response) — NOT
   * the media-plane RTP RTT. Lets the validator record handling latency without
   * mistaking it for a media measurement.
   */
  latency_ms: number;
  /** Whether the standby's warm-pipe consumer is open. */
  pipe_consumer_alive: boolean;
  /** Whether RTCP keepalive is flowing on the warm pipe. */
  rtcp_alive: boolean;
  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay pipe
   * transport (bytesReceived + bytesSent). >0 proves cross-relay active-forward
   * RTP actually crossed the pipe (DIRECT live measure). 0 for primary / unwired.
   */
  pipe_bytes_observed: number;
}

export interface StatsReportBody {
  roomId: string;
  peerId: string;
  sample: PeerQualitySample;
  /**
   * Client-computed cumulative avg/min/max per field since the peer joined
   * this room (RoomPage.tsx's aggregator ref) -- OPTIONAL: absent for any
   * client (e.g. the bot's stats-reporter.ts) that doesn't maintain one.
   */
  aggregates?: PeerQualityAggregates;
}

/** Resolves the live room state a peer must be admitted into. Injected by index.ts. */
export type GetRoomFn = (roomId: string) => RoomState | undefined;

export interface ClientLogEntry {
  level: string;
  module: string;
  message: string;
  context?: unknown;
  timestamp: string;
}

export interface LogsReportBody {
  roomId: string;
  peerId: string;
  entries: ClientLogEntry[];
}

export interface RelayDownHintBody {
  roomId: string;
  peerId: string;
}

export const REQUIRED_SAMPLE_FIELDS: ReadonlyArray<keyof PeerQualitySample> = [
  'latencyMs',
  'packetLoss',
  'jitterMs',
  'bitrateUpKbps',
  'bitrateDownKbps',
  'resolutionWidth',
  'resolutionHeight',
  'framerate',
  'packetReorderingRate',
  'encodeLatencyMs',
  'decodeLatencyMs',
  'freezeCount',
  'pauseCount',
  'connectionSetupMs',
  'iceSuccess',
  'reconnectMs',
  'avSyncDriftMs',
];

/** Per-field Prometheus gauges for the `/metrics/prom` peer-quality export. */
export interface PeerQualityGauges {
  latencyMs: Gauge<'roomId' | 'peerId'>;
  packetLoss: Gauge<'roomId' | 'peerId'>;
  jitterMs: Gauge<'roomId' | 'peerId'>;
  bitrateUpKbps: Gauge<'roomId' | 'peerId'>;
  bitrateDownKbps: Gauge<'roomId' | 'peerId'>;
  resolutionWidth: Gauge<'roomId' | 'peerId'>;
  resolutionHeight: Gauge<'roomId' | 'peerId'>;
  framerate: Gauge<'roomId' | 'peerId'>;
  packetReorderingRate: Gauge<'roomId' | 'peerId'>;
  encodeLatencyMs: Gauge<'roomId' | 'peerId'>;
  decodeLatencyMs: Gauge<'roomId' | 'peerId'>;
  freezeCount: Gauge<'roomId' | 'peerId'>;
  pauseCount: Gauge<'roomId' | 'peerId'>;
  connectionSetupMs: Gauge<'roomId' | 'peerId'>;
  iceSuccess: Gauge<'roomId' | 'peerId'>;
  reconnectMs: Gauge<'roomId' | 'peerId'>;
  avSyncDriftMs: Gauge<'roomId' | 'peerId'>;
}

/**
 * Base Prometheus metric name + help text per `PeerQualitySample` field —
 * the single source of truth both the current-value gauges AND the
 * cumulative avg/min/max gauges (`buildPeerQualityAggregateGauges`) are
 * generated from, so the two stay in sync without hand-duplicating 17
 * name/help pairs three times over.
 */
export const PEER_QUALITY_METRIC_INFO: Record<keyof PeerQualitySample, { name: string; help: string }> = {
  latencyMs: { name: 'dvconf_relay_peer_latency_ms', help: 'Client-reported RTT/latency, ms' },
  packetLoss: { name: 'dvconf_relay_peer_packet_loss', help: 'Client-reported packet loss' },
  jitterMs: { name: 'dvconf_relay_peer_jitter_ms', help: 'Client-reported jitter, ms' },
  bitrateUpKbps: { name: 'dvconf_relay_peer_bitrate_up_kbps', help: 'Client-reported uplink bitrate, kbps' },
  bitrateDownKbps: {
    name: 'dvconf_relay_peer_bitrate_down_kbps',
    help: 'Client-reported downlink bitrate, kbps',
  },
  resolutionWidth: { name: 'dvconf_relay_peer_resolution_width', help: 'Client-reported video width, px' },
  resolutionHeight: {
    name: 'dvconf_relay_peer_resolution_height',
    help: 'Client-reported video height, px',
  },
  framerate: { name: 'dvconf_relay_peer_framerate', help: 'Client-reported framerate, fps' },
  packetReorderingRate: {
    name: 'dvconf_relay_peer_packet_reordering_rate',
    help: 'Client-reported APPROXIMATE packet reordering rate',
  },
  encodeLatencyMs: { name: 'dvconf_relay_peer_encode_latency_ms', help: 'Client-reported encode latency, ms' },
  decodeLatencyMs: { name: 'dvconf_relay_peer_decode_latency_ms', help: 'Client-reported decode latency, ms' },
  freezeCount: { name: 'dvconf_relay_peer_freeze_count', help: 'Client-reported cumulative freeze count' },
  pauseCount: { name: 'dvconf_relay_peer_pause_count', help: 'Client-reported cumulative pause count' },
  connectionSetupMs: {
    name: 'dvconf_relay_peer_connection_setup_ms',
    help: 'Client-reported connection-setup time, ms',
  },
  iceSuccess: {
    name: 'dvconf_relay_peer_ice_success',
    help: 'Client-reported ICE success (1) / failure (0)',
  },
  reconnectMs: { name: 'dvconf_relay_peer_reconnect_ms', help: 'Client-reported reconnect time, ms' },
  avSyncDriftMs: {
    name: 'dvconf_relay_peer_av_sync_drift_ms',
    help: "Client-reported audio-vs-video sync offset, ms (audio playout timestamp minus video's; positive = audio ahead)",
  },
};
