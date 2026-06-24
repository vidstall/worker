// apps/validator-daemon/src/canary/test-support/m2b-live-validator-proc.ts
/**
 * M2b-live cross-process VALIDATOR child (REQ-MLL-01/05). A self-contained Node process: bring up a
 * real mediasoup consumer over an F1 standby pipe, run the UNCHANGED runCanaryVerifyRound with its
 * OWN Wallet-B + a loopback claims-server (its localBoard, reachable by the PEER child), and a peer
 * HttpClaimBoard (coObserver), and report any >=2-distinct proof back to the parent over stdout JSON
 * lines. This is the THIN entrypoint variant (DESIGN §9 q5): it imports N2 + the verify-loop directly
 * (NOT the full index.ts runtime) — still a real separate OS process; the REAL binary is the optional
 * REQ-MLL-11 demo.
 *
 * Control channel (parent <=> child, stdout/stdin JSON lines):
 *   1. parent spawns with env { RECEIVER_MINER_ID, SELF_CLAIMS_PORT, PEER_CLAIMS_URL, CANARY_LIVE_CAPTURE,
 *      ANNOUNCED_IP, CANARY_CLAIMS_AUTH_TOKEN }.
 *   2. child starts its claims-server on SELF_CLAIMS_PORT (its localBoard, so the PEER can cross-post to
 *      it) + brings up the live-consumer, then prints {"t":"standby","ip","port"} (its standby pipe params).
 *   3. parent prints back {"ip","port","piped":{id,kind,rtpParameters,producerPaused}} (one stdin line).
 *   4. child connectToRelay + consumePiped, then runs the verify-loop; localBoard exposed via its
 *      claims-server, coObserverBoards=[HttpClaimBoard -> PEER_CLAIMS_URL], selfSessionKeypair fresh.
 *   5. on a submitted proof -> {"t":"proof","attesters":N,"relayMinerId"}; finally {"t":"done","submitted"}.
 *
 * INV-A/B/C: runCanaryVerifyRound + the 145-byte proof are UNCHANGED; no relay media-path edit; Wallet-B only.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger } from '@dvconf/shared';
import { bringUpLiveConsumer, type PipedProducerDescriptor } from '../live-consumer-runtime.js';
import { runCanaryVerifyRound, type CanaryVerifyDeps } from '../verify-loop.js';
// RelayRoomScope/CanaryValidator are exported from cell.js (verify-loop.js imports them locally but
// does not re-export); matches the M2b-live Task-1/3 integration tests' import sites.
import type { RelayRoomScope, CanaryValidator } from '../cell.js';
import { InMemoryClaimBoard } from '../claim-board.js';
import { startCanaryClaimsServer } from '../claims-server.js';
import { HttpClaimBoard } from '../claims-client.js';
import type { DropAccumulator } from '../loss-classifier.js';
import type { DivergenceProof } from '../proof.js';

const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'm2b-live-xproc-room';
const CANARY_KID = 7;
const RELAY_R = 'relay-under-audit-R';
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const CLAIMS_TOKEN = 'm2b-live-loopback';
const VALIDATORS: CanaryValidator[] = [
  { minerId: 'a', sessionWallet: 'a' },
  { minerId: 'b', sessionWallet: 'b' },
];

const out = (o: unknown): void => {
  process.stdout.write(`${JSON.stringify(o)}\n`);
};

/** Read exactly ONE JSON line from stdin (the parent's relay-params message). */
function readOneStdinLine<T>(): Promise<T> {
  return new Promise<T>((resolve) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        process.stdin.off('data', onData);
        resolve(JSON.parse(buf.slice(0, nl)) as T);
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const receiverMinerId = process.env['RECEIVER_MINER_ID']!;
  const selfClaimsPort = Number(process.env['SELF_CLAIMS_PORT']!);
  const peerClaimsUrl = process.env['PEER_CLAIMS_URL']!;
  // The real claims-server FAILS LOUD without a token; inject the loopback token directly (the env may
  // also carry CANARY_CLAIMS_AUTH_TOKEN, but authTokenOverride is the deterministic test path).
  const logger = createLogger('canary/m2b-live-validator-proc');

  // (a) Start THIS validator's loopback claims-server (its localBoard) so the PEER can cross-post to it.
  // portOverride binds the parent-assigned port DIRECTLY (skips the prod resolver, which rejects a fixed
  // port reuse); the parent guarantees the port is free before spawning.
  const board = new InMemoryClaimBoard({ wCorr: 100 });
  const server = await startCanaryClaimsServer({
    board,
    logger,
    authTokenOverride: CLAIMS_TOKEN,
    portOverride: selfClaimsPort,
  });

  // The peer's claims-server, fronted as a co-observer board (C1 cross-post fan-out target).
  const peerBoard = new HttpClaimBoard({ baseUrl: peerClaimsUrl, token: CLAIMS_TOKEN });

  // (b) Bring up the real mediasoup consumer over an ephemeral F1 standby pipe.
  const runtime = await bringUpLiveConsumer({
    pipePort: 0,
    receiverMinerId,
    meta: { canaryKid: CANARY_KID, expectedCtrs: CTRS, kRoom: K_ROOM, cellSecret: CELL_SECRET },
  });
  out({ t: 'standby', ip: runtime.standbyParams.ip, port: runtime.standbyParams.port });

  // (c) Await the relay primary params + the piped-producer descriptor from the parent.
  const relay = await readOneStdinLine<{ ip: string; port: number; piped: PipedProducerDescriptor }>();
  await runtime.connectToRelay({ ip: relay.ip, port: relay.port });
  await runtime.consumePiped(relay.piped);

  // (d) Run the UNCHANGED verify-loop with this validator's OWN Wallet-B + cross-post to the peer board.
  const submitted: DivergenceProof[] = [];
  const self = new Ed25519Keypair();
  const deps: CanaryVerifyDeps = {
    getRelayRoomScopes: (): RelayRoomScope[] => [{ relayId: RELAY_R, roomId: ROOM_ID }],
    getValidators: () => VALIDATORS,
    getStunLossBps: () => 0n,
    capture: runtime.capture,
    localBoard: board,
    coObserverBoards: [peerBoard],
    selfSessionKeypair: self,
    submit: async (p) => {
      submitted.push(p);
      out({ t: 'proof', attesters: p.attestations.length, relayMinerId: p.relayMinerId });
    },
    config: { k: 2, deltaBps: 0n, sendRate: CTRS.length },
  };

  let acc: DropAccumulator | undefined;
  for (let r = 0; r < 30 && submitted.length === 0; r++) {
    acc = (await runCanaryVerifyRound(deps, acc, r)).accumulator;
    await new Promise((res) => setTimeout(res, 200)); // let the peer's cross-post accrue on this board
  }
  out({ t: 'done', submitted: submitted.length });

  runtime.shutdown();
  await server.stop();
  process.exit(0);
}

void main();
