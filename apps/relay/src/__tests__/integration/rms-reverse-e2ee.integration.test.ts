/**
 * REQ-RMS-038 (part-3 Stage R-C) -- HERMETIC E2EE 2-HOP FIDELITY + FAIL-CLOSED-ON-
 * DELIVERY, proven on REAL mediasoup across the reverse hub path
 *   standby-A's client  ->  PRIMARY hub  ->  far standby-C.
 *
 * The E2EE fail-closed gate (Task C1, signaling.ts) is UNIT-proven at the function
 * level by e2ee-failclosed.test.ts (RC-1a..1e, mocked mediasoup). This is the
 * INTEGRATION half: it drives the SHIPPED gate end-to-end through its REAL callers
 * on REAL mediasoup routers + REAL signaling servers, and adds the thing the unit
 * test cannot: REAL M3-Lane-B SFrame ciphertext (realKeying -> encryptFrame)
 * forwarded across the 2-hop pipe stays BYTE-IDENTICAL (E2EE content survives the
 * cross-relay forward), with the P10_FORCE_TAMPER RED hook as teeth.
 *
 * It EXTENDS R-B's rms-reverse-hubfan.integration.test.ts (the live hub-fan DOWN +
 * exclude-origin model: real `createSignalingServer.registerReverseMinted`, a real
 * primary room.router, a real far-standby routerC, real WS clients) with realKeying()
 * for the byte-identity leg, and runs a SECOND real signaling server for the far
 * standby C so the C-side delivery gate is the SHIPPED fanLocalProducer -- not a stub.
 *
 * ── What is asserted (Task C2 (a)-(d)) ────────────────────────────────────────
 *  (a) PUBLISHER-ID SURVIVES BOTH HOPS: the ORIGINAL publisher 'clientA' is what
 *      `registry.resolveByProducerId(roomId, producerId).producerPeerId` returns on
 *      the PRIMARY's registry AND on the far standby's registry -- NEVER a relayId.
 *      Each record is driven through the REAL announce wire (createInterRelayAnnouncer
 *      -> JSON -> isPipeProducerAnnounce guard -> registry.record), so the binding is
 *      proven to survive serialization on each hop (REQ-RMS-029, NOT a hand-seed).
 *  (b) FAIL-CLOSED == NOT-DELIVERED (not never-minted): an E2EE reverse announce with
 *      a MISSING producerPeerId is NOT DELIVERED -- the primary's local clients get NO
 *      `newProducer` (C1's fanLocalProducer gate) AND the far standby's local clients
 *      get NO `newProducer` (C's OWN fanLocalProducer gate). The hub-fan onPrimaryProducer
 *      STILL FIRES for the non-origin standby (the coordinator has no e2ee context --
 *      it forwards transport-level), so we assert on DELIVERY, never on mint.
 *  (c) OPEN-ROOM CONTROL: the SAME missing-id scenario in an OPEN room DELIVERS
 *      (graceful fallback binds to the cascade/origin relayId) and the forwarded media
 *      stays byte-stable -- proving the gate is E2EE-scoped, not a blanket drop.
 *  (d) P10 RED HOOK: the body-byte-identity legs (a/(c)) flip one SFrame ciphertext
 *      byte under P10_FORCE_TAMPER=1 -> byteIdentical < mediaPackets -> the byte-identity
 *      assert FAILS. Unset -> PASS.
 *
 * ── NOT a tautology ───────────────────────────────────────────────────────────
 * The fail-closed DECISION lives ONLY in production (signaling.ts:1998 fanLocalProducer
 * gate, fired via registerReverseMinted on the hub and via fanLocalProducer on C). The
 * onPrimaryProducer spy contains ZERO gate logic -- it only records which peers the REAL
 * hub-fan loop chose. The C-side bridge (pipe DOWN + mint + C.fanLocalProducer) is harness
 * plumbing that mirrors the production forward path (REQ-RMS-027/029, rms-active-forward
 * 4a/4c); the gate that suppresses delivery is the SHIPPED C-server fanLocalProducer.
 *
 * Real mediasoup (NOT a mock): fresh routers per `it` off two module Workers (primary +
 * far-standby C); the byte-id leg pipes (router.pipeToRouter) the real SFrame producer
 * primary -> C and captures forwarded RTP at C. SFrame ciphertext is the SHIPPED client
 * crypto stack's (realKeying + encryptFrame), reimplemented nowhere.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-reverse-e2ee.integration.test.ts
 *   P10 RED hook:  $env:P10_FORCE_TAMPER='1'; <that command>  => MUST FAIL
 *
 * Requirements touched: REQ-RMS-038 (E2EE fail-closed) + REQ-RMS-029 (publisher binding)
 * + REQ-RMS-026 (SSRC remap, implicit in the pipe) + REQ-MCS-014 (relay-blind SFrame).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { WebSocket, WebSocketServer } from 'ws';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  isPipeProducerAnnounce,
  pipeRoomToSecondWorker,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import {
  encryptFrame,
  decryptFrame,
  SFRAME_TRAILER_LEN,
  codecOffsetForFrameType,
  type KeyLookup,
} from '@dvconf/shared';
import {
  VP8_PT,
  makeVp8RtpWithBody,
  makeRtcpSenderReport,
  realKeying,
  locateForwardedSframe,
} from './_sframe-byteid-helpers.js';
import { createSignalingServer, type InterRelayContext } from '../../signaling/index.js';
import { createInterRelaySocketMap } from '../../inter-relay-socket-map.js';
import { MetricsTracker } from '../../metrics.js';
import type { MediasoupManager } from '../../mediasoup-manager.js';

// ── Codecs: VP8-only (mirrors relay-blind-realsframe / multi-hop for the real SFrame
//    byte-id leg). The room's AudioLevelObserver attach is best-effort (signaling.ts
//    try/catch), so a VP8-only router is fine for the joined WS clients. ─────────────
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

/** RED hook: with P10_FORCE_TAMPER=1, flip one SFrame ciphertext body byte on the DOWN hop. */
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Module-scoped real Workers (spawned once); routers are created FRESH per `it`
//    so a client-disconnect's room.router.close() (signaling.ts:1913) never closes a
//    router a later test reuses. ───────────────────────────────────────────────────
let primaryWorker: msTypes.Worker; // hub
let workerC: msTypes.Worker; // far standby C

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  workerC = await mediasoup.createWorker({ logLevel: 'warn' });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  workerC?.close();
});

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as never;
}

