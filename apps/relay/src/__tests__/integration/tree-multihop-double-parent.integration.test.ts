/**
 * Cascade-tree Phase T-B — transient DOUBLE-PARENT (B4) dedup + the I-1
 * reverse-mint drain "Path B" fix, both driven end-to-end against REAL
 * mediasoup Workers/Routers/PipeTransports (the same production coordinator
 * primitives the daemon drives — see tree-multihop-cascade-depth2's header
 * disclosure for the harness scope).
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/tree-multihop-double-parent.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  createPrimaryPipeTransport,
  createStandbyPipeTransport,
  pipeProducerOntoPrimaryTransport,
  PrimaryPipeCoordinator,
  StandbyWarmPipeCoordinator,
  InterRelayProducerRegistry,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';

// ── codecs ──────────────────────────────────────────────────────────────────
const audioCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 100 },
];
const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;

/** OS-assigned-port allocator (allocate => 0): rerun-safe, no EADDRINUSE. */
const zeroAllocator: PipePortAllocatorLike = { allocate: () => 0, release: () => {}, size: () => 0 };

// ── module-scoped real Workers (5 for the tree, 2 spare for coordinator legs) ─
const workers: msTypes.Worker[] = [];
beforeAll(async () => {
  for (let i = 0; i < 7; i++) workers.push(await mediasoup.createWorker({ logLevel: 'warn' }));
}, 60_000);
afterAll(() => { for (const w of workers) w?.close(); });

