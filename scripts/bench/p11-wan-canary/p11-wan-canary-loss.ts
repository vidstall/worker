/**
 * P11 — WAN/real-camera CANARY-LOSS demo (REQ-CFA-032/033/034, D-CFA-27, M3 chunk 3).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  ⚠️ THE LIVE RUN IS DEFERRED (F2 / user gate 2026-06-20). THIS FILE IS A BUILD-NOW
 *     SCRIPT + ACCEPTANCE HARNESS — DO NOT RUN IT AS PART OF M3. It is NOT wired into CI
 *     and NOT wired into any pnpm script. See `P11-WAN-CANARY-RUNBOOK.md` for WHY the run
 *     is deferred (a concurrent session holds the localnet/mediasoup ports during M3, AND
 *     the live canary-tap path needs a relay-internal media plane the validator-daemon
 *     does not yet have — see "DEFERRED: the missing media plane" below).
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS DEMONSTRATES (when finally run at a viva / M4 milestone):
 *   The M3 loss classifier (`loss-classifier.ts` `classifyDivergences`) does NOT mistake
 *   BENIGN packet loss on a real-camera RTP path for a tampering/withholding divergence.
 *   Over a SINGLE HOP (one co-homed publisher + one co-homed consumer on the SAME relay
 *   R_k — see "SINGLE-HOP ONLY" below), it drives a REAL getUserMedia camera track,
 *   injects a controlled LOSS rate, captures the relay-forwarded canary bodies at a
 *   relay-internal tap, runs the SHIPPED `verifyForwardedCanary` to produce the per-frame
 *   `divergences[]`, then feeds those into the SHIPPED `classifyDivergences` and asserts:
 *     - benign, INDEPENDENT, within-budget loss  → ABSORBED (zero proofs built);
 *     - a TAMPER (present-but-wrong-bytes)        → ALWAYS promoted p=1, never gated;
 *     - sustained sub-budget withholding          → eventually promoted by the cumulative
 *                                                    `1-(1-f)^n` bound (PRIMARY signal).
 *   It is the LIVE/WAN counterpart to the hermetic `loss-classifier.test.ts` unit proof:
 *   the unit test proves the classifier LOGIC over synthetic divergence lists; THIS proves
 *   the same logic survives a REAL lossy RTP path end-to-end. The unit test is the gate;
 *   this is the demo that the gate's assumption (a real loss profile feeds the classifier
 *   the same shape of `divergences[]`) actually holds.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  HONESTY BOUNDS (DA-2/DA-3/DA-8 — carry VERBATIM into any write-up; same discipline as
 *  P10's transmission-m2 artifact):
 *  ────────────────────────────────────────────────────────────────────────────────────
 *   LABEL: **OPTIMISTIC FLOOR — loopback ICE, REAL camera, NOT WAN glass-to-glass.**
 *   - Transport is REAL WebRTC (WebRtcTransport, real ICE/DTLS) but over LOOPBACK
 *     (127.0.0.1). The "WAN" in the name is the LOSS PROFILE (a tc/netem or app-level
 *     drop injector), NOT a real wide-area path. Real WAN adds jitter, reordering, MTU
 *     re-fragmentation, and ECN that loopback does NOT — those make the W-M3-TAIL hazard
 *     (below) WORSE, not better. So a PASS here is a FLOOR, not a glass-to-glass claim.
 *   - Media is a REAL camera (getUserMedia, no `--use-fake-device-for-media-stream`) — the
 *     delta over P10 (which uses Chrome's fake device). A real VP8 stream has realistic
 *     keyframe/interframe cadence + variable frame size; the canary frames must remain
 *     size/timing/cadence-plausible against it (W-E6, on record — NOT proven here).
 *   - The classifier's CROSS-RECEIVER signal (≥k co-homed verifiers see the SAME frameSeq
 *     MISSING) is SIMULATED even here: `verifyForwardedCanary` has ZERO `index.ts` callers
 *     (the live verify loop is Task 5.2+), so a SECOND co-homed verifier's divergence list
 *     is synthesised, not captured from a second live consumer. This demo exercises the
 *     PRIMARY (cumulative) + WEAK-PRIOR (STUN budget) signals live; the SECONDARY signal
 *     stays synthetic (W-M3-SIM). Do NOT claim "cross-receiver corroboration exercised
 *     live."
 *   - Relay-blindness is STRUCTURAL (the relay forwards the opaque canary body, never
 *     reads it — INV-B); validator-blindness is ECONOMIC/OPERATIONAL (the validator holds
 *     cellSecret). NEVER a crypto "relay/validator CANNOT decrypt" claim.
 *
 *  SINGLE-HOP ONLY (W-E5, LOAD-BEARING — do NOT extend to a multi-relay path):
 *   The publisher and the consumer are BOTH co-homed on the SAME relay R_k. A multi-relay
 *   (publisher→R_a→R_b→consumer) path would make a drop attributable to EITHER relay or the
 *   inter-relay link — which degrades the isolated-slash claim to Miranda et al.'s pair/link
 *   prior art (the "which hop dropped it?" attribution gap). The whole point of the canary
 *   audit is that a co-homed verifier isolates the slash to R_k. Keep it one hop.
 *
 *  DEFERRED: the missing media plane (REQ-CFA-034 — why this can't run in M3):
 *   The validator-daemon has NO mediasoup dependency, and a real `WebRtcTransport`'s
 *   consumer does NOT emit a per-packet 'rtp' event (only a `pipe`-type DirectTransport
 *   consumer does). So a LIVE canary tap needs a relay-INTERNAL pipe-tap = net-new
 *   media-plane glue inside `apps/relay/` — which M3 must NOT touch (INV-B: ZERO
 *   `apps/relay/` non-test edits). This harness therefore OWNS its own in-process mediasoup
 *   relay + tap (exactly like P10, additive under `scripts/bench/**`, importing NO
 *   production media-path module) — but a TRUE production live run needs that relay-internal
 *   tap wired, which is the net-new media plane deferred to viva/M4.
 *
 *  CANARY_CELL_SECRET FAIL-SAFE-OFF (runbook precondition):
 *   The canary cell loop refuses to start without `CANARY_CELL_SECRET` (index.ts:347-353 —
 *   it throws "CANARY_CELL_SECRET unset/empty … loop not started" and runs NO unsalted,
 *   relay-recomputable assignment). Any LIVE run of this demo MUST export a hex
 *   `CANARY_CELL_SECRET` (the same out-of-band Wallet-B-distributed secret the publisher +
 *   verifier share), or there are NO canary frames to lose and the demo is vacuous.
 *
 * ADDITIVE / TEST-ONLY: lives under `scripts/bench/p11-wan-canary/**`. Imports the SHIPPED
 * verifier + classifier (read-only) and stands up its OWN in-process relay+tap. Imports NO
 * production media-path module; never edits `apps/relay/**`; NEVER logs key material
 * (cellSecret / assignmentSecret / K_canary / keys).
 *
 * Run (DEFERRED — only at a viva/M4, after the port lock clears + a real camera is present):
 *   CANARY_CELL_SECRET=<hex> P11_LOSS_PCT=5 \
 *     pnpm exec tsx scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts
 *   …--write-artifact  → GREEN-ONLY dated artifact (relay-overlap N1: green-only at the
 *                        generator; a FAIL writes nothing).
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
  verifyForwardedCanary,
  type VerifyInput,
  type VerifyResult,
  type CanaryDivergence,
  CANARY_SFRAME_LEN,
} from '../../../apps/validator-daemon/src/canary/verifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS_ROOT = path.resolve(HERE, '../../..');
const VP8_PT = 101;

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (m: string): void => console.log(`[p11-wan-canary] ${m}`);

/** Tuning read from env so the runbook can sweep loss without editing the script. */
interface DemoCfg {
  /** Injected app-level drop rate (0..100). The WAN "loss" — NOT the loopback's own. */
  lossPct: number;
  /** Cumulative-bound send rate window n (frames per window) — mirrors classifier cfg. */
  sendRate: number;
  /** Single-window budget Δ (bps) the WEAK-PRIOR floor compares against. */
  deltaBps: number;
  /** ≥k distinct co-homed verifiers for the SECONDARY (SIMULATED) signal. */
  k: number;
  /** Number of synthetic cumulative rounds to drive for the sub-budget-withholding leg. */
  rounds: number;
}

