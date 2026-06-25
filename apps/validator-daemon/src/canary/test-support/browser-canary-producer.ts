// apps/validator-daemon/src/canary/test-support/browser-canary-producer.ts
/**
 * M2b-live-WAN Sub-lane A (Task 3) — the BROWSER-backed source leg of the cross-process
 * canary e2e. A drop-in replacement for `startNodeCanaryProducer` (`node-canary-producer.ts`):
 * same shape `Promise<{ producerId; start(); stop(); close() }>`, the only downstream coupling
 * being `producerId: string` (consumed by `startEvilRelayForward({ sourceProducerId })`).
 *
 * THE DELTA over the Node producer: instead of a mediasoup DirectTransport fed by
 * `CanaryPublisher.produce` bytes, this launches a REAL headless-Chromium page that joins over a
 * WS + a REAL WebRtcTransport (real ICE/DTLS on localhost), and whose every outbound encoded
 * frame is REPLACED with the fully-pinned synthetic 62-byte canary SFrame (via the Task-1/2
 * `canary-harness-entry.js` → `canary-frame-browser.ts`, which itself REUSES the SHIPPED client
 * `encryptFrame` + `PathCKeyDerivation` the daemon verifier cross-imports). The canary is
 * byte-identical to the FROZEN `recomputeCanaryFrame` BY CONSTRUCTION (locked by the Task-1 unit).
 *
 * THE CRUX (relayRouter injection): the WS `produce` handler creates the WebRtcTransport +
 * producer on the TEST'S INJECTED `relayRouter` (NOT a fresh `standUpRelay` router), so the
 * resulting `producer.id` is a real producer ON THE SAME router the test's `startEvilRelayForward`
 * + the F1 primary-pipe legs use. Without this, `evil-relay-forward.ts` could not `consume({
 * producerId })` the browser's producer. The producer EXISTS on `relayRouter` BEFORE this function
 * resolves (we await the page's `produced` reply), so the evil-relay can consume it immediately.
 *
 * ADDITIVE / TEST-SUPPORT: lives under canary/test-support/**; imports NO production media-path
 * module. Reuses the Task-1/2 browser harness (esbuild IIFE bundle of the client crypto) verbatim
 * as the page entry — the producer CRYPTO is unchanged. NEVER logs key material
 * (cellSecret / K_canary / P_i / seed); the kid/ctr the shipped encryptFrame logs are non-secret
 * routing integers (p10 §header). The `encodedInsertableStreams:true` send-transport flag + the
 * `delete window.RTCRtpScriptTransform` mask are harness-only (DISCLOSED at Gate A — production
 * `useRelay.createSendTransport` does NOT set the flag).
 *
 * Import-depth note (verified vs the filesystem, NOT copied from the plan): this module sits at
 * apps/validator-daemon/src/canary/test-support/, so the browser harness home
 * (scripts/bench/m2b-canary-browser/) is 5 `../` up: test-support→canary→src→validator-daemon→
 * apps→ROOT. These are runtime `path.resolve(__dirname, ...)` filesystem paths (esbuild entry +
 * readFileSync of the page HTML), NOT ES import specifiers — verified at module load below.
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import type { types as msTypes } from 'mediasoup';
import { build as esbuild } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 5 `../` test-support→canary→src→validator-daemon→apps→ROOT, then into the browser harness home.
const HARNESS_DIR = path.resolve(HERE, '../../../../../scripts/bench/m2b-canary-browser');
const HARNESS_ENTRY = path.join(HARNESS_DIR, 'canary-harness-entry.js');
const HARNESS_PAGE = path.join(HARNESS_DIR, 'canary-harness-page.html');
// Fail LOUD at load if the depth is wrong (the plan miscounts these — Tasks 0/1 both hit off-by-ones).
if (!existsSync(HARNESS_ENTRY) || !existsSync(HARNESS_PAGE)) {
  throw new Error(
    `browser-canary-producer: harness assets not found (depth miscount?) entry=${HARNESS_ENTRY} page=${HARNESS_PAGE}`,
  );
}

const log = (m: string): void => console.log(`[browser-canary-producer] ${m}`);

/** Matches `NodeCanaryProducer` (node-canary-producer.ts:16-21) — the source-leg contract. */
export interface BrowserCanaryProducer {
  producerId: string;
  start(): void;
  stop(): void;
  close(): void;
}

/**
 * Bundle the browser entry (real mediasoup-client + the SHIPPED client SFrame crypto +
 * PathCKeyDerivation via the Task-1 canary-core) into an IIFE the page loads as /bundle.js.
 * esbuild resolves the cross-repo client `.ts` modules the same way Vite does — nothing is
 * reimplemented. (VERBATIM from the Task-2 single-tap bundleEntry.)
 */