// ══════════════════════════════════════════════════════════════════════════════
// C) double-parent dedup (B4) — REAL StandbyWarmPipeCoordinator on REAL routers
// ══════════════════════════════════════════════════════════════════════════════
/** Build a fully-connected forward pipe leg (parent → child) via the warmpipe-rtp recipe. */
async function buildForwardLeg(
  parentRouter: msTypes.Router,
  childRouter: msTypes.Router,
  sourceProducerId: string,
): Promise<{ childPipe: msTypes.PipeTransport; parentPipe: msTypes.PipeTransport; announced: { producerId: string; kind: msTypes.MediaKind; rtpParameters: msTypes.RtpParameters } }> {
  const parentPipe = await createPrimaryPipeTransport(parentRouter, 0);
  const childPipe = await createStandbyPipeTransport(childRouter, 0);
  await parentPipe.connect({ ip: '127.0.0.1', port: childPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
  await childPipe.connect({ ip: '127.0.0.1', port: parentPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
  const pipedConsumer = await pipeProducerOntoPrimaryTransport(parentPipe, sourceProducerId);
  return { childPipe, parentPipe, announced: { producerId: pipedConsumer.id, kind: pipedConsumer.kind, rtpParameters: pipedConsumer.rtpParameters } };
}
async function makeSource(router: msTypes.Router): Promise<msTypes.Producer> {
  const t = await router.createDirectTransport();
  return t.produce({
    kind: 'audio',
    rtpParameters: { codecs: [{ mimeType: 'audio/opus', payloadType: OPUS_PT, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }], encodings: [{ ssrc: OPUS_SSRC }] },
  });
}

describe('transient DOUBLE-PARENT (B4) — same origin on two edges → consumed ONCE end-to-end (REAL coordinator + REAL pipes)', () => {
  it('the SAME originProducerId arriving on two DISTINCT parent legs into one child mints EXACTLY once (per-room origin dedup)', async () => {
    const parentA = await workers[5]!.createRouter({ mediaCodecs: audioCodecs });
    const parentB = await workers[6]!.createRouter({ mediaCodecs: audioCodecs });
    const child = await workers[0]!.createRouter({ mediaCodecs: audioCodecs });
    const roomId = 'room-double-parent';
    const ORIGIN = 'ORIGIN-DP-SHARED';

    // Two real sources, one per parent router — modelling ONE logical stream reaching the child on
    // two edges (the immutable origin is the SHARED originProducerId the daemon threads on the announce).
    const srcA = await makeSource(parentA);
    const srcB = await makeSource(parentB);
    const legA = await buildForwardLeg(parentA, child, srcA.id);
    const legB = await buildForwardLeg(parentB, child, srcB.id);

    const registry = new InterRelayProducerRegistry();
    // Distinct per-hop producerId per leg (the piped consumer ids differ), SAME immutable origin.
    registry.record({ type: 'pipe-producer', roomId, producerId: legA.announced.producerId, kind: legA.announced.kind, peerRelayId: 'relay-A', rtpParameters: legA.announced.rtpParameters, originProducerId: ORIGIN } as never);
    registry.record({ type: 'pipe-producer', roomId, producerId: legB.announced.producerId, kind: legB.announced.kind, peerRelayId: 'relay-B', rtpParameters: legB.announced.rtpParameters, originProducerId: ORIGIN } as never);

    const mints: msTypes.Producer[] = [];
    const coord = new StandbyWarmPipeCoordinator(
      registry, undefined,
      (_roomId, producer) => { mints.push(producer); }, // onLocalProducer = the local-mint / fan callback
      true,  // activeForward
      true,  // treeActive → per-room origin dedup (B4)
    );

    // Bind each leg's REAL connected child pipe + drive the forward mint via onAnnounce (pending=false
    // path → forwardLocalProducers). Leg A mints ORIGIN once; leg B sees ORIGIN already produced → skip.
    coord.bindPipeTransportForTest(roomId, 'relay-A', legA.childPipe);
    await coord.onAnnounce(roomId, undefined, undefined, undefined, 'relay-A');
    coord.bindPipeTransportForTest(roomId, 'relay-B', legB.childPipe);
    await coord.onAnnounce(roomId, undefined, undefined, undefined, 'relay-B');

    // eslint-disable-next-line no-console
    console.log(`[T-B B4 double-parent] localMintCount(child)=${mints.length}`);
    expect(mints.length).toBe(1);                          // consumed ONCE (no dup)
    expect(child.canConsume({ producerId: mints[0]!.id, rtpCapabilities: child.rtpCapabilities })).toBe(true); // real, consumable

    try {
      mints[0]!.close(); srcA.close(); srcB.close();
      legA.childPipe.close(); legA.parentPipe.close(); legB.childPipe.close(); legB.parentPipe.close();
      parentA.close(); parentB.close(); child.close();
    } catch { /* best-effort */ }
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// D) I-1 reverse-mint drain "Path B" — REAL PrimaryPipeCoordinator queue→drain (the 4c41c45 fix)
// ══════════════════════════════════════════════════════════════════════════════
describe('I-1 reverse-mint drain Path B (REQ-RMS-043/044/046) — queued-then-drained preserves the immutable origin + un-reseeded budget, no double-consume', () => {
  it('a reverse announce QUEUED before the leg connects, then minted on drain, fires onReverseMinted EXACTLY once with the IMMUTABLE origin + the un-reseeded inbound hopTtl (NOT the fresh mint id, NOT a reseeded diameter)', async () => {
    const standbyRouter = await workers[5]!.createRouter({ mediaCodecs: audioCodecs });
    const primaryRouter = await workers[6]!.createRouter({ mediaCodecs: audioCodecs });
    const roomId = 'room-reverse-pathB';
    const ORIGIN = 'ORIGIN-DP-REV';
    const PUBLISHER = 'standby-publisher';
    const INBOUND_HOP = 2;

    // ── Build a REAL connected reverse pipe (standby → primary) + obtain the announced remapped
    //    rtpParameters from the standby reverse-consume (warmpipe-rtp recipe). ──
    const publisher = await makeSource(standbyRouter);
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);
    const primaryReversePipe = await createPrimaryPipeTransport(primaryRouter, 0);
    await standbyPipe.connect({ ip: '127.0.0.1', port: primaryReversePipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await primaryReversePipe.connect({ ip: '127.0.0.1', port: standbyPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const reverseConsumer = await pipeProducerOntoPrimaryTransport(standbyPipe, publisher.id);
    const announced = { producerId: reverseConsumer.id, kind: reverseConsumer.kind, rtpParameters: reverseConsumer.rtpParameters };
    expect(announced.producerId).not.toBe(publisher.id); // the announce carries the PIPED id, not the source

    // ── REAL PrimaryPipeCoordinator (treeActive → fresh per-hop mint) with an onReverseMinted spy. ──
    const reverseMintedCalls: Array<{ minted: msTypes.Producer; originRelayId: string; producerPeerId?: string; originProducerId?: string; hopTtl?: number }> = [];
    let reply: PipeConnectParams | null = null;
    const coord = new PrimaryPipeCoordinator({
      announcer: () => {},
      portAllocator: zeroAllocator,
      paramSender: (_r, params) => { reply = params; },
      onReverseMinted: (_roomId, minted, originRelayId, producerPeerId, originProducerId, hopTtl) => {
        reverseMintedCalls.push({ minted, originRelayId, producerPeerId, originProducerId, hopTtl });
      },
      treeActive: true,
    });

    // ── PATH B: reverseMint BEFORE the leg transport is bound → QUEUES (returns null, no immediate mint). ──
    const queued = await coord.reverseMint(roomId, primaryRouter, {
      producerId: announced.producerId, kind: announced.kind, rtpParameters: announced.rtpParameters,
      producerPeerId: PUBLISHER, originProducerId: ORIGIN, hopTtl: INBOUND_HOP,
    });
    expect(queued).toBeNull();                    // queued, not minted
    expect(reverseMintedCalls).toHaveLength(0);   // onReverseMinted has NOT fired yet

    // ── DRAIN: bind the REAL connected primary reverse pipe, then drain the queue. ──
    coord.bindLegTransportForTest(roomId, DEFAULT_PEER_RELAY_ID, primaryReversePipe);
    const drained = await coord.drainReverseMints(roomId, DEFAULT_PEER_RELAY_ID);

    // eslint-disable-next-line no-console
    console.log(`[T-B I-1 reverse Path B] drained=${drained.length} onReverseMintedCalls=${reverseMintedCalls.length}`);
    expect(drained).toHaveLength(1);              // minted exactly once on drain (no double-consume)
    expect(reverseMintedCalls).toHaveLength(1);   // onReverseMinted fired EXACTLY once
    const call = reverseMintedCalls[0]!;
    expect(call.originProducerId).toBe(ORIGIN);   // the IMMUTABLE origin threaded through the drain
    expect(call.hopTtl).toBe(INBOUND_HOP);        // the inbound budget is NOT reseeded to a full diameter
    expect(call.producerPeerId).toBe(PUBLISHER);  // the original publisher survives the queue→drain
    expect(call.minted.id).not.toBe(ORIGIN);      // the mint has a FRESH per-hop id (Task 5 freshId), NOT the origin
    expect(primaryRouter.canConsume({ producerId: call.minted.id, rtpCapabilities: primaryRouter.rtpCapabilities })).toBe(true);

    try {
      call.minted.close(); publisher.close();
      standbyPipe.close(); primaryReversePipe.close();
      coord.clear(roomId, DEFAULT_PEER_RELAY_ID);
      standbyRouter.close(); primaryRouter.close();
    } catch { /* best-effort */ }
  }, 60_000);
});