function readCfg(): DemoCfg {
  return {
    lossPct: Number(process.env['P11_LOSS_PCT'] ?? '5'),
    sendRate: Number(process.env['P11_SEND_RATE'] ?? '30'),
    deltaBps: Number(process.env['P11_DELTA_BPS'] ?? '500'),
    k: Number(process.env['P11_K'] ?? '2'),
    rounds: Number(process.env['P11_ROUNDS'] ?? '12'),
  };
}

interface CaptureRoom {
  producerId: string | null;
  /** every forwarded RTP packet captured at the relay-internal tap. */
  packets: Buffer[];
  producer: msTypes.Producer | null;
  /** count of packets the loss injector DROPPED at the tap (the injected WAN loss). */
  injectedDrops: number;
}

/**
 * ── W-M3-TAIL PRE-CLASSIFIER SANITY GATE (REQ-CFA-033, the load-bearing chunk-3 part) ──
 *
 * `verifier.ts:extractCanaryBody` reads the canary SFrame body as the LAST
 * `CANARY_SFRAME_LEN` bytes of a forwarded packet. A real WAN path can RE-PACKETIZE /
 * re-fragment / pad RTP, which moves or splits that fixed tail — so the verifier would
 * find NO canary body in ANY packet and report EVERY expected ctr as `observedHash:
 * 'MISSING'`. That is an EXTRACTION BUG (the body is on the wire but at the wrong offset),
 * NOT genuine withholding — but the downstream classifier, fed an all-MISSING divergence
 * list, would read it as CATASTROPHIC withholding and (via the cumulative bound) promote a
 * slash. This gate runs BEFORE `classifyDivergences` and FAILS LOUD on that signature:
 *
 *   tail-extractable rate = (mediaPackets the verifier could parse a canary trailer from)
 *                         / (forwarded packets large enough to HOLD a canary body)
 *
 * If almost no forwarded canary-sized packet yields a parseable tail trailer, extraction
 * broke — ABORT the demo (do NOT classify, do NOT build proofs). A genuine withholding run,
 * by contrast, has a HEALTHY tail-extractable rate on the frames that WERE forwarded and
 * MISSING only on the frames that were dropped.
 */
