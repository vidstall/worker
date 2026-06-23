/**
 * provision-room (PROMOTED from .scratch-provision-room.ts; ran live WAN Stage 5.1).
 * Chains register_user → create_room(SFU,2,room_class_hint=0) → assign_relay_and_signaling
 * via the EXTRACTED @dvconf/shared createRoomWithRelay, then writes the shared room manifest
 * to BOTH /shared/room.json (publish-output named volume; in-container readers) AND
 * /shared-host/room.json (host bind-mount ./.demo-shared; the root runner on the host fs reads
 * THIS copy — /shared is a docker named volume, not a host path).
 *
 * Run from dvconf-daemons (where the chain + faucet live):
 *   DEPLOYER_SECRET=suiprivkey1... RELAY_MINER_ID=0x.. ADMIN_CAP_ID=0x.. \
 *   SIGNALING_MINER_ID=0x.. PRIMARY_URL=ws://relay:4001 \
 *   pnpm exec tsx scripts/demo/provision-room.ts
 * (object IDs resolved by loadNetworkConfig() from the read-publish-output.sh env, like seed-bootstrap.)
 */
import { writeFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  createRoomWithRelay,
} from '../../packages/shared/src/index.ts';

const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const ROOM_OUTPUT_PATH = process.env['ROOM_OUTPUT_PATH'] ?? '/shared/room.json';
const ROOM_HOST_OUTPUT_PATH = process.env['ROOM_HOST_OUTPUT_PATH'] ?? '/shared-host/room.json';

export interface RoomManifest {
  roomId: string;
  relayId: string;
  signalingId: string;
  primaryUrl: string;
}

/** Write the shared room manifest to every path (mirrors seed-bootstrap.ts:536 writeFileSync). */
export function writeRoomManifest(paths: string[], manifest: RoomManifest): void {
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  for (const p of paths) writeFileSync(p, body, 'utf8');
}

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`env ${k} required`);
  return v;
};

async function main(): Promise<void> {
  // loadNetworkConfig() resolves rpcUrl from SUI_NETWORK + every *_ID env var (client.ts:38).
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const log = createLogger('provision-room');

  const deployer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(need('DEPLOYER_SECRET')).secretKey);
  const userKp = new Ed25519Keypair(); // fresh user; funded by the injected faucet callback
  const relayMinerId = need('RELAY_MINER_ID');
  const adminCapId = need('ADMIN_CAP_ID');
  const signalingId = process.env['SIGNALING_MINER_ID'] ?? relayMinerId;
  const primaryUrl = process.env['PRIMARY_URL'] ?? 'ws://relay:4001';

  const fundAddress = (address: string): Promise<void> =>
    requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address }).then(() => undefined);

  log.info({ deployer: deployer.getPublicKey().toSuiAddress(), relayMinerId }, 'provisioning room+assign');
  const roomId = await createRoomWithRelay(client, userKp, deployer, adminCapId, relayMinerId, config, log, fundAddress);

  const manifest: RoomManifest = { roomId, relayId: relayMinerId, signalingId, primaryUrl };
  writeRoomManifest([ROOM_OUTPUT_PATH, ROOM_HOST_OUTPUT_PATH], manifest);
  log.info({ roomId, out: [ROOM_OUTPUT_PATH, ROOM_HOST_OUTPUT_PATH] }, 'room provisioned + manifest written (volume + host)');
  process.stdout.write(`\nROOM_ID=${roomId}\n`);
}

// Run only when invoked directly (the pure writeRoomManifest stays import-safe for tests;
// mirrors assert-active-validators.ts:54 — an unconditional main() process.exit(1)s at import
// time when env is unset, which would defeat Step-1's hermetic writeRoomManifest unit test).
if (process.argv[1]?.endsWith('provision-room.ts')) {
  main().catch((err) => {
    process.stderr.write(`provision-room: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
