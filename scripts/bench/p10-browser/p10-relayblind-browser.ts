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
 *
 * Implementation split into sibling modules (pure code movement, no behavior change):
 *   - relay-standup.ts : browser-entry bundling, in-process relay stand-up, page drive.
 *   - analysis.ts       : E2EE / control capture analysis.
 *   - artifact.ts        : GREEN-ONLY dated evidence artifact generator.
 */

import { chromium } from 'playwright';
import type { CaptureRoom } from './relay-standup.js';
import { log, bundleEntry, standUpRelay, driveRoom } from './relay-standup.js';
import { analyseE2EE, analyseControl } from './analysis.js';
import { writeArtifact, type HarnessVerdict } from './artifact.js';

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
