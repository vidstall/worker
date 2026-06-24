/**
 * M2b-live N4 — REQ-MLL-03/04. The byzantine corruption happens INSIDE a real relay-role
 * DirectTransport consume -> (corrupt|passthrough) -> re-produce hop, BEFORE the F1 pipe, so the
 * validator receives genuinely-diverged bytes off the wire (NOT a post-capture harness flip — the
 * M2b capture-core honesty caveat this slice closes). In-process here (two workers); the
 * cross-process Node separation is Task 5.
 *
 * Run: pnpm exec vitest run --config vitest.canary.config.ts canary-m2b-live-evilrelay
 */
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createPrimaryPipeTransport, createStandbyPipeTransport } from '@dvconf/inter-relay-client';
import { attachValidatorSink } from '../../pipe-tap.js';
import { PipeTapCollector, createPipeTapCapture } from '../../pipe-tap-capture.js';
import { runCanaryVerifyRound, type CanaryVerifyDeps } from '../../verify-loop.js';
import { InMemoryClaimBoard } from '../../claim-board.js';
import { distinctAttesterCount, type DivergenceProof } from '../../proof.js';
// RelayRoomScope is exported from cell.js (verify-loop.js imports it locally but does not re-export);
// matches the M2b capture-core integration test's import site.
import type { CanaryValidator, RelayRoomScope } from '../../cell.js';
import { startNodeCanaryProducer } from '../../test-support/node-canary-producer.js'; // Task 2 (committed c258bf8)
import { startEvilRelayForward } from '../../test-support/evil-relay-forward.js';

const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'm2b-live-evilrelay-room';
const CANARY_KID = 7;
const RELAY_R = 'relay-under-audit-R';
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const SELF: CanaryValidator = { minerId: 'val-self', sessionWallet: 's-self' };
const PEER: CanaryValidator = { minerId: 'val-peer', sessionWallet: 's-peer' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];

let relayWorker: msTypes.Worker;
let validatorWorker: msTypes.Worker;
beforeAll(async () => {
  relayWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' });
}, 60_000);
afterAll(() => { relayWorker?.close(); validatorWorker?.close(); });

// Producer -> EVIL-RELAY (corrupt|passthrough) -> pipe -> 2 validator sinks -> captured bytes.
async function forwardViaEvilRelay(byzantine: boolean): Promise<{ a: Buffer[]; b: Buffer[] }> {
  const relayRouter = await relayWorker.createRouter({ mediaCodecs });
  const validatorRouter = await validatorWorker.createRouter({ mediaCodecs });

  const producer = await startNodeCanaryProducer({ relayRouter, kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID, ctrs: CTRS });

  const primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
  const standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
  await primaryPipe.connect({ ip: '127.0.0.1', port: standbyPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
  await standbyPipe.connect({ ip: '127.0.0.1', port: primaryPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);

  // Plan Task-1 Step-4 option (applied consistently): startEvilRelayForward returns the FULL piped
  // descriptor so the standby side produces directly from it (no throwaway probe-consume).
  const evil = await startEvilRelayForward({ relayRouter, sourceProducerId: producer.producerId, byzantine, pipeTransport: primaryPipe });
  const pipedProducer = await standbyPipe.produce({
    id: evil.pipedProducerId, kind: evil.kind,
    rtpParameters: evil.rtpParameters, paused: evil.producerPaused,
  } as Parameters<msTypes.PipeTransport['produce']>[0]);

  const sinkA = await attachValidatorSink(validatorRouter, pipedProducer.id);
  const sinkB = await attachValidatorSink(validatorRouter, pipedProducer.id);
  const a: Buffer[] = []; const b: Buffer[] = [];
  sinkA.consumer.on('rtp', (p: Buffer) => a.push(Buffer.from(p)));
  sinkB.consumer.on('rtp', (p: Buffer) => b.push(Buffer.from(p)));
  await sinkA.consumer.requestKeyFrame(); await sinkB.consumer.requestKeyFrame();

  producer.start();
  await sleep(1200);
  producer.stop();
  await sleep(50);
  try { sinkA.close(); sinkB.close(); evil.close(); producer.close(); relayRouter.close(); validatorRouter.close(); } catch { /* */ }
  return { a, b };
}

function makeDeps(a: Buffer[], b: Buffer[], board: InMemoryClaimBoard, submitted: DivergenceProof[], self: Ed25519Keypair): CanaryVerifyDeps {
  const emA = new EventEmitter(); const emB = new EventEmitter();
  const collector = new PipeTapCollector([
    { receiverMinerId: SELF.minerId, consumer: emA },
    { receiverMinerId: PEER.minerId, consumer: emB },
  ]);
  for (const p of a) emA.emit('rtp', p);
  for (const p of b) emB.emit('rtp', p);
  return {
    getRelayRoomScopes: (): RelayRoomScope[] => [{ relayId: RELAY_R, roomId: ROOM_ID }],
    getValidators: () => [SELF, PEER],
    getStunLossBps: () => 0n,
    capture: createPipeTapCapture(collector, { canaryKid: CANARY_KID, expectedCtrs: CTRS, kRoom: K_ROOM, cellSecret: CELL_SECRET }),
    localBoard: board,
    selfSessionKeypair: self,
    submit: async (proof) => { submitted.push(proof); },
    config: { k: 2, deltaBps: 0n, sendRate: CTRS.length },
  };
}

async function runQuorum(a: Buffer[], b: Buffer[]): Promise<DivergenceProof[]> {
  const board = new InMemoryClaimBoard({ wCorr: 100 });
  const submitted: DivergenceProof[] = [];
  const da = makeDeps(a, b, board, submitted, new Ed25519Keypair());
  const db = makeDeps(a, b, board, submitted, new Ed25519Keypair());
  let accA: unknown; let accB: unknown;
  for (let r = 0; r < 7; r++) {
    accA = (await runCanaryVerifyRound(da, accA as never, r)).accumulator;
    accB = (await runCanaryVerifyRound(db, accB as never, r)).accumulator;
  }
  return submitted;
}

describe('REQ-MLL-03/04 — evil-relay corrupts on the wire (NOT harness-side)', () => {
  it('HONEST evil-relay passthrough -> real RTP, 0 divergence', async () => {
    const { a, b } = await forwardViaEvilRelay(false);
    expect(a.length).toBeGreaterThan(0); expect(b.length).toBeGreaterThan(0);
    expect((await runQuorum(a, b)).length).toBe(0);
  }, 40_000);

  it('BYZANTINE evil-relay -> detected -> >=2-distinct proof', async () => {
    const { a, b } = await forwardViaEvilRelay(true);
    const submitted = await runQuorum(a, b);
    expect(submitted.length).toBeGreaterThan(0);
    expect(distinctAttesterCount(submitted[0]!.attestations)).toBeGreaterThanOrEqual(2);
  }, 40_000);
});