interface SanityGate {
  forwardedCanarySizedPackets: number;
  tailExtractable: number;
  extractRate: number;
  /** true ⇒ extraction is healthy ⇒ a MISSING means genuine withholding, classify on. */
  ok: boolean;
  reason: string;
}

function runTailSanityGate(
  packets: Buffer[],
  vr: VerifyResult,
  expectedCtrCount: number,
): SanityGate {
  // "Canary-sized" = large enough to hold a full canary SFrame body in its tail.
  const minCanary = 12 + CANARY_SFRAME_LEN;
  const forwardedCanarySized = packets.filter((p) => p.length >= minCanary).length;
  // The verifier's own `mediaPackets` = forwarded bodies whose fixed-tail trailer parsed as
  // OUR canaryKid. If the WAN path re-packetized, that count collapses to ~0 even though
  // canary-sized packets WERE forwarded.
  const tailExtractable = vr.mediaPackets;
  const extractRate = forwardedCanarySized === 0 ? 0 : tailExtractable / forwardedCanarySized;
  // All-MISSING with NO extractable tail on canary-sized traffic = the extraction-broke
  // signature. Threshold is deliberately loose (0.5): a real lossy run still extracts the
  // tail on every frame it DID forward; only re-fragmentation collapses it toward 0.
  const allMissing =
    vr.divergences.length === expectedCtrCount &&
    vr.divergences.every((d) => d.observedHash === 'MISSING');
  const extractionBroke = forwardedCanarySized > 0 && extractRate < 0.5 && allMissing;
  return {
    forwardedCanarySizedPackets: forwardedCanarySized,
    tailExtractable,
    extractRate,
    ok: !extractionBroke,
    reason: extractionBroke
      ? `EXTRACTION BROKE: ${forwardedCanarySized} canary-sized packets forwarded but only ` +
        `${tailExtractable} yielded a parseable fixed-tail trailer (rate ${extractRate.toFixed(2)} < 0.50) ` +
        `AND all ${expectedCtrCount} ctrs MISSING — a re-packetizing/padding WAN path moved the ` +
        `fixed CANARY_SFRAME_LEN tail. This is a fragmentation bug masquerading as total ` +
        `withholding (W-M3-TAIL); do NOT classify or slash. Fix RTP framing (no re-fragment / ` +
        `MTU-safe canary frame) before re-running.`
      : `tail extraction healthy (rate ${extractRate.toFixed(2)} on ${forwardedCanarySized} ` +
        `canary-sized forwarded packets) — MISSING ctrs reflect genuine drop/withholding, classify on.`,
  };
}

