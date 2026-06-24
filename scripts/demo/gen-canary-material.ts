/**
 * gen-canary-material — gap #3 (consolidated E2E Stage-5 LIVE slash) pre-boot generator.
 *
 * The consolidated stack's two validators boot with CANARY_LIVE_SEAMS_ENABLED=1, so the canary
 * verify-loop's `buildLiveSeams` (validator-daemon index.ts:506) requires the OOB crypto material +
 * a real on-chain room with the accused relay assigned. This one-shot runs ONCE, BEFORE the
 * validators, and writes everything they read from the shared volume:
 *
 *   1. provisions a real room + assigns the seed relay (reuse @dvconf/shared createRoomWithRelay) so
 *      canary_audit::slash_for_canary_divergence §2/§3 (relay_bond.miner_id == relay_miner_id AND
 *      relay ∈ room.assigned_relays) pass.  -> /shared/room.json (+ host bind-mount copy).
 *   2. two P-256 self-signed TLS certs (CN = the in-network hostnames) for the cross-host
 *      /canary/claims mTLS carrier.  -> /shared/val{1,2}-{cert,key}.pem.
 *   3. an ed25519-signed OOB manifest bundle binding each validator's MAIN on-chain pubkey to its
 *      cert SPKI (reuse signManifest / spkiFingerprint — the SAME fingerprint the mTLS pin computes).
 *      -> /shared/manifest-bundle.json.
 *   4. a sourceable env file the validator entrypoint (read-canary-env.sh) exports — the roomId +
 *      relay miner_id (runtime-created, non-deterministic) + each validator's operator pubkey.
 *      -> /shared/canary-env.sh.
 *
 * KEY FACTS (recon-verified, do NOT re-derive):
 *   - operator pubkey = the validator's MAIN ed25519 key (persistent, from daemon-keys.json). It is
 *     used only as a manifest binding + a board self-skip — NOT the attestation signer. The
 *     attestation is signed by the per-boot SESSION key, which each validator self-registers on-chain
 *     at boot (self_assign_session_wallet) — so NO session-wallet registration is needed here.
 *   - deployer authority for assign_relay_and_signaling = the publisher (AdminCap owner): its secret +
 *     cap id are written to /shared/admin-creds.json by publish-and-init.sh.
 *   - relay.minerId comes from the seed daemon-keys.json (seed-bootstrap now emits it).
 *
 * Idempotent on the room: if ROOM_OUTPUT_PATH already holds a valid roomId, it is reused (so the
 * runner's Stage-2 provision-room re-run sees the SAME room). NOT committed secrets — localnet
 * throwaway keys + per-regenesis ids; the certs/keys land in the named volume only.
 *
 * Entry: read-publish-output.sh (exports PACKAGE_ID + *_REGISTRY_ID) -> this script. Run via compose
 * as a default pre-boot one-shot the validators depend_on (service_completed_successfully).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  createRoomWithRelay,
  signManifest,
  spkiFingerprint,
  type OperatorManifest,
  type SignedManifest,
} from '../../packages/shared/src/index.ts';
import { writeRoomManifest, type RoomManifest } from './provision-room.ts';

const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const KEYS_PATH = process.env['CANARY_DAEMON_KEYS_PATH'] ?? '/shared/daemon-keys.json';
const ADMIN_CREDS_PATH = process.env['ADMIN_CREDS_PATH'] ?? '/shared/admin-creds.json';
const ROOM_OUTPUT_PATH = process.env['ROOM_OUTPUT_PATH'] ?? '/shared/room.json';
const ROOM_HOST_OUTPUT_PATH = process.env['ROOM_HOST_OUTPUT_PATH'] ?? '/shared-host/room.json';
const SHARED_DIR = process.env['CANARY_SHARED_DIR'] ?? '/shared';
const ENV_OUTPUT_PATH = process.env['CANARY_ENV_OUTPUT_PATH'] ?? '/shared/canary-env.sh';
const CONFIG_HOST_OUTPUT_PATH = process.env['CONFIG_HOST_OUTPUT_PATH'] ?? '/shared-host/onchain-config.json';
const MANIFEST_BUNDLE_PATH = process.env['CANARY_MANIFEST_BUNDLE_PATH'] ?? '/shared/manifest-bundle.json';
const VAL1_ENDPOINT = process.env['CANARY_VAL1_ENDPOINT'] ?? 'validator-daemon:8092';
const VAL2_ENDPOINT = process.env['CANARY_VAL2_ENDPOINT'] ?? 'validator-daemon-2:8093';
const MANIFEST_VALID_DAYS = 89; // <= 90d (OPERATOR-SIGNOFF §5)

interface SeededKeyFile {
  validator?: { secretKey?: string };
  'validator-2'?: { secretKey?: string };
  relay?: { secretKey?: string; minerId?: string; stakeId?: string };
}
interface AdminCreds {
  adminCapId?: string;
  adminSecretKey?: string;
}

/** A keypair from a bech32 `suiprivkey1...` secret (the on-chain identity family). */
function kpFromSecret(secret: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
}

