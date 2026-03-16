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
