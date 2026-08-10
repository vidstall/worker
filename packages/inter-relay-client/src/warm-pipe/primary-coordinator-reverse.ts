/**
 * Primary warm-pipe coordinator — part-3 REVERSE leg (REQ-RMS-034/037), split
 * out of primary-coordinator.ts as free functions that take explicit params
 * (the coordinator's private Maps + its deps object) instead of closing over
 * `this`. PrimaryPipeCoordinator keeps thin wrapper methods that call these.
 *
 * A standby-homed client's media flows UP the warm pipe to the PRIMARY, which
 * mints a LOCAL hub copy from the announced reverse-pipe consumer (then fans
 * it). The dual of the forward onProducer/drain: mint LOCALLY (no announce),
 * with an announce-before-leg-connected QUEUE (REQ-RMS-037 ordering) + per-leg
 * dedup (REQ-RMS-034 mint exactly once).
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import { produceLocalFromPipe } from '../relay-role-manager.js';
import { meshKey, primaryPortKey, DEFAULT_PEER_RELAY_ID } from './pipe-protocol.js';
import { createPrimaryPipeTransport } from './primary-pipe-transport.js';
import type { PrimaryPipeCoordinatorDeps, PrimaryPipeState } from './primary-coordinator.js';

/** One reverse announce queued until the leg transport is connected. */
export interface ReverseMintPendingEntry {
  producerId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
  producerPeerId?: string;
  // T-B (REQ-RMS-043/044/046, T7 I-1) — the IMMUTABLE origin + inbound hop budget carried on the
  // queued announce (same inbound-announce source the immediate reverse path reads), so a queued-
  // then-drained mint threads them into onReverseMinted → registerReverseMinted. Undefined on the
  // shipped star / pre-tree path → the drain fires onReverseMinted 4-arg (byte-stable).
  originProducerId?: string;
  hopTtl?: number;
}

/** Explicit deps the reverse-leg free functions need, passed in by the class. */
export interface PrimaryReverseLegDeps {
  states: Map<string, PrimaryPipeState>;
  reverseMintPending: Map<string, ReverseMintPendingEntry[]>;
  reverseMintedIds: Map<string, Set<string>>;
  deps: PrimaryPipeCoordinatorDeps;
}

/**
 * The shared mint+dedup primitive. Mints EXACTLY ONCE per producerId on this
 * leg (REQ-RMS-034). A benign idempotent dup from mediasoup ("already exists")
 * is swallowed -> null (mirror forward Fix-1). A TRANSIENT produce failure
 * UN-MARKS the id so a later announce can retry (mirror A2 reverse-consume
 * self-heal at inter-relay.ts:1253-1257) then rethrows.
 */
