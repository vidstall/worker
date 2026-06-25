/**
 * M2b-live-WAN Sub-lane B / Part-1 (B-hermetic) — Task 4A, REQ-MLW-B-05/06/09. The HERMETIC
 * (chain-free) full-cast component proof: a REAL headless-Chromium canary does a REAL signaling
 * JOIN against the PRODUCTION relay signaling server (covert no-password path) + a REAL
 * WebRtcTransport/DTLS PRODUCE onto a REAL relay router, whose media is forwarded by the demo-only
 * byzantine evil-relay over a REAL router->router F1 PipeTransport to TWO INDEPENDENT validator Node
 * child processes. Each child is its own OS process (a real mediasoup worker + the UNCHANGED
 * runCanaryVerifyRound + its own Wallet-B + a loopback claims-server). The children cross-post their
 * Wallet-B self-attestations to each other over the loopback claims-server, so >=2-distinct is the
 * product of two SEPARATE processes (NOT one process holding two keypairs).
 *
 * THIS IS `canary-m2b-live-local` WITH ONE SWAP: the producer-creation is the A4-live REAL-BROWSER
 * producer (real signaling JOIN -> real produce on the test-owned relayRouter via the
 * "router-handle bridge") instead of the Node mediasoup producer. EVERYTHING from
 * `producer.producerId` DOWN (the 2 evil-relay primary-pipe legs, the stdin handover, the collect /
 * attesters logic, the honest->0 / byzantine->>=2 assertions) is VERBATIM from
 * `canary-m2b-live-local`.
 *
 *   HONEST forward    -> 0 proofs on both children (INV-A, no false positive).
 *   BYZANTINE forward -> both detect from the captured bytes -> a >=2-distinct proof.
 *
 * The honest->0 / byzantine->>=2 split is the non-vacuity RED hook (REQ-MLW-B-09): if honest ever
 * yields a proof or byzantine yields <2, that is a real signal to investigate (NOT to mask).
 *
 * NO chain here — the on-chain slash is the Task-4B walkthrough. This task PROVES the full leg
 * `real browser -> evil-relay -> 2 capture procs -> >=2-distinct` with the honest/byzantine RED hook.
 *
 * INV-A/B/C: runCanaryVerifyRound + the 145-byte proof are UNCHANGED; no relay media-path edit
 * (the tamper is the reused demo-only `startEvilRelayForward`); Wallet-B only; never logs key material.
 *
 * Run: cd dvconf-daemons && npx vitest run --config vitest.canary.config.ts canary-m2b-live-bhermetic
 */
import { createServer } from 'node:http';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrimaryPipeTransport } from '@dvconf/inter-relay-client';
import { startBrowserCanaryProducer } from '../../test-support/browser-canary-producer.js';
import { startRealSignaling } from '../../test-support/real-signaling-harness.js';
import { startEvilRelayForward } from '../../test-support/evil-relay-forward.js';

const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
// MUST match the forked child's hardcoded ROOM_ID (m2b-live-validator-proc.ts:38): roomId is folded
// into the canary HKDF `info` (keying.ts -> K_canary), so the browser producer (which derives
// K_canary from THIS roomId via real signaling) and the child verifier (which recomputes the
// expected C_i from ITS roomId) MUST agree — a mismatch makes EVERY honest frame look diverged
// (TAMPER, since the kid:7 trailer is still readable), collapsing the honest/byzantine RED hook.
const ROOM_ID = 'm2b-live-xproc-room';
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const CLAIMS_TOKEN = 'm2b-live-loopback';
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];
const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(__dirname, '../../test-support/m2b-live-validator-proc.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Line = Record<string, any>;

/** Read the next stdout JSON line matching `pred` from a child. */
function readLine(cp: ChildProcess, pred: (o: Line) => boolean): Promise<Line> {
  return new Promise((res) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          let o: Line;
          try {
            o = JSON.parse(line) as Line;
          } catch {
            continue; // ignore non-JSON noise on stdout
          }
          if (pred(o)) {
            cp.stdout!.off('data', onData);
            res(o);
            return;
          }
        }
      }
    };
    cp.stdout!.on('data', onData);
  });
}

