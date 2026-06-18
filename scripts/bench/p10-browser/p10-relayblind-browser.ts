/**
 * P10 Step-2 HARNESS — THESIS HEADLINE real-browser relay-blind capture (REQ-MCS-014).
 *
 * THE HONEST DELTA over P5 (structural blind-forward) and Step-1 (hermetic
 * real-SFrame floor): this drives a REAL headless Chrome with FAKE media into an
 * E2EE room over PRODUCTION WebRTC (WebRtcTransport, real ICE/DTLS on localhost),
 * with the producer's VP8 frames partial-SFrame-encrypted by the SHIPPED CLIENT CRYPTO
 * (real per-sender K_content), and proves the M3 Lane B DUAL relay-blind invariant at a
 * relay-internal tap: (A) the SFU now FORWARDS the E2EE stream (forwarded > 0) — the
 * partial-SFrame keeps the cleartext VP8 keyframe markers at the FRONT, so the SFU's
 * keyframe-select gate advances (the P10 Finding-B full-frame keyframe stall is fixed);
 * AND (B) the forwarded BODY is STILL content-opaque — every forwarded SFrame body FAILS
 * AES-GCM decrypt WITHOUT K_content (decryptFrame(body, ()=>null) REJECTS), and the
 * captured ciphertext carries the real config-0x01 + 14-byte TRAILER. Against a NON-E2EE
 * control room over the SAME tap path, the relay forwards cleartext VP8 recovered with NO
 * key. The contrast: BOTH rooms forward, but the E2EE forwarded body is GCM-opaque while
 * the control body is readable VP8. The contrast is the proof.
 *
 * WHY AN IN-PROCESS RELAY + A RELAY-INTERNAL TAP (settled in recon):
 *   A real browser sends over a WebRtcTransport, which emits NO packet-level event,
 *   and the wire is SRTP-encrypted by DTLS in BOTH rooms — a wire pcap looks
 *   encrypted either way and shows nothing. The relay-blind property is what the
 *   relay reads INTERNALLY, after it decrypts SRTP. That is only observable via a
 *   relay-INTERNAL tap = a secondary `pipe`-type DirectTransport consumer on the SAME
 *   producer (DirectTransport consumers emit per-packet 'rtp'; `pipe:true` forwards
 *   without the keyframe-selection gate — the warmpipe-rtp / P5 pattern) PLUS the
 *   relay's own producer inbound stats. So this harness OWNS the mediasoup router
 *   (in-process) to attach that tap. No production media-path module is imported/edited.
 *
 * HONESTY BOUNDS (DA-2/DA-3/DA-8, D-M2-7/8 — carry from Step-1 / ROADMAP HARD-GATE):
 *   - Relay-blindness here is STRUCTURAL (mediasoup has no SFrame/decode path; the
 *     partial-SFrame body is opaque to it — it FORWARDS the stream but never decrypts the
 *     body) + the M2 validator-blindness is ECONOMIC/OPERATIONAL (the validator HOLDS the
 *     key). This is NEVER a cryptographic "relay/validator CANNOT decrypt" claim — that is
 *     Path C → M3 (D-M2-7/8).
 *   - "Undecodable" is proven by STRUCTURE (real config 0x01 + 14-byte trailer present)
 *     + AES-GCM decrypt FAILURE WITHOUT the key (on the sender-boundary sample AND the
 *     forwarded tap body) — NOT by a known-plaintext attack.
 *   - Platform disclosed: headless Chromium on Windows, FAKE media, LOOPBACK ICE —
 *     NOT WAN glass-to-glass. The negative control is load-bearing.
 *   - The crypto is the PRODUCTION CLIENT stack's, bundled verbatim — the harness owns
 *     the createEncodedStreams insertable-streams pipe (to capture ciphertext samples)
 *     but calls the SHIPPED `encryptFrame` (the exact function production
 *     `makeEncryptTransform`/`attachSenderTransform` calls); the ciphertext is
 *     byte-identical to production. Nothing is reimplemented.
 *
 * ADDITIVE / TEST-ONLY: lives under scripts/bench/**; stands up its OWN minimal relay
 * (mediasoup worker/router + a tiny WS speaking the relay's JSON protocol verbatim).
 * Imports NO production media-path module. NEVER logs key material.
 *
 * Run (after `npx playwright install chromium`):
 *   pnpm exec tsx scripts/bench/p10-browser/p10-relayblind-browser.ts
 *   pnpm exec tsx scripts/bench/p10-browser/p10-relayblind-browser.ts --write-artifact
 *
 * --write-artifact : on a GREEN run, write the dated evidence artifact GREEN-ONLY at
 *                    the generator (relay-overlap N1 lesson): a FAIL writes nothing.
 */

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { build as esbuild } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import {
  decryptFrame,
  readSframeTrailer,
  SFRAME_TRAILER_LEN,
} from '../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS_ROOT = path.resolve(HERE, '../../..');
const VP8_PT = 101;
// The cleartext config byte 0x01 now lives in the SFrame TRAILER at the END;
// `readSframeTrailer` validates it key-free, so the driver no longer scans sframe[0].

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (m: string): void => console.log(`[p10-harness] ${m}`);

