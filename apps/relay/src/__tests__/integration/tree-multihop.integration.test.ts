/**
 * Cascade-tree Phase T-B — HERMETIC multi-router depth-2 tree proof (Task 9).
 * REQ-RMS-042 / 043 / 044 / 046 (+ REQ-RMS-048 flag-parity).
 *
 * This is the end-to-end judge of Tasks 3–7 on REAL mediasoup. It spawns ≥5 real
 * Workers/Routers, forces a D=2/H=2 spanning tree via `RMS_TREE_DEGREE=2` (B1),
 * and drives the ACTUAL tree-forwarding decision function (`computeTreeFanPlan`)
 * hop-by-hop across REAL mediasoup pipe transports.
 *
 * ┌─ MANDATORY DISCLOSURE (round-2 N1) — what this HAND-WIRED harness DOES / does NOT prove ─┐
 * │                                                                                          │
 * │ HAND-WIRED, like the warmpipe-rtp / multi-hop-byte-identity models. It proves the        │
 * │ FAN LOGIC + byte-identity + loop-guard + per-room dedup + the reverse-drain threading    │
 * │ on real media, by driving the SAME production primitives the daemon drives:              │
 * │                                                                                          │
 * │   • the tree SHAPE is DERIVED by the real `deriveTreePosition` (D=2 forces depth-2) —     │
 * │     never hand-asserted;                                                                  │
 * │   • the fan DECISION at every hop is the real `computeTreeFanPlan` (edge-scope + hop-     │
 * │     guard + seed/decrement) — the exact pure fn `index.ts fanToTreeNeighbors` calls;      │
 * │   • the media CARRY is real mediasoup pipeToRouter (`pipeRoomToSecondWorker`) — the same  │
 * │     opaque byte-preserving pipe the daemon's onPrimaryProducer/onStandbyProducer legs use;│
 * │   • the per-room origin dedup + internal received-DOWN re-forward is the REAL             │
 * │     `StandbyWarmPipeCoordinator` (treeActive) on REAL routers + REAL connected pipes;     │
 * │   • the reverse-drain Path B is the REAL `PrimaryPipeCoordinator` reverseMint→queue→      │
 * │     drainReverseMints→onReverseMinted chain (the 4c41c45 I-1 fix) on a REAL pipe.         │
 * │                                                                                          │
 * │ The `driveTreeFan()` helper below is a FAITHFUL reconstruction of the index.ts main-      │
 * │ scoped `fanToTreeNeighbors` closure (index.ts:936-966): it calls `computeTreeFanPlan`     │
 * │ + `resolveRelayEndpoint` identically, maps `plan.childUrls` → DOWN pipes (the             │
 * │ onPrimaryProducer leg) and `plan.parentUrl` → an UP pipe (the onStandbyProducer leg).     │
 * │ HONEST SCOPE of the reconstruction (do NOT overclaim): the closure itself can't be        │
 * │ imported without booting the daemon, so the two glue seams it stands in for are covered    │
 * │ ELSEWHERE, not here:                                                                       │
 * │   • the SIGNALING own-produce HOIST (handleProduce → fanToTreeNeighbors, §3.3) — the case  │
 * │     a revert would break — is covered RED-on-revert by `tree-own-produce-hoist.test.ts`    │
 * │     (a signaling-level spy on the REAL handleProduce; verified RED when the hoist is        │
 * │     reverted). The C/D coordinator tests below are REAL end-to-end (no reconstruction).    │
 * │   • the plan→leg dispatch INSIDE fanToTreeNeighbors (childUrls→onPrimaryProducer,          │
 * │     parentUrl→onStandbyProducer) is REVIEW-ONLY here — NOT RED-on-revert covered (a T-C    │
 * │     live obligation). The T7 unit suite (tree-forwarding.test.ts) covers the coordinator   │
 * │     CALLBACK threading, NOT this plan→leg mapping.                                          │
 * │                                                                                          │
 * │ NOT claimed: this does NOT prove the daemon auto-BUILDS the live tree-link mesh (the      │
 * │ RoomAssigned → standbyLinkManager.connectTo(parentUrl) wiring, design §0.1). That is a    │
 * │ T-C live-run assertion. The I1 test below drives the handler's exact call SEQUENCE         │
 * │ (determineRole → deriveTreePosition → resolveTreeParentDial → connectTo) as a function    │
 * │ composition, NOT the booted poller — it is REVIEW-ONLY (NOT RED-on-revert), and does NOT   │
 * │ close index.ts:1037's handler-wiring TODO (still a T-C obligation). The byte-identity      │
 * │ carry uses pipeToRouter (same-id                                                          │
 * │ across hops); the FRESH per-hop id (Task 5) is proven separately by the coordinator       │
 * │ dedup + reverse-drain tests below (produceLocalFromPipe freshId on real routers).         │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/tree-multihop.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  // T-A tree derivation + T-B fan carry primitives (all REAL production code).
  toCanonicalRelayId,
  determineRole,
  pipeRoomToSecondWorker,
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
import { InMemoryRelayEndpointCache } from '@dvconf/shared';
import {
  deriveTreePosition,
  computeTreeFanPlan,
  seedOrDecrementHop,
  type TreePosition,
} from '../../tree-position.js';
import { resolveRelayEndpoint, resolveTreeParentDial } from '../../relay-endpoint-resolver.js';
import {
  encryptFrame,
  decryptFrame,
  SFRAME_TRAILER_LEN,
  codecOffsetForFrameType,
  type KeyLookup,
} from '../../../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';
import {
  VP8_PT,
  makeVp8RtpWithBody,
  makeRtcpSenderReport,
  realKeying,
  locateForwardedSframe,
} from './_sframe-byteid-helpers.js';

// ── codecs ──────────────────────────────────────────────────────────────────
const videoCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const audioCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: 100 },
];
const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** OS-assigned-port allocator (allocate => 0): rerun-safe, no EADDRINUSE. */
const zeroAllocator: PipePortAllocatorLike = { allocate: () => 0, release: () => {}, size: () => 0 };

