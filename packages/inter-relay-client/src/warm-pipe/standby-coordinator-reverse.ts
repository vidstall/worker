/**
 * Standby warm-pipe coordinator — part-3 REVERSE leg (REQ-RMS-034/037), split
 * out of standby-coordinator.ts as free functions that take an explicit
 * `ReverseLegDeps` parameter object instead of closing over the coordinator
 * class's private state. StandbyWarmPipeCoordinator keeps thin wrapper methods
 * that call these, passing its own private fields in explicitly.
 *
 * A STANDBY-homed local client's producer is consumed onto the warm pipe UP
 * toward the primary and announced UP (mirror of the forward consume-onto-pipe).
 * ADDITIVE to the forward path; the reverse UP-announcer fires ONLY from
 * onLocalClientProducer (a real local-client produce) — NEVER from the forward
 * mint path (forwardLocalProducers), so a minted/hub-fanned producer never re-
 * announces UP (loop-safe, REQ-RMS-036; Task B2 asserts this wire output).
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import { DEFAULT_PEER_RELAY_ID, meshKey } from './pipe-protocol.js';
import { pipeProducerOntoPrimaryTransport } from './primary-coordinator.js';
import type { ReverseUpAnnouncer, WarmPipeState } from './standby-coordinator-types.js';

/** One local-client producer queued before the reverse pipe was connected. */
export interface ReversePendingEntry {
  producer: Pick<msTypes.Producer, 'id' | 'kind'>;
  producerPeerId?: string;
  // T-B (REQ-RMS-044/046) — the loop-guard budget + immutable origin carried on a
  // reverse producer queued before the leg connected, so drainReverse announces them UP
  // unchanged. Optional → a shipped (non-tree) queued entry omits them (byte-stable).
  hopTtl?: number;
  originProducerId?: string;
}

/** One reverse announce already SENT (REQ-RMS-037 D3, resend-on-reopen). */
export interface SentReverseAnnounceEntry {
  producer: Pick<msTypes.Producer, 'id' | 'kind'>;
  producerPeerId?: string;
  scopedPeer?: string;
  rtpParameters?: msTypes.RtpParameters;
  hopTtl?: number;
  originProducerId?: string;
  peerRelayId: string; // un-scoped key for per-leg clear()
}

/**
 * Explicit deps the reverse-leg free functions need — the coordinator's own
 * private Maps + the reverse announcer/logger, passed in by the class wrapper
 * methods (never closed over) so this module stays independently testable.
 */
export interface ReverseLegDeps {
  states: Map<string, WarmPipeState>;
  reverseConsumedIds: Map<string, Set<string>>;
  reversePending: Map<string, ReversePendingEntry[]>;
  sentReverseAnnounces: Map<string, Map<string, SentReverseAnnounceEntry>>;
  reverseAnnouncer: ReverseUpAnnouncer | null;
  logger?: Logger;
}

/**
 * Consume one local producer onto the (connected) reverse pipe transport and
 * announce the piped consumer UP. Dedup per (room,peer): a producerId already
 * consumed onto this leg is skipped (no double-consume). Marks BEFORE the consume
 * so a re-entrant drive cannot double-consume the same id.
 *
 * Error discipline MIRRORS the forward path's Fix 1 (forwardLocalProducers): the
 * consume + announce are wrapped so a TRANSIENT failure (a) un-marks the id (a later
 * re-drive self-heals/retries) and (b) is SWALLOWED — it never propagates out of
 * drainReverse (so one bad queued item does not discard the rest of the drained
 * queue) nor out of onPrimaryConnectParams after transport.connect() already
 * succeeded. A benign duplicate (defensive belt — consume(), unlike the forward
 * produce(), does NOT throw on duplicate, so the `seen` Set is the real dedup) keeps
 * the id marked.
 */
