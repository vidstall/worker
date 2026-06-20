/**
 * F1 Tier-3 — REAL inter-relay WS LINK live gate (REQ-RO-003).
 *
 * Proves the ONLY thing Tier-3 exists to prove that Tier-2 cannot: that the
 * WS-driven connect() handshake — real `pipe-connect` frames over a REAL `ws`
 * link (openInterRelayLink ↔ a real ws WebSocketServer) — puts real RTP on the
 * wire, AND the relay's REAL /api/probe (startMetricsServer + the F1
 * createPipeLivenessObserver) flips ok:true ONLY AFTER RTP actually advances.
 *
 * HONESTY (design §9.9 + OQ#5): this is the SINGLE-PROCESS real-link-loopback —
 * real ws link + real metrics server + real mediasoup, all co-resident in ONE
 * test process. It is a genuine REAL-LINK path (the connect() is driven by real
 * WS frames, not an in-memory call), labeled honestly as co-resident, NOT a
 * two-host WAN run. STRETCH (documented, not built here): spawn two full
 * `index.ts` daemons via child_process — that needs a live Sui localnet +
 * RoomAssigned events to reach the role/poller path, out of F1 scope.
 *
 * Requirements: REQ-RO-003.
 *
 * Run: pnpm exec vitest run --config vitest.relay-livelink.config.ts \
 *        apps/relay/src/__tests__/integration/live/warmpipe-live-link.integration.test.ts
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { openInterRelayLink } from '../../../inter-relay-link.js';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
  buildPipeConnectFrame,
  isPipeConnectFrame,
  type PipeConnectParams,
} from '../../../inter-relay.js';
import { createStandbyPipeTransport, createPipeLivenessObserver } from '../../../relay-role-manager.js';
import { startMetricsServer, type ProbeState } from '../../../metrics-server.js';
import { MetricsTracker } from '../../../metrics.js'; // CONSISTENCY-FIX MEDIUM: real export is the class MetricsTracker (no-arg ctor); createMetricsTracker does not exist

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child() { return this; }, level: 'silent' } as any;
}

function makeVp8(ssrc: number, seq: number, ts: number, keyframe: boolean): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; header[1] = (VP8_PT & 0x7f) | 0x80;
  header.writeUInt16BE(seq & 0xffff, 2); header.writeUInt32BE(ts >>> 0, 4); header.writeUInt32BE(ssrc >>> 0, 8);
  const desc = Buffer.from([0x90, 0x80, 0x80, 0x00]);
  const vp8 = keyframe
    ? Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01])
    : Buffer.from([0x11, 0x00, 0x00]);
  return Buffer.concat([header, desc, vp8, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
}

let teardown: Array<() => void> = [];
afterEach(() => { for (const t of teardown.splice(0)) { try { t(); } catch { /* best-effort */ } } });

