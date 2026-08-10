/**
 * P11 WAN canary — relay stand-up: single-hop mediasoup relay + relay-internal loss-injecting
 * tap + the tiny http/ws signaling server that serves the browser entry. Split out of
 * `p11-wan-canary-loss.ts` (pure code movement — see that file's header for the full demo
 * context / honesty bounds; nothing here changes behavior).
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { build as esbuild } from 'esbuild';
import type { DemoCfg } from './config-gate.js';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DAEMONS_ROOT = path.resolve(HERE, '../../..');
export const VP8_PT = 101;

export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const log = (m: string): void => console.log(`[p11-wan-canary] ${m}`);

export interface CaptureRoom {
  producerId: string | null;
  /** every forwarded RTP packet captured at the relay-internal tap. */
  packets: Buffer[];
  producer: msTypes.Producer | null;
  /** count of packets the loss injector DROPPED at the tap (the injected WAN loss). */
  injectedDrops: number;
}

export async function bundleEntry(): Promise<string> {
  const entry = path.join(HERE, 'wan-canary-entry.js');
  log(`bundling browser entry ${entry}`);
  const out = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    loader: { '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = out.outputFiles[0]!.text;
  log(`bundle size ${(js.length / 1024).toFixed(0)}kb`);
  return js;
}

/**
 * Stand up the SINGLE-HOP in-process relay (one mediasoup worker+router) + the secure-context
 * page server + the relay WS. On `produce`, attaches the relay-internal tap with an APP-LEVEL
 * LOSS INJECTOR: each forwarded RTP packet is dropped with probability `lossPct/100` (a
 * Bernoulli drop — the simplest WAN loss model; a tc/netem qdisc is the OS-level alternative,
 * see the runbook). Co-homed publisher+consumer on this ONE relay = single hop (W-E5).
 */
export async function standUpRelay(
  bundleJs: string,
  room: CaptureRoom,
  cfg: DemoCfg,
): Promise<{ worker: msTypes.Worker; pageUrl: string; wsUrl: string; close: () => void }> {
  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  const router = await worker.createRouter({ mediaCodecs });
  log(`mediasoup worker+router up (pid=${worker.pid}) — SINGLE HOP`);

  async function attachTap(producer: msTypes.Producer): Promise<void> {
    const tapTransport = await router.createDirectTransport();
    const tapConsumer = await tapTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
      pipe: true,
    });
    tapConsumer.on('rtp', (pkt: Buffer) => {
      // ── THE LOSS INJECTOR ── drop this forwarded packet with p = lossPct/100. This is the
      // benign WAN loss the classifier must NOT mistake for withholding. A relay that
      // WITHHELD would drop SELECTIVELY (a targeted set of canary frameSeqs); this injector
      // drops UNIFORMLY at random — the benign-loss baseline.
      if (Math.random() * 100 < cfg.lossPct) {
        room.injectedDrops++;
        return;
      }
      room.packets.push(Buffer.from(pkt));
      if (room.packets.length > 8192) room.packets.shift();
    });
    log(`tap attached on producer ${producer.id}; loss injector @ ${cfg.lossPct}%`);
  }

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/index') || url.startsWith('/wan')) {
      const html = readFileSync(path.join(HERE, 'wan-canary-page.html'), 'utf8');
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
