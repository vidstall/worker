/**
 * Real network probing for the Validator daemon.
 *
 * Two measurement strategies:
 * 1. STUN probing -- Send STUN Binding Requests via UDP to measure RTT, jitter, and packet loss.
 * 2. Relay metrics fetch -- HTTP GET to relay's metrics endpoint for bytes/peers/loss data.
 *
 * All numeric results use bigint (basis-point invariant -- never floating point).
 *
 * Follows RFC 5389 STUN Binding Request format.
 */

import * as dgram from 'node:dgram';
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { createLogger } from '@dvconf/shared';
import type { MeasurementProbe, ProbeSample } from './measurements.js';

const logger = createLogger('validator:probe');

/** Result of STUN probing (latency, jitter, packet loss). */
export interface StunProbeResult {
  /** Average round-trip latency in milliseconds. */
  avgLatencyMs: bigint;
  /** Latency variation (jitter) in milliseconds. */
  jitterMs: bigint;
  /** Number of probes sent. */
  probesSent: bigint;
  /** Number of successful responses received. */
  probesReceived: bigint;
  /** Packet loss in basis points (lost/sent * 10000). */
  packetLossBps: bigint;
}

/** Result of relay metrics HTTP fetch (per IC-5). */
export interface RelayMetricsResult {
  /** Total bytes forwarded by the relay for this room. */
  bytesForwarded: bigint;
  /** Number of unique peers seen in this room. */
  uniquePeers: bigint;
  /** Aggregate packets lost reported by relay. */
  packetsLost: bigint;
  /** Jitter in ms reported by relay. */
  jitter: bigint;
  /** Session duration in seconds. */
  duration: bigint;
  /** Currently active peers. */
  activePeers: bigint;
}

// ─── STUN Constants (RFC 5389) ──────────────────────────────────

/** STUN Binding Request message type: 0x0001 */
const STUN_BINDING_REQUEST = 0x0001;

/** STUN magic cookie: 0x2112A442 */
const STUN_MAGIC_COOKIE = 0x2112a442;

/** STUN header size: 20 bytes (type[2] + length[2] + cookie[4] + txn_id[12]) */
const STUN_HEADER_SIZE = 20;

/** Default number of STUN probes per measurement. */
const DEFAULT_PROBE_COUNT = 10;

/** Timeout per STUN probe in ms. */
const STUN_PROBE_TIMEOUT_MS = 3000;

/**
 * Build a STUN Binding Request packet (RFC 5389).
 *
 * Format:
 *   - Bytes 0-1:   Message type (0x0001 = Binding Request)
 *   - Bytes 2-3:   Message length (0 = no attributes)
 *   - Bytes 4-7:   Magic cookie (0x2112A442)
 *   - Bytes 8-19:  Transaction ID (96 bits, random)
 *
 * @returns [packet, transactionId] where transactionId is the 12-byte random ID.
 */
function buildStunBindingRequest(): [Buffer, Buffer] {
  const packet = Buffer.alloc(STUN_HEADER_SIZE);

  // Message type: Binding Request
  packet.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  // Message length: 0 (no attributes in a basic binding request)
  packet.writeUInt16BE(0, 2);
  // Magic cookie
  packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  // Transaction ID: 12 random bytes
  const txnId = crypto.randomBytes(12);
  txnId.copy(packet, 8);

  return [packet, txnId];
}

/**
 * Check if a UDP response is a STUN Binding Response matching our transaction ID.
 *
 * A valid response has:
 *   - At least 20 bytes
 *   - Message type 0x0101 (Binding Success Response)
 *   - Magic cookie 0x2112A442
 *   - Matching transaction ID
 */
function isStunBindingResponse(data: Buffer, expectedTxnId: Buffer): boolean {
  if (data.length < STUN_HEADER_SIZE) return false;

  const msgType = data.readUInt16BE(0);
  // 0x0101 = Binding Success Response
  if (msgType !== 0x0101) return false;

  const cookie = data.readUInt32BE(4);
  if (cookie !== STUN_MAGIC_COOKIE) return false;

  // Compare transaction ID (bytes 8-19)
  const receivedTxnId = data.subarray(8, 20);
  return Buffer.compare(receivedTxnId, expectedTxnId) === 0;
}

/**
 * Send STUN Binding Requests to a relay's public STUN endpoint via UDP.
 *
 * Measures RTT from request to response. Sends N probes, computes average
 * latency, jitter (inter-arrival variance), and packet loss.
 *
 * @param host         - Relay host (IP or hostname).
 * @param port         - Relay STUN port (typically the mediasoup RTC port).
 * @param probeCount   - Number of probes to send (default: 10).
 * @returns StunProbeResult with latency, jitter, and loss metrics.
 */
