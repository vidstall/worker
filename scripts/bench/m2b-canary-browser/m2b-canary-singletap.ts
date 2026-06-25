/**
 * M2b-live-WAN Sub-lane A — Task-2 A3a single-tap browser DETECTION (REQ-MLW-A-03/04).
 * FORK of scripts/bench/m2b-canary-browser/m2b-canary-spike.ts.
 *
 * THE STEP (plan Task 2 / spec Q5): a thin, fast green BEFORE the full 2-process wiring —
 * a REAL headless Chromium produces the fully-pinned synthetic 62-byte canary SFrame over a
 * REAL WebRtcTransport into an in-process mediasoup relay; a single DirectTransport pipe-tap
 * captures every forwarded RTP packet; the FROZEN daemon `verifyForwardedCanary` (verifier.ts,
 * INV-A: NEVER edited) yields `byteIdentical === mediaPackets`, 0 divergences (honest forward).
 *
 * GREEN = `mediaPackets > 0 && byteIdentical === mediaPackets && divergences.length === 0`.
 * This is the SAME detection chain Task 3 drives across 2 processes — here exercised through a
 * single in-process sink so a keying/tail-survival regression falsifies fast.
 *
 * The detection MUST go through the FROZEN `verifyForwardedCanary` — this orchestrator NEVER
 * hand-rolls a byteId/divergence check; it imports the real verifier and reports its output.
 *
 * ADDITIVE / TEST-ONLY: lives under scripts/bench/**; stands up its OWN minimal relay
 * (mediasoup worker/router + a tiny WS) + relay-internal pipe-tap. Imports NO production
 * media-path module (beyond the FROZEN verifier + the Task-1 browser canary-core via the
 * reused harness entry). NEVER logs key material (cellSecret / K_canary / P_i / seed).
 *
 * Run: cd dvconf-daemons && pnpm exec tsx scripts/bench/m2b-canary-browser/m2b-canary-singletap.ts
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { build as esbuild } from 'esbuild';
import { chromium, type Browser } from 'playwright';
// FROZEN daemon verifier — the REAL receiver-side detection (verifier.ts, INV-A: never edited).
// Same 3-up `../` depth the sibling spike uses for recomputeCanaryFrame (verified resolves).
import { verifyForwardedCanary } from '../../../apps/validator-daemon/src/canary/verifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VP8_PT = 101;

// Pinned shared constants — MUST match the daemon e2e on both sides (BASE-MAP §2/§5).
const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'm2b-live-xproc-room';
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (m: string): void => console.log(`[m2b-canary-singletap] ${m}`);

interface CaptureRoom {
  producerId: string | null;
  /** every forwarded RTP packet captured at the relay-internal tap. */
  packets: Buffer[];
  producer: msTypes.Producer | null;
}

/**
 * Bundle the browser entry (real mediasoup-client + the SHIPPED client SFrame crypto +
 * PathCKeyDerivation via the Task-1 canary-core) into an IIFE the page loads as /bundle.js.
 * esbuild resolves the cross-repo client modules the same way Vite does; nothing is
 * reimplemented. (VERBATIM from the Task-0 spike bundleEntry.)
 */
