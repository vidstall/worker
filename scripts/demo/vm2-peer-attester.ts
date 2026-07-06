// scripts/demo/vm2-peer-attester.ts
/**
 * Track-C GENUINE 2-host co-sign — the PEER HOST (vm2) attester. Runs on the SECOND Azure VM as a
 * fully-independent corroborator so the on-chain slash carries >=2 DISTINCT Wallet-B attesters that
 * live on DIFFERENT hosts (closes #1 cross-host co-sign + #7 real-media validator capture on a 2nd host,
 * over #4 real forwarded SRTP media across the WAN).
 *
 * SELF-CUSTODY (INV-C): vm2 owns its Wallet-B session keypair. vm1 never holds it — vm1 only binds the
 * ADDRESS on-chain (CANARY_PEER_SESSION_ADDR), and vm2 signs att2 with its OWN key here. So "vm1 forged
 * both attestations" is structurally impossible.
 *
 * PULL-CORROBORATION (D-CFA-41): vm2 does NOT trust vm1's claim. It independently captures the SAME
 * cross-host-forwarded media (bringUpLiveConsumer standby #2), re-derives the expected canary hashes
 * (verifyForwardedCanary), and only signs `attestIfIndependentlyObserved` — i.e. only when its OWN
 * observation byte-MATCHES the open cell's (frameSeq, expectedHash, observedHash). No local match => it
 * refuses (fail-loud). It reads vm1's open cell from the shared /canary/claims board and posts att2 back.
 *
 * Two modes (argv[2]):
 *   gen-identity  -> generate a fresh Ed25519 session keypair; print {secretKey,address} JSON to stdout
 *                    (the ONLY intentional secret-to-stdout, one-time provisioning; the driver captures
 *                    it, sets CANARY_PEER_SESSION_SECRET on vm2 + CANARY_PEER_SESSION_ADDR on vm1).
 *   attest (default) -> the full independent capture + corroborate + post flow.
 *
 * Env (attest mode): CANARY_PIPE_PARAMS_PATH (in, scp'd from vm1), CANARY_PIPE_RETURN_PATH (out, scp'd
 *   back to vm1), CLAIM_BOARD_URL + CANARY_CLAIMS_AUTH_TOKEN (vm1's board), CANARY_PEER_SESSION_SECRET
 *   (vm2's own key), ANNOUNCED_IP (vm2 private IP), PIPE_SRTP=1, CANARY_STANDBY_PIPE_PORT (default 40001),
 *   CANARY_PIPE_RECEIVER_MINER_ID (snapshot label, must equal vm1's), CANARY_COSIGN_TIMEOUT_MS.
 */
import { writeFileSync, renameSync, readFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { createLogger } from '../../packages/shared/src/index.ts';
import { bringUpLiveConsumer } from '../../apps/validator-daemon/src/canary/live-consumer-runtime.ts';
import { verifyForwardedCanary } from '../../apps/validator-daemon/src/canary/verifier.ts';
import { attestIfIndependentlyObserved } from '../../apps/validator-daemon/src/canary/claim-board.ts';
import { HttpClaimBoard } from '../../apps/validator-daemon/src/canary/claims-client.ts';
import type { CanaryPipeParams } from '../../apps/validator-daemon/src/capture-precedence.ts';

const MOD = 'track-c/vm2-peer-attester';

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`${MOD}: ${what} required`);
  return v;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** gen-identity: mint vm2's self-custody Wallet-B session keypair; print {secretKey,address} to stdout. */
function genIdentity(): void {
  const kp = Ed25519Keypair.generate();
  const secretKey = kp.getSecretKey(); // bech32 `suiprivkey1...` — vm2 keeps this; vm1 never sees it
  const address = kp.getPublicKey().toSuiAddress();
  // Intentional one-time secret-to-stdout (identity provisioning). NOT via the structured logger.
  process.stdout.write(JSON.stringify({ secretKey, address }) + '\n');
}

