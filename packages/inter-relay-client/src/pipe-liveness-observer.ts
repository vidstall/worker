/**
 * Relay role manager — honest probe-liveness observer (REQ-RO-010 / REQ-RO-011).
 *
 * Pure extraction from relay-role-manager.ts (which is now a barrel — see its
 * module doc).
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 * ADR: ADR-0009 (relay-overlap-redundancy M1)
 */

import type { types as msTypes } from 'mediasoup';

/**
 * Liveness flags written by {@link createPipeLivenessObserver} into the
 * daemon's /api/probe state box (index.ts probeLiveness). Plain booleans —
 * no mediasoup types cross this seam (mirrors metrics-server ProbeState).
 */
export interface PipeLivenessFlags {
  /** The standby's warm-pipe consumer is open (exists + not closed). */
  pipeConsumerAlive: boolean;
  /**
   * A real RTCP/packet counter ADVANCE was observed across >=2 getStats()
   * samples. NEVER true on the first sample (no prior to compare) and never
   * true for a paused-but-static counter (REQ-RO-011 anti-over-claim).
   */
  rtcpAlive: boolean;
  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay PIPE
   * TRANSPORT (bytesReceived + bytesSent), summed across its stats. Unlike
   * rtcpAlive (which watches the PAUSED keepalive consumer), this counts ALL RTP
   * the primary piped across for the active-forward path — a DIRECT live measure
   * that cross-relay media actually crossed (>0 => bytes traversed the pipe).
   * 0 when no getPipeTransport dep is wired (additive / back-compat).
   */
  pipeBytesObserved?: number;
}

/**
 * Dependencies injected into {@link createPipeLivenessObserver}. Keeping the
 * consumer behind a getter (not a captured reference) lets the observer see
 * the LIVE pipe consumer as the coordinator swaps it, and clear liveness when
 * it goes null/closed (worker.died, cutover teardown).
 */
export interface PipeLivenessObserverDeps {
  /** Resolve the CURRENT standby pipe consumer (null when none). */
  getPipeConsumer: () => msTypes.Consumer | null;
  /**
   * REQ-RMS-025 byte-proof (OPTIONAL, additive) — resolve the CURRENT standby
   * inter-relay pipe TRANSPORT (null when none). When provided, each poll reads
   * its getStats() and reports the cumulative bytesReceived+bytesSent as
   * `pipeBytesObserved` (a DIRECT live measure that cross-relay RTP crossed).
   * Omitted by failover-only callers => pipeBytesObserved stays 0.
   */
  getPipeTransport?: () => msTypes.PipeTransport | null;
  /** Write the resolved flags into the /api/probe state box. */
  setLiveness: (flags: PipeLivenessFlags) => void;
  /** Poll cadence (ms). Default 2000. */
  intervalMs?: number;
  /** Samples required to confirm an advance. Default 2 (this-vs-prior). */
  requiredSamples?: number;
}

/** Handle returned by {@link createPipeLivenessObserver}. */
export interface PipeLivenessObserver {
  start(): void;
  stop(): void;
}

/**
 * Sum every cumulative mediasoup counter that moves when real RTP/RTCP is on
 * the pipe (a ConsumerStat is RtpStreamSendStats). Any monotonic increase
 * across two samples => genuine activity. byteCount alone could be 0 on a
 * tiny-RTCP-only path, so we OR several counters; all are non-decreasing.
 */
function readPipeStatCounter(
  stats: ReadonlyArray<{
    packetCount?: number;
    byteCount?: number;
    nackCount?: number;
    pliCount?: number;
    firCount?: number;
  }>,
): number {
  let total = 0;
  for (const s of stats) {
    total +=
      (s.packetCount ?? 0) +
      (s.byteCount ?? 0) +
      (s.nackCount ?? 0) +
      (s.pliCount ?? 0) +
      (s.firCount ?? 0);
  }
  return total;
}

