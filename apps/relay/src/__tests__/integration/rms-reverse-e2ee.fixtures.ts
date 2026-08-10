/**
 * Shared setup/fixtures for rms-reverse-e2ee.integration.test.ts.
 *
 * REQ-RMS-038 (part-3 Stage R-C) -- HERMETIC E2EE 2-HOP FIDELITY + FAIL-CLOSED-ON-
 * DELIVERY, proven on REAL mediasoup across the reverse hub path
 *   standby-A's client  ->  PRIMARY hub  ->  far standby-C.
 *
 * See the sibling test file's header comment for the full "what is asserted /
 * not a tautology" narrative. This module holds the module-scoped real Workers,
 * the REAL signaling-server harness (startSignaling/joinClient/waitForFan), the
 * REAL SFrame fixtures (buildSframes/makeSframeVp8SourceOn/driveAndAssertByteId),
 * and the per-test teardown arrays.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-reverse-e2ee.integration.test.ts
 *   P10 RED hook:  $env:P10_FORCE_TAMPER='1'; <that command>  => MUST FAIL
 */

import { beforeAll, afterAll, afterEach, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { WebSocket, WebSocketServer } from 'ws';
import {
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
export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

/** RED hook: with P10_FORCE_TAMPER=1, flip one SFrame ciphertext body byte on the DOWN hop. */
export const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Module-scoped real Workers (spawned once); routers are created FRESH per `it`
//    so a client-disconnect's room.router.close() (signaling.ts:1913) never closes a
//    router a later test reuses. ───────────────────────────────────────────────────
export let primaryWorker: msTypes.Worker; // hub
export let workerC: msTypes.Worker; // far standby C

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  workerC = await mediasoup.createWorker({ logLevel: 'warn' });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  workerC?.close();
});

export function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as never;
}

/** Manager whose createRouter returns the given REAL router (room.router == real). */
export function managerWithRealRouter(real: msTypes.Router): MediasoupManager {
  return {
    workers: [{ pid: 1 } as unknown as msTypes.Worker],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(real),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

export type SignalingServer = ReturnType<typeof createSignalingServer>;

/** Start a REAL signaling server (interRelay 5th + providedSockets 6th, like R-B). */
export function startSignaling(
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

export function connectPlain(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
export function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<Record<string, unknown>> {
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
export function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

/** Join one WS client; collect every `newProducer` frame it receives (in order). */
export async function joinClient(
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
export async function waitForFan(
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
export interface SframeCtx {
  sframes: Uint8Array[];
  sentBodiesB64: Set<string>;
  kid: number;
  keyLookup: KeyLookup;
  ctrToPlain: Map<number, Uint8Array>;
}
export async function buildSframes(): Promise<SframeCtx> {
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
export async function makeSframeVp8SourceOn(
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
export async function driveAndAssertByteId(
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

export const ORIGIN_RELAY = 'ws://standby-A'; // origin of the reverse announce (excluded by hub-fan)
export const CASCADE_RELAY = 'standby-C'; // the non-origin far standby (MUST receive the hub-fan)
export const HUB_RELAY = 'ws://primary-hub'; // the relayId C's forward leg attributes the DOWN copy to
export const PUBLISHER = 'clientA'; // the ORIGINAL publisher (a real client peerId, NEVER a relayId)

// ── per-test teardown ────────────────────────────────────────────────────────────
export let openClients: WebSocket[] = [];
export let openServers: WebSocketServer[] = [];
export let openRouters: msTypes.Router[] = [];
afterEach(() => {
  for (const c of openClients) { try { c.close(); } catch { /* best-effort */ } }
  for (const s of openServers) { try { s.close(); } catch { /* best-effort */ } }
  for (const r of openRouters) { try { r.close(); } catch { /* best-effort */ } }
  openClients = []; openServers = []; openRouters = [];
});

export type { InterRelaySocketLike };