// ── SHAPING degree that FORCES the depth-2 tree (B1) ──────────────────────────
const RMS_TREE_DEGREE = 2;
const RMS_TREE_MAX_HEIGHT = 3;

// ── module-scoped real Workers (5 for the tree, 2 spare for coordinator legs) ─
const workers: msTypes.Worker[] = [];
beforeAll(async () => {
  for (let i = 0; i < 7; i++) workers.push(await mediasoup.createWorker({ logLevel: 'warn' }));
}, 60_000);
afterAll(() => { for (const w of workers) w?.close(); });

// ── a derived tree of REAL routers ────────────────────────────────────────────
interface TreeNode {
  index: number;
  id: string;          // canonical relayId
  url: string;         // ws endpoint (the id-space bridge target)
  router: msTypes.Router;
  pos: TreePosition;
}
interface Tree {
  nodes: TreeNode[];
  resolve: (id: string) => string | null;
  urlToNode: Map<string, TreeNode>;
}

/**
 * Build a tree of real routers over `rawIds`. Each node's TreePosition is DERIVED by the
 * production `deriveTreePosition` with the SHAPING degree — the shape is never hand-asserted.
 */
async function buildTree(
  rawIds: string[],
  codecs: msTypes.RtpCodecCapability[],
): Promise<Tree> {
  const cache = new InMemoryRelayEndpointCache();
  const nodes: TreeNode[] = [];
  const urlToNode = new Map<string, TreeNode>();
  for (let i = 0; i < rawIds.length; i++) {
    const id = toCanonicalRelayId(rawIds[i]!);
    const url = `ws://r${i}.tree:41${String(i).padStart(2, '0')}`;
    cache.setUrl(id, url);
    const router = await workers[i]!.createRouter({ mediaCodecs: codecs });
    const pos = deriveTreePosition(rawIds, rawIds[i]!, RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT);
    const node: TreeNode = { index: i, id, url, router, pos };
    nodes.push(node);
    urlToNode.set(url, node);
  }
  // resolve is the SAME fn index.ts fanToTreeNeighbors uses (resolveRelayEndpoint on the shared cache).
  return { nodes, resolve: (id: string) => resolveRelayEndpoint(cache, id), urlToNode };
}

/**
 * FAITHFUL reconstruction of index.ts `fanToTreeNeighbors` (index.ts:936-966) driving REAL pipes.
 * At each node it calls the REAL `computeTreeFanPlan` (edge-scope + hop-guard), then for each
 * resolved child URL pipes DOWN (the onPrimaryProducer leg) and for the parent URL pipes UP
 * (the onStandbyProducer leg) via real mediasoup pipeToRouter. Recurses at each neighbor with
 * receiveEdge = the URL it arrived on + inboundHopTtl = plan.hop. Records what each node fanned
 * to (for the no-echo assert) and where the hop-guard dropped a re-forward.
 */