describe('F1 Tier-3 — real inter-relay WS link drives connect() → RTP on wire → /api/probe flips ok only after RTP (REQ-RO-003)', () => {
  it('WS-driven pipe-connect puts real RTP on the wire; /api/probe ok is false BEFORE and true AFTER the liveness observer sees RTCP advance', async () => {
    process.env['METRICS_PORT'] = '0'; // OS-assigned — avoid the default 4001 collision

    // ── real mediasoup primary + standby ──
    const pWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    const sWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    teardown.push(() => pWorker.close(), () => sWorker.close());
    const pRouter = await pWorker.createRouter({ mediaCodecs });
    const sRouter = await sWorker.createRouter({ mediaCodecs });

    // ── the STANDBY's pipe is bound first (matches ensureWarmPipe binding-first order) ──
    const standbyPipe = await createStandbyPipeTransport(sRouter, 0);

    // ── PRIMARY runs a REAL ws server; the STANDBY dials it with openInterRelayLink ──
    const wss = new WebSocketServer({ port: 0 });
    teardown.push(() => wss.close());
    await new Promise<void>((r) => wss.on('listening', () => r()));
    const wssPort = (wss.address() as { port: number }).port;

    // The primary accepts the standby's inbound `pipe-connect` (standby-initiates, §2)
    // and replies with its own params over the SAME socket. Real JSON frames both ways.
    let primaryPipe: msTypes.PipeTransport | null = null;
    const primaryConnected = new Promise<void>((resolve) => {
      wss.on('connection', (sock: WsServerSocket) => {
        sock.on('message', async (raw) => {
          const msg = JSON.parse(raw.toString());
          if (!isPipeConnectFrame(msg)) return;
          // bind + connect the primary to the standby's announced params
          primaryPipe = await createPrimaryPipeTransport(pRouter, 0);
          await primaryPipe.connect({ ip: msg.ip, port: msg.port } as Parameters<msTypes.PipeTransport['connect']>[0]);
          // reply DOWN with the primary's own params
          const primaryParams: PipeConnectParams = { ip: '127.0.0.1', port: primaryPipe.tuple.localPort };
          sock.send(JSON.stringify(buildPipeConnectFrame(msg.roomId, primaryParams)));
          resolve();
        });
      });
    });

    // ── STANDBY opens the REAL link + announces its params UP (the new send path) ──
    let standbyGotPrimaryParams: PipeConnectParams | null = null;
    const standbyDone = new Promise<void>((resolve) => {
      const link = openInterRelayLink({
        url: `ws://127.0.0.1:${wssPort}`,
        onFrame: (raw) => {
          const msg = JSON.parse(raw.toString());
          if (isPipeConnectFrame(msg)) { standbyGotPrimaryParams = { ip: msg.ip, port: msg.port }; resolve(); }
        },
        logger: silentLogger(),
      });
      teardown.push(() => link.close());
      // wait for OPEN, then send the standby's pipe-connect UP over the live link.
      const announce = () => {
        const params: PipeConnectParams = { ip: '127.0.0.1', port: standbyPipe.tuple.localPort };
        link.send(JSON.stringify(buildPipeConnectFrame('live-room', params)));
      };
      if (link.readyState === 1) announce(); else link.once('open', announce);
    });

    await primaryConnected;
    await standbyDone;
    expect(standbyGotPrimaryParams).not.toBeNull();
    expect(primaryPipe).not.toBeNull();

    // ── standby connects on the primary's params; both ends now CONNECTED ──
    await standbyPipe.connect({
      ip: standbyGotPrimaryParams!.ip, port: standbyGotPrimaryParams!.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // ── primary video producer + pipe it onto the CONNECTED primary pipe ──
    const srcTransport = await pRouter.createDirectTransport();
    const rtpParameters: msTypes.RtpParameters = {
      codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
      encodings: [{ ssrc: 0x5000_0000 }],
    };
    const producer = await srcTransport.produce({ kind: 'video', rtpParameters });
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(primaryPipe!, producer.id);

    // standby produces the piped producer + an UNPAUSED warm pipe consumer (the
    // liveness observer reads ITS getStats — that is the standby's RTP receiver).
    const pipedProducer = await standbyPipe.produce({
      id: primaryPipeConsumer.id, kind: 'video',
      rtpParameters: primaryPipeConsumer.rtpParameters, paused: false,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);
    const warmConsumer = await sRouter.createDirectTransport().then((dt) =>
      dt.consume({ producerId: pipedProducer.id, rtpCapabilities: sRouter.rtpCapabilities, paused: false }));

    // ── REAL metrics server + the F1 liveness observer feeding ProbeState ──
    const probe: ProbeState = { role: 'standby', pipeConsumerAlive: false, rtcpAlive: false };
    const metrics = new MetricsTracker(); // CONSISTENCY-FIX MEDIUM: mirror Cluster D dispatch harness
    const server = startMetricsServer(metrics, silentLogger(), () => probe);
    teardown.push(() => server.close());
    const metricsPort = (server.address() as { port: number }).port;
    const probeUrl = `http://127.0.0.1:${metricsPort}/api/probe`;

    const observer = createPipeLivenessObserver({
      getPipeConsumer: () => warmConsumer,
      // CONSISTENCY-FIX HIGH#4: createPipeLivenessObserver.setLiveness is a SINGLE object arg
      // (flags:{pipeConsumerAlive,rtcpAlive})=>void (Cluster E definer / index F6 consumer).
      setLiveness: (flags) => { probe.pipeConsumerAlive = flags.pipeConsumerAlive; probe.rtcpAlive = flags.rtcpAlive; },
      intervalMs: 50,
      requiredSamples: 2,
    });
    observer.start();
    teardown.push(() => observer.stop());

    // ── BEFORE RTP: /api/probe must answer ok:false (no RTCP advance yet) ──
    const before = await (await fetch(probeUrl)).json();
    expect(before.ok).toBe(false);
    expect(before.rtcp_alive).toBe(false);

    // ── DRIVE real RTP over the WS-negotiated pipe ──
    let seq = 0, ts = 0, frame = 0;
    const interval = setInterval(() => {
      producer.send(makeVp8(0x5000_0000, seq++, ts, frame % 10 === 0));
      ts += 3000; frame++;
    }, 10);
    teardown.push(() => clearInterval(interval));

    // ── AFTER RTP: poll until /api/probe flips ok:true (observer needs ≥2 samples) ──
    let after: any = { ok: false };
    for (let i = 0; i < 40 && !after.ok; i++) {
      await sleep(100);
      after = await (await fetch(probeUrl)).json();
    }
    clearInterval(interval);

    // eslint-disable-next-line no-console
    console.log(`[F1 REQ-RO-003 live-link] before.ok=${before.ok} after.ok=${after.ok} after.rtcp_alive=${after.rtcp_alive} role=${after.role}`);

    // THE gate: ok flipped false→true ONLY after real RTP advanced over the real link.
    expect(after.ok).toBe(true);
    expect(after.rtcp_alive).toBe(true);
    expect(after.role).toBe('standby');

    try { warmConsumer.close(); producer.close(); srcTransport.close(); } catch { /* best-effort */ }
  }, 60_000);
});