export async function stunProbe(
  host: string,
  port: number,
  probeCount: number = DEFAULT_PROBE_COUNT,
): Promise<StunProbeResult> {
  const rtts: number[] = [];
  let sent = 0;
  let received = 0;

  const socket = dgram.createSocket('udp4');

  try {
    for (let i = 0; i < probeCount; i++) {
      const rtt = await sendSingleProbe(socket, host, port);
      sent++;
      if (rtt !== null) {
        received++;
        rtts.push(rtt);
      }
    }
  } finally {
    socket.close();
  }

  // Compute average latency
  let avgLatencyMs = 0n;
  if (rtts.length > 0) {
    const sum = rtts.reduce((a, b) => a + b, 0);
    avgLatencyMs = BigInt(Math.round(sum / rtts.length));
  }

  // Compute jitter (mean absolute deviation between consecutive RTTs)
  let jitterMs = 0n;
  if (rtts.length > 1) {
    let jitterSum = 0;
    for (let i = 1; i < rtts.length; i++) {
      jitterSum += Math.abs(rtts[i] - rtts[i - 1]);
    }
    jitterMs = BigInt(Math.round(jitterSum / (rtts.length - 1)));
  }

  // Packet loss in basis points
  const packetLossBps = sent > 0
    ? BigInt(Math.round(((sent - received) / sent) * 10_000))
    : 0n;

  logger.info(
    {
      host,
      port,
      sent,
      received,
      avgLatencyMs: avgLatencyMs.toString(),
      jitterMs: jitterMs.toString(),
      lossBps: packetLossBps.toString(),
    },
    `STUN probe complete: ${received}/${sent} responses, avg=${avgLatencyMs}ms, jitter=${jitterMs}ms, loss=${packetLossBps}bp`,
  );

  return {
    avgLatencyMs,
    jitterMs,
    probesSent: BigInt(sent),
    probesReceived: BigInt(received),
    packetLossBps,
  };
}

/**
 * Send a single STUN Binding Request and wait for response.
 *
 * @returns RTT in milliseconds, or null if timed out.
 */
function sendSingleProbe(
  socket: dgram.Socket,
  host: string,
  port: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const [packet, txnId] = buildStunBindingRequest();
    const startTime = performance.now();
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.removeListener('message', onMessage);
        resolve(null);
      }
    }, STUN_PROBE_TIMEOUT_MS);

    function onMessage(data: Buffer) {
      if (!resolved && isStunBindingResponse(data, txnId)) {
        resolved = true;
        clearTimeout(timeout);
        socket.removeListener('message', onMessage);
        const rtt = performance.now() - startTime;
        resolve(rtt);
      }
    }

    socket.on('message', onMessage);

    socket.send(packet, port, host, (err) => {
      if (err && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        socket.removeListener('message', onMessage);
        logger.warn({ err, host, port }, 'STUN probe send failed');
        resolve(null);
      }
    });
  });
}

/**
 * Fetch relay metrics via HTTP GET (per IC-5).
 *
 * Endpoint: GET http://<host>:<metricsPort>/metrics/<roomId>
 *
 * @param metricsBaseUrl - Base URL of the relay metrics endpoint (e.g., "http://localhost:4001").
 * @param roomId         - Room ID to query metrics for.
 * @returns RelayMetricsResult, or null if the endpoint is unreachable or room not found.
 */
export async function fetchRelayMetrics(
  metricsBaseUrl: string,
  roomId: string,
): Promise<RelayMetricsResult | null> {
  const url = `${metricsBaseUrl}/metrics/${roomId}`;

  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode === 404) {
        logger.warn({ url, roomId }, `Relay metrics: room not found (404)`);
        resolve(null);
        res.resume(); // drain response
        return;
      }

      if (res.statusCode !== 200) {
        logger.warn({ url, statusCode: res.statusCode }, `Relay metrics: unexpected status`);
        resolve(null);
        res.resume();
        return;
      }

      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body) as {
            bytesForwarded: string;
            uniquePeers: number;
            packetsLost: number;
            jitter: number;
            duration: number;
            activePeers: number;
          };

          const result: RelayMetricsResult = {
            bytesForwarded: BigInt(json.bytesForwarded),
            uniquePeers: BigInt(json.uniquePeers),
            packetsLost: BigInt(json.packetsLost),
            jitter: BigInt(json.jitter),
            duration: BigInt(json.duration),
            activePeers: BigInt(json.activePeers),
          };

          logger.info(
            {
              roomId,
              bytesForwarded: result.bytesForwarded.toString(),
              uniquePeers: result.uniquePeers.toString(),
            },
            `Relay metrics fetched for room=${roomId}: bytes=${result.bytesForwarded}, peers=${result.uniquePeers}`,
          );

          resolve(result);
        } catch (parseErr) {
          logger.error({ err: parseErr, body }, 'Failed to parse relay metrics response');
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      logger.warn({ err, url }, 'Failed to fetch relay metrics');
      resolve(null);
    });

    req.on('timeout', () => {
      logger.warn({ url }, 'Relay metrics request timed out');
      req.destroy();
      resolve(null);
    });
  });
}