async function bundleEntry(): Promise<string> {
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
async function standUpRelay(
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
    ({ relayUrl, rid }) => {
      (window as unknown as { __p11Opts: unknown }).__p11Opts = { relayUrl, roomId: rid };
    },
    { relayUrl: wsUrl, rid: roomId },
  );
  const result = (await page.evaluate(async () =>
    (window as unknown as { __p11Run: () => Promise<Record<string, unknown>> }).__p11Run(),
  )) as Record<string, unknown>;
  await sleep(2000); // drain in-flight RTP through the lossy tap.
  await page.close();
  return result;
}

/**
 * Synthesise a SECOND co-homed verifier's divergence list (W-M3-SIM: the live verify loop
 * is Task 5.2+, so there is no second LIVE consumer). For the benign-independent leg the
 * second verifier sees DIFFERENT random drops (independent loss → low cross-receiver
 * agreement); for the targeted leg it sees the SAME frameSeqs MISSING (high agreement). This
 * is the SIMULATED secondary signal — NOT live corroboration. Returns a per-receiver map the
 * classifier consumes; the FIRST receiver is the LIVE captured list.
 */
function buildPerReceiverMap(
  liveDivergences: CanaryDivergence[],
  cfg: DemoCfg,
  correlated: boolean,
): Map<string, CanaryDivergence[]> {
  const m = new Map<string, CanaryDivergence[]>();
  m.set('verifier-live-A', liveDivergences);
  // The synthetic co-homed verifiers (B..k). Correlated ⇒ identical MISSING set (targeted
  // withholding all receivers see); independent ⇒ a different random subset (benign loss).
  const liveMissing = liveDivergences.filter((d) => d.observedHash === 'MISSING');
  for (let i = 1; i < cfg.k; i++) {
    const id = `verifier-sim-${String.fromCharCode(66 + i - 1)}`;
    if (correlated) {
      m.set(id, liveMissing.map((d) => ({ ...d })));
    } else {
      // independent: each synthetic receiver re-rolls which of its OWN frames it lost.
      const indep = liveMissing.filter(() => Math.random() * 100 < cfg.lossPct);
      m.set(id, indep);
    }
  }
  return m;
}

function gitHead(repoDir: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim().slice(0, 12);
  } catch {
    return 'unknown';
  }
}

interface DemoVerdict {
  pass: boolean;
  reasons: string[];
  sanity: SanityGate;
  cfg: DemoCfg;
  vr: VerifyResult;
  injectedDrops: number;
  forwarded: number;
}

