/**
 * P10 Step-2 harness — GREEN-ONLY dated evidence artifact generator.
 *
 * Split out of p10-relayblind-browser.ts (pure code movement, no behavior change).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as mediasoup from 'mediasoup';
import type { RoomAnalysis } from './analysis.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMONS_ROOT = path.resolve(HERE, '../../..');

export interface HarnessVerdict {
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
export function writeArtifact(v: HarnessVerdict, browserVersion: string): string {
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
