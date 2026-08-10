/**
 * P10 Step-2 harness — in-process relay stand-up + browser drive.
 *
 * Split out of p10-relayblind-browser.ts (pure code movement, no behavior change):
 * bundles the browser entry, stands up the in-process mediasoup relay + minimal WS
 * signaling protocol with the relay-internal tap, and drives one room through a
 * headless Chrome page.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { build as esbuild } from 'esbuild';
import type { Browser } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VP8_PT = 101;
// The cleartext config byte 0x01 now lives in the SFrame TRAILER at the END;
// `readSframeTrailer` validates it key-free, so the driver no longer scans sframe[0].

export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const log = (m: string): void => console.log(`[p10-harness] ${m}`);

export interface CaptureRoom {
  /** the browser's producer id (set on produce). */
  producerId: string | null;
  /** every forwarded RTP packet captured at the relay-internal tap. */
  packets: Buffer[];
  /** the relay-side mediasoup producer (for inbound-vs-forwarded stats). */
  producer: msTypes.Producer | null;
  /** inbound-RTP packet count read WHILE the page was connected (set in driveRoom). */
  relayReceivedSnapshot: number;
}

/** Read the relay-side mediasoup producer's INBOUND received-packet count (0 if none). */
export async function relayReceivedPackets(room: CaptureRoom): Promise<number> {
  if (!room.producer) return 0;
  try {
    const stats = await room.producer.getStats();
    let pkts = 0;
    for (const s of stats as Array<Record<string, unknown>>) {
      if (s['type'] === 'inbound-rtp' && typeof s['packetCount'] === 'number') {
        pkts += s['packetCount'] as number;
      }
    }
    return pkts;
  } catch {
    return 0;
  }
}

/**
 * Bundle the browser entry (real mediasoup-client + the SHIPPED client SFrame
 * crypto) into an IIFE the page loads as /bundle.js. esbuild resolves the cross-repo
 * client modules + their deps (libsodium, @mysten/*) the same way Vite does for
 * Step-1; nothing is reimplemented.
 */