async function attest(): Promise<void> {
  const logger = createLogger(MOD);
  const paramsPath = need(process.env['CANARY_PIPE_PARAMS_PATH'], 'CANARY_PIPE_PARAMS_PATH (scp\'d from vm1)');
  const returnPath = need(process.env['CANARY_PIPE_RETURN_PATH'], 'CANARY_PIPE_RETURN_PATH (scp\'d back to vm1)');
  const boardUrl = need(process.env['CLAIM_BOARD_URL'], 'CLAIM_BOARD_URL (vm1 /canary/claims)');
  const boardToken = need(process.env['CANARY_CLAIMS_AUTH_TOKEN'], 'CANARY_CLAIMS_AUTH_TOKEN');
  const sessionKp = Ed25519Keypair.fromSecretKey(
    decodeSuiPrivateKey(need(process.env['CANARY_PEER_SESSION_SECRET'], 'CANARY_PEER_SESSION_SECRET (vm2 self-custody)')).secretKey,
  );
  const standbyPort = Number(process.env['CANARY_STANDBY_PIPE_PORT']) || 40001;
  const timeoutMs = Number(process.env['CANARY_COSIGN_TIMEOUT_MS']) || 120_000;

  const params = JSON.parse(readFileSync(paramsPath, 'utf8')) as CanaryPipeParams;
  const roomId = need(params.meta.roomId, 'params.meta.roomId (Track-C: needed to re-derive canary hashes)');
  const kRoom = Uint8Array.from(params.meta.kRoom);
  const cellSecret = Uint8Array.from(params.meta.cellSecret);
  logger.info(
    { module: MOD, action: 'params_loaded', context: { roomId, relayIp: params.relay.ip, relayPort: params.relay.port, standbyPort } },
    'Track-C vm2: loaded cross-host pipe params (secrets NOT logged — INV-C)',
  );

  // 1. Bring up vm2's OWN standby pipe #2 (SRTP under PIPE_SRTP=1). Its {ip,port,srtpParameters} is the
  //    return channel: write it FIRST (atomic tmp+rename) so vm1's primary#2.connect can proceed.
  const runtime = await bringUpLiveConsumer({
    pipePort: standbyPort,
    receiverMinerId: need(process.env['CANARY_PIPE_RECEIVER_MINER_ID'], 'CANARY_PIPE_RECEIVER_MINER_ID'),
    meta: { canaryKid: params.meta.canaryKid, expectedCtrs: params.meta.expectedCtrs, kRoom, cellSecret },
  });
  const tmp = `${returnPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(runtime.standbyParams), 'utf8');
  renameSync(tmp, returnPath); // atomic publish so the driver never scps a half-written return
  logger.info(
    { module: MOD, action: 'return_written', context: { returnPath, standbyPort: runtime.standbyParams.port } },
    'Track-C vm2: published standby params for vm1 primary#2.connect',
  );

  // 2. Connect the standby to vm1's primary#2 (cross-host, SRTP) + re-produce the piped descriptor.
  await runtime.connectToRelay(params.relay);
  await runtime.consumePiped(params.piped);
  logger.info({ module: MOD, action: 'consuming' }, 'Track-C vm2: standby connected + consuming cross-host forwarded media');

  // 3. Corroborate loop: accumulate real capture, re-derive expected hashes, and append THIS host's
  //    independent attestation to vm1's open cell — only on a local byte-MATCH (anti-fabrication).
  const board = new HttpClaimBoard({ baseUrl: boardUrl, token: boardToken });
  const receiverMinerId = process.env['CANARY_PIPE_RECEIVER_MINER_ID']!;
  const scope = { relayId: 'vm2-peer', roomId };
  const deadline = Date.now() + timeoutMs;
  let posted = false;
  for (;;) {
    await sleep(1000); // let cross-host RTP accumulate + give vm1 time to post its cell
    const cap = await runtime.capture(scope);
    const buffers = cap.perReceiver.get(receiverMinerId) ?? [];
    const localDivs = buffers.length
      ? (await verifyForwardedCanary(buffers, { kRoom, roomId, cellSecret, canaryKid: params.meta.canaryKid, expectedCtrs: params.meta.expectedCtrs })).divergences
      : [];
    for (const open of await board.listOpen()) {
      const att = await attestIfIndependentlyObserved(open.claim, localDivs, sessionKp);
      if (att) {
        await board.post(open.claim, att, open.openedRound);
        logger.info(
          { module: MOD, action: 'att2_posted', context: { frameSeq: open.claim.frameSeq, relayMinerId: open.claim.relayMinerId, capturedPackets: buffers.length } },
          'Track-C vm2: independently observed the divergence -> posted att2 (distinct-host Wallet-B) to vm1 board',
        );
        posted = true;
        break;
      }
    }
    if (posted) break;
    if (Date.now() >= deadline) {
      runtime.shutdown();
      throw new Error(
        `${MOD}: no independently-corroborable divergence within ${timeoutMs}ms ` +
          `(captured ${buffers.length} pkts, ${localDivs.length} local divergences, board had open cells but none byte-matched). ` +
          'Refusing to attest what vm2 did not observe (anti-fabrication).',
      );
    }
  }
  runtime.shutdown();
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'attest';
  if (mode === 'gen-identity') { genIdentity(); return; }
  await attest();
}

void main().catch((e) => {
  // eslint-disable-next-line no-console -- top-level fatal for a standalone script (before logger scope)
  console.error(`${MOD}: FATAL`, e);
  process.exit(1);
});
