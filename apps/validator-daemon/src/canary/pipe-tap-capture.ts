/**
 * M2 slice-1 — production-shaped REAL-media capture for the canary verify-loop.
 *
 * A validator covertly consumes the relay-forwarded canary stream and records the
 * forwarded RTP packets per receiver. The captured Buffers feed the UNCHANGED
 * `runCanaryVerifyRound` pipeline (verifyForwardedCanary recomputes the canonical
 * canary ciphertext from cellSecret and byte-compares — NO decrypt). Relay-blind
 * by construction (INV-B): we never read content, only capture forwarded bytes.
 *
 * Slice-1 wires this to in-process mediasoup consumers (hermetic). The live
 * covert-join transport (WebRtcTransport) that supplies these consumers in
 * production is M2b.
 */
import type { RelayRoomScope } from './cell.js';
import type { CanaryForwardCapture, CanaryForwardCaptureResult } from './verify-loop.js';

/** The slice of mediasoup's Consumer we depend on: `consumer.on('rtp', (pkt: Buffer) => …)`. */
export interface RtpTapConsumer {
  on(event: 'rtp', listener: (pkt: Buffer) => void): unknown;
}

export interface PipeTapReceiver {
  /** The receiver's on-chain miner_id (the perReceiver Map key + SECONDARY >=k identity). */
  receiverMinerId: string;
  consumer: RtpTapConsumer;
}

const DEFAULT_RING = 1024;

/**
 * Attaches an `rtp` listener to each receiver's consumer ONCE and accumulates the
 * forwarded packets into a per-receiver ring buffer. `snapshot()` returns a deep
 * copy so a verify round never races the live capture.
 */
export class PipeTapCollector {
  private readonly buffers = new Map<string, Buffer[]>();

  constructor(receivers: PipeTapReceiver[], private readonly maxPerReceiver = DEFAULT_RING) {
    for (const r of receivers) {
      this.buffers.set(r.receiverMinerId, []);
      r.consumer.on('rtp', (pkt: Buffer) => {
        const arr = this.buffers.get(r.receiverMinerId)!;
        arr.push(Buffer.from(pkt)); // copy off mediasoup's reused buffer
        if (arr.length > this.maxPerReceiver) arr.shift();
      });
    }
  }

  snapshot(): Map<string, Buffer[]> {
    const out = new Map<string, Buffer[]>();
    for (const [k, v] of this.buffers) out.set(k, v.map((b) => Buffer.from(b)));
    return out;
  }
}

export interface PipeTapCaptureMeta {
  canaryKid: number;
  expectedCtrs: number[];
  kRoom: Uint8Array;
  cellSecret: Uint8Array;
}

/**
 * Wraps a collector into the verify-loop's `CanaryForwardCapture` seam. Each call
 * snapshots the current per-receiver captures for the given (relay,room) scope.
 */
export function createPipeTapCapture(
  collector: PipeTapCollector,
  meta: PipeTapCaptureMeta,
): CanaryForwardCapture {
  return async (scope: RelayRoomScope): Promise<CanaryForwardCaptureResult> => ({
    relayId: scope.relayId,
    roomId: scope.roomId,
    canaryKid: meta.canaryKid,
    expectedCtrs: meta.expectedCtrs,
    kRoom: meta.kRoom,
    cellSecret: meta.cellSecret,
    perReceiver: collector.snapshot(),
  });
}