async function bundleEntry(): Promise<string> {
  const entry = path.join(HERE, 'canary-harness-entry.js');
  log(`bundling browser entry ${entry}`);
  const out = await esbuild({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    loader: { '.ts': 'ts' }, // allow .ts cross-repo client imports
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const js = out.outputFiles[0]!.text;
  log(`bundle size ${(js.length / 1024).toFixed(0)}kb`);
  return js;
}

/**
 * Stand up the in-process relay (mediasoup worker + router) + an http server (serves the
 * secure-context page) + a minimal WS speaking the relay's JSON protocol verbatim. On
 * `produce`, attaches the SINGLE relay-internal pipe-tap on the browser's producer and records
 * every forwarded RTP packet into `room`. (VERBATIM from the Task-0 spike standUpRelay.)
 */
async function standUpRelay(bundleJs: string, room: CaptureRoom): Promise<{
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
    // pipe:true → forwards EVERY RTP packet WITHOUT the keyframe-selection gate.
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
    if (url === '/' || url.startsWith('/index') || url.startsWith('/harness') || url.startsWith('/canary')) {
      const html = readFileSync(path.join(HERE, 'canary-harness-page.html'), 'utf8');
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

/** Drive one room through the headless Chrome page; returns the page run result. */
async function driveRoom(
  browser: Browser,
  pageUrl: string,
  wsUrl: string,
  roomId: string,
): Promise<Record<string, unknown>> {
  const page = await browser.newPage();
  page.on('console', (m) => log(`PAGE> ${m.text()}`));
  page.on('pageerror', (e) => log(`PAGE-ERROR> ${String(e)}`));
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.evaluate(
    (o) => {
      (window as unknown as { __canaryOpts: unknown }).__canaryOpts = o;
    },
    {
      relayUrl: wsUrl,
      roomId,
      // Uint8Arrays serialize as number[] over the page boundary; rebuilt in-page.
      kRoom: Array.from(K_ROOM),
      cellSecret: Array.from(CELL_SECRET),
      canaryKid: CANARY_KID,
      ctrs: CTRS,
    },
  );
  const result = (await page.evaluate(async () =>
    (window as unknown as { __canaryRun: () => Promise<Record<string, unknown>> }).__canaryRun(),
  )) as Record<string, unknown>;
  // hold the page open a beat so the tap drains in-flight RTP.
  await sleep(1500);
  await page.close();
  return result;
}

async function main(): Promise<void> {
  const bundleJs = await bundleEntry();

  const room: CaptureRoom = { producerId: null, packets: [], producer: null };
  const relay = await standUpRelay(bundleJs, room);

  log('launching headless Chromium (fake media)…');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  log(`Chromium ${browser.version()}`);

  log('═══ driving canary room (browser produces pinned canary SFrames) ═══');
  // The room label MUST equal the pinned keying ROOM_ID — it is folded into the canary HKDF
  // info, so a divergent room label → a divergent K_canary → ciphertext mismatch. The relay's
  // standUpRelay ignores the label (one router per WS conn), so reusing ROOM_ID is safe.
  const pageRun = await driveRoom(browser, relay.pageUrl, relay.wsUrl, ROOM_ID);
  log(`page run: ok=${pageRun['ok']} producerId=${String(pageRun['producerId']).slice(0, 12)}… transformApi=${pageRun['transformApi']} canaryKid=${pageRun['canaryKid']} outbound=${pageRun['outboundBytesSent']} ICE=${pageRun['connectionState']} samples=${(pageRun['cipherSamples'] as string[] | undefined)?.length ?? 0}`);

  await browser.close();
  relay.close();

  if (pageRun['ok'] !== true) {
    log(`FATAL — browser run failed: ${String(pageRun['error'] ?? 'unknown')}`);
    console.log('A3a: mediaPackets=0 byteIdentical=0 divergences=0 → FAIL (browser produce failed)');
    process.exit(1);
  }

  // DETECTION through the FROZEN verifier — feed the forwarded tap packets + the pinned input.
  // NO hand-rolled byteId/divergence check: this is the REAL receiver-side equality the 2-process
  // e2e (Task 3) drives, exercised here through the single in-process sink.
  const input = {
    kRoom: K_ROOM,
    roomId: ROOM_ID,
    cellSecret: CELL_SECRET,
    canaryKid: CANARY_KID,
    expectedCtrs: CTRS,
  };
  const vr = await verifyForwardedCanary(room.packets, input);

  log('─────────────── detection ───────────────');
  log(`forwarded tap packets: ${room.packets.length}`);
  log('──────────────────────────────────────────');

  console.log(
    `A3a: mediaPackets=${vr.mediaPackets} byteIdentical=${vr.byteIdentical} divergences=${vr.divergences.length}`,
  );

  const GREEN = vr.mediaPackets > 0 && vr.byteIdentical === vr.mediaPackets && vr.divergences.length === 0;
  process.exit(GREEN ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[m2b-canary-singletap] FATAL', err);
  console.log('A3a: mediaPackets=0 byteIdentical=0 divergences=0 → FAIL');
  process.exit(1);
});