export async function reverseConsumeAndAnnounce(
  roomId: string,
  key: string,
  peerRelayId: string,
  transport: msTypes.PipeTransport,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId: string | undefined,
  // T-B (REQ-RMS-044/046) — additive trailing loop-guard budget + immutable origin threaded
  // onto the reverse announce UP. Undefined on the shipped path → the frame omits both.
  hopTtl: number | undefined,
  originProducerId: string | undefined,
  deps: ReverseLegDeps,
): Promise<void> {
  const { reverseConsumedIds, sentReverseAnnounces, reverseAnnouncer, logger } = deps;
  let seen = reverseConsumedIds.get(key);
  if (!seen) {
    seen = new Set<string>();
    reverseConsumedIds.set(key, seen);
  }
  if (seen.has(producer.id)) {
    return;
  }
  // Mark BEFORE the await — the re-entrancy guard against two concurrent calls for
  // the SAME id. Un-marked below on a transient failure so a re-drive retries.
  seen.add(producer.id);
  let pipedConsumer: msTypes.Consumer;
  try {
    // REQ-RMS-026 — the announce carries the pipe CONSUMER's rtpParameters (the
    // REMAPPED SSRC across the pipe), NOT the source producer's.
    pipedConsumer = await pipeProducerOntoPrimaryTransport(transport, producer.id);
    // T-B (REQ-RMS-044/046) — carry the loop-guard budget + immutable origin UP. Widen the
    // reverse announce to 7-arg ONLY when a tree hop actually set them; the shipped reverse
    // path (both undefined) keeps its original 5-arg call so it is byte-identical (the frame
    // AND the announcer arity — the RED-RA-2* assertions hold). The builder omits both anyway.
    const scopedPeer = peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId;
    const piped = { id: pipedConsumer.id, kind: pipedConsumer.kind };
    // REQ-RMS-037 (D3) — record the SENT announce args (the PIPED consumer id + its remapped
    // rtpParameters, EXACTLY what ships below — NOT the source producer's) so a link RE-open
    // can re-DELIVER via resendReverseAnnounces without re-consuming the pipe. Keyed per leg +
    // origin (originProducerId ?? producer.id) so a re-drive of the same id overwrites, not grows.
    let roomStore = sentReverseAnnounces.get(roomId);
    if (!roomStore) {
      roomStore = new Map();
      sentReverseAnnounces.set(roomId, roomStore);
    }
    roomStore.set(`${peerRelayId}::${originProducerId ?? producer.id}`, {
      producer: piped,
      producerPeerId, scopedPeer, rtpParameters: pipedConsumer.rtpParameters,
      hopTtl, originProducerId, peerRelayId,
    });
    if (hopTtl === undefined && originProducerId === undefined) {
      reverseAnnouncer?.(roomId, piped, producerPeerId, scopedPeer, pipedConsumer.rtpParameters);
    } else {
      reverseAnnouncer?.(
        roomId, piped, producerPeerId, scopedPeer, pipedConsumer.rtpParameters, hopTtl, originProducerId,
      );
    }
  } catch (err) {
    // Mirror forward Fix 1 — discriminate a benign duplicate (keep marked; a
    // defensive belt since consume() does not throw on duplicate) from a TRANSIENT
    // failure (worker hiccup / consume racing a rebuilt pipe's connect).
    const message = String((err as Error)?.message ?? err);
    const dup = /already exists|duplicate/i.test(message);
    if (dup) {
      // Keep marked + skip so we never re-consume a known id.
      logger?.debug(
        { roomId, producerId: producer.id, error: message },
        'REQ-RMS-034: reverse consume-onto-pipe skipped — producer id already consumed (idempotent)',
      );
    } else {
      // Un-mark so the next onLocalClientProducer / drainReverse self-heals
      // (retries). A real fault → warn, not debug. SWALLOW (do NOT rethrow): one
      // bad item must not discard the rest of a drained queue nor escape
      // onPrimaryConnectParams after connect() already succeeded.
      seen.delete(producer.id);
      logger?.warn(
        { roomId, producerId: producer.id, error: message },
        'REQ-RMS-034: reverse consume-onto-pipe failed — leaving id unmarked to retry on the next drive',
      );
    }
    return;
  }
  // Log AFTER a successful announce (A1 lesson — keep log fidelity; never before).
  // Records the source producer id → piped consumer id (mirror the forward info shape).
  logger?.info(
    {
      roomId,
      producerId: producer.id,
      pipedConsumerId: pipedConsumer.id,
      kind: pipedConsumer.kind,
      peerRelayId,
    },
    'REQ-RMS-034: standby consumed a LOCAL producer onto the reverse pipe + announced UP (reverse hop)',
  );
}