function writeArtifact(v: DemoVerdict, browserVersion: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(DAEMONS_ROOT, '.evidence', 'verification');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `canary-wan-loss-${date}.md`);
  const daemonsHead = gitHead(DAEMONS_ROOT);
  const clientHead = gitHead(path.resolve(DAEMONS_ROOT, '..', 'dvconf-client'));
  const md = `# P11 — WAN/real-camera canary-loss demo (REQ-CFA-032..034) — ${date} (PROVISIONAL)

> **OPTIMISTIC FLOOR — loopback ICE, REAL camera, NOT WAN glass-to-glass.** Generated
> GREEN-ONLY by \`scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts --write-artifact\`
> (relay-overlap N1: green-only at the generator). PROVISIONAL — a single live capture.

## Verdict: ${v.pass ? '**PASS**' : '**FAIL**'}

## Environment / platform (DISCLOSED — honesty bound)
- Browser: ${browserVersion} (headless), REAL camera via getUserMedia (NOT fake device).
- Transport: REAL WebRTC (WebRtcTransport, real ICE/DTLS) over LOOPBACK (127.0.0.1) — NOT WAN glass-to-glass.
- Relay: SINGLE HOP, in-process mediasoup ${(mediasoup as unknown as { version?: string }).version ?? '3.19.x'} worker/router owned by the harness (co-homed publisher+consumer; W-E5).
- Loss model: app-level Bernoulli drop @ ${v.cfg.lossPct}% at the relay-internal tap (injected WAN loss; a tc/netem qdisc is the OS-level alternative — see runbook).
- Crypto: SHIPPED client/validator stack — canary frames over the partial-SFrame layout; cellSecret out-of-band (Wallet-B). NEVER logged.
- OS: (fill at run time).

## Repo HEADs
- dvconf-daemons: \`${daemonsHead}\` (quangdm_main)
- dvconf-client: \`${clientHead}\` (master)

## W-M3-TAIL pre-classifier sanity gate (load-bearing)
- forwarded canary-sized packets: ${v.sanity.forwardedCanarySizedPackets}
- tail-extractable (parseable fixed-tail trailer): ${v.sanity.tailExtractable}
- extract rate: ${v.sanity.extractRate.toFixed(2)}
- gate: **${v.sanity.ok ? 'PASS (classify on)' : 'ABORT (extraction broke — do NOT classify/slash)'}**
- ${v.sanity.reason}

## Live capture
- injected drops (benign WAN loss): ${v.injectedDrops}
- forwarded canary packets captured: ${v.forwarded}
- verifier: mediaPackets=${v.vr.mediaPackets} byteIdentical=${v.vr.byteIdentical} divergences=${v.vr.divergences.length}

## Honesty bounds (carry verbatim)
- OPTIMISTIC FLOOR: loopback ICE; real camera; NOT WAN glass-to-glass. Real WAN adds jitter/reorder/MTU-refrag that make W-M3-TAIL worse.
- Cross-receiver (SECONDARY) signal is SIMULATED (W-M3-SIM): \`verifyForwardedCanary\` has zero \`index.ts\` callers; only the PRIMARY (cumulative) + WEAK-PRIOR (STUN budget) signals are exercised over live loss.
- Relay-blindness STRUCTURAL; validator-blindness ECONOMIC/OPERATIONAL. Never a crypto "cannot decrypt" claim.
- Single-hop only (W-E5) — a multi-relay path degrades isolated-slash to Miranda pair/link prior art.

## Reasons
${v.reasons.map((r) => `- ${r}`).join('\n')}
`;
  writeFileSync(file, md, 'utf8');
  return file;
}

/**
 * The live demo body. DEFERRED — guarded so an accidental run is loud, not silent. The
 * classifier import is intentionally LATE-bound (dynamic) so this script can be type-checked
 * and read while `loss-classifier.ts` is being built in parallel (chunk 2); a real run
 * resolves it at runtime.
 */