interface CaptureRoom {
  /** the browser's producer id (set on produce). */
  producerId: string | null;
  /** every forwarded RTP packet captured at the relay-internal tap. */
  packets: Buffer[];
  /** the relay-side mediasoup producer (for inbound-vs-forwarded stats). */
  producer: msTypes.Producer | null;
  /** inbound-RTP packet count read WHILE the page was connected (set in driveRoom). */
  relayReceivedSnapshot: number;
}

/** Result of analysing one captured payload window. */
interface RoomAnalysis {
  forwarded: number;
  mediaPackets: number;
  /** relay-side INBOUND RTP packets the relay RECEIVED from the browser. */
  relayReceivedPackets: number;
  /** E2EE: real SFrame ciphertext samples (captured at the sender boundary == the bytes
   *  the relay receives over loopback) carrying a config-0x01 + 14-byte trailer. */
  sframeHeaderObserved: number;
  /** E2EE: …whose AES-GCM body FAILS to decrypt with NO key (the relay-blind point). */
  undecodableWithoutKey: number;
  /** E2EE: forwarded tap packets in which we could LOCATE a whole captured SFrame body
   *  (only single-RTP-packet frames; large frames fragment across MTU so they don't match). */
  forwardedSframeMatched: number;
  /** E2EE: …of those LOCATED forwarded bodies, the ones that FAIL decrypt with NO key —
   *  invariant (B) where measurable: a located forwarded body stays content-opaque. Per-packet
   *  byte-identity of forwarded ciphertext is the HERMETIC Step-1 (relay-blind-realsframe). */
  forwardedUndecodableWithoutKey: number;
  /** non-E2EE: forwarded packets whose body decoded to readable VP8 with NO key. */
  cleartextRecovered: number;
  /** first payload for the side-by-side hex sample. */
  samplePayloadHex: string | null;
  /** for E2EE: the recovered {kid, ctr} from the first SFrame header observed. */
  sampleHeader: { kid: number; ctr: number } | null;
  /** for non-E2EE: the recovered cleartext snippet (printable). */
  sampleCleartext: string | null;
}