/** Lowercase raw-pubkey hex (the manifest operatorPubkey + CANARY_SELF_OPERATOR_PUBKEY form). */
function pubHex(kp: Ed25519Keypair): string {
  return Buffer.from(kp.getPublicKey().toRawBytes()).toString('hex');
}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null || v === '') throw new Error(`gen-canary-material: ${what} required`);
  return v;
};

/**
 * PURE — the sourceable shell env file the validator entrypoint (read-canary-env.sh) exports. The 4
 * vars buildLiveSeams requireEnv's that are runtime-derived (roomId, relayMinerId) or per-operator
 * (the two main pubkeys). Single-quoted (values are 0x.../hex, no quoting hazards, but stay safe).
 */
export function renderCanaryEnvFile(o: {
  roomId: string;
  relayMinerId: string;
  val1Pub: string;
  val2Pub: string;
}): string {
  return [
    '# canary live-seams env (gap #3 gen-canary-material) — sourced by read-canary-env.sh. NOT secrets.',
    `export CANARY_DEMO_ROOM_ID='${o.roomId}'`,
    `export CANARY_DEMO_RELAY_MINER_ID='${o.relayMinerId}'`,
    `export VAL1_SELF_PUBKEY='${o.val1Pub}'`,
    `export VAL2_SELF_PUBKEY='${o.val2Pub}'`,
    '',
  ].join('\n');
}

/**
 * Build the ed25519-signed OOB manifest bundle: one OperatorManifest per validator binding its MAIN
 * pubkey (operatorPubkey = signing keypair's pubkey — signManifest refuses a foreign-key manifest) to
 * its cert SPKI (spkiFingerprint = the EXACT fingerprint the mTLS pin recomputes). `validUntilMs` is
 * injected (deterministic for tests; main() passes Date.now()+89d).
 */
export async function buildManifestBundle(
  operators: Array<{ keypair: Ed25519Keypair; certPem: string; boardEndpoint: string }>,
  validUntilMs: number,
): Promise<SignedManifest[]> {
  const bundle: SignedManifest[] = [];
  for (const op of operators) {
    const manifest: OperatorManifest = {
      operatorPubkey: pubHex(op.keypair),
      boardEndpoint: op.boardEndpoint,
      certFingerprint: spkiFingerprint(op.certPem),
      validUntil: validUntilMs,
    };
    bundle.push(await signManifest(manifest, op.keypair));
  }
  return bundle;
}

/**
 * Generate a P-256 self-signed TLS cert + key via openssl (present in the daemon image) and return
 * the cert PEM. Writes `<dir>/<name>-cert.pem` + `<dir>/<name>-key.pem` (the paths the override's
 * CANARY_TLS_{CERT,KEY}_PATH point at). Mirrors the @dvconf/shared mtls test fixtures (EC P-256).
 */
export function generateP256Cert(cn: string, dir: string, name: string): { certPath: string; keyPath: string; certPem: string } {
  const certPath = `${dir}/${name}-cert.pem`;
  const keyPath = `${dir}/${name}-key.pem`;
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-keyout', keyPath, '-out', certPath, '-days', '3650', '-nodes', '-subj', `/CN=${cn}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  return { certPath, keyPath, certPem: readFileSync(certPath, 'utf8') };
}