/** Grab a FREE loopback TCP port (bind :0, read the assigned port, close) — avoids 19181/19182 collisions. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

let relayWorker: msTypes.Worker;
beforeAll(async () => {
  relayWorker = await mediasoup.createWorker({ logLevel: 'warn' });
}, 60_000);
afterAll(() => {
  relayWorker?.close();
});

/** Spawn 2 validator children + drive the relay-side evil-relay forward; return the per-child proof attester counts. */
async function runXProc(byzantine: boolean): Promise<number[]> {
  // Ephemeral, guaranteed-free claims-server ports for each child (each is the OTHER's coObserver URL).
  const portA = await freePort();
  const portB = await freePort();

  const spawnChild = (receiverMinerId: string, selfPort: number, peerPort: number): ChildProcess =>
    fork(CHILD, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['pipe', 'pipe', 'inherit', 'ipc'],
      env: {
        ...process.env,
        RECEIVER_MINER_ID: receiverMinerId,
        SELF_CLAIMS_PORT: String(selfPort),
        PEER_CLAIMS_URL: `http://127.0.0.1:${peerPort}`,
        CANARY_CLAIMS_AUTH_TOKEN: CLAIMS_TOKEN,
        CANARY_LIVE_CAPTURE: 'pipe',
        ANNOUNCED_IP: '127.0.0.1',
      },
    });

  const childA = spawnChild('val-A', portA, portB);
  const childB = spawnChild('val-B', portB, portA);

  const standbyA = await readLine(childA, (o) => o['t'] === 'standby');
  const standbyB = await readLine(childB, (o) => o['t'] === 'standby');

  // Relay side: one router, one producer, an evil-relay forward to BOTH children (2 primary pipe legs).
  const relayRouter = await relayWorker.createRouter({ mediaCodecs });

  // SWAP vs canary-m2b-live-local (the ONLY delta): the source is the A4-live REAL-BROWSER producer.
  // The REAL production signaling server (covert no-password path) over the test-owned relayRouter,
  // then a REAL headless-Chromium canary that does a REAL signaling JOIN + a REAL WebRtcTransport/DTLS
  // PRODUCE — landing on THIS relayRouter (the "router-handle bridge"), the SAME router the evil-relay
  // forwards + the F1 primary-pipe legs tap. Everything from `producer.producerId` DOWN is VERBATIM.
  const signaling = await startRealSignaling({ relayRouter, roomId: ROOM_ID });
  const producer = await startBrowserCanaryProducer({
    signalingUrl: signaling.wsUrl, // A4-live live mode (no injected relayRouter)
    roomId: ROOM_ID,
    kRoom: K_ROOM,
    cellSecret: CELL_SECRET,
    canaryKid: CANARY_KID,
    ctrs: CTRS,
  });

  const wireChild = async (
    cp: ChildProcess,
    standby: { ip: string; port: number },
  ): Promise<{ close(): void }> => {
    const primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
    await primaryPipe.connect({ ip: standby.ip, port: standby.port } as Parameters<
      msTypes.PipeTransport['connect']
    >[0]);
    const evil = await startEvilRelayForward({
      relayRouter,
      sourceProducerId: producer.producerId,
      byzantine,
      pipeTransport: primaryPipe,
    });
    // The committed evil-relay returns the FULL piped descriptor (kind/rtpParameters/producerPaused) so
    // we hand it to the child verbatim — no throwaway probe-consume (plan Task-1 Step-4 option).
    cp.stdin!.write(
      `${JSON.stringify({
        ip: '127.0.0.1',
        port: primaryPipe.tuple.localPort,
        piped: {
          id: evil.pipedProducerId,
          kind: evil.kind,
          rtpParameters: evil.rtpParameters,
          producerPaused: evil.producerPaused,
        },
      })}\n`,
    );
    return {
      close: (): void => {
        try {
          evil.close();
          primaryPipe.close();
        } catch {
          /* best-effort */
        }
      },
    };
  };

  const wA = await wireChild(childA, standbyA as { ip: string; port: number });
  const wB = await wireChild(childB, standbyB as { ip: string; port: number });

  producer.start();

  const attesters: number[] = [];
  const collect = async (cp: ChildProcess): Promise<void> => {
    const done = await readLine(cp, (o) => o['t'] === 'done' || o['t'] === 'proof');
    if (done['t'] === 'proof') attesters.push(done['attesters'] as number);
  };
  await Promise.race([
    Promise.all([collect(childA), collect(childB)]),
    new Promise((r) => setTimeout(r, 30_000)),
  ]);

  producer.stop();
  try {
    wA.close();
    wB.close();
    producer.close();
    await signaling.stop();
    relayRouter.close();
    childA.kill();
    childB.kill();
  } catch {
    /* best-effort */
  }
  return attesters;
}

describe('REQ-MLW-B-05/06/09 — B-hermetic real-browser canary -> evil-relay -> 2 capture procs -> >=2-distinct', () => {
  it('HONEST forward across 2 validator processes -> 0 proofs', async () => {
    const attesters = await runXProc(false);
    expect(attesters.length).toBe(0);
  }, 180_000);

  it('BYZANTINE forward -> both validators detect -> a >=2-distinct proof', async () => {
    const attesters = await runXProc(true);
    expect(attesters.length).toBeGreaterThan(0);
    expect(Math.max(...attesters)).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