// ─── Standby liveness probe (RO-020) ────────────────────────────────

/** Parsed result of GET /api/probe (the standby-liveness channel). */
export interface ProbeLivenessResult {
  /** Standby liveness verdict — gates the standby proof's duration_seconds. */
  ok: boolean;
  /** Relay role reported by the endpoint ('primary' | 'standby' | 'unknown'). */
  role: string;
  /** Server-handling RTT in ms (NOT media-plane RTT). */
  latencyMs: bigint;
  /** Whether the standby's warm-pipe consumer is open. */
  pipeConsumerAlive: boolean;
  /** Whether RTCP keepalive is flowing on the warm pipe. */
  rtcpAlive: boolean;
}

/**
 * Fetch the standby-liveness channel via HTTP GET (RO-020).
 *
 * Endpoint: GET http://<host>:<metricsPort>/api/probe
 *
 * @param livenessBaseUrl - Base URL of the relay (e.g. "http://standby:4001").
 * @returns {@link ProbeLivenessResult}, or null when unreachable / non-200 /
 *          unparseable — a null result is treated as a FAILED (unanswered)
 *          probe by the caller (duration_seconds gated to 0).
 */
export async function fetchProbeLiveness(
  livenessBaseUrl: string,
): Promise<ProbeLivenessResult | null> {
  const url = `${livenessBaseUrl}/api/probe`;

  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        logger.warn({ url, statusCode: res.statusCode }, 'Probe liveness: unexpected status');
        resolve(null);
        res.resume();
        return;
      }

      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body) as {
            ok: boolean;
            role: string;
            latency_ms: number;
            pipe_consumer_alive: boolean;
            rtcp_alive: boolean;
          };
          resolve({
            ok: Boolean(json.ok),
            role: json.role ?? 'unknown',
            latencyMs: BigInt(Math.round(json.latency_ms ?? 0)),
            pipeConsumerAlive: Boolean(json.pipe_consumer_alive),
            rtcpAlive: Boolean(json.rtcp_alive),
          });
        } catch (parseErr) {
          logger.error({ err: parseErr, body }, 'Failed to parse probe liveness response');
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      logger.warn({ err, url }, 'Failed to fetch probe liveness');
      resolve(null);
    });

    req.on('timeout', () => {
      logger.warn({ url }, 'Probe liveness request timed out');
      req.destroy();
      resolve(null);
    });
  });
}

// ─── Real measurement probe (RO-019b) ───────────────────────────────

/** Per-relay endpoint config for the real measurement probe. */
export interface RelayProbeEndpoint {
  /** Relay metrics HTTP base URL (e.g. "http://localhost:4001"); '' to skip. */
  metricsBaseUrl: string;
  /** STUN host for latency probing; '' to skip the STUN leg. */
  stunHost?: string;
  /** STUN port for latency probing. */
  stunPort?: number;
  /**
   * RO-020: standby /api/probe base URL (e.g. "http://standby:4001"). When set,
   * the standby's liveness is gated: a FAILED/unanswered probe forces
   * durationSeconds = 0 so the on-chain standby-liveness gate withholds reward.
   * Omitted for the primary (the primary is the live media path, not gated).
   */
  livenessUrl?: string;
}

/**
 * Injectable transports for {@link createRelayProbe}. Production defaults wrap
 * the real HTTP/STUN primitives; unit tests inject deterministic fakes so the
 * duration_seconds gating is verifiable without a live server.
 */
export interface RelayProbeHooks {
  /** RO-020 standby-liveness fetch (defaults to {@link fetchProbeLiveness}). */
  fetchLiveness?: (livenessBaseUrl: string) => Promise<ProbeLivenessResult | null>;
  /** Relay metrics fetch (defaults to {@link fetchRelayMetrics}, room-bound). */
  fetchMetrics?: (metricsBaseUrl: string, roomId: string) => Promise<RelayMetricsResult | null>;
}

