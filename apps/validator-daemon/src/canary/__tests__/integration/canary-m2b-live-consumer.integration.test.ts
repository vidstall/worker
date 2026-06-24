import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createPrimaryPipeTransport, createStandbyPipeTransport } from '@dvconf/inter-relay-client';
import { startNodeCanaryProducer } from '../../test-support/node-canary-producer.js';
import { startEvilRelayForward } from '../../test-support/evil-relay-forward.js';
import { attachLiveConsumer } from '../../live-consumer.js';
import { runCanaryVerifyRound, type CanaryVerifyDeps } from '../../verify-loop.js';
// RelayRoomScope is exported from cell.js (verify-loop.js imports it locally but does not re-export);
// the plan's Task-3 Step-1 import from verify-loop.js is a TS2459 — adapted to the real export source.
import type { RelayRoomScope } from '../../cell.js';
import { InMemoryClaimBoard } from '../../claim-board.js';
import { distinctAttesterCount, type DivergenceProof } from '../../proof.js';

const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'lc-room'; const CANARY_KID = 7; const RELAY_R = 'relay-R';
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mediaCodecs: msTypes.RtpCodecCapability[] = [{ kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 }];
let relayWorker: msTypes.Worker; let validatorWorker: msTypes.Worker;
beforeAll(async () => { relayWorker = await mediasoup.createWorker({ logLevel: 'warn' }); validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' }); }, 60_000);
afterAll(() => { relayWorker?.close(); validatorWorker?.close(); });

describe('REQ-MLL — attachLiveConsumer feeds runCanaryVerifyRound (byzantine -> >=2-distinct)', () => {
  it('a live-consumer over a real pipe leg detects the evil-relay tamper', async () => {
    const relayRouter = await relayWorker.createRouter({ mediaCodecs });
    const validatorRouter = await validatorWorker.createRouter({ mediaCodecs });
    const producer = await startNodeCanaryProducer({ relayRouter, kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID, ctrs: CTRS });
    const primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
    const standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
    await primaryPipe.connect({ ip: '127.0.0.1', port: standbyPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({ ip: '127.0.0.1', port: primaryPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const evil = await startEvilRelayForward({ relayRouter, sourceProducerId: producer.producerId, byzantine: true, pipeTransport: primaryPipe });
    // Plan Task-1 Step-4 option (applied consistently in Task 1 + here): startEvilRelayForward
    // returns the FULL piped descriptor, so the standby side produces directly from it. The plan's
    // Task-3 Step-1 probe-consume (relayRouter.consume(evil.pipedProducerId)) does NOT work: the
    // piped id is a consumer on the PIPE transport, not a producer routable on relayRouter ("Producer
    // ... not found"). Adapted minimally to the real EvilRelayForward signature.
    const pipedProducer = await standbyPipe.produce({ id: evil.pipedProducerId, kind: evil.kind, rtpParameters: evil.rtpParameters, paused: evil.producerPaused } as Parameters<msTypes.PipeTransport['produce']>[0]);

    const lc = await attachLiveConsumer({ validatorRouter, pipedProducerId: pipedProducer.id, receiverMinerId: 'val-rx', meta: { canaryKid: CANARY_KID, expectedCtrs: CTRS, kRoom: K_ROOM, cellSecret: CELL_SECRET } });
    producer.start(); await sleep(1200); producer.stop(); await sleep(50);

    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const mk = (self: Ed25519Keypair): CanaryVerifyDeps => ({
      getRelayRoomScopes: (): RelayRoomScope[] => [{ relayId: RELAY_R, roomId: ROOM_ID }],
      getValidators: () => [{ minerId: 'a', sessionWallet: 'a' }, { minerId: 'b', sessionWallet: 'b' }],
      getStunLossBps: () => 0n, capture: lc.capture, localBoard: board, selfSessionKeypair: self,
      submit: async (p) => { submitted.push(p); }, config: { k: 2, deltaBps: 0n, sendRate: CTRS.length },
    });
    const da = mk(new Ed25519Keypair()); const db = mk(new Ed25519Keypair());
    let accA: unknown; let accB: unknown;
    for (let r = 0; r < 7; r++) { accA = (await runCanaryVerifyRound(da, accA as never, r)).accumulator; accB = (await runCanaryVerifyRound(db, accB as never, r)).accumulator; }
    expect(submitted.length).toBeGreaterThan(0);
    expect(distinctAttesterCount(submitted[0]!.attestations)).toBeGreaterThanOrEqual(2);
    try { lc.close(); evil.close(); producer.close(); relayRouter.close(); validatorRouter.close(); } catch { /* */ }
  }, 40_000);
});
