/**
 * Real network probing for the Validator daemon.
 *
 * Two measurement strategies:
 * 1. STUN probing -- Send STUN Binding Requests via UDP to measure RTT, jitter, and packet loss.
 * 2. Relay metrics fetch -- HTTP GET to relay's metrics endpoint for bytes/peers/loss data.
 *
 * All numeric results use bigint (basis-point invariant -- never floating point).
 *
 * Extracted into `probe/stun.ts` (STUN protocol implementation) and
 * `probe/relay-metrics.ts` (fetchRelayMetrics/fetchProbeLiveness); this file keeps
 * `createRelayProbe` and re-exports the split-out pieces so every existing import
 * site (`from '.../probe.js'`) keeps working unchanged.
 */

import { createLogger } from '@dvconf/shared';
import type { MeasurementProbe, ProbeSample } from './measurements.js';
import { stunProbe, type StunProbeResult } from './probe/stun.js';
import {
  fetchRelayMetrics,
  fetchProbeLiveness,
  type RelayMetricsResult,
  type ProbeLivenessResult,
} from './probe/relay-metrics.js';

export { stunProbe, type StunProbeResult } from './probe/stun.js';
export {
  fetchRelayMetrics,
  fetchProbeLiveness,
  type RelayMetricsResult,
  type ProbeLivenessResult,
} from './probe/relay-metrics.js';

const logger = createLogger('validator:probe');

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
  fetchLiveness?: (livenessBaseUrl: string, traceId?: string) => Promise<ProbeLivenessResult | null>;
  /** STUN RTT/jitter/loss probe (defaults to {@link stunProbe}). */
  stunProbe?: (stunHost: string, stunPort: number) => Promise<StunProbeResult>;
  /** Relay metrics fetch (defaults to {@link fetchRelayMetrics}, room-bound). */
  fetchMetrics?: (
    metricsBaseUrl: string,
    roomId: string,
    traceId?: string,
  ) => Promise<RelayMetricsResult | null>;
  /**
   * Observes the raw {@link RelayMetricsResult} right after the metrics fetch
   * resolves (or `null` when unreachable/skipped) — lets callers (e.g.
   * measurement-cycle.ts's client-reported relay-down-hint re-probe) read the
   * result without a duplicate HTTP fetch. Purely additive/observational;
   * never affects the returned {@link ProbeSample}.
   */
  onMetrics?: (metrics: RelayMetricsResult | null) => void;
  /**
   * Monitoring-redesign gap #6: observes the raw {@link StunProbeResult}
   * right after the STUN leg resolves — lets callers (e.g.
   * measurement-cycle.ts) export cross-host RTT/jitter/loss as Prometheus
   * gauges without a duplicate probe. Purely additive/observational; never
   * fires when the STUN leg is skipped/unconfigured (never called with null
   * — a caller wanting "did the leg run" already knows from its own config).
   */
  onStunSample?: (relayMinerId: string, stun: StunProbeResult) => void;
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
  traceId?: string,
): MeasurementProbe {
  const fetchLiveness = hooks?.fetchLiveness ?? fetchProbeLiveness;
  const fetchMetrics = hooks?.fetchMetrics ?? fetchRelayMetrics;
  const runStunProbe = hooks?.stunProbe ?? stunProbe;
  const onMetrics = hooks?.onMetrics;
  const onStunSample = hooks?.onStunSample;

  return async (relayMinerId: string): Promise<ProbeSample> => {
    const endpoint = resolveEndpoint(relayMinerId);

    // RO-020 standby-liveness leg (only when a livenessUrl is configured —
    // i.e. this is the standby). A FAILED/unanswered probe gates the standby
    // proof's duration_seconds to 0 so the on-chain liveness gate withholds
    // reward; a SUCCESSFUL probe (ok:true) lets duration_seconds be > 0.
    let liveness: ProbeLivenessResult | null = null;
    let livenessGated = false;
    if (endpoint.livenessUrl) {
      liveness = await fetchLiveness(endpoint.livenessUrl, traceId);
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
        stun = await runStunProbe(endpoint.stunHost, endpoint.stunPort);
        onStunSample?.(relayMinerId, stun);
      } catch (err) {
        logger.warn({ err, relayMinerId }, 'STUN probe failed; falling back to metrics-only');
      }
    }

    // Bytes / peers / duration leg via relay metrics HTTP (optional).
    let metrics: RelayMetricsResult | null = null;
    if (endpoint.metricsBaseUrl) {
      metrics = await fetchMetrics(endpoint.metricsBaseUrl, roomId, traceId);
    }
    onMetrics?.(metrics);

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
