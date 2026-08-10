/**
 * P11 WAN canary — verdict shape + the dated .evidence artifact writer. Split out of
 * `p11-wan-canary-loss.ts` (pure code movement — see that file's header for the full demo
 * context / honesty bounds; nothing here changes behavior).
 */

import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as mediasoup from 'mediasoup';
import type { VerifyResult } from '../../../apps/validator-daemon/src/canary/verifier.js';
import { DAEMONS_ROOT } from './relay-standup.js';
import type { DemoCfg, SanityGate } from './config-gate.js';

function gitHead(repoDir: string): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim().slice(0, 12);
  } catch {
    return 'unknown';
  }
}

export interface DemoVerdict {
  pass: boolean;
  reasons: string[];
  sanity: SanityGate;
  cfg: DemoCfg;
  vr: VerifyResult;
  injectedDrops: number;
  forwarded: number;
}

export function writeArtifact(v: DemoVerdict, browserVersion: string): string {
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