async function main(): Promise<void> {
  const log = createLogger('gen-canary-material');
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  const keys = JSON.parse(readFileSync(KEYS_PATH, 'utf8')) as SeededKeyFile;
  const val1Kp = kpFromSecret(need(keys.validator?.secretKey, `${KEYS_PATH} .validator.secretKey`));
  const val2Kp = kpFromSecret(need(keys['validator-2']?.secretKey, `${KEYS_PATH} .validator-2.secretKey`));
  const relayMinerId = need(keys.relay?.minerId, `${KEYS_PATH} .relay.minerId (seed-bootstrap must emit it)`);
  const val1Pub = pubHex(val1Kp);
  const val2Pub = pubHex(val2Kp);

  // ── 1. room (idempotent) ──────────────────────────────────────────────────────────────────
  let roomId: string;
  if (existsSync(ROOM_OUTPUT_PATH)) {
    roomId = (JSON.parse(readFileSync(ROOM_OUTPUT_PATH, 'utf8')) as { roomId?: string }).roomId ?? '';
  } else {
    roomId = '';
  }
  if (!roomId) {
    const admin = JSON.parse(readFileSync(ADMIN_CREDS_PATH, 'utf8')) as AdminCreds;
    const deployer = kpFromSecret(need(admin.adminSecretKey, `${ADMIN_CREDS_PATH} .adminSecretKey`));
    const adminCapId = need(admin.adminCapId, `${ADMIN_CREDS_PATH} .adminCapId`);
    const userKp = new Ed25519Keypair(); // fresh user; createRoomWithRelay faucets it
    const fundAddress = (address: string): Promise<void> =>
      requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address }).then(() => undefined);
    log.info({ relayMinerId, deployer: deployer.getPublicKey().toSuiAddress() }, 'provisioning room + assigning relay');
    roomId = await createRoomWithRelay(client, userKp, deployer, adminCapId, relayMinerId, config, log, fundAddress);
    const manifest: RoomManifest = {
      roomId,
      relayId: relayMinerId,
      signalingId: relayMinerId,
      primaryUrl: process.env['PRIMARY_URL'] ?? 'ws://relay:4001',
    };
    writeRoomManifest([ROOM_OUTPUT_PATH, ROOM_HOST_OUTPUT_PATH], manifest);
  } else {
    log.info({ roomId }, 'room already provisioned — reusing (idempotent)');
  }

  // ── 2. two P-256 TLS certs (CN = in-network hostnames) ────────────────────────────────────
  const val1Cert = generateP256Cert('validator-daemon', SHARED_DIR, 'val1');
  const val2Cert = generateP256Cert('validator-daemon-2', SHARED_DIR, 'val2');

  // ── 3. ed25519-signed OOB manifest bundle (operator MAIN pubkey ↔ cert SPKI) ───────────────
  const validUntilMs = Date.now() + MANIFEST_VALID_DAYS * 24 * 60 * 60 * 1000;
  const bundle = await buildManifestBundle(
    [
      { keypair: val1Kp, certPem: val1Cert.certPem, boardEndpoint: VAL1_ENDPOINT },
      { keypair: val2Kp, certPem: val2Cert.certPem, boardEndpoint: VAL2_ENDPOINT },
    ],
    validUntilMs,
  );
  writeFileSync(MANIFEST_BUNDLE_PATH, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');

  // ── 4. the sourceable env file the validators export ──────────────────────────────────────
  writeFileSync(ENV_OUTPUT_PATH, renderCanaryEnvFile({ roomId, relayMinerId, val1Pub, val2Pub }), 'utf8');

  // ── 5. host-readable resolved on-chain IDs (env-name keyed) — so the runner's HOST-side stages
  //   (assert-active-validators, Stage-5b queryLatestCanarySlash) hydrate the FRESH per-regenesis ids
  //   into process.env instead of reading the STALE committed dvconf-daemons/.env (loadNetworkConfig
  //   reads process.env; dotenv override:false means a runner-set value wins). Written to the host
  //   bind-mount (/shared-host) like room.json so the host runner can read it.
  writeFileSync(
    CONFIG_HOST_OUTPUT_PATH,
    JSON.stringify(
      {
        PACKAGE_ID: config.packageId,
        NETWORK_REGISTRY_ID: config.networkRegistryId,
        MINER_STORE_ID: config.minerStoreId,
        CP_REGISTRY_ID: config.cpRegistryId,
        RELAY_REGISTRY_ID: config.relayRegistryId,
        VALIDATOR_REGISTRY_ID: config.validatorRegistryId,
        USER_REGISTRY_ID: config.userRegistryId,
        ROOM_MANAGER_ID: config.roomManagerId,
        SIGNALING_REGISTRY_ID: config.signalingRegistryId,
        ROLE_VOTE_BOX_ID: config.roleVoteBoxId,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  log.info(
    {
      roomId,
      relayMinerId,
      val1Spki: bundle[0]?.manifest.certFingerprint,
      val2Spki: bundle[1]?.manifest.certFingerprint,
      bundleOut: MANIFEST_BUNDLE_PATH,
      envOut: ENV_OUTPUT_PATH,
    },
    'canary material generated (room + 2 certs + signed bundle + env)',
  );
  process.stdout.write(`\nCANARY_DEMO_ROOM_ID=${roomId}\nVAL1_SELF_PUBKEY=${val1Pub}\nVAL2_SELF_PUBKEY=${val2Pub}\n`);
}

// Run only when invoked directly — the pure exports (renderCanaryEnvFile / buildManifestBundle /
// generateP256Cert) stay import-safe for the hermetic test (a bare main() would read /shared on
// import). Same guard as provision-room.ts:77 / assert-active-validators.ts:54.
if (process.argv[1]?.endsWith('gen-canary-material.ts')) {
  main().catch((err) => {
    process.stderr.write(`gen-canary-material: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