async function mintOne(
  key: string,
  transport: msTypes.PipeTransport,
  announced: {
    producerId: string;
    kind: msTypes.MediaKind;
    rtpParameters: msTypes.RtpParameters;
    producerPeerId?: string;
  },
  reverseMintedIds: Map<string, Set<string>>,
  treeActive: boolean | undefined,
): Promise<msTypes.Producer | null> {
  let seen = reverseMintedIds.get(key);
  if (!seen) {
    seen = new Set();
    reverseMintedIds.set(key, seen);
  }
  if (seen.has(announced.producerId)) return null;
  seen.add(announced.producerId);
  try {
    // T6 — tree mode mints a FRESH local id per hop (freshId); default keeps the
    // shipped same-id reverse mint byte-stable. Dedup above stays on the announced id.
    return await produceLocalFromPipe(transport, announced, { freshId: treeActive === true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|duplicate/i.test(message)) return null; // benign idempotent dup
    seen.delete(announced.producerId); // transient -> allow retry
    throw err;
  }
}

/**
 * Mint a LOCAL hub producer on the primary from the announced reverse-pipe
 * consumer. Returns the minted producer, or null if QUEUED (the leg transport
 * is not connected yet) or if it was a no-op dedup. A queued announce is minted
 * later by drainReverseMints when the leg connects (REQ-RMS-037 ordering).
 */
export async function reverseMint(
  roomId: string,
  announced: {
    producerId: string;
    kind: msTypes.MediaKind;
    rtpParameters: msTypes.RtpParameters;
    producerPeerId?: string;
    originProducerId?: string;
    hopTtl?: number;
  },
  peerRelayId: string,
  legDeps: PrimaryReverseLegDeps,
): Promise<msTypes.Producer | null> {
  const key = meshKey(roomId, peerRelayId);
  const transport = legDeps.states.get(key)?.pipeTransport ?? null;
  if (!transport) {
    const q = legDeps.reverseMintPending.get(key) ?? [];
    q.push(announced);
    legDeps.reverseMintPending.set(key, q);
    legDeps.deps.logger?.debug(
      { roomId, peerRelayId, producerId: announced.producerId },
      'R3: reverse announce queued -- awaiting leg transport connect',
    );
    return null;
  }
  return mintOne(key, transport, announced, legDeps.reverseMintedIds, legDeps.deps.treeActive);
}

/**
 * Drain every queued reverse announce onto the (now-connected) leg transport,
 * minting a local hub producer for each (REQ-RMS-037). Called on leg connect.
 * No-op if the leg transport is still absent. Returns the minted producers.
 *
 * RESILIENT (C1; mirrors A2's "one bad queued item must not discard the rest"
 * lesson at the reverse-consume drain): we snapshot+clear the pending queue,
 * then mint each item INDEPENDENTLY. A transient mintOne throw on item k must
 * NOT abort the loop and lose items k+1..n (they were already cleared from the
 * pending map) -> instead we log, RE-QUEUE the failed item onto the LIVE
 * pending map (safe: we iterate the separate `pend` snapshot), and CONTINUE.
 * mintOne already un-marked the id on a transient throw (seen.delete), so the
 * re-queued retry re-mints; a benign dup still returns null (no double-mint).
 */
export async function drainReverseMints(
  roomId: string,
  peerRelayId: string,
  legDeps: PrimaryReverseLegDeps,
): Promise<msTypes.Producer[]> {
  const key = meshKey(roomId, peerRelayId);
  const transport = legDeps.states.get(key)?.pipeTransport ?? null;
  if (!transport) return [];
  const pend = legDeps.reverseMintPending.get(key) ?? [];
  legDeps.reverseMintPending.set(key, []);
  const out: msTypes.Producer[] = [];
  for (const a of pend) {
    try {
      const p = await mintOne(key, transport, a, legDeps.reverseMintedIds, legDeps.deps.treeActive);
      if (p) {
        out.push(p);
        // B4a (REQ-RMS-037) — fan the queued-then-drained mint (the A6 double-
        // race tail: it bypassed the handler's immediate registerReverseMinted
        // because reverseMint returned null when queued). Thread the entry's
        // ORIGINAL producerPeerId so the fan binds to the real publisher. Fires
        // exactly once per successful mint (inside `if (p)`); dedup'd upstream
        // by mintOne's reverseMintedIds set so a benign dup never re-fans.
        // T-B (REQ-RMS-043/044/046, T7 I-1) — ALSO thread the IMMUTABLE origin + inbound hop budget
        // the entry carried, so the tree hub-fan re-forwards on the origin (not the fresh mint id)
        // with the real budget (not a reseeded full diameter). Guard-widen: the shipped star / pre-
        // tree drain (both undefined) keeps the EXACT 4-arg call the coordinator arity test pins.
        if (a.originProducerId === undefined && a.hopTtl === undefined) {
          legDeps.deps.onReverseMinted?.(roomId, p, peerRelayId, a.producerPeerId);
        } else {
          legDeps.deps.onReverseMinted?.(roomId, p, peerRelayId, a.producerPeerId, a.originProducerId, a.hopTtl);
        }
      }
    } catch (err) {
      legDeps.deps.logger?.warn(
        {
          roomId,
          peerRelayId,
          producerId: a.producerId,
          error: err instanceof Error ? err.message : String(err),
        },
        'R3: reverse mint failed mid-drain - continuing, re-queued for retry',
      );
      const live = legDeps.reverseMintPending.get(key) ?? [];
      live.push(a);
      legDeps.reverseMintPending.set(key, live);
    }
  }
  return out;
}

/**
 * Ensure the primary's reverse-leg pipe transport exists by MIRRORING the FULL
 * onProducer handshake -- mint + connect + the §2 paramSender DOWN-reply that
 * carries the primary's OWN bound port (I1: the reply is PART of the handshake;
 * onProducer is the only other paramSender call site, so without it here the
 * standby never learns the primary's port -> half-open pipe -> no reverse
 * media, and a later onProducer sees pipeTransport != null and SKIPS its own
 * reply). If the standby params are not yet present we CANNOT connect -> log +
 * return; a later onStandbyConnectParams completes the pair.
 *
 * The create-leg branch calls REAL mediasoup (createPrimaryPipeTransport) so it
 * is NOT unit-tested here -- A5's hermetic integration test MUST cover the
 * reverse-announce-arrives-BEFORE-any-forward-producer path (this function's
 * reason to exist). The already-bound (no-op) branch is unit-covered
 * (RED-RA-3b-order / -resilient) via the caller's drain-only fallthrough.
 *
 * Transport-mint ONLY — the caller (PrimaryPipeCoordinator.ensureReverseLeg)
 * still owns draining the forward + reverse queues afterward (RC-A), since
 * that shares the class's own `drain` (forward path, not part of the reverse
 * leg group).
 */
export async function ensureReverseLegTransport(
  roomId: string,
  router: msTypes.Router,
  s: PrimaryPipeState,
  peerRelayId: string,
  deps: PrimaryPipeCoordinatorDeps,
): Promise<void> {
  if (s.pipeTransport !== null) return;
  if (s.standbyParams === null) {
    deps.logger?.debug(
      { roomId, peerRelayId },
      'R3: ensureReverseLeg deferred -- standby pipe-connect params not yet present',
    );
    return;
  }
  if (s.pipePort === null) {
    s.pipePort = deps.portAllocator.allocate(primaryPortKey(roomId, peerRelayId));
  }
  // A5 MUST cover this real-mediasoup mint+connect+reply path for the
  // reverse-announce-before-any-forward-producer case (not unit-tested).
  const transport = await createPrimaryPipeTransport(router, s.pipePort);
  s.pipeTransport = transport;
  await transport.connect({
    ip: s.standbyParams.ip,
    port: s.standbyParams.port,
    srtpParameters: s.standbyParams.srtpParameters,
  } as Parameters<msTypes.PipeTransport['connect']>[0]);
  s.connected = true;
  // §2 handshake DOWN-reply with the primary's OWN bound port (byte-mirrors
  // onProducer): without it the standby can't complete the pipe. SRTP field
  // is guard-spread so a flag-OFF reply stays byte-identical; peerRelayId is
  // DEFAULT-gated so the legacy single-standby reply routes to the legacy link.
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
  deps.paramSender(
    roomId,
    {
      ip: announcedIp,
      port: transport.tuple.localPort,
      ...(transport.srtpParameters !== undefined
        ? { srtpParameters: transport.srtpParameters }
        : {}),
    },
    peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId,
  );
  deps.logger?.info(
    { roomId, peerRelayId, primaryPort: transport.tuple.localPort },
    'R3: reverse-leg pipe transport minted + connected to standby + replied DOWN',
  );
}