export async function bundleEntry(): Promise<string> {
  const entry = path.join(HERE, 'harness-entry.js');
  log(`bundling browser entry ${entry}`);
  const out = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    // allow .ts cross-repo client imports + node builtins shimmed away by the browser.
    loader: { '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = out.outputFiles[0]!.text;
  log(`bundle size ${(js.length / 1024).toFixed(0)}kb`);
  return js;
}

/**
 * Stand up the in-process relay (mediasoup worker + router) + an http server (serves
 * the secure-context page) + a minimal WS speaking the relay's JSON protocol verbatim.
 * On `produce`, attaches the relay-internal DirectTransport tap on the browser's
 * producer and records every forwarded RTP packet into `room`.
 */
export async function standUpRelay(bundleJs: string, room: CaptureRoom): Promise<{
  worker: msTypes.Worker;
  pageUrl: string;
  wsUrl: string;
  close: () => void;
}> {
  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  const router = await worker.createRouter({ mediaCodecs });
  log(`mediasoup worker+router up (pid=${worker.pid})`);

  async function attachTap(producer: msTypes.Producer): Promise<void> {
    const tapTransport = await router.createDirectTransport();
    // pipe:true → a `pipe`-type consumer that forwards EVERY RTP packet of the producer
    // WITHOUT the simulcast keyframe-selection gate. With the M3 Lane B PARTIAL-SFrame the
    // cleartext VP8 keyframe markers stay at the FRONT, so even a plain (gated) consumer
    // would now detect the keyframe and forward — forwarded > 0 over pipe:true confirms
    // the upstream producer keyframe stall (P10 Finding B) is RESOLVED. The relay forwards
    // the E2EE body opaquely (it never decrypts it) and forwards cleartext VP8 verbatim in
    // the control room — identical mechanics, the body content is what differs.
    const tapConsumer = await tapTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
      pipe: true,
    });
    tapConsumer.on('rtp', (pkt: Buffer) => {
      room.packets.push(Buffer.from(pkt));
      if (room.packets.length > 4096) room.packets.shift();
    });
    log(`tap attached: pipe DirectTransport consumer ${tapConsumer.id} on producer ${producer.id}`);
  }

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/index') || url.startsWith('/harness')) {
      const html = readFileSync(path.join(HERE, 'harness-page.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.startsWith('/bundle.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(bundleJs);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const httpPort = (httpServer.address() as { port: number }).port;
  const pageUrl = `http://127.0.0.1:${httpPort}/`;

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const wsPort = (wss.address() as { port: number }).port;
  const wsUrl = `ws://127.0.0.1:${wsPort}`;
  log(`http ${pageUrl}  ws ${wsUrl}`);

  wss.on('connection', (ws: WebSocket) => {
    const transports = new Map<string, msTypes.WebRtcTransport>();
    const producers: msTypes.Producer[] = [];
    const send = (msg: Record<string, unknown>): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    ws.on('message', (raw: Buffer) => {
      void (async () => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = msg['type'] as string;
        try {
          if (type === 'join') {
            send({ type: 'routerRtpCapabilities', rtpCapabilities: router.rtpCapabilities });
          } else if (type === 'createTransport') {
            // REAL WebRtcTransport — mirrors room-handler.ts createWebRtcTransport.
            const transport = await router.createWebRtcTransport({
              listenIps: [{ ip: '0.0.0.0', announcedIp: '127.0.0.1' }],
              enableUdp: true,
              enableTcp: true,
              preferUdp: true,
            });
            transports.set(transport.id, transport);
            send({
              type: 'transportCreated',
              id: transport.id,
              direction: msg['direction'],
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            });
          } else if (type === 'connectTransport') {
            const transport = transports.get(msg['transportId'] as string);
            if (transport) {
              await transport.connect({
                dtlsParameters: msg['dtlsParameters'] as msTypes.DtlsParameters,
              });
              log(`transport connected (DTLS) ${transport.id}`);
            }
          } else if (type === 'produce') {
            const transport = transports.get(msg['transportId'] as string);
            if (!transport) return;
            const producer = await transport.produce({
              kind: msg['kind'] as msTypes.MediaKind,
              rtpParameters: msg['rtpParameters'] as msTypes.RtpParameters,
            });
            producers.push(producer);
            room.producerId = producer.id;
            room.producer = producer;
            log(`browser produced ${producer.kind} producer ${producer.id}`);
            await attachTap(producer);
            send({ type: 'produced', producerId: producer.id });
          }
        } catch (err) {
          log(`signaling error on ${type}: ${String(err)}`);
        }
      })();
    });
    ws.on('close', () => {
      for (const p of producers) { try { p.close(); } catch { /* best-effort */ } }
      for (const t of transports.values()) { try { t.close(); } catch { /* best-effort */ } }
    });
  });

  return {
    worker,
    pageUrl,
    wsUrl,
    close: () => { try { wss.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } worker.close(); },
  };
}

/**
 * Drive one room (E2EE or control) through the headless Chrome page. Reads the relay's
 * inbound-RTP count WHILE THE PAGE IS STILL CONNECTED (closing the page tears down the
 * WebRtcTransport and zeroes the producer's inbound stats) and stashes it on the room.
 */
export async function driveRoom(
  browser: Browser,
  pageUrl: string,
  wsUrl: string,
  roomId: string,
  e2ee: boolean,
  room: CaptureRoom,
): Promise<Record<string, unknown>> {
  const page = await browser.newPage();
  page.on('console', (m) => log(`PAGE> ${m.text()}`));
  page.on('pageerror', (e) => log(`PAGE-ERROR> ${String(e)}`));
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.evaluate(
    ({ relayUrl, rid, e }) => {
      (window as unknown as { __p10Opts: unknown }).__p10Opts = { relayUrl, roomId: rid, e2ee: e };
    },
    { relayUrl: wsUrl, rid: roomId, e: e2ee },
  );
  const result = (await page.evaluate(async () =>
    (window as unknown as { __p10Run: () => Promise<Record<string, unknown>> }).__p10Run(),
  )) as Record<string, unknown>;
  // hold the page open a beat so the tap drains in-flight RTP.
  await sleep(1500);
  // READ inbound stats while the transport is still up (page.close() resets them).
  room.relayReceivedSnapshot = await relayReceivedPackets(room);
  await page.close();
  return result;
}