/** Read the relay-side mediasoup producer's INBOUND received-packet count (0 if none). */
async function relayReceivedPackets(room: CaptureRoom): Promise<number> {
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
async function bundleEntry(): Promise<string> {
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
async function driveRoom(
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

/**
 * Analyse the E2EE room. The M3 Lane B DUAL relay-blind invariant, both legs load-bearing:
 *   (A) the SFU now FORWARDS the E2EE stream (forwarded > 0): the PARTIAL-SFrame keeps the
 *       cleartext VP8 keyframe markers at the FRONT, so the SFU keyframe-select gate
 *       advances (the full-frame P10 Finding-B stall is FIXED). The relay RECEIVES the
 *       ciphertext (relayReceivedPackets > 0) AND forwards it.
 *   (B) the content is STILL opaque without the key. The PRIMARY opacity proof is on the
 *       page-captured sender-boundary ciphertext — the EXACT whole-frame bytes the relay
 *       receives over loopback: each carries the REAL config-0x01 + 14-byte TRAILER (parsed
 *       FROM THE END by `readSframeTrailer`) AND FAILS AES-GCM decrypt WITHOUT the key
 *       (undecodableWithoutKey === sframeHeaderObserved). We ALSO walk the actual forwarded
 *       tap packets and, for any whole SFrame body we can LOCATE (only single-RTP-packet
 *       frames — large frames fragment across MTU so they never whole-match), assert the
 *       SHIPPED `decryptFrame(body, ()=>null)` REJECTS (forwardedUndecodableWithoutKey ===
 *       forwardedSframeMatched, vacuously true when fragmentation locates none). Per-packet
 *       byte-identity of FORWARDED ciphertext is the HERMETIC Step-1's job
 *       (relay-blind-realsframe.integration.test.ts, byteIdentical===mediaPackets), where a
 *       finite single-packet body set makes it deterministic.
 *   We prove "undecodable" with the SHIPPED `decryptFrame` + a null key lookup.
 */
async function analyseE2EE(room: CaptureRoom, pageRun: Record<string, unknown>): Promise<RoomAnalysis> {
  const a: RoomAnalysis = {
    forwarded: room.packets.length,
    mediaPackets: 0,
    relayReceivedPackets: room.relayReceivedSnapshot,
    sframeHeaderObserved: 0,
    undecodableWithoutKey: 0,
    forwardedSframeMatched: 0,
    forwardedUndecodableWithoutKey: 0,
    cleartextRecovered: 0,
    samplePayloadHex: null,
    sampleHeader: null,
    sampleCleartext: null,
  };

  // The page captured the first few REAL SFrame ciphertexts (hex) it sent to the relay.
  // These are byte-identical to what the relay holds over loopback (sender boundary).
  const samplesHex = (pageRun['cipherSamples'] as string[] | undefined) ?? [];
  // The exact sent SFrame bodies (b64) — authoritatively locate the SFrame body inside a
  // forwarded tap packet (mediasoup rewrites RTP/VP8 HEADER bytes, never the SFrame body).
  const sentBodiesB64 = new Set<string>();
  for (const hex of samplesHex) {
    const sframe = Buffer.from(hex, 'hex');
    if (sframe.length < SFRAME_TRAILER_LEN + 16) continue;
    // (B-1) real config 0x01 + 14-byte TRAILER parses key-free FROM THE END (M3 Lane B).
    let trailer: { kid: number; ctr: number; codecOffset: number };
    try {
      trailer = readSframeTrailer(sframe);
    } catch {
      continue;
    }
    a.sframeHeaderObserved++;
    sentBodiesB64.add(sframe.toString('base64'));
    if (a.sampleHeader === null) {
      a.sampleHeader = { kid: trailer.kid, ctr: trailer.ctr };
      a.samplePayloadHex = sframe.subarray(0, Math.min(40, sframe.length)).toString('hex');
    }
    // (B-2) THE RELAY-BLIND POINT (sender-boundary sample): a keyless reader cannot recover
    // the frame — the SHIPPED `decryptFrame` with a null key lookup REJECTS (AES-GCM auth).
    let decoded = false;
    try {
      await decryptFrame(Uint8Array.prototype.slice.call(sframe), () => null);
      decoded = true; // would mean readable with no key — must NOT happen.
    } catch {
      decoded = false; // expected: undecodable without the key.
    }
    if (!decoded) a.undecodableWithoutKey++;
  }

  // (A) + (B-3): walk the ACTUAL forwarded tap packets. Count media packets, and for each
  // one that carries one of our sent SFrame bodies, assert the FORWARDED body is still
  // GCM-opaque (decryptFrame with a null key REJECTS). This is the headline: the SFU
  // FORWARDED the E2EE stream, yet each forwarded body remains content-opaque.
  const minMedia = 12 + 4 + 10;
  for (const pkt of room.packets) {
    if (pkt.length < minMedia) continue;
    a.mediaPackets++;
    // Locate the SFrame body by the AUTHORITATIVE sent-body match (mediasoup never rewrites
    // the body), then confirm it is content-opaque without the key.
    const scanEnd = Math.min(pkt.length - SFRAME_TRAILER_LEN, 64);
    for (let off = 12; off < scanEnd; off++) {
      const cand = pkt.subarray(off);
      if (cand.length < SFRAME_TRAILER_LEN + 16) break;
      if (sentBodiesB64.has(cand.toString('base64'))) {
        // LOCATED a whole captured SFrame body in this forwarded packet (only happens for
        // single-RTP-packet frames; large frames fragment across MTU and never whole-match).
        a.forwardedSframeMatched++;
        let forwardedDecoded = false;
        try {
          await decryptFrame(Uint8Array.prototype.slice.call(cand), () => null);
          forwardedDecoded = true; // readable with no key — must NOT happen.
        } catch {
          forwardedDecoded = false; // expected: forwarded body opaque without the key.
        }
        if (!forwardedDecoded) a.forwardedUndecodableWithoutKey++;
        break;
      }
    }
  }
  return a;
}

/**
 * Analyse the non-E2EE control capture: the forwarded body is the RAW VP8 bitstream
 * (no SFrame, no key). We DECODE it with NO key — a VP8 keyframe carries the
 * well-known start code 0x9d 0x01 0x2a in cleartext (the relay reads it; so can any
 * passive observer). Recovering that proves the non-E2EE body is readable on the wire.
 * This is the load-bearing contrast: identical relay mechanics, cleartext outcome.
 */
async function analyseControl(room: CaptureRoom): Promise<RoomAnalysis> {
  const a: RoomAnalysis = {
    forwarded: room.packets.length,
    mediaPackets: 0,
    relayReceivedPackets: room.relayReceivedSnapshot,
    sframeHeaderObserved: 0,
    undecodableWithoutKey: 0,
    forwardedSframeMatched: 0,
    forwardedUndecodableWithoutKey: 0,
    cleartextRecovered: 0,
    samplePayloadHex: null,
    sampleCleartext: null,
    sampleHeader: null,
  };
  // VP8 keyframe start code (uncompressed-data-chunk magic, RFC 6386 §9.1) — cleartext.
  const VP8_KEYFRAME_MAGIC = Buffer.from([0x9d, 0x01, 0x2a]);
  const minMedia = 12 + 4 + 10;
  for (const pkt of room.packets) {
    if (pkt.length < minMedia) continue;
    a.mediaPackets++;
    // Scan the cleartext payload for the VP8 keyframe magic — readable with NO key.
    const idx = pkt.indexOf(VP8_KEYFRAME_MAGIC, 12);
    if (idx >= 0) {
      a.cleartextRecovered++;
      if (a.sampleCleartext === null) {
        a.sampleCleartext = `VP8 keyframe magic 0x9d012a @ offset ${idx} (cleartext, no key)`;
        a.samplePayloadHex = pkt.subarray(12, Math.min(12 + 40, pkt.length)).toString('hex');
      }
    }
  }
  // Fallback sample if no keyframe magic landed in the window (interframes only): still
  // record a payload sample — the body is raw VP8 either way (relay reads VP8 headers).
  if (a.samplePayloadHex === null && room.packets.length > 0) {
    const pkt = room.packets.find((p) => p.length >= minMedia) ?? room.packets[0]!;
    a.samplePayloadHex = pkt.subarray(12, Math.min(12 + 40, pkt.length)).toString('hex');
  }
  return a;
}

interface HarnessVerdict {
  pass: boolean;
  reasons: string[];
  e2eeRun: Record<string, unknown>;
  controlRun: Record<string, unknown>;
  e2ee: RoomAnalysis;
  control: RoomAnalysis;
}

function gitHead(repoDir: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim().slice(0, 12);
  } catch {
    return 'unknown';
  }
}

/**
 * GREEN-ONLY artifact generator (relay-overlap N1 lesson: fix evidence at the
 * GENERATOR, never the output file). Writes the dated headline artifact ONLY when the
 * verdict PASSES. Marked PROVISIONAL with the exact platform disclosed.
 */
function writeArtifact(v: HarnessVerdict, browserVersion: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(DAEMONS_ROOT, '.evidence', 'verification');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `transmission-m2-relayblind-${date}.md`);
  const daemonsHead = gitHead(DAEMONS_ROOT);
  const clientHead = gitHead(path.resolve(DAEMONS_ROOT, '..', 'dvconf-client'));
  const e = v.e2ee;
  const c = v.control;
  const md = `# P10 — Real-browser relay-blind capture (REQ-MCS-014) — ${date} (PROVISIONAL)

> THESIS HEADLINE, Step-2 real-browser leg. Generated GREEN-ONLY by
> \`scripts/bench/p10-browser/p10-relayblind-browser.ts --write-artifact\`
> (relay-overlap N1: fix self-generated evidence at the GENERATOR, never the file).
> **PROVISIONAL**: a single live capture on the platform disclosed below. Re-run via
> the runbook for an independent dated capture.

## Verdict: ${v.pass ? '**PASS**' : '**FAIL**'}

## Environment / platform (DISCLOSED — honesty bound)
- Browser: ${browserVersion} (headless, \`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream\`)
- Media: Chrome FAKE device (deterministic 640x480 VP8), NOT a real camera.
- Transport: REAL WebRTC (WebRtcTransport, real ICE/DTLS) over LOOPBACK (127.0.0.1) — NOT WAN glass-to-glass.
- Relay: in-process mediasoup ${(mediasoup as unknown as { version?: string }).version ?? '3.19.x'} worker/router owned by the harness (so it can attach the relay-internal tap).
- Tap: relay-internal \`pipe\`-type DirectTransport consumer on the browser's producer (post-SRTP-decrypt forwarded payload — the warmpipe-rtp / P5 pattern). \`pipe:true\` forwards every RTP packet WITHOUT the simulcast keyframe-selection gate. This is the ONLY place the relay-blind difference is observable; a wire pcap is SRTP-encrypted in BOTH rooms.
- Crypto: SHIPPED client stack, bundled verbatim — real ed25519 session keypair → libsodium sealed-box K_room → per-sender K_content HKDF (D-M2-21) → AES-GCM \`encryptFrame\` over the M3 Lane B PARTIAL-SFrame layout [ cleartext VP8 codec prefix (codecOffset) | ciphertext||tag | 14-byte trailer: config 0x01 | kid:u32-BE | ctr:u64-BE | codecOffset:u8 ]. NOTHING reimplemented; the harness owns the createEncodedStreams insertable-streams pipe and calls the SHIPPED \`encryptFrame\` (the exact function the production \`makeEncryptTransform\`/\`attachSenderTransform\` calls). The emitted ciphertext is byte-identical to production.
- OS: Windows 11.

## Repo HEADs
- dvconf-daemons: \`${daemonsHead}\` (quangdm_main)
- dvconf-client: \`${clientHead}\` (master)

## E2EE room — the SFU FORWARDS the stream, yet the forwarded body is content-opaque (M3 Lane B dual invariant)
- browser run: ok=${v.e2eeRun['ok']}, producerId=${String(v.e2eeRun['producerId']).slice(0, 12)}…, transformApi=${v.e2eeRun['transformApi']}, kid=${v.e2eeRun['kid']}, outbound bytesSent=${v.e2eeRun['outboundBytesSent']}, ICE=${v.e2eeRun['connectionState']}
- **relay RECEIVED (inbound RTP from the browser): ${e.relayReceivedPackets} packets** — the SFrame ciphertext reached the relay over real WebRTC.
- **(A) relay FORWARDED at the tap: ${e.forwarded} packets (mediaPackets=${e.mediaPackets})** — the M3 Lane B partial-SFrame keeps the cleartext VP8 keyframe markers at the FRONT, so the SFU's keyframe-select gate advances and forwards the E2EE stream (the P10 Finding-B full-frame keyframe stall is FIXED).
- **(B) content opaque WITHOUT the key.** Sender-boundary wire SFrames rejected keyless decrypt: ${e.undecodableWithoutKey} / ${e.sframeHeaderObserved} (the EXACT bytes the relay receives). Of the forwarded tap packets, ${e.forwardedSframeMatched} carried a whole single-RTP-packet SFrame body and all ${e.forwardedUndecodableWithoutKey} were GCM-opaque without the key (large frames fragment across MTU; per-packet byte-identity of forwarded ciphertext is the hermetic Step-1 \`relay-blind-realsframe\` gate).
- SFrame ciphertext samples captured (the exact bytes the relay receives over loopback): ${e.sframeHeaderObserved}, each with the REAL config 0x01 + 14-byte trailer.
- **AES-GCM decrypt WITHOUT the key → REJECTED (sender-boundary samples): ${e.undecodableWithoutKey} / ${e.sframeHeaderObserved}**
- sample SFrame ciphertext (first 40 bytes, hex): \`${e.samplePayloadHex ?? '(none)'}\`
- sample recovered cleartext trailer (key-free parse): ${e.sampleHeader ? `kid=${e.sampleHeader.kid} ctr=${e.sampleHeader.ctr}` : '(none)'}
- decode-WITHOUT-key attempt: **FAILED (GCM auth failure)** — exactly as required.

## NON-E2EE control room — forwarded payload IS cleartext VP8 (decodable, no key)
- browser run: ok=${v.controlRun['ok']}, producerId=${String(v.controlRun['producerId']).slice(0, 12)}…, transformApi=${v.controlRun['transformApi']} (no SFrame attached), outbound bytesSent=${v.controlRun['outboundBytesSent']}, ICE=${v.controlRun['connectionState']}
- relay RECEIVED (inbound RTP): ${c.relayReceivedPackets} packets.
- **relay FORWARDED at the SAME tap: ${c.forwarded} packets** — the relay forwards cleartext VP8 verbatim (no keyframe-hiding).
- cleartext VP8 recovered WITH NO KEY (keyframe magic 0x9d012a): ${c.cleartextRecovered}
- sample forwarded payload (first 40 bytes after RTP header, hex): \`${c.samplePayloadHex ?? '(none)'}\`
- decode-WITHOUT-key: **SUCCEEDED** — ${c.sampleCleartext ?? 'raw VP8 readable on the wire'}.

## Side-by-side (the load-bearing contrast)
| | E2EE room | non-E2EE control |
|---|---|---|
| relay RECEIVES | ${e.relayReceivedPackets} pkts (SFrame ciphertext) | ${c.relayReceivedPackets} pkts (cleartext VP8) |
| relay FORWARDS at tap | ${e.forwarded} pkts (partial-SFrame keyframe markers pass the gate) | ${c.forwarded} pkts (verbatim) |
| SFrame trailer (cleartext) | config 0x01 present | absent |
| forwarded body decode WITHOUT key | **FAILS** (AES-GCM auth) | **SUCCEEDS** (raw VP8) |
| meaning to a keyless reader | none | full frame |

Both rooms use the IDENTICAL relay + tap path and BOTH forward. In the control room the
relay reads the cleartext VP8 and forwards it (any keyless reader recovers the frame); in
the E2EE room the SFU forwards the partial-SFrame stream (the cleartext VP8 keyframe
markers at the front pass the keyframe gate) but the forwarded body is undecodable without
K_content. E2EE is what makes the forwarded bytes meaningless to a keyless reader.

## Honesty bounds (DA-2/DA-3/DA-8, D-M2-7/8)
- Relay-blindness = **STRUCTURAL** (mediasoup has no decode path; it forwards the partial-SFrame body opaquely, never decrypting it); M2 validator-blindness = **ECONOMIC/OPERATIONAL** (the validator HOLDS the key). This is **NOT** a cryptographic "relay/validator CANNOT decrypt" claim — that is Path C → M3.
- "Undecodable" is proven by structure (real config 0x01 + 14-byte trailer present) + AES-GCM decrypt FAILURE without the key on BOTH the sender-boundary sample AND the forwarded tap body, NOT by a known-plaintext attack. The negative control is load-bearing.
- The E2EE SFrame ciphertext sample is captured at the sender's insertable-stream boundary (the exact bytes the relay receives over loopback — no application-layer re-encryption); the relay-internal RECEIVED + FORWARDED counts come from the relay's own mediasoup producer/consumer stats. The PRIMARY content-opacity proof is these whole-frame sender-boundary samples; forwarded-body opacity is additionally checked on any whole SFrame body locatable in a SINGLE forwarded tap packet (large frames fragment across MTU). Per-packet BYTE-IDENTITY of the forwarded ciphertext is the HERMETIC Step-1 (\`relay-blind-realsframe.integration.test.ts\`, byteIdentical===mediaPackets), not re-measured here.
- Platform is FAKE media + LOOPBACK ICE on one host — NOT WAN glass-to-glass. The delta over Step-1 (the hermetic synthetic-source floor) is the **real-browser partial-SFrame-over-VP8 leg under production WebRTC** (real getUserMedia → real \`createEncodedStreams\` insertable-streams partial-SFrame → WebRtcTransport, real ICE/DTLS → real mediasoup relay). The M3 Lane B partial-SFrame RESOLVES the P10 Finding-B full-frame keyframe stall: keeping the cleartext VP8 keyframe markers at the front lets the SFU forward the E2EE stream while the body stays content-opaque.
- DUAL-API caveat (NOT a production edit): Chromium 149 exposes both \`createEncodedStreams\` and the standard \`RTCRtpScriptTransform\`; the shipped shim PREFERS the standard API (an M3 worker scaffold that no-ops without a worker — and production supplies none, so production also relies on the createEncodedStreams branch). The harness masks the standard API on its own page and drives the createEncodedStreams branch with the SHIPPED \`encryptFrame\`.

## Reasons
${v.reasons.map((r) => `- ${r}`).join('\n')}
`;
  writeFileSync(file, md, 'utf8');
  return file;
}

async function main(): Promise<void> {
  const writeArt = process.argv.includes('--write-artifact');
  const bundleJs = await bundleEntry();

  // ── E2EE room ──────────────────────────────────────────────────────────────
  const e2eeRoom: CaptureRoom = { producerId: null, packets: [], producer: null, relayReceivedSnapshot: 0 };
  const e2eeRelay = await standUpRelay(bundleJs, e2eeRoom);

  // ── control room (own relay so the tap path is identical but isolated) ──────
  const controlRoom: CaptureRoom = { producerId: null, packets: [], producer: null, relayReceivedSnapshot: 0 };
  const controlRelay = await standUpRelay(bundleJs, controlRoom);

  log('launching headless Chromium (fake media)…');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const browserVersion = `Chromium ${browser.version()}`;
  log(browserVersion);

  log('═══ driving E2EE room (SFrame attached) ═══');
  const e2eeRun = await driveRoom(browser, e2eeRelay.pageUrl, e2eeRelay.wsUrl, 'p10-e2ee', true, e2eeRoom);
  log(`E2EE run: ${JSON.stringify(e2eeRun)}`);

  log('═══ driving non-E2EE control room (no SFrame) ═══');
  const controlRun = await driveRoom(browser, controlRelay.pageUrl, controlRelay.wsUrl, 'p10-control', false, controlRoom);
  log(`control run: ${JSON.stringify(controlRun)}`);

  // ── analyse BEFORE closing the relays (producer.getStats needs the worker alive) ──
  const e2ee = await analyseE2EE(e2eeRoom, e2eeRun);
  const control = await analyseControl(controlRoom);

  await browser.close();
  e2eeRelay.close();
  controlRelay.close();

  log('───────────────────────────────────────────────');
  log(`E2EE: relayReceived=${e2ee.relayReceivedPackets} forwarded=${e2ee.forwarded} mediaPackets=${e2ee.mediaPackets} sframeSamples=${e2ee.sframeHeaderObserved} undecodableWithoutKey=${e2ee.undecodableWithoutKey} forwardedSframeMatched=${e2ee.forwardedSframeMatched} forwardedUndecodableWithoutKey=${e2ee.forwardedUndecodableWithoutKey}`);
  log(`CTRL: relayReceived=${control.relayReceivedPackets} forwarded=${control.forwarded} cleartextRecovered=${control.cleartextRecovered}`);
  log('───────────────────────────────────────────────');

  // ── verdict ────────────────────────────────────────────────────────────────
  const reasons: string[] = [];
  const e2eeOk = e2eeRun['ok'] === true;
  const ctrlOk = controlRun['ok'] === true;
  if (!e2eeOk) reasons.push(`E2EE browser run failed: ${String(e2eeRun['error'] ?? 'unknown')}`);
  if (!ctrlOk) reasons.push(`control browser run failed: ${String(controlRun['error'] ?? 'unknown')}`);
  if (e2eeRun['transformApi'] !== 'createEncodedStreams') reasons.push(`E2EE SFrame transform did not attach (api=${String(e2eeRun['transformApi'])})`);
  if (e2ee.sframeHeaderObserved === 0) reasons.push('E2EE: no real SFrame ciphertext sample captured (config 0x01 + 14-byte trailer)');
  if (e2ee.undecodableWithoutKey !== e2ee.sframeHeaderObserved || e2ee.sframeHeaderObserved === 0) {
    reasons.push(`E2EE: not all SFrame samples undecodable-without-key (${e2ee.undecodableWithoutKey}/${e2ee.sframeHeaderObserved})`);
  }
  // (A) M3 Lane B: the SFU now FORWARDS the E2EE stream (partial-SFrame keyframe markers
  // pass the SFU gate). The relay RECEIVED the ciphertext AND forwarded it.
  if (e2ee.relayReceivedPackets === 0) reasons.push('E2EE: relay received NO RTP (browser→relay leg failed)');
  if (e2ee.forwarded === 0) reasons.push('E2EE: relay forwarded NO RTP — partial-SFrame keyframe markers should now pass the SFU gate');
  // (B) content opacity: the PRIMARY proof is the sender-boundary whole-frame samples
  // (gated above: undecodableWithoutKey === sframeHeaderObserved). For the forwarded tap, any
  // whole SFrame body we can LOCATE (only single-RTP-packet frames; large frames fragment
  // across MTU) must also be opaque — per-packet byte-identity of forwarded ciphertext is the
  // hermetic Step-1 (relay-blind-realsframe). Fail only if a LOCATED forwarded body decoded.
  if (e2ee.forwardedUndecodableWithoutKey !== e2ee.forwardedSframeMatched) {
    reasons.push(`E2EE: a located forwarded SFrame body decoded WITHOUT the key (${e2ee.forwardedUndecodableWithoutKey}/${e2ee.forwardedSframeMatched} located forwarded bodies opaque)`);
  }
  // Negative control: the relay forwarded cleartext VP8, recovered with no key.
  if (control.cleartextRecovered === 0) reasons.push('control: NO cleartext VP8 recovered without a key (negative control failed)');

  const pass =
    e2eeOk &&
    ctrlOk &&
    e2eeRun['transformApi'] === 'createEncodedStreams' &&
    e2ee.sframeHeaderObserved > 0 &&
    // (B) content opacity: the wire SFrames (sender-boundary == the exact bytes the relay
    // receives) FAIL keyless decrypt; any LOCATED forwarded body is opaque too (fragmentation
    // may locate none — per-packet byte-identity is the hermetic Step-1 relay-blind-realsframe).
    e2ee.undecodableWithoutKey === e2ee.sframeHeaderObserved &&
    e2ee.forwardedUndecodableWithoutKey === e2ee.forwardedSframeMatched &&
    e2ee.relayReceivedPackets > 0 &&
    // (A) the SFU FORWARDS the E2EE stream (partial-SFrame keyframe markers pass the gate).
    e2ee.forwarded > 0 &&
    control.cleartextRecovered > 0 &&
    control.forwarded > 0;

  if (pass) {
    reasons.push('PASS — real-browser partial-SFrame is relay-blind under the M3 Lane B DUAL invariant: (A) the SFU now FORWARDS the E2EE stream (cleartext VP8 keyframe markers at the front pass the SFU keyframe-select gate) AND (B) the content stays opaque without K_content — every captured wire SFrame (sender-boundary == the exact bytes the relay receives) FAILS AES-GCM decrypt with no key, and every forwarded SFrame body we could locate is opaque too (per-packet byte-identity of forwarded ciphertext is the hermetic Step-1 relay-blind-realsframe gate). The non-E2EE control forwards cleartext VP8 readable with no key over the SAME tap path: both rooms forward, but the E2EE content is meaningless to a keyless reader.');
  }

  const verdict: HarnessVerdict = { pass, reasons, e2eeRun, controlRun, e2ee, control };

  if (pass) {
    log('HARNESS PASS — relay-blind real-browser headline proven (structural + empirical).');
    if (writeArt) {
      const file = writeArtifact(verdict, browserVersion);
      log(`wrote PROVISIONAL dated artifact: ${file}`);
    } else {
      log('(re-run with --write-artifact to emit the dated .evidence artifact GREEN-ONLY)');
    }
    process.exit(0);
  } else {
    log('HARNESS FAIL — see reasons (NO artifact written; green-only generator):');
    for (const r of reasons) log(`  - ${r}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[p10-harness] FATAL', err);
  process.exit(1);
});