interface DriveResult {
  reached: Map<string, { router: msTypes.Router; producerId: string }>;
  fannedTargets: Map<string, string[]>;
  guardDrops: string[];
}
async function driveTreeFan(
  tree: Tree,
  startIdx: number,
  startRouter: msTypes.Router,
  sourceProducerId: string,
  receiveEdge: string | null,
  inboundHopTtl: number | undefined,
): Promise<DriveResult> {
  const reached = new Map<string, { router: msTypes.Router; producerId: string }>();
  const fannedTargets = new Map<string, string[]>();
  const guardDrops: string[] = [];
  reached.set(tree.nodes[startIdx]!.url, { router: startRouter, producerId: sourceProducerId });

  async function fanFrom(nodeIdx: number, edge: string | null, inHop: number | undefined): Promise<void> {
    const node = tree.nodes[nodeIdx]!;
    // THE REAL FAN DECISION (identical call to index.ts fanToTreeNeighbors).
    const plan = computeTreeFanPlan(node.pos, edge, inHop, tree.resolve);
    const targets = [...plan.childUrls, ...(plan.parentUrl !== null ? [plan.parentUrl] : [])];
    fannedTargets.set(node.url, targets);
    if (plan.hop <= 0) guardDrops.push(node.url);
    const here = reached.get(node.url)!;
    for (const targetUrl of targets) {
      const target = tree.urlToNode.get(targetUrl)!;
      if (!reached.has(targetUrl)) {
        // REAL mediasoup carry: pipe the producer to the neighbor router (byte-preserving).
        await pipeRoomToSecondWorker(here.router, target.router, here.producerId);
        reached.set(targetUrl, { router: target.router, producerId: here.producerId });
      }
      await fanFrom(target.index, node.url, plan.hop);
    }
  }
  await fanFrom(startIdx, receiveEdge, inboundHopTtl);
  return { reached, fannedTargets, guardDrops };
}

// ── SFrame builders (mirror multi-hop-byte-identity) ──────────────────────────
async function buildSframes(): Promise<{
  sframes: Uint8Array[]; sentBodiesB64: Set<string>; kid: number; keyLookup: KeyLookup; ctrToPlain: Map<number, Uint8Array>;
}> {
  const { kid, encryptKey, keyLookup } = await realKeying();
  const plaintexts = [
    new TextEncoder().encode('T-B tree frame ONE alpha alpha alpha'),
    new TextEncoder().encode('tree frame TWO bravo'),
    new TextEncoder().encode('the THIRD tree frame charlie charlie charlie charlie'),
  ];
  const sframes: Uint8Array[] = [];
  const ctrToPlain = new Map<number, Uint8Array>();
  for (let i = 0; i < plaintexts.length; i++) {
    const codecOffset = codecOffsetForFrameType('key', plaintexts[i]!.length);
    sframes.push(await encryptFrame(plaintexts[i]!, { kid, ctr: i }, encryptKey, codecOffset));
    ctrToPlain.set(i, plaintexts[i]!);
  }
  const sentBodiesB64 = new Set(sframes.map((s) => Buffer.from(s).toString('base64')));
  return { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain };
}

interface Capture { consumer: msTypes.Consumer; captured: Buffer[]; transport: msTypes.DirectTransport }
async function captureAt(router: msTypes.Router, producerId: string): Promise<Capture> {
  const transport = await router.createDirectTransport();
  const consumer = await transport.consume({ producerId, rtpCapabilities: router.rtpCapabilities, paused: false });
  const captured: Buffer[] = [];
  consumer.on('rtp', (pkt: Buffer) => { captured.push(Buffer.from(pkt)); if (captured.length > 1024) captured.shift(); });
  return { consumer, captured, transport };
}