/**
 * REQ-RMS-034 — a STANDBY-homed local client produced. Consume that producer
 * onto the warm PipeTransport UP toward the primary and announce it UP carrying
 * the pipe-CONSUMER's REMAPPED rtpParameters (REQ-RMS-026). If the pipe transport
 * is not connected yet the producer is QUEUED (reversePending) and drained by
 * drainReverse once onPrimaryConnectParams connects the leg (REQ-RMS-037 ordering)
 * — RTP is NEVER piped onto an unconnected transport. Idempotent per (room,peer):
 * the same producerId is consumed at most once onto a given transport
 * (reverseConsumedIds).
 *
 * REQ-RMS-037 (Task B4b) — RECORDED standby asymmetries (single-room demo scope;
 * NOT fixed here, by design):
 *   (1) This gates on `transport === null`, NOT on a `connected` flag — so a
 *       producer can be consumed onto an EXISTING-but-not-yet-connected pipe
 *       transport (consume-before-connect). mediasoup TOLERATES this (the consume
 *       binds and self-heals once the transport connects); RTP is never lost, only
 *       briefly buffered. The primary side has no such window (reverseMint queues
 *       on BOTH leg-absent AND params-absent).
 *   (2) On a transient consume/announce failure, reverseConsumeAndAnnounce un-marks
 *       the id in `reverseConsumedIds` (so a FUTURE onLocalClientProducer retries)
 *       but `drainReverse` does NOT re-queue the failed item into `reversePending`
 *       (it empties the queue up-front). This is ASYMMETRIC to the primary's
 *       `drainReverseMints`, which re-queues a transient-failed mint. Net: a queued
 *       reverse producer that fails its single drain attempt is recovered only if
 *       the local client produces it again — acceptable under single-room demo
 *       scope where each producer is driven repeatedly by the live media path.
 */
export async function onLocalClientProducer(
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId: string | undefined,
  peerRelayId: string,
  // T-B (REQ-RMS-044/046) — additive trailing loop-guard budget + immutable origin. The
  // tree UP-fan (index.ts fanToTreeNeighbors → onStandbyProducer) threads them so they reach
  // the reverse announce UP. Undefined on the shipped local-client path → byte-stable frame.
  hopTtl: number | undefined,
  originProducerId: string | undefined,
  deps: ReverseLegDeps,
): Promise<void> {
  const key = meshKey(roomId, peerRelayId);
  const transport = deps.states.get(key)?.topology.pipeTransport ?? null;
  if (transport === null) {
    // Not connected yet — QUEUE; drainReverse re-drives on connect (no double-pipe).
    const q = deps.reversePending.get(key) ?? [];
    q.push({ producer, producerPeerId, hopTtl, originProducerId });
    deps.reversePending.set(key, q);
    return;
  }
  await reverseConsumeAndAnnounce(
    roomId, key, peerRelayId, transport, producer, producerPeerId, hopTtl, originProducerId, deps,
  );
}

/**
 * REQ-RMS-037 — drain producers queued before the reverse pipe was connected.
 * Called by onPrimaryConnectParams AFTER transport.connect() succeeds. No-op when
 * the leg has no bound transport yet (defensive).
 */
export async function drainReverse(
  roomId: string,
  peerRelayId: string,
  deps: ReverseLegDeps,
): Promise<void> {
  const key = meshKey(roomId, peerRelayId);
  const transport = deps.states.get(key)?.topology.pipeTransport ?? null;
  if (transport === null) {
    return;
  }
  const pend = deps.reversePending.get(key) ?? [];
  deps.reversePending.set(key, []);
  for (const p of pend) {
    await reverseConsumeAndAnnounce(
      roomId, key, peerRelayId, transport, p.producer, p.producerPeerId, p.hopTtl, p.originProducerId, deps,
    );
  }
}

/** REQ-RMS-037 (D3) — rooms that currently hold stored reverse announces (for reopen resend). */
export function roomsWithStoredAnnounces(
  sentReverseAnnounces: ReverseLegDeps['sentReverseAnnounces'],
): string[] {
  return [...sentReverseAnnounces.keys()];
}

/**
 * REQ-RMS-037 (D3) — re-announce every stored frame for a room after a link RE-open.
 * Pure re-SEND: no pipe re-consume, reverseConsumedIds untouched; the primary's
 * reverseMintedIds dedup makes duplicates a no-op (Task 1 precondition proof).
 */
export function resendReverseAnnounces(
  roomId: string,
  deps: Pick<ReverseLegDeps, 'sentReverseAnnounces' | 'reverseAnnouncer' | 'logger'>,
): void {
  const roomStore = deps.sentReverseAnnounces.get(roomId);
  if (!roomStore || deps.reverseAnnouncer === null) return;
  const reverseAnnouncer = deps.reverseAnnouncer;
  for (const e of roomStore.values()) {
    // Mirror the shipped arity split (reverseConsumeAndAnnounce) so a non-tree entry stays a 5-arg call.
    if (e.hopTtl === undefined && e.originProducerId === undefined) {
      reverseAnnouncer(roomId, e.producer, e.producerPeerId, e.scopedPeer, e.rtpParameters);
    } else {
      reverseAnnouncer(roomId, e.producer, e.producerPeerId, e.scopedPeer, e.rtpParameters, e.hopTtl, e.originProducerId);
    }
  }
  deps.logger?.info({ roomId, count: roomStore.size }, 'REQ-RMS-037: re-delivered stored reverse announces on link reopen');
}