/** Manager whose createRouter returns the given REAL router (room.router == real). */
function managerWithRealRouter(real: msTypes.Router): MediasoupManager {
  return {
    workers: [{ pid: 1 } as unknown as msTypes.Worker],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(real),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

type SignalingServer = ReturnType<typeof createSignalingServer>;

/** Start a REAL signaling server (interRelay 5th + providedSockets 6th, like R-B). */
function startSignaling(
  interRelay: InterRelayContext,
  manager: MediasoupManager,
  sockets: ReturnType<typeof createInterRelaySocketMap>,
): Promise<{ server: SignalingServer; port: number }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    delete process.env['INTER_RELAY_TOKEN']; // single-host bench: token gate open
    const server = createSignalingServer(manager, new MetricsTracker(), mockLogger(), undefined, interRelay, sockets);
    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;
    server.wss.on('listening', () => {
      const addr = server.wss.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

function connectPlain(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const reply = JSON.parse(data.toString()) as Record<string, unknown>;
      if (reply['type'] === expectType) {
        ws.off('message', onMessage);
        resolve(reply);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}

/** Valid base64 of a 32-byte ed25519 session pubkey (copied from e2ee-failclosed.test.ts). */
function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

/** Join one WS client; collect every `newProducer` frame it receives (in order). */
async function joinClient(
  port: number,
  roomId: string,
  peerId: string,
  opts: { e2ee: boolean; seed: number },
): Promise<{ ws: WebSocket; fans: Array<Record<string, unknown>> }> {
  const ws = await connectPlain(port);
  const joinMsg: Record<string, unknown> = opts.e2ee
    ? { type: 'join', roomId, peerId, roomPassword: 'pw', peerPubkey: pubkey32(opts.seed), e2ee: true }
    : { type: 'join', roomId, peerId };
  await sendAndAwait(ws, joinMsg, 'routerRtpCapabilities');
  const fans: Array<Record<string, unknown>> = [];
  ws.on('message', (data: WebSocket.RawData) => {
    const m = JSON.parse(data.toString()) as Record<string, unknown>;
    if (m['type'] === 'newProducer') fans.push(m);
  });
  return { ws, fans };
}

/** Wait (bounded) until a `newProducer` for producerId is collected; return it or undefined. */
async function waitForFan(
  fans: Array<Record<string, unknown>>,
  producerId: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = fans.find((m) => m['producerId'] === producerId);
    if (hit) return hit;
    await sleep(25);
  }
  return fans.find((m) => m['producerId'] === producerId);
}

// ── REAL SFrame fixtures (SHIPPED client crypto; reimplemented nowhere) ──────────
interface SframeCtx {
  sframes: Uint8Array[];
  sentBodiesB64: Set<string>;
  kid: number;
  keyLookup: KeyLookup;
  ctrToPlain: Map<number, Uint8Array>;
}
async function buildSframes(): Promise<SframeCtx> {
  const { kid, encryptKey, keyLookup } = await realKeying();
  const plaintexts = [
    new TextEncoder().encode('RMS-038 R-C 2-hop frame ONE alpha alpha alpha'),
    new TextEncoder().encode('R-C frame TWO bravo'),
    new TextEncoder().encode('the THIRD R-C frame charlie charlie charlie charlie'),
  ];
  const sframes: Uint8Array[] = [];
  const ctrToPlain = new Map<number, Uint8Array>();
  for (let i = 0; i < plaintexts.length; i++) {
    const codecOffset = codecOffsetForFrameType('key', plaintexts[i]!.length);
    const sframe = await encryptFrame(plaintexts[i]!, { kid, ctr: i }, encryptKey, codecOffset);
    sframes.push(sframe);
    ctrToPlain.set(i, plaintexts[i]!);
  }
  const sentBodiesB64 = new Set(sframes.map((s) => Buffer.from(s).toString('base64')));
  return { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain };
}

/** A real VP8 producer on `router` that sends real-SFrame VP8 RTP (start/stop driven).
 *  `ssrc` is parameterized so two producers can coexist on ONE router (the RtpListener
 *  rejects a duplicate SSRC at produce() time). */
async function makeSframeVp8SourceOn(
  router: msTypes.Router,
  sframes: Uint8Array[],
  ssrc = 0x7000_0000,
): Promise<{ producer: msTypes.Producer; start: () => void; stop: () => void }> {
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    encodings: [{ ssrc, scalabilityMode: 'L1T1' }],
  };
  const dt = await router.createDirectTransport();
  const producer = await dt.produce({ kind: 'video', rtpParameters });
  let seq = 0, pic = 0, ts = 0, frame = 0, pktCount = 0, octetCount = 0;
  let interval: NodeJS.Timeout | null = null;
  return {
    producer,
    start: () => {
      interval = setInterval(() => {
        const keyframe = frame % 10 === 0;
        const body = sframes[frame % sframes.length]!;
        const pkt = makeVp8RtpWithBody({ ssrc, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe });
        producer.send(pkt);
        pktCount += 1;
        octetCount += pkt.length;
        if (keyframe) dt.sendRtcp(makeRtcpSenderReport(ssrc, ts, pktCount, octetCount));
        ts += 3000; // ~33ms @ 90kHz
        frame++;
      }, 10);
    },
    stop: () => {
      if (interval !== null) clearInterval(interval);
    },
  };
}

/**
 * Capture RTP forwarded onto `pipeProducer` (already piped DOWN to routerC) and assert
 * every forwarded media packet's REAL ciphertext body is byte-identical to a sent body +
 * decryptable with K_content. P10_FORCE_TAMPER flips a ciphertext byte -> RED. The pipe is
 * created by the caller ONCE (mediasoup rejects a second pipeToRouter for the same producer).
 */
async function driveAndAssertByteId(
  source: { producer: msTypes.Producer; start: () => void; stop: () => void },
  routerC: msTypes.Router,
  pipeProducer: msTypes.Producer,
  ctx: SframeCtx,
  label: string,
): Promise<void> {
  const sinkT = await routerC.createDirectTransport();
  const sink = await sinkT.consume({
    producerId: pipeProducer.id,
    rtpCapabilities: routerC.rtpCapabilities,
    paused: false,
  });
  const captured: Buffer[] = [];
  sink.on('rtp', (pkt: Buffer) => { captured.push(Buffer.from(pkt)); if (captured.length > 1024) captured.shift(); });

  source.start();
  await sink.requestKeyFrame();
  const deadline = Date.now() + 5000;
  while (captured.length === 0 && Date.now() < deadline) await sleep(50);
  await sleep(900);
  source.stop();

  expect(captured.length).toBeGreaterThan(0);
  let mediaPackets = 0, byteIdentical = 0, decryptedOk = 0;
  const minBody = 1 + 16 + SFRAME_TRAILER_LEN;
  for (const pkt of captured) {
    if (pkt.length < 12 + 4 + 3 + minBody) continue;
    mediaPackets++;
    if (FORCE_TAMPER) { const ti = pkt.length - SFRAME_TRAILER_LEN - 1; if (ti >= 0) pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff; }
    const found = locateForwardedSframe(pkt, ctx.kid, ctx.sentBodiesB64);
    if (!found) continue;
    byteIdentical++;
    const body = Uint8Array.prototype.slice.call(pkt.subarray(found.bodyOffset));
    const recovered = await decryptFrame(body, ctx.keyLookup);
    expect(Buffer.from(recovered).equals(Buffer.from(ctx.ctrToPlain.get(found.ctr)!))).toBe(true);
    decryptedOk++;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[REQ-RMS-038 ${label}] captured=${captured.length} mediaPackets=${mediaPackets} ` +
      `byteIdentical=${byteIdentical} decryptedOk=${decryptedOk}${FORCE_TAMPER ? ' [P10 RED HOOK]' : ''}`,
  );
  expect(mediaPackets).toBeGreaterThan(0);
  expect(byteIdentical).toBe(mediaPackets); // P10 RED hook flips a body byte -> byteIdentical < mediaPackets -> FAIL
  expect(decryptedOk).toBe(byteIdentical);

  try { sink.close(); sinkT.close(); } catch { /* best-effort */ }
}

const ORIGIN_RELAY = 'ws://standby-A'; // origin of the reverse announce (excluded by hub-fan)
const CASCADE_RELAY = 'standby-C'; // the non-origin far standby (MUST receive the hub-fan)
const HUB_RELAY = 'ws://primary-hub'; // the relayId C's forward leg attributes the DOWN copy to
const PUBLISHER = 'clientA'; // the ORIGINAL publisher (a real client peerId, NEVER a relayId)

// ── per-test teardown ────────────────────────────────────────────────────────────
let openClients: WebSocket[] = [];
let openServers: WebSocketServer[] = [];
let openRouters: msTypes.Router[] = [];
afterEach(() => {
  for (const c of openClients) { try { c.close(); } catch { /* best-effort */ } }
  for (const s of openServers) { try { s.close(); } catch { /* best-effort */ } }
  for (const r of openRouters) { try { r.close(); } catch { /* best-effort */ } }
  openClients = []; openServers = []; openRouters = [];
});

describe('REQ-RMS-038 — R-C hermetic E2EE 2-hop fidelity + fail-closed-on-delivery (real mediasoup)', () => {
  it('(a)+(d) E2EE, publisher-id PRESENT: binding survives BOTH hops + REAL SFrame byte-identical primary→C (P10 RED hook = teeth)', async () => {
    const roomId = 'rms-rc-e2ee-present';
    const ctx = await buildSframes();

    const primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
    const routerC = await workerC.createRouter({ mediaCodecs });
    openRouters.push(primaryRouter, routerC);

    // ── HUB (primary) server: E2EE room + ONE joined local client + the socket map the
    //    hub-fan loop iterates (origin + cascade attached). ──
    const hubRegistry = new InterRelayProducerRegistry();
    const onPrimaryProducerCalls: Array<{ peerRelayId?: string; producerPeerId?: string; producerId: string }> = [];
    const hubInterRelay: InterRelayContext = {
      role: 'primary',
      registry: hubRegistry,
      announceProducer: () => {},
      onPrimaryProducer: (_rid, _router, producer, peerRelayId, producerPeerId) => {
        onPrimaryProducerCalls.push({ peerRelayId, producerPeerId, producerId: producer.id });
      },
    };
    const hubSockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    hubSockets.attach(ORIGIN_RELAY, stub());
    hubSockets.attach(CASCADE_RELAY, stub());
    const { server: hubServer, port: hubPort } = await startSignaling(
      hubInterRelay, managerWithRealRouter(primaryRouter), hubSockets,
    );
    openServers.push(hubServer.wss);
    const hub = await joinClient(hubPort, roomId, 'hub-listener', { e2ee: true, seed: 1 });
    openClients.push(hub.ws);

    // ── Far standby C server: SAME E2EE room + ONE joined local client. Its OWN shipped
    //    fanLocalProducer gate is the C-side delivery seam. ──
    const cRegistry = new InterRelayProducerRegistry();
    const cInterRelay: InterRelayContext = { role: 'standby', registry: cRegistry, announceProducer: () => {} };
    const { server: cServer, port: cPort } = await startSignaling(
      cInterRelay, managerWithRealRouter(routerC), createInterRelaySocketMap(),
    );
    openServers.push(cServer.wss);
    const c = await joinClient(cPort, roomId, 'c-listener', { e2ee: true, seed: 2 });
    openClients.push(c.ws);

    // ── The reverse-minted hub copy: a REAL VP8 SFrame producer on the primary room.router. ──
    const minted = await makeSframeVp8SourceOn(primaryRouter, ctx.sframes);

    // The hub RECEIVED standby-A's reverse UP-announce carrying producerPeerId='clientA'
    // (driven through the REAL announce wire — proves the binding survives serialization).
    // In production, produceLocalFromPipe mints id === announced.id (rms-reverse-leg), so the
    // hub copy's id IS the announced id; the test models that by announcing minted.producer.id
    // directly (no produceLocalFromPipe here — `minted` is a fresh real producer), so
    // resolveByProducerId(minted.id) returns the ORIGINAL publisher.
    const recordIntoHub = createInterRelayAnnouncer({
      send: (data) => { const p = JSON.parse(data) as unknown; if (isPipeProducerAnnounce(p)) hubRegistry.record(p); },
    });
    recordIntoHub(roomId, { id: minted.producer.id, kind: 'video' }, PUBLISHER, ORIGIN_RELAY);

    // ── DRIVE THE REAL HUB SEAM: registerReverseMinted fans LOCAL (gate present-id ⇒ fan)
    //    + hub-fans DOWN to the non-origin standby (onPrimaryProducer), excludes origin. ──
    hubServer.registerReverseMinted(roomId, minted.producer, ORIGIN_RELAY, PUBLISHER);

    // (delivery on the PRIMARY) the hub's local client got the producer bound to the
    // ORIGINAL publisher 'clientA' — NEVER the origin relayId.
    const hubFan = await waitForFan(hub.fans, minted.producer.id);
    expect(hubFan, 'E2EE present-id MUST fan to the primary local client').toBeDefined();
    expect(hubFan!['peerId']).toBe(PUBLISHER);
    expect(hubFan!['peerId']).not.toBe(ORIGIN_RELAY);

    // the hub-fan onPrimaryProducer fired for the non-origin standby, never the origin.
    const calledPeers = onPrimaryProducerCalls.map((x) => x.peerRelayId);
    expect(calledPeers).toContain(CASCADE_RELAY);
    expect(calledPeers).not.toContain(ORIGIN_RELAY);
    expect(onPrimaryProducerCalls.find((x) => x.peerRelayId === CASCADE_RELAY)!.producerPeerId).toBe(PUBLISHER);

    // ── C-SIDE forward + delivery: pipe the hub copy DOWN to routerC ONCE (reused for
    //    both the C fan and the byte-id capture), record C's DOWN announce (REAL wire),
    //    and fan via C's OWN shipped fanLocalProducer. ──
    const { pipeProducer } = await pipeRoomToSecondWorker(primaryRouter, routerC, minted.producer.id);
    const recordIntoC = createInterRelayAnnouncer({
      send: (data) => { const p = JSON.parse(data) as unknown; if (isPipeProducerAnnounce(p)) cRegistry.record(p); },
    });
    recordIntoC(roomId, { id: pipeProducer.id, kind: 'video' }, PUBLISHER, HUB_RELAY);
    cServer.fanLocalProducer(roomId, PUBLISHER, pipeProducer, HUB_RELAY);

    const cFan = await waitForFan(c.fans, pipeProducer.id);
    expect(cFan, 'E2EE present-id MUST fan to the far-standby local client').toBeDefined();
    expect(cFan!['peerId']).toBe(PUBLISHER);
    expect(cFan!['peerId']).not.toBe(HUB_RELAY);

    // ── ASSERTION (a): publisher-id survives BOTH hops in the registry (NEVER a relayId). ──
    const hubRec = hubRegistry.resolveByProducerId(roomId, minted.producer.id);
    const cRec = cRegistry.resolveByProducerId(roomId, pipeProducer.id);
    expect(hubRec?.producerPeerId).toBe(PUBLISHER);
    expect(hubRec?.producerPeerId).not.toBe(ORIGIN_RELAY);
    expect(cRec?.producerPeerId).toBe(PUBLISHER);
    expect(cRec?.producerPeerId).not.toBe(HUB_RELAY);
    expect(cRec?.producerPeerId).not.toBe(CASCADE_RELAY);

    // ── ASSERTION (d): REAL SFrame ciphertext is byte-identical across the 2nd hop
    //    (primary→C, reusing the pipeProducer above); P10_FORCE_TAMPER flips a body byte
    //    → byteIdentical < mediaPackets. ──
    await driveAndAssertByteId(minted, routerC, pipeProducer, ctx, 'e2ee-present-2hop');

    try { minted.producer.close(); } catch { /* best-effort */ }
  }, 60_000);

  it('(b) E2EE, publisher-id MISSING: NOT-DELIVERED on the primary AND on C (gate), while the hub-fan onPrimaryProducer STILL fired (delivery, not mint)', async () => {
    const roomId = 'rms-rc-e2ee-missing';

    const primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
    const routerC = await workerC.createRouter({ mediaCodecs });
    openRouters.push(primaryRouter, routerC);

    const onPrimaryProducerCalls: Array<{ peerRelayId?: string; producerPeerId?: string }> = [];
    const hubInterRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: () => {},
      onPrimaryProducer: (_rid, _router, _producer, peerRelayId, producerPeerId) => {
        onPrimaryProducerCalls.push({ peerRelayId, producerPeerId });
      },
    };
    const hubSockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    hubSockets.attach(ORIGIN_RELAY, stub());
    hubSockets.attach(CASCADE_RELAY, stub());
    const { server: hubServer, port: hubPort } = await startSignaling(
      hubInterRelay, managerWithRealRouter(primaryRouter), hubSockets,
    );
    openServers.push(hubServer.wss);
    const hub = await joinClient(hubPort, roomId, 'hub-listener', { e2ee: true, seed: 1 });
    openClients.push(hub.ws);

    const cInterRelay: InterRelayContext = {
      role: 'standby', registry: new InterRelayProducerRegistry(), announceProducer: () => {},
    };
    const { server: cServer, port: cPort } = await startSignaling(
      cInterRelay, managerWithRealRouter(routerC), createInterRelaySocketMap(),
    );
    openServers.push(cServer.wss);
    const c = await joinClient(cPort, roomId, 'c-listener', { e2ee: true, seed: 2 });
    openClients.push(c.ws);

    // A reverse-minted producer with NO original publisher id (a pre-mesh / publisher-less
    // cross-relay frame). No media needs to flow — fail-closed is a DELIVERY decision.
    const minted = await makeSframeVp8SourceOn(primaryRouter, [new Uint8Array([1, 2, 3, 4])]);

    // HUB: registerReverseMinted with producerPeerId=undefined in an E2EE room.
    hubServer.registerReverseMinted(roomId, minted.producer, ORIGIN_RELAY, undefined);

    // C: pipe DOWN (the coordinator forwards transport-level, no e2ee context) + fan via
    // C's OWN shipped fanLocalProducer with the RAW (undefined) producerPeerId.
    const { pipeProducer } = await pipeRoomToSecondWorker(primaryRouter, routerC, minted.producer.id);
    cServer.fanLocalProducer(roomId, undefined, pipeProducer, HUB_RELAY);

    await sleep(200); // give any (incorrect) fan a chance to land before asserting absence

    // ── (b) NOT-DELIVERED — the gate suppresses delivery at BOTH hops. ──
    expect(
      hub.fans.find((m) => m['producerId'] === minted.producer.id),
      'E2EE missing-id MUST NOT be delivered to the primary local client',
    ).toBeUndefined();
    expect(
      c.fans.find((m) => m['producerId'] === pipeProducer.id),
      'E2EE missing-id MUST NOT be delivered to the far-standby local client',
    ).toBeUndefined();

    // ── CRITICAL framing: the hub-fan onPrimaryProducer DID FIRE for the non-origin
    //    standby (the coordinator has no e2ee context — it forwards transport-level).
    //    The producer MAY have been minted/forwarded; suppression is on DELIVERY only. ──
    const calledPeers = onPrimaryProducerCalls.map((x) => x.peerRelayId);
    expect(calledPeers).toContain(CASCADE_RELAY);
    expect(calledPeers).not.toContain(ORIGIN_RELAY);
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-038 e2ee-missing] hubDelivered=${hub.fans.some((m) => m['producerId'] === minted.producer.id)} ` +
        `cDelivered=${c.fans.some((m) => m['producerId'] === pipeProducer.id)} ` +
        `hubFanFiredForC=${calledPeers.includes(CASCADE_RELAY)} (fail-closed = NOT-DELIVERED, not never-minted)`,
    );

    // ── POSITIVE CONTROL (proves the absence above is real suppression, not a dead/slow
    //    listener): fan a PRESENT-id producer through the SAME shipped path to BOTH e2ee
    //    servers and confirm it DOES land on both clients within waitForFan's ~2000ms (the
    //    same delivery bound case (a) relies on). A distinct SSRC lets it coexist with the
    //    missing-id producer on primaryRouter. No media leg here ⇒ P10-insensitive (so (b)
    //    stays GREEN under P10_FORCE_TAMPER). ──
    const PRESENT = 'clientPresent';
    const present = await makeSframeVp8SourceOn(primaryRouter, [new Uint8Array([5, 6, 7, 8])], 0x7000_0010);
    hubServer.registerReverseMinted(roomId, present.producer, ORIGIN_RELAY, PRESENT);
    const { pipeProducer: presentPipe } = await pipeRoomToSecondWorker(primaryRouter, routerC, present.producer.id);
    cServer.fanLocalProducer(roomId, PRESENT, presentPipe, HUB_RELAY);

    const hubPresentFan = await waitForFan(hub.fans, present.producer.id);
    const cPresentFan = await waitForFan(c.fans, presentPipe.id);
    expect(hubPresentFan, 'positive control: present-id MUST deliver to the primary client (channel live + fast)').toBeDefined();
    expect(hubPresentFan!['peerId']).toBe(PRESENT);
    expect(cPresentFan, 'positive control: present-id MUST deliver to the far-standby client (channel live + fast)').toBeDefined();
    expect(cPresentFan!['peerId']).toBe(PRESENT);

    try { minted.producer.close(); present.producer.close(); } catch { /* best-effort */ }
  }, 60_000);

  it('(c)+(d) OPEN room, publisher-id MISSING: graceful fallback DELIVERS (bound to relayId) byte-stable — proves the gate is E2EE-scoped (P10 RED hook)', async () => {
    const roomId = 'rms-rc-open-missing';
    const ctx = await buildSframes();

    const primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
    const routerC = await workerC.createRouter({ mediaCodecs });
    openRouters.push(primaryRouter, routerC);

    const hubSockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    hubSockets.attach(ORIGIN_RELAY, stub());
    hubSockets.attach(CASCADE_RELAY, stub());
    const hubInterRelay: InterRelayContext = {
      role: 'primary', registry: new InterRelayProducerRegistry(), announceProducer: () => {},
      onPrimaryProducer: () => {},
    };
    const { server: hubServer, port: hubPort } = await startSignaling(
      hubInterRelay, managerWithRealRouter(primaryRouter), hubSockets,
    );
    openServers.push(hubServer.wss);
    // OPEN room: legacy join with NO roomPassword ⇒ no roomConfigs entry ⇒ e2ee=false.
    const hub = await joinClient(hubPort, roomId, 'hub-listener', { e2ee: false, seed: 1 });
    openClients.push(hub.ws);

    const minted = await makeSframeVp8SourceOn(primaryRouter, ctx.sframes);

    // The SAME missing-id scenario as (b), but in an OPEN room: the gate does NOT fire;
    // graceful fallback binds the fan to the cascade/origin relayId (byte-stable).
    hubServer.registerReverseMinted(roomId, minted.producer, ORIGIN_RELAY, undefined);

    const hubFan = await waitForFan(hub.fans, minted.producer.id);
    expect(hubFan, 'OPEN missing-id MUST still DELIVER (graceful fallback)').toBeDefined();
    expect(hubFan!['peerId']).toBe(ORIGIN_RELAY); // bound to the relayId (no publisher id present)

    // ── (d) the forwarded media is byte-stable across the 2nd hop (P10 RED hook = teeth). ──
    const { pipeProducer } = await pipeRoomToSecondWorker(primaryRouter, routerC, minted.producer.id);
    await driveAndAssertByteId(minted, routerC, pipeProducer, ctx, 'open-missing-2hop');

    try { minted.producer.close(); } catch { /* best-effort */ }
  }, 60_000);
});