/** Drive a VP8 SFrame source + return the far-node captures. */
async function driveVideoAndCapture(
  tree: Tree,
  startIdx: number,
  receiveEdge: string | null,
  inboundHopTtl: number | undefined,
  sframes: Uint8Array[],
  captureUrls: string[],
): Promise<{ caps: Map<string, Capture | null>; drive: DriveResult }> {
  const startNode = tree.nodes[startIdx]!;
  const ssrc = 0x6000_0000 + startIdx * 0x100;
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    encodings: [{ ssrc, scalabilityMode: 'L1T1' }],
  };
  const srcTransport = await startNode.router.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'video', rtpParameters });

  // Build the pipe tree via the REAL fan decision (computeTreeFanPlan) before RTP flows.
  const drive = await driveTreeFan(tree, startIdx, startNode.router, producer.id, receiveEdge, inboundHopTtl);

  const caps = new Map<string, Capture | null>();
  for (const url of captureUrls) {
    caps.set(url, drive.reached.has(url) ? await captureAt(tree.urlToNode.get(url)!.router, producer.id) : null);
  }
  for (const c of caps.values()) if (c) await c.consumer.requestKeyFrame();

  let seq = 0, pic = 0, ts = 0, frame = 0, pkts = 0, octets = 0;
  const interval = setInterval(() => {
    const keyframe = frame % 10 === 0;
    const body = sframes[frame % sframes.length]!;
    const packet = makeVp8RtpWithBody({ ssrc, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe });
    producer.send(packet);
    pkts += 1; octets += packet.length;
    if (keyframe) srcTransport.sendRtcp(makeRtcpSenderReport(ssrc, ts, pkts, octets));
    ts += 3000; frame++;
  }, 10);
  await sleep(1000);
  clearInterval(interval);
  await sleep(60);
  try { producer.close(); srcTransport.close(); } catch { /* best-effort */ }
  return { caps, drive };
}

/** Count media packets + byte-identical SFrame bodies + decrypt-recovers at a capture. */
async function analyzeCapture(
  captured: Buffer[],
  kid: number,
  sentBodiesB64: Set<string>,
  keyLookup: KeyLookup,
  ctrToPlain: Map<number, Uint8Array>,
): Promise<{ mediaPackets: number; byteIdentical: number; decryptedOk: number }> {
  let mediaPackets = 0, byteIdentical = 0, decryptedOk = 0;
  const minBody = 1 + 16 + SFRAME_TRAILER_LEN;
  for (const pkt of captured) {
    if (pkt.length < 12 + 4 + 3 + minBody) continue;
    mediaPackets++;
    const found = locateForwardedSframe(pkt, kid, sentBodiesB64);
    if (!found) continue;
    byteIdentical++;
    const body = Uint8Array.prototype.slice.call(pkt.subarray(found.bodyOffset));
    const recovered = await decryptFrame(body, keyLookup);
    if (Buffer.from(recovered).equals(Buffer.from(ctrToPlain.get(found.ctr)!))) decryptedOk++;
  }
  return { mediaPackets, byteIdentical, decryptedOk };
}