/**
 * Honest probe-liveness observer (REQ-RO-010 / REQ-RO-011).
 *
 * Polls getPipeConsumer().getStats() on an interval and writes
 * {pipeConsumerAlive, rtcpAlive} via setLiveness:
 *   - pipeConsumerAlive = consumer exists AND not closed.
 *   - rtcpAlive = a non-zero counter ADVANCE was seen across >=requiredSamples
 *     samples. NEVER set on the first sample (no baseline) and never true for a
 *     static (paused-unpaid) counter — this is the single switch that moves the
 *     standby from on-chain duration_seconds=0 (never paid) to >0, so it MUST
 *     NOT over-claim a cold/static standby (REQ-RO-011).
 *   - both CLEARED false on null / closed consumer (no stale liveness).
 *
 * Does NOT touch metrics-server (buildProbeResponse / ProbeState unchanged) —
 * it only writes the existing probeLiveness box (OQ-2 fallback-safe). All logic
 * is in this factory; index.ts only assembles (REQ-RO-012).
 */
export function createPipeLivenessObserver(
  deps: PipeLivenessObserverDeps,
): PipeLivenessObserver {
  const intervalMs = deps.intervalMs ?? 2000;
  const requiredSamples = deps.requiredSamples ?? 2;

  let timer: ReturnType<typeof setInterval> | null = null;
  // History of counter readings for the CURRENT live consumer. Reset whenever
  // the consumer goes null/closed so a fresh pipe starts from no-baseline
  // (never set-on-create after a swap).
  let prevCounter: number | null = null;
  let advanceSamples = 0;

  function resetHistory(): void {
    prevCounter = null;
    advanceSamples = 0;
  }

  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay PIPE
   * TRANSPORT (bytesReceived + bytesSent). Independent of the paused keepalive
   * consumer: counts ALL active-forward RTP that crossed. 0 when no transport
   * dep / no bound transport / a transient getStats() failure.
   */
  async function readPipeTransportBytes(): Promise<number> {
    const transport = deps.getPipeTransport?.() ?? null;
    if (transport === null || transport.closed) return 0;
    try {
      const tstats = (await transport.getStats()) as ReadonlyArray<{
        bytesReceived?: number;
        bytesSent?: number;
      }>;
      let total = 0;
      for (const s of tstats) total += (s.bytesReceived ?? 0) + (s.bytesSent ?? 0);
      return total;
    } catch {
      return 0;
    }
  }

  async function poll(): Promise<void> {
    // REQ-RMS-025 byte-proof: read the pipe TRANSPORT bytes independently of the
    // (paused) keepalive consumer — a DIRECT live measure that cross-relay RTP
    // crossed. Reported on EVERY setLiveness call below (additive; 0 when unwired).
    const pipeBytesObserved = await readPipeTransportBytes();

    const consumer = deps.getPipeConsumer();
    // Clear on null/closed — never report stale liveness.
    if (consumer === null || consumer.closed) {
      resetHistory();
      deps.setLiveness({ pipeConsumerAlive: false, rtcpAlive: false, pipeBytesObserved });
      return;
    }

    let counter: number | null = null;
    try {
      const stats = (await consumer.getStats()) as ReadonlyArray<{
        packetCount?: number;
        byteCount?: number;
        nackCount?: number;
        pliCount?: number;
        firCount?: number;
      }>;
      counter = readPipeStatCounter(stats);
    } catch {
      // Transient getStats() failure (transport mid-rebuild): keep the
      // consumer-alive signal but make no liveness claim this tick.
      counter = null;
    }

    if (counter === null) {
      // Consumer exists but no usable sample this tick.
      deps.setLiveness({ pipeConsumerAlive: true, rtcpAlive: false, pipeBytesObserved });
      return;
    }

    // ADVANCE detection across >=requiredSamples. First sample = baseline only
    // (NEVER set-on-create). An increase vs the prior reading counts a sample.
    if (prevCounter !== null && counter > prevCounter) {
      advanceSamples += 1;
    } else if (prevCounter !== null && counter <= prevCounter) {
      // No movement this tick — require contiguous advance, so reset the run.
      advanceSamples = 0;
    }
    prevCounter = counter;

    const rtcpAlive = advanceSamples >= requiredSamples - 1;
    deps.setLiveness({ pipeConsumerAlive: true, rtcpAlive, pipeBytesObserved });
  }

  return {
    start(): void {
      if (timer !== null) return; // idempotent
      resetHistory();
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      resetHistory();
    },
  };
}
