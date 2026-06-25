/**
 * M2b-live-WAN Sub-lane A — Task-0 GATE spike (THROWAWAY, hermetic, localhost).
 * FORK of scripts/bench/p10-browser/p10-relayblind-browser.ts.
 *
 * THE GATE (base-probe §3 / spec §7 / plan Task-0): prove, in a REAL headless Chromium
 * through the REAL client createEncodedStreams partial-SFrame path, that a fully-pinned
 * synthetic 62-byte canary SFrame
 *   (1) is BYTE-IDENTICAL to the FROZEN daemon `recomputeCanaryFrame` for each ctr 0..7
 *       (cross-repo crypto byte-equivalence — true BY CONSTRUCTION since the browser reuses
 *       the same client encryptFrame + PathCKeyDerivation the verifier cross-imports), AND
 *   (2) arrives as the LITERAL last-62 bytes of a single forwarded RTP packet (no MTU
 *       fragmentation / no trailing RTP padding) so the FROZEN `extractCanaryBody`
 *       (verifier.ts:169, rigid last-62, UNCHANGED) recovers it — the REAL falsifiable risk.
 *
 * GREEN both → GATE GO (build Tasks 1+). RED on (2) only → STOP; do NOT harden the verifier
 * (breaks INV-A) — that is a re-scope decision for the human (Q4 default: keep the verifier
 * frozen, constrain the producer). RED on (1) → a keying/PRF divergence to fix in the harness.
 *
 * ADDITIVE / TEST-ONLY: lives under scripts/bench/**; stands up its OWN minimal relay
 * (mediasoup worker/router + a tiny WS) + relay-internal pipe-tap. Imports NO production
 * media-path module (beyond the shared canary-core cross-import). NEVER logs key material.
 *
 * Run: cd dvconf-daemons && pnpm exec tsx scripts/bench/m2b-canary-browser/m2b-canary-spike.ts
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { build as esbuild } from 'esbuild';
import { chromium, type Browser } from 'playwright';
// FROZEN daemon recompute — the byte-identity ground truth (verifier.ts, INV-A: never edited).
import { recomputeCanaryFrame, deriveCanarySeed } from '../../../apps/validator-daemon/src/canary/verifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS_ROOT = path.resolve(HERE, '../../..');
const VP8_PT = 101;
const CANARY_SFRAME_LEN = 62; // verifier.ts: CANARY_FRAME_LEN(32) + GCM tag(16) + trailer(14)

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
const log = (m: string): void => console.log(`[m2b-canary-spike] ${m}`);

interface CaptureRoom {
  producerId: string | null;
  /** every forwarded RTP packet captured at the relay-internal tap. */
  packets: Buffer[];
  producer: msTypes.Producer | null;
}

