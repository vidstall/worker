/**
 * Stage-2 live gated-join probe (REQ-CMD-4/5). Drives a REAL WS join against the live
 * signaling AuthHook (createServer({authHook}), signaling index.ts:655). A no-token join
 * is closed with code 4401 (verifyResult.closeCode, index.ts:318). Accept mode does NOT
 * claim a client-key WS-accept (the issuer mints to the assigned relay/signaling pubkeys,
 * not an arbitrary client key); it asserts the on-chain CapabilityIssued for the shared
 * roomId was emitted by onRoomAssigned. scripts/ is outside the pnpm graph -> import shared
 * via the relative source path (mirrors issue-cap-token-demo.ts:51).
 *
 * Run:
 *   pnpm exec tsx scripts/demo/gated-join-probe.ts --mode reject --url ws://localhost:8080
 *   pnpm exec tsx scripts/demo/gated-join-probe.ts --mode accept --url ws://localhost:8080 --room-file /shared/room.json
 */
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
} from '../../packages/shared/src/index.ts';

/** BCS JoinPayload (byte-identical to auth.ts:134-142). */
export function buildJoinPayload(roomId: string, peerPubkey: number[], nonce: number): Uint8Array {
  return bcs
    .struct('JoinPayload', { roomId: bcs.string(), peerPubkey: bcs.vector(bcs.u8()), nonce: bcs.u64() })
    .serialize({ roomId, peerPubkey, nonce: BigInt(nonce) })
    .toBytes();
}

export interface JoinOutcome { accepted: boolean; code: number | null; }

/** Map a WS close (code, reason) to an accept/reject outcome. A never-closed socket
 *  (code=null) = accepted; any 44xx close = rejected (auth.ts closeCodeFor: 4401/4403/4409). */
export function classifyClose(code: number | null, _reason?: string): JoinOutcome {
  if (code === null) return { accepted: true, code: null };
  return { accepted: false, code };
}

/** Open a WS, send a join, and resolve once we either (a) see a close (reject) or
 *  (b) the socket survives `settleMs` open with no close (accepted). */
export async function driveJoin(args: {
  url: string;
  roomId: string;
  token: string;
  kp: Ed25519Keypair | null; // null => no-token reject probe
  nonce: number;
  settleMs?: number;
}): Promise<JoinOutcome> {
  const settleMs = args.settleMs ?? 1500;
  return await new Promise<JoinOutcome>((resolve) => {
    const ws = new WebSocket(args.url);
    let settled = false;
    const done = (o: JoinOutcome): void => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* best-effort */ }
      resolve(o);
    };
    ws.on('open', async () => {
      let signature = '';
      let nonce = args.nonce;
      if (args.kp !== null && args.token.length > 0) {
        const peerPubkey = Array.from(args.kp.getPublicKey().toRawBytes());
        const sig = await args.kp.sign(buildJoinPayload(args.roomId, peerPubkey, nonce));
        signature = Buffer.from(sig).toString('base64');
      } else {
        nonce = 0;
      }
      ws.send(JSON.stringify({ type: 'join', roomId: args.roomId, token: args.token, signature, nonce }));
      // No close within settleMs => accepted (the join was processed, roomManager.join).
      setTimeout(() => done(classifyClose(null)), settleMs);
    });
    ws.on('close', (code: number, reason: Buffer) => done(classifyClose(code, reason.toString())));
    ws.on('error', () => done(classifyClose(4401, 'ws-error')));
  });
}

/** Parse a flag value from argv (e.g. getArg('--mode') -> 'reject'). */
function getArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Read the shared roomId from --room-file (the host bind-mount copy or the in-container copy). */
function readRoomId(roomFile: string): string {
  const m = JSON.parse(readFileSync(roomFile, 'utf8')) as { roomId?: string };
  if (!m.roomId) throw new Error(`gated-join-probe: ${roomFile} has no roomId`);
  return m.roomId;
}

/** Find a CapabilityIssued event for `roomId` on-chain (issue-cap-token-demo.ts:241-243 pattern). */
async function findCapabilityIssued(roomId: string): Promise<boolean> {
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const page = await client.queryEvents({
    query: { MoveEventType: `${config.packageId}::capability_events::CapabilityIssued` },
    order: 'descending',
    limit: 50,
  });
  return page.data.some((e) => {
    const pj = e.parsedJson as { room_id?: string } | undefined;
    return pj?.room_id === roomId;
  });
}

async function main(): Promise<void> {
  const logger = createLogger('gated-join-probe');
  const mode = getArg('--mode');
  const url = getArg('--url') ?? 'ws://localhost:8080';

  if (mode === 'reject') {
    // No-token join MUST be closed 4401 by the live AuthHook.
    const outcome = await driveJoin({ url, roomId: '0xno-room', token: '', kp: null, nonce: 0 });
    logger.info({ action: 'reject_probe', context: { outcome } }, `reject probe outcome=${JSON.stringify(outcome)}`);
    if (outcome.accepted || outcome.code !== 4401) {
      process.stderr.write(`gated-join-probe[reject]: expected 4401 close, got ${JSON.stringify(outcome)}\n`);
      process.exit(1);
    }
    process.stdout.write('REJECT_OK code=4401\n');
    return;
  }

  if (mode === 'accept') {
    // M1 accept proof = the on-chain CapabilityIssued for the shared roomId (NOT a client-key WS accept).
    const roomFile = getArg('--room-file') ?? '/shared/room.json';
    const roomId = readRoomId(roomFile);
    const issued = await findCapabilityIssued(roomId);
    logger.info({ action: 'accept_probe', context: { roomId, issued } }, `CapabilityIssued found=${issued}`);
    if (!issued) {
      process.stderr.write(`gated-join-probe[accept]: no CapabilityIssued for ${roomId}\n`);
      process.exit(1);
    }
    process.stdout.write(`ACCEPT_OK CapabilityIssued room=${roomId}\n`);
    return;
  }

  process.stderr.write(`gated-join-probe: --mode must be reject|accept (got ${mode ?? '(none)'})\n`);
  process.exit(2);
}

// Run only when invoked directly (pure helpers stay import-safe for the unit test).
if (process.argv[1]?.endsWith('gated-join-probe.ts')) {
  main().catch((err) => {
    process.stderr.write(`gated-join-probe: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
