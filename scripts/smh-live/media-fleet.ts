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
 * NOTE: this is an integration boundary (needs a real relay). Its live smoke is deferred
 * to the D2 phase (Task 10) — nothing here boots a relay.
 */

import { VirtualPeer, type WriterLike } from '../bench/mediasoup-client-harness.js';

/** A single joined peer + its targeted relay. */
export interface FleetPeer {
  /** The relay WS URL this peer homed to (e.g. ws://127.0.0.1:4000). */
  relayUrl: string;
  /** The distinct peer id used on the join. */
  peerId: string;
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

/**
 * Launch one `VirtualPeer` per `relayUrls[i]`, each joined to `roomId` and producing one
 * silent audio track. Joins are SEQUENTIAL (mirrors the harness `main()` — the relay's
 * per-room async lock removes the parallel-join race, and sequential setup keeps per-peer
 * failures easy to attribute). If any peer fails to come up, every peer already started is
 * closed before the error is rethrown (no leaked transports/sockets).
 */
export async function launchFleet(relayUrls: string[], roomId: string): Promise<Fleet> {
  const running: VirtualPeer[] = [];
  const peers: FleetPeer[] = [];
  try {
    for (let i = 0; i < relayUrls.length; i++) {
      const relayUrl = relayUrls[i]!;
      const peerId = `smh-fleet-peer-${i}`;
      const peer = new VirtualPeer({ relayUrl, roomId, peerId, writer: NOOP_WRITER });
      await peer.run(); // join + produce ONE audio track (default run(), no produceNew)
      running.push(peer);
      peers.push({ relayUrl, peerId, stop: () => peer.close() });
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