// ══════════════════════════════════════════════════════════════════════════════
// A) depth-2 tree byte-identity + no-echo + loop-guard (REQ-RMS-042/044)
// ══════════════════════════════════════════════════════════════════════════════
describe('cascade-tree depth-2 (D=2 forces the shape) — REAL multi-router forwarding', () => {
  it('the shape is DERIVED (not hand-asserted): D=2 → R0 root {R1,R2}; R1 internal {R3,R4}; R2/R3/R4 leaves; diameter 3', async () => {
    const tree = await buildTree(['0x00', '0x01', '0x02', '0x03', '0x04'], videoCodecs);
    const [r0, r1, r2, r3, r4] = tree.nodes as [TreeNode, TreeNode, TreeNode, TreeNode, TreeNode];
    expect(r0.pos.role).toBe('root');
    expect(r0.pos.parent).toBeNull();
    expect(r0.pos.children).toEqual([r1.id, r2.id]);
    expect(r1.pos.role).toBe('internal');
    expect(r1.pos.parent).toBe(r0.id);
    expect(r1.pos.children).toEqual([r3.id, r4.id]);
    expect(r2.pos.role).toBe('leaf');
    expect(r3.pos.role).toBe('leaf');
    expect(r4.pos.role).toBe('leaf');
    // diameter drives the seeded hop budget (exact-diameter TTL, REQ-RMS-044).
    expect(r0.pos.diameter).toBe(3);
  }, 60_000);

  it('leaf producer crosses ≥2 internal hops, byte-identical at a far leaf (R3→R1→R0→R2)', async () => {
    const tree = await buildTree(['0x00', '0x01', '0x02', '0x03', '0x04'], videoCodecs);
    const R2 = tree.nodes[2]!.url, R4 = tree.nodes[4]!.url;
    const { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain } = await buildSframes();

    // Produce at the LEAF R3; drive the T-B fan. R3→(UP)R1→(UP)R0→(DOWN)R2 = 2 internal hops.
    const { caps, drive } = await driveVideoAndCapture(tree, 3, null, undefined, sframes, [R2, R4]);

    const farLeaf = caps.get(R2)!;
    expect(farLeaf).not.toBeNull();
    const a = await analyzeCapture(farLeaf!.captured, kid, sentBodiesB64, keyLookup, ctrToPlain);
    // eslint-disable-next-line no-console
    console.log(`[T-B far-leaf R3→R1→R0→R2] mediaPackets=${a.mediaPackets} byteIdentical=${a.byteIdentical} decryptedOk=${a.decryptedOk}`);
    expect(a.mediaPackets).toBeGreaterThan(0);
    expect(a.byteIdentical).toBe(a.mediaPackets);   // byte-identical across ≥2 internal hops
    expect(a.decryptedOk).toBe(a.byteIdentical);     // decrypt recovers the original plaintext

    // Cross-subtree also reached R4 (R1's OTHER child) — a distinct subtree leaf sees the stream.
    const otherLeaf = caps.get(R4)!;
    expect(otherLeaf).not.toBeNull();
    const b = await analyzeCapture(otherLeaf!.captured, kid, sentBodiesB64, keyLookup, ctrToPlain);
    expect(b.byteIdentical).toBeGreaterThan(0);

    // The producer must have REACHED both far nodes through the real pipe tree.
    expect(drive.reached.has(R2)).toBe(true);
    expect(drive.reached.has(R4)).toBe(true);
    for (const c of caps.values()) if (c) { try { c.consumer.close(); c.transport.close(); } catch { /* best-effort */ } }
  }, 60_000);

  it('the receive edge is never fanned back (no echo): R1 (arrived-from R3) does NOT re-fan to R3', async () => {
    const tree = await buildTree(['0x00', '0x01', '0x02', '0x03', '0x04'], videoCodecs);
    const R3 = tree.nodes[3]!.url;
    const { drive } = await driveVideoAndCapture(tree, 3, null, undefined, (await buildSframes()).sframes, []);
    const reannouncedAtR1 = drive.fannedTargets.get(tree.nodes[1]!.url) ?? [];
    // R1 received on the R3 edge → it fans UP to R0 + DOWN to R4, but NEVER back to R3 (edge-scope).
    expect(reannouncedAtR1).not.toContain(R3);
    expect(reannouncedAtR1).toContain(tree.nodes[0]!.url); // UP to R0
    expect(reannouncedAtR1).toContain(tree.nodes[4]!.url); // DOWN to R4 (its OTHER child)
  }, 60_000);

  it('hopTtl drops beyond the diameter budget (loop guard): an internal node with an exhausted inbound budget re-forwards to NOBODY, even to un-visited neighbors', async () => {
    const tree = await buildTree(['0x00', '0x01', '0x02', '0x03', '0x04'], videoCodecs);
    const r1 = tree.nodes[1]!;
    const r3Url = tree.nodes[3]!.url;
    // R1 has un-received-edge neighbors (child R4 + parent R0) it WOULD normally fan to; but an
    // inbound budget of 1 → seedOrDecrementHop(1, diameter) == 0 → the <=0 guard yields an EMPTY plan.
    expect(seedOrDecrementHop(1, r1.pos.diameter)).toBe(0);
    const plan = computeTreeFanPlan(r1.pos, r3Url, 1, tree.resolve);
    expect(plan.hop).toBe(0);
    expect(plan.childUrls).toEqual([]);   // R4 NOT fanned despite being un-visited (loop-safe)
    expect(plan.parentUrl).toBeNull();    // R0 NOT fanned despite being un-visited (loop-safe)

    // And in the real end-to-end drive the guard DOES fire at the diameter boundary (the far leaf R2
    // arrives at hop 1 → its own re-forward resolves to 0 → recorded guard drop).
    const { drive } = await driveVideoAndCapture(tree, 3, null, undefined, (await buildSframes()).sframes, []);
    expect(drive.guardDrops).toContain(tree.nodes[2]!.url);
  }, 60_000);

  it('internal own-produce DECISION reaches its OWN subtree (I-2): the own-produce call shape into computeTreeFanPlan is byte-identical at BOTH children R3 and R4', async () => {
    // SCOPE (honest): this drives the DECISION FN (computeTreeFanPlan) with handleProduce's EXACT
    // own-produce call shape —
    //   fanToTreeNeighbors(roomId, router, producer, peerId, producer.id, /*receiveEdge*/ null, /*inboundHopTtl*/ undefined)
    // — and proves the plan fans DOWN to BOTH children (it would fail only if computeTreeFanPlan
    // were UP-only, NOT if the signaling wiring were reverted — the reconstruction can't see the
    // signaling dispatch). The SIGNALING HOIST that actually feeds this call shape (handleProduce
    // → fanToTreeNeighbors, §3.3) is covered RED-on-revert by tree-own-produce-hoist.test.ts.
    const tree = await buildTree(['0x00', '0x01', '0x02', '0x03', '0x04'], videoCodecs);
    const R3 = tree.nodes[3]!.url, R4 = tree.nodes[4]!.url;
    const { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain } = await buildSframes();
    const { caps, drive } = await driveVideoAndCapture(tree, 1, null, undefined, sframes, [R3, R4]);

    // R1's own produce fanned DOWN to BOTH children (concern #1: internal dual-role).
    const fannedAtR1 = drive.fannedTargets.get(tree.nodes[1]!.url) ?? [];
    expect(fannedAtR1).toContain(R3);
    expect(fannedAtR1).toContain(R4);
    expect(fannedAtR1).toContain(tree.nodes[0]!.url); // AND UP to its parent R0 (dual-role)

    for (const url of [R3, R4]) {
      const cap = caps.get(url)!;
      expect(cap).not.toBeNull();
      const a = await analyzeCapture(cap!.captured, kid, sentBodiesB64, keyLookup, ctrToPlain);
      // eslint-disable-next-line no-console
      console.log(`[T-B I-2 internal own-produce → ${url}] mediaPackets=${a.mediaPackets} byteIdentical=${a.byteIdentical}`);
      expect(a.byteIdentical).toBeGreaterThan(0);
      expect(a.byteIdentical).toBe(a.mediaPackets);
      try { cap!.consumer.close(); cap!.transport.close(); } catch { /* best-effort */ }
    }
  }, 60_000);

  it('concern #2 — a tree ROOT own produce fans DOWN only (no phantom UP to a non-existent parent), role-independent', async () => {
    const tree = await buildTree(['0x00', '0x01', '0x02', '0x03', '0x04'], videoCodecs);
    const r0 = tree.nodes[0]!;
    // The fan is driven by TREE position (root: parent=null), NOT chain role — so a tree-root-but-
    // chain-standby node fans DOWN to its children and NEVER announces UP to a non-existent parent.
    const plan = computeTreeFanPlan(r0.pos, null, undefined, tree.resolve);
    expect(plan.parentUrl).toBeNull();
    expect(plan.childUrls.sort()).toEqual([tree.nodes[1]!.url, tree.nodes[2]!.url].sort());
    // Drive it end-to-end: R0's own produce reaches its children, and NOTHING is fanned "up".
    const { drive } = await driveVideoAndCapture(tree, 0, null, undefined, (await buildSframes()).sframes, []);
    const fannedAtR0 = drive.fannedTargets.get(r0.url) ?? [];
    expect(fannedAtR0).toEqual(expect.arrayContaining([tree.nodes[1]!.url, tree.nodes[2]!.url]));
    expect(fannedAtR0).toHaveLength(2); // exactly the two children, no parent
  }, 60_000);

  it('K≤2 with the flag ON collapses to a single-child STAR + forwards byte-identically (REQ-RMS-048)', async () => {
    // SCOPE (honest — NOT a flag-OFF-vs-ON parity DIFF): this proves (a) deriveTree collapses K=2 to
    // the shipped single-standby SHAPE (root + ONE leaf child, diameter 1) and (b) flag-ON forwarding
    // through that star is byte-identical end-to-end. It does NOT measure a byte-diff against the
    // flag-OFF star path (that path isn't driven by this tree harness); the shape-collapse + byte-
    // identity together are the REQ-RMS-048 evidence that flag-ON at K≤2 is the star, not a fan-out.
    const tree = await buildTree(['0x00', '0x01'], videoCodecs);
    const [r0, r1] = tree.nodes as [TreeNode, TreeNode];
    expect(r0.pos.role).toBe('root');
    expect(r0.pos.children).toEqual([r1.id]); // exactly ONE child — a star
    expect(r1.pos.role).toBe('leaf');
    expect(r0.pos.diameter).toBe(1);
    const { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain } = await buildSframes();
    const { caps } = await driveVideoAndCapture(tree, 0, null, undefined, sframes, [r1.url]);
    const cap = caps.get(r1.url)!;
    expect(cap).not.toBeNull();
    const a = await analyzeCapture(cap!.captured, kid, sentBodiesB64, keyLookup, ctrToPlain);
    // eslint-disable-next-line no-console
    console.log(`[T-B K≤2 star R0→R1] mediaPackets=${a.mediaPackets} byteIdentical=${a.byteIdentical}`);
    expect(a.mediaPackets).toBeGreaterThan(0);
    expect(a.byteIdentical).toBe(a.mediaPackets);   // byte-identical through the single-child star
    expect(a.decryptedOk).toBe(a.byteIdentical);
    try { cap!.consumer.close(); cap!.transport.close(); } catch { /* best-effort */ }
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// B) I1 handler-wiring: a NON-root chain-primary DIALS its TREE PARENT (not re-gated on role)
//    ⚠️ REVIEW-ONLY (NOT RED-on-revert). This is a function-COMPOSITION of the handler's decision
//    fns, NOT the booted RoomAssigned poller — reverting the index.ts handler's dial wiring
//    (index.ts:1029-1041) would NOT turn this red. It does NOT close index.ts:1037's handler-wiring
//    TODO; that remains a T-C live obligation. The PURE dial (resolveTreeParentDial) is already
//    RED-on-revert unit-covered (relay-endpoint-resolver.test.ts, incl. the non-sorted I1 regression).
// ══════════════════════════════════════════════════════════════════════════════
describe('I1 handler-wiring (REQ-RMS-042) — the tree dial follows TREE role, not chain slot-0 [composition, review-only]', () => {
  it('composition: a non-root chain-primary would dial its tree parent via the RoomAssigned decision sequence (determineRole→deriveTreePosition→resolveTreeParentDial→connectTo), NOT re-gated on role===primary', () => {
    // DISCLOSURE: this composes the RoomAssigned handler's DECISION FNS (index.ts:1000-1041) — it is
    // NOT the booted poller (which needs a full daemon: chain client, EventPoller, standbyLinkManager),
    // so it is REVIEW-ONLY, NOT RED-on-revert, and does NOT close index.ts:1037's TODO (T-C tracks it).
    // relay_ids are UNSORTED so chain slot-0 (0x02) is NOT the tree root (0x00 = sorted-min canonical).
    const relayIds = ['0x02', '0x00', '0x01', '0x03', '0x04'];
    const myMinerId = '0x02'; // chain slot-0 → chain-PRIMARY, but NOT the tree root
    const cache = new InMemoryRelayEndpointCache();
    for (const raw of relayIds) cache.setUrl(toCanonicalRelayId(raw), `ws://${raw}.node:4100`);

    // (1) it genuinely IS a chain-primary (the case that would be WRONGLY skipped if the dial were
    //     re-gated on role==='primary' — a chain-primary "doesn't dial").
    expect(determineRole(relayIds, myMinerId)).toBe('primary');

    // (2) the handler derives + stores the tree position, then dials via resolveTreeParentDial.
    const roomTreePosition = new Map<string, TreePosition>();
    const pos = deriveTreePosition(relayIds, myMinerId, RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT);
    roomTreePosition.set('room-i1', pos);
    expect(pos.role).not.toBe('root');                    // slot-0 is NOT the tree root
    expect(pos.parent).toBe(toCanonicalRelayId('0x00'));  // its tree parent IS the sorted-min root

    const dials: string[] = [];
    const connectTo = (u: string): void => { dials.push(u); }; // stub for standbyLinkManager.connectTo
    const dialUrl = resolveTreeParentDial(roomTreePosition.get('room-i1'), cache);
    if (dialUrl !== null) connectTo(dialUrl);

    // (3) it dialed the TREE PARENT (0x00), NOT nobody, NOT the chain slot-0 self.
    const parentUrl = cache.getUrl(toCanonicalRelayId('0x00'));
    expect(dialUrl).toBe(parentUrl);
    expect(dials).toEqual([parentUrl]);

    // Contrast: the TRUE tree root (0x00, itself a chain-standby slot-1 here) dials NOBODY.
    const rootPos = deriveTreePosition(relayIds, '0x00', RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT);
    expect(rootPos.parent).toBeNull();
    expect(resolveTreeParentDial(rootPos, cache)).toBeNull();
  });
});

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