async function bundleEntry(): Promise<string> {
  const out = await esbuild({
    entryPoints: [HARNESS_ENTRY],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
    logLevel: 'silent',
    loader: { '.ts': 'ts' }, // allow .ts cross-repo client imports
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return out.outputFiles[0]!.text;
}

/**
 * Stand up ONLY the static harness page + /bundle.js over loopback http (A4-live mode). The real
 * production signaling daemon is WS-only (it does NOT serve the harness HTML), so the headless page
 * is still served here while `__canaryOpts.relayUrl` points the in-page WS client at the real
 * signaling daemon. (The A3b `standUpBrowserIngest` keeps its OWN http server unchanged so the
 * proven Sub-lane A path is byte-identical.)
 */
async function standUpPageServer(bundleJs: string): Promise<{ pageUrl: string; close: () => void }> {
  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/index') || url.startsWith('/harness') || url.startsWith('/canary')) {
      const html = readFileSync(HARNESS_PAGE, 'utf8');
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
  return {
    pageUrl: `http://127.0.0.1:${httpPort}/`,
    close: () => { try { httpServer.close(); } catch { /* */ } },
  };
}

/**
 * Stand up the in-process page/WS server for the browser source. UNLIKE the spike's
 * `standUpRelay`, this does NOT create its own mediasoup worker/router — it lands the produced
 * producer on the INJECTED `relayRouter` so the test's evil-relay + F1 pipe can find it. The WS
 * protocol is the spike's verbatim (join / createTransport / connectTransport / produce). On
 * `produce`, it creates a REAL WebRtcTransport + producer on `relayRouter` and resolves
 * `onProducer(producer)` so the adapter can hand `producer.id` back synchronously.
 */
async function standUpBrowserIngest(
  relayRouter: msTypes.Router,
  bundleJs: string,
  onProducer: (producer: msTypes.Producer) => void,
): Promise<{ pageUrl: string; wsUrl: string; close: () => void }> {
  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/index') || url.startsWith('/harness') || url.startsWith('/canary')) {
      const html = readFileSync(HARNESS_PAGE, 'utf8');
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
            // Caps from the INJECTED relayRouter so the Device negotiates against the SAME router.
            send({ type: 'routerRtpCapabilities', rtpCapabilities: relayRouter.rtpCapabilities });
          } else if (type === 'createTransport') {
            // REAL WebRtcTransport ON THE INJECTED relayRouter (the crux — same router the test uses).
            const transport = await relayRouter.createWebRtcTransport({
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
            log(`browser produced ${producer.kind} producer ${producer.id} on injected relayRouter`);
            onProducer(producer); // hand the real relayRouter producer to the adapter
            send({ type: 'produced', producerId: producer.id });
          }
        } catch (err) {
          log(`signaling error on ${type}: ${String(err)}`);
        }
      })();
    });
    ws.on('close', () => {
      // The producer lives on the test's relayRouter; the TEST owns its close. Only tear down the
      // WebRtcTransports the browser opened (closing them does NOT close the producer's router).
      for (const p of producers) { try { p.close(); } catch { /* best-effort */ } }
      for (const t of transports.values()) { try { t.close(); } catch { /* best-effort */ } }
    });
  });

  return {
    pageUrl,
    wsUrl,
    close: () => { try { wss.close(); } catch { /* */ } try { httpServer.close(); } catch { /* */ } },
  };
}

/**
 * Launch a headless-Chromium browser canary producer. TWO modes (additive):
 *
 *  • A3b mock-ingest (`relayRouter` given, no `signalingUrl`): the browser joins an in-process WS
 *    whose `produce` handler creates the WebRtcTransport + producer on the TEST's INJECTED
 *    `relayRouter`. Resolves AFTER the page's `produced` reply so the caller can immediately
 *    `startEvilRelayForward({ sourceProducerId })`. (UNCHANGED — the proven Sub-lane A path.)
 *
 *  • A4-live (`signalingUrl` given, no `relayRouter`): the browser joins the REAL production relay
 *    `createSignalingServer` (covert no-password path) over a REAL WebRtcTransport/DTLS produce.
 *    The producer lands on the real relay's room router (which the harness's injected manager has
 *    made === the caller's test-owned router — the "router-handle bridge"). Here there is no
 *    in-process `onProducer` hook, so the producer id comes from the page's resolved
 *    `window.__canaryResult.producerId` (the relay's `produced` reply).
 *
 * Shape MIRRORS `startNodeCanaryProducer`: { producerId, start, stop, close }. Here the headless
 * Chrome fake-VP8 device produces RTP CONTINUOUSLY once the createEncodedStreams canary transform
 * is attached, so `start()` is the formal trigger (the producer is already live the moment this
 * resolves) and `stop()`/`close()` tear the browser + ingest down.
 */