/**
 * Bundle the browser entry (real mediasoup-client + the SHIPPED client SFrame crypto +
 * PathCKeyDerivation) into an IIFE the page loads as /bundle.js. esbuild resolves the
 * cross-repo client modules the same way Vite does; nothing is reimplemented.
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
 * `produce`, attaches the relay-internal pipe-tap on the browser's producer and records
 * every forwarded RTP packet into `room`. (VERBATIM from p10 standUpRelay.)
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
  // The room label MUST equal the pinned keying ROOM_ID — it is folded into the canary
  // HKDF info (e2ee-spike hkdfInfo: `dvconf-e2ee/v1|${roomId}|kid=…`), so a divergent room
  // label → a divergent K_canary → ciphertext mismatch (byteId 0/8). The relay's
  // standUpRelay ignores the label (one router per WS conn), so reusing ROOM_ID is safe.
  const pageRun = await driveRoom(browser, relay.pageUrl, relay.wsUrl, ROOM_ID);
  log(`page run: ok=${pageRun['ok']} producerId=${String(pageRun['producerId']).slice(0, 12)}… transformApi=${pageRun['transformApi']} canaryKid=${pageRun['canaryKid']} outbound=${pageRun['outboundBytesSent']} ICE=${pageRun['connectionState']} samples=${(pageRun['cipherSamples'] as string[] | undefined)?.length ?? 0}`);

  await browser.close();
  relay.close();

  if (pageRun['ok'] !== true) {
    log(`FATAL — browser run failed: ${String(pageRun['error'] ?? 'unknown')}`);
    console.log(`A2 GATE: byteId 0/${CTRS.length}, tailSurvived 0 → NO-GO`);
    process.exit(1);
  }

  const cipherSamples = (pageRun['cipherSamples'] as string[] | undefined) ?? [];
  const base = { kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID };
  const seed = deriveCanarySeed(base.cellSecret);

  // (1) BYTE-IDENTITY: each browser cipherSample == FROZEN Node recompute for the same ctr.
  let idOk = 0;
  for (let i = 0; i < CTRS.length; i++) {
    const browserHex = cipherSamples[i];
    if (typeof browserHex !== 'string') {
      console.error(`ctr ${CTRS[i]} MISSING browser sample (got ${cipherSamples.length} samples)`);
      continue;
    }
    const browserBuf = Buffer.from(browserHex, 'hex');
    const nodeBuf = Buffer.from(await recomputeCanaryFrame(base, seed, CTRS[i]!));
    if (browserBuf.equals(nodeBuf)) idOk++;
    else console.error(`ctr ${CTRS[i]} MISMATCH browser=${browserBuf.toString('base64')} node=${nodeBuf.toString('base64')}`);
  }

  // (2) TAIL-SURVIVAL: a forwarded tap packet's LAST 62 bytes == one recomputed SFrame.
  const recomputed = new Set<string>();
  for (const c of CTRS) {
    recomputed.add(Buffer.from(await recomputeCanaryFrame(base, seed, c)).toString('base64'));
  }
  let tailOk = 0;
  // diagnostics for a NO-GO-on-(2): packet-length distribution + where the canary lands.
  const lenHistogram = new Map<number, number>();
  let pktsCarryingCanaryAnywhere = 0;
  for (const pkt of room.packets) {
    lenHistogram.set(pkt.length, (lenHistogram.get(pkt.length) ?? 0) + 1);
    if (pkt.length >= 12 + CANARY_SFRAME_LEN) {
      if (recomputed.has(pkt.subarray(pkt.length - CANARY_SFRAME_LEN).toString('base64'))) tailOk++;
    }
    // does the canary appear ANYWHERE in this packet (not just the rigid tail)?
    for (let off = 0; off + CANARY_SFRAME_LEN <= pkt.length; off++) {
      if (recomputed.has(pkt.subarray(off, off + CANARY_SFRAME_LEN).toString('base64'))) {
        pktsCarryingCanaryAnywhere++;
        break;
      }
    }
  }

  const GO = idOk === CTRS.length && tailOk > 0;
  const verdict = GO ? 'GO' : 'NO-GO';

  // Diagnostic block (always printed — load-bearing for a NO-GO-on-(2) human decision).
  log('─────────────── diagnostics ───────────────');
  log(`forwarded tap packets: ${room.packets.length}`);
  log(`browser cipherSamples: ${cipherSamples.length}/${CTRS.length}`);
  const lens = [...lenHistogram.entries()].sort((a, b) => a[0] - b[0]);
  log(`packet-length histogram (len:count): ${lens.map(([l, c]) => `${l}:${c}`).join('  ')}`);
  log(`packets carrying the canary ANYWHERE (scan): ${pktsCarryingCanaryAnywhere}; as the rigid last-62 tail: ${tailOk}`);
  log('────────────────────────────────────────────');

  const gateLine = `A2 GATE: byteId ${idOk}/${CTRS.length}, tailSurvived ${tailOk} → ${verdict}`;
  console.log(gateLine);

  // GREEN-only generator discipline: write the verdict log ONLY on GO; on NO-GO write the
  // diagnostic + STOP flag (the spec/plan say: do NOT harden the verifier — re-scope w/ human).
  const dir = path.join(DAEMONS_ROOT, '..', '.evidence', 'verification');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'm2b-live-wan-A-task0-spike.log');
  const lines: string[] = [
    `# M2b-live-WAN Sub-lane A — Task-0 GATE spike — ${new Date().toISOString()}`,
    ``,
    gateLine,
    ``,
    `byteId: ${idOk}/${CTRS.length}`,
    `tailSurvived: ${tailOk}`,
    `verdict: ${verdict}`,
    ``,
    `forwarded tap packets: ${room.packets.length}`,
    `browser cipherSamples: ${cipherSamples.length}/${CTRS.length}`,
    `packet-length histogram (len:count): ${lens.map(([l, c]) => `${l}:${c}`).join('  ')}`,
    `packets carrying the canary ANYWHERE: ${pktsCarryingCanaryAnywhere}; as rigid last-62 tail: ${tailOk}`,
    `Chromium: ${browser.version?.() ?? '(closed)'}`,
    `producerId: ${String(pageRun['producerId'])}`,
    `transformApi: ${String(pageRun['transformApi'])}`,
    `canaryKid: ${CANARY_KID}  ctrs: [${CTRS.join(',')}]`,
    ``,
  ];
  if (!GO) {
    lines.push(
      `STOP — NO-GO. ${idOk !== CTRS.length ? `byte-identity failed (${idOk}/${CTRS.length}) → keying/PRF divergence in the harness; FIX THE HARNESS, not the verifier.` : `byte-identity 8/8 but tail-survival 0 → the browser VP8 encode fragments/pads the canary off the rigid last-62 tail.`}`,
      `Per spec §7 / plan Task-0 Step-4: do NOT harden extractCanaryBody (breaks INV-A). This is a re-scope decision for the human (Q4 default: keep the verifier frozen, constrain the producer).`,
    );
  } else {
    lines.push(
      `GO — both gate legs GREEN. byte-identity is by construction (browser reuses the same client encryptFrame + PathCKeyDerivation the verifier cross-imports); tail-survival proven on a REAL browser createEncodedStreams produce. Build Tasks 1+.`,
    );
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
  log(`wrote verdict log: ${file}`);

  process.exit(GO ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[m2b-canary-spike] FATAL', err);
  console.log('A2 GATE: byteId 0/8, tailSurvived 0 → NO-GO');
  process.exit(1);
});