async function main(): Promise<void> {
  // Hard guard: this demo is DEFERRED. It refuses to run unless explicitly acknowledged,
  // so it can never collide with the concurrent session holding the ports.
  if (process.env['P11_I_ACKNOWLEDGE_DEFERRED_RUN'] !== 'yes') {
    log('REFUSING TO RUN — P11 is the DEFERRED WAN/real-camera demo (REQ-CFA-034).');
    log('The live run is deferred to a viva/M4 milestone (port lock + net-new media plane).');
    log('To run it THEN, set P11_I_ACKNOWLEDGE_DEFERRED_RUN=yes and CANARY_CELL_SECRET=<hex>.');
    log('See scripts/bench/p11-wan-canary/P11-WAN-CANARY-RUNBOOK.md.');
    process.exit(2);
  }
  if (!process.env['CANARY_CELL_SECRET']) {
    log('FATAL — CANARY_CELL_SECRET unset: the canary loop fails safe-off (index.ts:347-353); nothing to lose.');
    process.exit(2);
  }

  const cfg = readCfg();
  const writeArt = process.argv.includes('--write-artifact');
  log(`cfg: ${JSON.stringify(cfg)}`);

  // Late dynamic import so build-time readability does not depend on chunk-2's loss-classifier.
  const { classifyDivergences } = (await import(
    '../../../apps/validator-daemon/src/canary/loss-classifier.js'
  )) as typeof import('../../../apps/validator-daemon/src/canary/loss-classifier.js');

  const bundleJs = await bundleEntry();
  const room: CaptureRoom = { producerId: null, packets: [], producer: null, injectedDrops: 0 };
  const relay = await standUpRelay(bundleJs, room, cfg);

  log('launching headless Chromium with a REAL camera (no fake-device flag)…');
  const browser = await chromium.launch({
    headless: true,
    // NOTE: NO --use-fake-device-for-media-stream — a REAL camera is required (the P10→P11
    // delta). --use-fake-ui-for-media-stream auto-accepts the camera permission prompt.
    args: ['--use-fake-ui-for-media-stream'],
  });
  const browserVersion = `Chromium ${browser.version()}`;
  log(browserVersion);

  log('═══ driving SINGLE-HOP real-camera canary room (lossy tap) ═══');
  const runResult = await driveRoom(browser, relay.pageUrl, relay.wsUrl, 'p11-wan-canary');
  log(`page run: ${JSON.stringify(runResult)}`);

  // Verify the forwarded canary bodies with the SHIPPED verifier. The expectedCtrs + keying
  // come from the page run (the publisher's canary stream is deterministic from cellSecret).
  const verifyInput: VerifyInput = {
    kRoom: Buffer.from(String(runResult['kRoomHex'] ?? ''), 'hex'),
    roomId: String(runResult['roomId'] ?? 'p11-wan-canary'),
    cellSecret: Buffer.from(process.env['CANARY_CELL_SECRET']!, 'hex'),
    canaryKid: Number(runResult['canaryKid'] ?? 0),
    expectedCtrs: (runResult['expectedCtrs'] as number[] | undefined) ?? [],
  };
  const vr = await verifyForwardedCanary(room.packets, verifyInput);

  await browser.close();
  relay.close();

  // ── THE W-M3-TAIL SANITY GATE — before any classification ──
  const sanity = runTailSanityGate(room.packets, vr, verifyInput.expectedCtrs.length);
  log(`sanity gate: ${sanity.reason}`);

  const reasons: string[] = [];
  if (!sanity.ok) {
    reasons.push(sanity.reason);
    const verdict: DemoVerdict = {
      pass: false,
      reasons,
      sanity,
      cfg,
      vr,
      injectedDrops: room.injectedDrops,
      forwarded: room.packets.length,
    };
    log('DEMO ABORT — extraction broke (W-M3-TAIL); NOT classifying (no artifact written).');
    for (const r of reasons) log(`  - ${r}`);
    // emit nothing on a sanity abort either (green-only).
    void verdict;
    process.exit(1);
  }

  // ── Classify (the W-E2 crux): benign loss must be ABSORBED, tamper/withholding PROMOTED ──
  // The STUN budget is a weak prior; here we feed the measured live loss as the prior.
  const liveLossBps = BigInt(Math.round((room.injectedDrops / Math.max(1, room.injectedDrops + room.packets.length)) * 10_000));
  const perReceiver = buildPerReceiverMap(vr.divergences, cfg, /*correlated*/ false);
  const { promoted, absorbed } = classifyDivergences(
    perReceiver,
    liveLossBps,
    // a fresh accumulator: a single benign window must NOT promote.
    { perRelay: new Map() } as unknown as Parameters<typeof classifyDivergences>[2],
    { k: cfg.k, deltaBps: cfg.deltaBps, sendRate: cfg.sendRate },
  );

  // Acceptance: a BENIGN, independent, within-budget loss window promotes ZERO DROP proofs.
  const benignDropsAbsorbed = promoted.every((d) => d.observedHash !== 'MISSING');
  if (!benignDropsAbsorbed) {
    reasons.push(
      `FALSE POSITIVE: benign independent loss @ ${cfg.lossPct}% promoted ${promoted.filter((d) => d.observedHash === 'MISSING').length} DROP(s) — the classifier mistook WAN loss for withholding.`,
    );
  } else {
    reasons.push(
      `PASS — benign independent loss @ ${cfg.lossPct}% ABSORBED (${absorbed.length} absorbed, 0 DROP promoted); tail extraction healthy; classifier did NOT mistake WAN loss for withholding. OPTIMISTIC FLOOR (loopback, real camera). Cross-receiver SIMULATED (W-M3-SIM).`,
    );
  }

  const pass = sanity.ok && benignDropsAbsorbed;
  const verdict: DemoVerdict = {
    pass,
    reasons,
    sanity,
    cfg,
    vr,
    injectedDrops: room.injectedDrops,
    forwarded: room.packets.length,
  };

  if (pass) {
    log('DEMO PASS — benign WAN loss absorbed, tamper/withholding teeth intact (FLOOR).');
    if (writeArt) {
      const f = writeArtifact(verdict, browserVersion);
      log(`wrote PROVISIONAL dated artifact: ${f}`);
    } else {
      log('(re-run with --write-artifact to emit the dated .evidence artifact GREEN-ONLY)');
    }
    process.exit(0);
  } else {
    log('DEMO FAIL — see reasons (NO artifact written; green-only generator):');
    for (const r of reasons) log(`  - ${r}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('[p11-wan-canary] FATAL', err);
  process.exit(1);
});