export async function startBrowserCanaryProducer(args: {
  /** A3b mode: produce onto this INJECTED router. Mutually exclusive with `signalingUrl`. */
  relayRouter?: msTypes.Router;
  /** A4-live mode: join this REAL signaling daemon URL. Mutually exclusive with `relayRouter`. */
  signalingUrl?: string;
  kRoom: Uint8Array;
  roomId: string;
  cellSecret: Uint8Array;
  canaryKid: number;
  ctrs: number[];
}): Promise<BrowserCanaryProducer> {
  const bundleJs = await bundleEntry();

  // The relayRouter producer the in-process A3b WS handler lands (live mode leaves this null and
  // reads the producer id from the page result instead).
  let relayProducer: msTypes.Producer | null = null;
  let closeIngest: () => void = () => {};
  let relayUrl: string;
  let pageUrl: string;
  const liveMode = Boolean(args.signalingUrl);
  if (args.signalingUrl) {
    // A4-live: point the page at the REAL production signaling daemon (WS only); serve the static
    // harness page over a separate loopback http server.
    relayUrl = args.signalingUrl;
    const pageServer = await standUpPageServer(bundleJs);
    pageUrl = pageServer.pageUrl;
    closeIngest = () => pageServer.close();
  } else {
    if (!args.relayRouter) {
      throw new Error(
        'browser-canary-producer: pass relayRouter (A3b mock-ingest) OR signalingUrl (A4-live)',
      );
    }
    const ingest = await standUpBrowserIngest(args.relayRouter, bundleJs, (p) => {
      relayProducer = p;
    });
    closeIngest = () => ingest.close();
    relayUrl = ingest.wsUrl;
    pageUrl = ingest.pageUrl;
  }

  log('launching headless Chromium (fake VP8 device)…');
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const page: Page = await browser.newPage();
  page.on('console', (m) => log(`PAGE> ${m.text()}`));
  page.on('pageerror', (e) => log(`PAGE-ERROR> ${String(e)}`));
  await page.goto(pageUrl, { waitUntil: 'load' });

  // Pass the pinned canary inputs to the page (Uint8Arrays serialize as number[]; rebuilt in-page).
  // `relayUrl` is the in-process A3b WS OR the REAL signaling daemon WS (live mode) — the page's WS
  // client (`canary-harness-entry.js`) is identical for both: it sends {type:'join',roomId}, then
  // createTransport/connectTransport/produce, and reports producerId in window.__canaryResult.
  await page.evaluate(
    (o) => {
      (window as unknown as { __canaryOpts: unknown }).__canaryOpts = o;
    },
    {
      relayUrl,
      roomId: args.roomId,
      kRoom: Array.from(args.kRoom),
      cellSecret: Array.from(args.cellSecret),
      canaryKid: args.canaryKid,
      ctrs: args.ctrs.slice(),
    },
  );

  // Kick off the page's produce path. run() sleeps a window then returns; the fake device keeps
  // producing until the page closes. `window.__canaryRun()` ASSIGNS window.__canaryResult to the
  // run() Promise — we await that resolution below.
  await page.evaluate(() =>
    void (window as unknown as { __canaryRun: () => Promise<unknown> }).__canaryRun(),
  );

  // Resolve the producer id per mode:
  //  • A4-live — no in-process onProducer hook (the real relay owns the producer). The id comes
  //    from the page's RESOLVED window.__canaryResult.producerId (the relay's `produced` reply).
  //    NOTE window.__canaryResult is a Promise (canary-harness-entry.js:234) → we AWAIT it.
  //  • A3b — the in-process WS `produce` handler landed the producer on the injected relayRouter
  //    via onProducer; poll for that (the proven Sub-lane A gate; unchanged behavior).
  let producerId: string;
  if (liveMode) {
    const result = await page.evaluate(async () => {
      const w = window as unknown as { __canaryResult?: Promise<unknown> | { producerId?: string } };
      const deadline = Date.now() + 60_000;
      // __canaryResult is the run() Promise; await it (with a timeout guard) and return the object.
      const settled = await Promise.race([
        Promise.resolve(w.__canaryResult).catch((e) => ({ ok: false, error: String(e) })),
        new Promise((r) => setTimeout(() => r(null), Math.max(0, deadline - Date.now()))),
      ]);
      return (settled ?? null) as { ok?: boolean; producerId?: string; error?: string } | null;
    });
    if (!result?.producerId) {
      try { await browser.close(); } catch { /* */ }
      closeIngest();
      throw new Error(
        `browser-canary-producer: no producerId from real signaling within 60s (${result?.error ?? 'no result'})`,
      );
    }
    producerId = result.producerId;
    log(`source-leg ready: producerId=${producerId} (live on the REAL relay via real signaling)`);
  } else {
    const deadline = Date.now() + 60_000;
    while (relayProducer === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (relayProducer === null) {
      try { await browser.close(); } catch { /* */ }
      closeIngest();
      throw new Error('browser-canary-producer: timed out waiting for the browser to produce on relayRouter');
    }
    producerId = (relayProducer as msTypes.Producer).id;
    log(`source-leg ready: producerId=${producerId} (live on the injected relayRouter)`);
  }

  let torn = false;
  const teardown = (): void => {
    if (torn) return;
    torn = true;
    void browser.close().catch(() => { /* best-effort */ });
    closeIngest();
  };

  return {
    producerId,
    // The browser fake device produces RTP continuously from the moment the canary transform
    // attached (gated above). start() is the formal trigger; the stream is already flowing.
    start(): void { /* browser already producing on relayRouter (gated on the `produced` reply) */ },
    stop(): void { /* RTP stops when the browser/page closes in close() */ },
    close(): void { teardown(); },
  };
}
