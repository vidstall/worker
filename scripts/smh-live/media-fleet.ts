/**
 * SMH-LIVE programmatic media fleet — N headless `mediasoup-client` peers, one homed
 * per relay, all joined to one room, each producing ONE audio track at join.
 *
 * Wraps the reused `VirtualPeer` from `scripts/bench/mediasoup-client-harness.ts` (now
 * exported — one additive line). Per RECONCILIATION v2, D3 is dropped, so there is NO
 * `produceNew` — the default `run()` (join → send/recv transports → one silent audio
 * producer) is exactly what D2 needs (each relay carries a live producer + consumers,
 * so a kill-relay failover is observable end-to-end).
 *
 * A no-op `WriterLike` is passed because the fleet does not sample latency (D2/D3 assert
 * on-chain promotion + consume continuity, not `L_g2g`).
 *
 * ── D2 media-hardening (this file) ──
 * The D2 hard gate requires SERVER-side `bytesForwarded>0` on the primary relay BEFORE
 * the chaos kill. That only happens when a peer CONSUMES another peer's track on that
 * relay (a consumer's outbound-rtp is the forwarded bytes). With one-peer-per-relay the
 * only consume path is CROSS-relay (piped producer → minted local producer → newProducer
 * push → consume) which is racy/flaky (observed: zero consumes → bytesForwarded=0).
 *
 * Fix (harness-side, additive, zero daemon edit): home a SECOND "consumer" peer on the
 * PRIMARY relay. When it joins, the relay's join-time `newProducer` loop immediately
 * announces the primary-homed producer's LOCAL id → the consumer peer consumes it over a
 * pure INTRA-relay SFU path (no cross-relay pipe) → the primary relay forwards real
 * outbound-rtp bytes deterministically. The per-relay producers still exist (failover
 * stays observable); this only ADDS a guaranteed local consume on the primary.
 *
 * NOTE: this is an integration boundary (needs a real relay). Its live smoke is deferred
 * to the D2 phase (Task 10) — nothing here boots a relay.
 */

import { VirtualPeer, retryOnTimeout, type WriterLike } from '../bench/mediasoup-client-harness.js';

// Re-export the pure retry helper so callers (and tests) get it from one place.
export { retryOnTimeout };

/**
 * SMH-LIVE (D2 media WARM-UP) — bounded async poll until a predicate is satisfied.
 *
 * Repeatedly `await probe()`, returning the FIRST value for which `pass(value)` is
 * truthy. A probe rejection is swallowed (one bad tick — e.g. a 404 before the room
 * has metrics — never aborts the poll). Once the deadline passes, returns the LAST
 * observed value (even if still failing) rather than throwing, so the caller can
 * record the honest final value in the evidence file.
 *
 * Used to poll the relay `/metrics/:roomId` `bytesForwarded` until it is >0 before the
 * chaos kill — the bounded wait that converts flaky media establishment into a reliable
 * gate. Pure (no relay dependency) so it is unit-tested in isolation.
 */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  pass: (value: T) => boolean,
  opts: { deadlineMs: number; intervalMs: number },
): Promise<T> {
  const deadline = Date.now() + opts.deadlineMs;
  let last: T = await safeProbe(probe);
  if (pass(last)) return last;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs));
    last = await safeProbe(probe, last);
    if (pass(last)) return last;
  }
  return last;
}

/** Await a probe; on rejection return the fallback (keeps the poll going). */
async function safeProbe<T>(probe: () => Promise<T>, fallback?: T): Promise<T> {
  try {
    return await probe();
  } catch {
    return fallback as T;
  }
}

/** A single joined peer + its targeted relay. */
export interface FleetPeer {
  /** The relay WS URL this peer homed to (e.g. ws://127.0.0.1:4000). */
  relayUrl: string;
  /** The distinct peer id used on the join. */
  peerId: string;
  /** Current total inbound media bytes for this peer (>0 proves REAL media flowed, D2 continuity). */
  bytesReceived: () => Promise<number>;
  /** Number of consumers this peer has established (>0 = actively receiving a remote track). */
  consumerCount: () => number;
  /** Close this one peer (idempotent-safe; best-effort). */
  stop: () => Promise<void>;
}

export interface Fleet {
  peers: FleetPeer[];
  /** Close every peer (best-effort — one failing close never blocks the rest). */
  stopAll: () => Promise<void>;
}

/** Latency writer is unused by the fleet — swallow every sample. */
const NOOP_WRITER: WriterLike = { write() {} };

export interface LaunchFleetOpts {
  /**
   * SMH-LIVE (D2 media-hardening): also home an EXTRA consumer peer on this relay URL
   * (typically the resolved PRIMARY's WS URL). It joins AFTER the per-relay producers
   * so the relay announces the already-present LOCAL producer to it at join, driving a
   * deterministic INTRA-relay consume → guaranteed server-side bytesForwarded>0 on that
   * relay. Undefined => no extra peer (pre-hardening one-per-relay behaviour).
   */
  extraConsumerRelayUrl?: string;
}

/**
 * Launch one `VirtualPeer` per `relayUrls[i]`, each joined to `roomId` and producing one
 * silent audio track. Joins are SEQUENTIAL (mirrors the harness `main()` — the relay's
 * per-room async lock removes the parallel-join race, and sequential setup keeps per-peer
 * failures easy to attribute). If any peer fails to come up, every peer already started is
 * closed before the error is rethrown (no leaked transports/sockets).
 *
 * When `opts.extraConsumerRelayUrl` is set, an additional peer homes to that relay AFTER
 * the per-relay producers, guaranteeing an intra-relay consume on it (D2 media-hardening).
 */
export async function launchFleet(
  relayUrls: string[],
  roomId: string,
  opts: LaunchFleetOpts = {},
): Promise<Fleet> {
  const running: VirtualPeer[] = [];
  const peers: FleetPeer[] = [];
  const push = (relayUrl: string, peerId: string, peer: VirtualPeer): void => {
    running.push(peer);
    peers.push({
      relayUrl,
      peerId,
      bytesReceived: () => peer.currentBytesReceived(),
      consumerCount: () => peer.consumerCount(),
      stop: () => peer.close(),
    });
  };
  try {
    for (let i = 0; i < relayUrls.length; i++) {
      const relayUrl = relayUrls[i]!;
      const peerId = `smh-fleet-peer-${i}`;
      const peer = new VirtualPeer({ relayUrl, roomId, peerId, writer: NOOP_WRITER });
      await peer.run(); // join + produce ONE audio track (default run(), no produceNew)
      push(relayUrl, peerId, peer);
    }
    // D2 media-hardening: the extra consumer peer joins LAST so every per-relay producer
    // already exists — in particular the primary-homed producer, which the primary relay
    // announces to this consumer at join for a deterministic intra-relay consume.
    if (opts.extraConsumerRelayUrl !== undefined) {
      const relayUrl = opts.extraConsumerRelayUrl;
      const peerId = 'smh-fleet-consumer';
      const peer = new VirtualPeer({ relayUrl, roomId, peerId, writer: NOOP_WRITER });
      await peer.run();
      push(relayUrl, peerId, peer);
    }
  } catch (err) {
    await Promise.allSettled(running.map((p) => p.close()));
    throw err;
  }
  return {
    peers,
    stopAll: async () => {
      await Promise.allSettled(running.map((p) => p.close()));
    },
  };
}
