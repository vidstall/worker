/**
 * M2b-live-WAN Sub-lane A (A3b) — REQ-MLW-A-04/05/06/12. FORK of
 * canary-m2b-live-local.integration.test.ts that swaps ONLY the SOURCE LEG: the Node
 * `startNodeCanaryProducer` is replaced by `startBrowserCanaryProducer` — a REAL headless-Chromium
 * page that produces the fully-pinned synthetic 62-byte canary SFrame (the SHIPPED client crypto,
 * byte-identical to the FROZEN `recomputeCanaryFrame` by construction) over a REAL WebRtcTransport
 * onto the test's INJECTED `relayRouter`.
 *
 * EVERYTHING from the producer call DOWN is VERBATIM from the local e2e (INV-A/B/C preserved): the
 * `wireChild` closure, `createPrimaryPipeTransport`, the additive byzantine `startEvilRelayForward`
 * over a REAL router→router F1 PipeTransport, the TWO INDEPENDENT validator Node child processes
 * (each its own OS process: a real mediasoup worker + the UNCHANGED runCanaryVerifyRound + its own
 * Wallet-B + a loopback claims-server), the cross-posted Wallet-B self-attestations, and ALL
 * assertions. The ONLY coupling to the source leg is `producer.producerId` (a real mediasoup
 * producer on `relayRouter`).
 *
 *   HONEST forward    -> 0 proofs on both children (INV-A, no false positive).
 *   BYZANTINE forward -> both detect from the captured bytes -> a >=2-distinct proof (REQ-MLW-A-06).
 * REQ-MLW-A-12 (non-vacuity): the honest-0-vs-byzantine->=2 split IS the RED-hook — disabling the
 * evil-relay flip flips the result; no separate assertion.
 *
 * Run: cd dvconf-daemons && npx vitest run --config vitest.canary.config.ts canary-m2b-live-wan-A
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
import { startEvilRelayForward } from '../../test-support/evil-relay-forward.js';

const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
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
  // SOURCE LEG SWAP (M2b-live-WAN-A): the REAL headless-Chromium browser produces the pinned canary
  // onto this SAME relayRouter; the rest of the chain is UNCHANGED vs canary-m2b-live-local.
  const relayRouter = await relayWorker.createRouter({ mediaCodecs });
  const producer = await startBrowserCanaryProducer({
    relayRouter,
    kRoom: K_ROOM,
    roomId: ROOM_ID,
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
    new Promise((r) => setTimeout(r, 25_000)),
  ]);

  producer.stop();
  try {
    wA.close();
    wB.close();
    producer.close();
    relayRouter.close();
    childA.kill();
    childB.kill();
  } catch {
    /* best-effort */
  }
  return attesters;
}

describe('REQ-MLW-A-04/05/06/12 — cross-process REAL-BROWSER canary detection', () => {
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