/** A zero/failed probe sample (relay unreachable / not configured). */
function unreachableSample(): ProbeSample {
  return {
    avgLatencyMs: 0n,
    jitterMs: 0n,
    packetLossBps: 10_000n, // 100% loss => failed probe
    packetsSent: 0n,
    packetsReceived: 0n,
    bytesForwarded: 0n,
    uniquePeers: 0n,
    durationSeconds: 0n, // 0 => standby liveness gate reads "did not answer"
  };
}

/**
 * Build a real {@link MeasurementProbe} from the as-built network primitives.
 *
 * Composes the relay metrics HTTP fetch (bytes/peers/jitter/duration) with an
 * optional STUN RTT probe (latency/jitter/loss/sent/received). The per-relay
 * endpoint is resolved via the injected `resolveEndpoint` (env/config-driven;
 * production multi-host resolution couples to G3). When the relay is
 * unreachable, an {@link unreachableSample} is returned so the on-chain
 * liveness gate reads a failed probe (`durationSeconds == 0`) — never random.
 *
 * @param roomId           - Room being measured (metrics are per-room).
 * @param resolveEndpoint  - Resolves the per-relay probe endpoint.
 * @param hooks            - Optional injectable transports (test seam).
 */
export function createRelayProbe(
  roomId: string,
  resolveEndpoint: (relayMinerId: string) => RelayProbeEndpoint,
  hooks?: RelayProbeHooks,
): MeasurementProbe {
  const fetchLiveness = hooks?.fetchLiveness ?? fetchProbeLiveness;
  const fetchMetrics = hooks?.fetchMetrics ?? fetchRelayMetrics;

  return async (relayMinerId: string): Promise<ProbeSample> => {
    const endpoint = resolveEndpoint(relayMinerId);

    // RO-020 standby-liveness leg (only when a livenessUrl is configured —
    // i.e. this is the standby). A FAILED/unanswered probe gates the standby
    // proof's duration_seconds to 0 so the on-chain liveness gate withholds
    // reward; a SUCCESSFUL probe (ok:true) lets duration_seconds be > 0.
    let liveness: ProbeLivenessResult | null = null;
    let livenessGated = false;
    if (endpoint.livenessUrl) {
      liveness = await fetchLiveness(endpoint.livenessUrl);
      if (!liveness || !liveness.ok) {
        livenessGated = true;
        logger.warn(
          { relayMinerId, roomId, ok: liveness?.ok ?? false },
          'RO-020: standby liveness probe failed; gating duration_seconds = 0',
        );
      }
    }

    // Latency / loss leg via STUN (optional).
    let stun: StunProbeResult | null = null;
    if (endpoint.stunHost && endpoint.stunPort) {
      try {
        stun = await stunProbe(endpoint.stunHost, endpoint.stunPort);
      } catch (err) {
        logger.warn({ err, relayMinerId }, 'STUN probe failed; falling back to metrics-only');
      }
    }

    // Bytes / peers / duration leg via relay metrics HTTP (optional).
    let metrics: RelayMetricsResult | null = null;
    if (endpoint.metricsBaseUrl) {
      metrics = await fetchMetrics(endpoint.metricsBaseUrl, roomId);
    }

    // When the standby liveness gate fired, force a zero-duration sample so the
    // standby proof reads "did not answer" — never paid (RO-016 liveness gate).
    if (livenessGated) {
      return unreachableSample();
    }

    if (!stun && !metrics && !liveness) {
      logger.warn({ relayMinerId, roomId }, 'No reachable probe endpoint; recording failed probe');
      return unreachableSample();
    }

    // duration_seconds: prefer the real metrics duration; else a live liveness
    // probe (ok:true) implies the standby is up (>= 1s); else a STUN-only path.
    const durationSeconds =
      metrics?.duration ?? (liveness?.ok ? 1n : stun ? 1n : 0n);

    return {
      avgLatencyMs: stun?.avgLatencyMs ?? liveness?.latencyMs ?? 0n,
      jitterMs: stun?.jitterMs ?? metrics?.jitter ?? 0n,
      packetLossBps: stun?.packetLossBps ?? 0n,
      packetsSent: stun?.probesSent ?? 0n,
      packetsReceived: stun?.probesReceived ?? 0n,
      bytesForwarded: metrics?.bytesForwarded ?? 0n,
      uniquePeers: metrics?.uniquePeers ?? 0n,
      durationSeconds,
    };
  };
}
