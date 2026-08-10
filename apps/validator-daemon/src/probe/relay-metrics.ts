/**
 * Relay HTTP metrics + standby-liveness fetches for the Validator daemon's real
 * network probing (per IC-5 / RO-020).
 *
 * All numeric results use bigint (basis-point invariant -- never floating point).
 *
 * Extracted from the former `probe.ts` monolith (HTTP half); `probe.ts` re-exports
 * {@link RelayMetricsResult}, {@link fetchRelayMetrics}, {@link ProbeLivenessResult},
 * and {@link fetchProbeLiveness} so external import sites are unchanged.
 */

import * as http from 'node:http';
import { createLogger, withTraceHeader } from '@dvconf/shared';

const logger = createLogger('validator:probe');

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
  /**
   * Best-effort, LOW-TRUST accelerant (see relay's `POST /relay-down-hint`):
   * a client reported its primary relay WS just died. Present only while
   * fresh on the relay side. Never itself authoritative — purely a signal
   * to re-probe sooner; the actual liveness-vote decision stays exclusively
   * validator-daemon's own independently-probed conclusion.
   */
  clientReportedDeadRelayHint?: boolean;
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
  traceId?: string,
): Promise<RelayMetricsResult | null> {
  const url = `${metricsBaseUrl}/metrics/${roomId}`;
  const headers = traceId ? withTraceHeader({}, traceId) : undefined;

  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000, headers }, (res) => {
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
            clientReportedDeadRelayHint?: boolean;
          };

          const result: RelayMetricsResult = {
            bytesForwarded: BigInt(json.bytesForwarded),
            uniquePeers: BigInt(json.uniquePeers),
            packetsLost: BigInt(json.packetsLost),
            jitter: BigInt(json.jitter),
            duration: BigInt(json.duration),
            activePeers: BigInt(json.activePeers),
            ...(json.clientReportedDeadRelayHint === true ? { clientReportedDeadRelayHint: true } : {}),
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
  traceId?: string,
): Promise<ProbeLivenessResult | null> {
  const url = `${livenessBaseUrl}/api/probe`;
  const headers = traceId ? withTraceHeader({}, traceId) : undefined;

  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 5000, headers }, (res) => {
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
