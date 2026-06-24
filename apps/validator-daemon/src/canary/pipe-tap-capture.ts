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
  off?(event: 'rtp', listener: (pkt: Buffer) => void): unknown;
  removeListener?(event: 'rtp', listener: (pkt: Buffer) => void): unknown;
}

export interface PipeTapReceiver {
  /** The receiver's on-chain miner_id (the perReceiver Map key + SECONDARY >=k identity). */
  receiverMinerId: string;
  consumer: RtpTapConsumer;
}

const DEFAULT_RING = 1024;

/** A fixed-capacity FIFO ring of Buffers (head/tail, O(1) push + overflow-drop). */
class BufferRing {
  private readonly buf: (Buffer | undefined)[];
  private head = 0;
  private size = 0;
  constructor(private readonly cap: number) {
    this.buf = new Array<Buffer | undefined>(cap);
  }
  push(b: Buffer): void {
    const tail = (this.head + this.size) % this.cap;
    if (this.size < this.cap) {
      this.buf[tail] = b;
      this.size += 1;
    } else {
      // full: overwrite the oldest and advance head (drop-oldest FIFO).
      this.buf[this.head] = b;
      this.head = (this.head + 1) % this.cap;
    }
  }
  toArray(): Buffer[] {
    const out: Buffer[] = [];
    for (let i = 0; i < this.size; i++) out.push(this.buf[(this.head + i) % this.cap]!);
    return out;
  }
}

/**
 * Attaches an `rtp` listener to each receiver's consumer ONCE and accumulates the
 * forwarded packets into a per-receiver ring. `snapshot()` returns a deep copy so a
 * verify round never races the live capture. `dispose()` removes the listeners
 * (long-lived collector teardown — call at consumer-close).
 */
export class PipeTapCollector {
  private readonly rings = new Map<string, BufferRing>();
  private readonly listeners: Array<{ consumer: RtpTapConsumer; fn: (pkt: Buffer) => void }> = [];

  constructor(receivers: PipeTapReceiver[], private readonly maxPerReceiver = DEFAULT_RING) {
    for (const r of receivers) {
      const ring = new BufferRing(this.maxPerReceiver);
      this.rings.set(r.receiverMinerId, ring);
      const fn = (pkt: Buffer): void => { ring.push(Buffer.from(pkt)); }; // copy off mediasoup's reused buffer
      r.consumer.on('rtp', fn);
      this.listeners.push({ consumer: r.consumer, fn });
    }
  }

  snapshot(): Map<string, Buffer[]> {
    const out = new Map<string, Buffer[]>();
    for (const [k, ring] of this.rings) out.set(k, ring.toArray().map((b) => Buffer.from(b)));
    return out;
  }

  /** Long-lived teardown: remove every `rtp` listener (no buildup over a live stream). */
  dispose(): void {
    for (const { consumer, fn } of this.listeners) {
      const c = consumer as { off?: (e: 'rtp', fn: (pkt: Buffer) => void) => void; removeListener?: (e: 'rtp', fn: (pkt: Buffer) => void) => void };
      if (typeof c.off === 'function') c.off('rtp', fn);
      else if (typeof c.removeListener === 'function') c.removeListener('rtp', fn);
    }
    this.listeners.length = 0;
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
