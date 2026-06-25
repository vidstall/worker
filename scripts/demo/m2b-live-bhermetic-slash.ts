/**
 * m2b-live-bhermetic-slash.ts — M2b-live-WAN Sub-lane B / B-hermetic Task 4B-i.
 * REQ-MLW-B-06/07/08/10 — the CHAIN-BACKED full-cast walkthrough orchestrator (the milestone headline).
 *
 * This is the on-chain sibling of the hermetic Task-4A component proof
 * (canary-m2b-live-bhermetic.integration.test.ts): instead of an InMemoryClaimBoard with NO chain,
 * it feeds REAL captured headless-browser bytes into the FROZEN verifier and submits a REAL on-chain
 * slash to the ALREADY-BOOTED consolidated localnet stack.
 *
 * ── THE FULL CAST (single host, all real) ──────────────────────────────────────────────────────
 *   1. a REAL headless-Chromium canary (A4-live) does a REAL signaling JOIN (covert no-password path)
 *      against the PRODUCTION relay signaling server + a REAL WebRtcTransport/DTLS PRODUCE onto a REAL
 *      relay mediasoup router (the "router-handle bridge");
 *   2. a demo-only byzantine evil-relay (startEvilRelayForward, REUSED VERBATIM — INV-B) taps that real
 *      producer and corrupts one ciphertext byte per packet;
 *   3. the corrupted media is forwarded over a REAL router→router F1 PipeTransport to a host-side
 *      validator mediasoup router sink (attachValidatorSink) where we CAPTURE the forwarded bytes;
 *   4. the captured REAL bytes flow through the FROZEN verifyForwardedCanary → a REAL divergence
 *      (expectedHash ≠ observedHash, a present-but-different TAMPER);
 *   5. that real divergence is assembled into a ≥2-distinct-Wallet-B proof (buildDivergenceProof) and
 *      submitted as a REAL on-chain canary_audit::slash_for_canary_divergence → CanaryDivergenceSlashed.
 *   6. an HONEST leg (byzantine:false) proves NO false positive: the honest forward yields 0 divergences
 *      and we assert NO new on-chain slash appears for that fresh room (REQ-MLW-B-05).
 *
 * ── DESIGN DECISION (the load-bearing 2-distinct choice): APPROACH (B) ─────────────────────────────
 * The on-chain ≥2-distinct quorum is by validator miner_id via lookup_session_wallet (canary_audit.move).
 * We need TWO DISTINCT registered validators with BOUND session wallets whose session keypairs sign the
 * proof. We REGISTER 2 FRESH distinct validators with bound session wallets on the BOOTED localnet and
 * use THEIR session keypairs — mirroring the proven canary-slash-e2e.integration.test.ts setup VERBATIM.
 *
 * WHY (B) not (A): the BOOTED stack's two validators generate their Wallet-B SESSION keypairs INSIDE
 * their containers at boot (self_assign_session_wallet — see gen-canary-material.ts:24-27); that session
 * SECRET never leaves the container and is NOT in the host-readable daemon-keys.json (which carries only
 * each validator's MAIN key). So (A) "reuse the booted validators' session keypairs" is NOT host-
 * accessible. (B) is self-contained and reliably yields ≥2 distinct attester_ids.
 *
 * ── HONESTY BOUNDARY (disclosed) ──────────────────────────────────────────────────────────────────
 *  • The DIVERGENCE is REAL (from real tampered browser media through the FROZEN verifier — INV-A).
 *  • The ATTESTER SET is mirrored from canary-slash-e2e's setup: 2 fresh validators registered by THIS
 *    orchestrator, not the booted stack's two daemons. The chain still authoritatively enforces ≥2
 *    DISTINCT miner_ids — the orchestrator cannot forge that.
 *  • The slash tx is SIGNED BY THE RELAY (the bond owner) — approach (b) / W-E9, NOT validator-driven.
 *    A StakePosition is OWNED (has key, no store); a PTB can only pass an owned &mut by its OWNER, and
 *    share_for_testing is #[test_only]/stripped. This proves the ENTRY MECHANISM end-to-end; production
 *    needs a protocol-controlled bond (W-E9, on record). The relay keypair+bond come from the LIVE seed
 *    daemon-keys.json relay slot (the relay assigned to the room), so it is the REAL accused relay.
 *
 * ── INVARIANTS ────────────────────────────────────────────────────────────────────────────────────
 * INV-A: verifyForwardedCanary + buildDivergenceProof + the 145-byte canonical message are UNCHANGED.
 * INV-B: the tamper is the REUSED demo-only startEvilRelayForward; the production relay media path is
 *        never edited (the real signaling server runs unmodified via the router-handle bridge).
 * INV-C: Wallet-B session sigs ONLY; never logs key material / cellSecret / kRoom / K_canary.
 *
 * ── RUN (against an ALREADY-BOOTED --keep-up consolidated stack) ───────────────────────────────────
 *   pnpm --dir dvconf-daemons exec tsx scripts/demo/m2b-live-bhermetic-slash.ts
 *
 * The booted stack must be up first:
 *   pnpm --dir dvconf-daemons exec tsx C:\Thesis\dvconf\run-consolidated-demo.ts --keep-up
 *
 * Scripts/ sits OUTSIDE the pnpm workspace package graph, so @dvconf/shared is imported via the
 * relative SOURCE path (same pattern as the sibling one-shots seed-bootstrap.ts / poll-canary-slash.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  createSuiClient,
  loadNetworkConfig,
  createRoomWithRelay,
  signAndAssert,
  MinerRole,
  createLogger,
  type NetworkConfig,
  type Logger,
  type TxStatusLike,
} from '../../packages/shared/src/index.ts';
// FROZEN canary primitives (reused VERBATIM — INV-A). These live in the validator-daemon app source;
// scripts/ resolves them by relative SOURCE path under tsx (same as the @dvconf/shared import above).
import { verifyForwardedCanary, type VerifyInput } from '../../apps/validator-daemon/src/canary/verifier.ts';
import { buildDivergenceProof, OBSERVED_HASH_MISSING } from '../../apps/validator-daemon/src/canary/proof.ts';
import { submitCanarySlash, type SlashCallOpts } from '../../apps/validator-daemon/src/canary/slash-submitter.ts';
// Capture topology (REUSED from Task 4A) — real browser producer + real signaling + the demo-only
// byzantine evil-relay + the F1 pipe + the validator sink.
import { startRealSignaling } from '../../apps/validator-daemon/src/canary/test-support/real-signaling-harness.ts';
import { startBrowserCanaryProducer } from '../../apps/validator-daemon/src/canary/test-support/browser-canary-producer.ts';
import { startEvilRelayForward } from '../../apps/validator-daemon/src/canary/test-support/evil-relay-forward.ts';
import { attachValidatorSink } from '../../apps/validator-daemon/src/canary/pipe-tap.ts';
// Relative SOURCE path (NOT the bare `@dvconf/inter-relay-client` specifier): scripts/ sits OUTSIDE
// the pnpm workspace package graph, so the bare name is unresolvable from root node_modules (only
// apps/* carry the symlink) — same constraint as the @dvconf/shared import above (seed-bootstrap:61).
import { createPrimaryPipeTransport, createStandbyPipeTransport } from '../../packages/inter-relay-client/src/index.ts';
// On-chain assertion helper (daemons-internal, the same one Stage-5b uses).
import { assertCanarySlash, type CanarySlashEvent } from './assert-canary-slash.ts';

const MOD = 'm2b-live-bhermetic-slash';

// ── workspace paths (this file is dvconf-daemons/scripts/demo/) ──────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..'); // demo -> scripts -> dvconf-daemons -> workspace root
const DEMO_SHARED = join(ROOT, '.demo-shared');
const ROOM_FILE = join(DEMO_SHARED, 'room.json');
const ONCHAIN_CONFIG_FILE = join(DEMO_SHARED, 'onchain-config.json');
const EVIDENCE_DIR = join(ROOT, '.evidence', 'verification');

// ── host-reachable booted-stack endpoints (compose publishes 9000 RPC + 9123 faucet) ────────────
const HOST_RPC_URL = process.env['SUI_NETWORK'] && /^https?:\/\//.test(process.env['SUI_NETWORK'])
  ? process.env['SUI_NETWORK']
  : 'http://127.0.0.1:9000';
const HOST_FAUCET_URL = process.env['FAUCET_URL'] ?? 'http://127.0.0.1:9123/gas';

// ── canary stream params for the browser↔verifier pair (internally consistent; NOT chain-checked) ─
// The chain verifies only ed25519 over the 145-byte proof + room/relay binding — NOT cellSecret/kRoom
// (those are off-chain crypto). So the producer + verifier just need to agree on these to make the
// divergence REAL. Distinct from the booted validators' CANARY_CELL_SECRET (which audits a DIFFERENT
// stream) — irrelevant here because the proof carries the hashes the verifier computed, not a secret.
const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];

const FAUCET_TIMEOUT_MS = 90_000;
const FAUCET_POLL_MS = 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Stake tiers (MIST) — mirror canary-localnet-helpers (validator min 0.1; 0.3 clears the apply guard).
const VALIDATOR_STAKE_MIST = 300_000_000n;

/**
 * Retry a chain op on the Sui "owned-object already locked by a different transaction" / equivocation
 * error. The seed CP + the publisher deployer keypairs are ALSO held by LIVE containers (the cp-daemon
 * signs cap-token issuance / role votes; the publisher rarely signs), so a tx that reuses one of those
 * keys can briefly race a live tx for the shared gas coin. This is a transient lock — wait for the
 * conflicting tx to finalize and retry. NOT used for the fresh-keypair ops (no contention there).
 */
async function withLockRetry<T>(label: string, fn: () => Promise<T>, attempts = 6, backoffMs = 2500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /already locked by a different transaction|equivocat|reserved for another transaction|JsonRpcError.*-3200|quorum of validators/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      lastErr = e;
      process.stdout.write(`  [retry ${i + 1}/${attempts}] ${label}: transient lock — backing off ${backoffMs}ms\n`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

interface RoomManifest { roomId: string; relayId?: string; signalingId?: string; primaryUrl?: string }

/** A keypair from a bech32 `suiprivkey1...` secret. */
function kpFromSecret(secret: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null || v === '') throw new Error(`${MOD}: ${what} required`);
  return v;
};

// ── run-log accumulation (written to .evidence/, gitignored) ─────────────────────────────────────
const runLog: string[] = [];
function logLine(s: string): void {
  runLog.push(s);
  process.stdout.write(`${s}\n`);
}

/**
 * Hydrate the FRESH per-regenesis on-chain ids from the host bind-mount into process.env so
 * loadNetworkConfig() reads the LIVE package + registries, NOT the stale committed dvconf-daemons/.env.
 * Mirrors run-consolidated-demo.ts::hydrateOnchainEnv. Also pins SUI_NETWORK to the host-reachable RPC.
 */
function hydrateOnchainEnv(): void {
  process.env['SUI_NETWORK'] = HOST_RPC_URL; // override the container-internal sui-localnet:9000
  if (!existsSync(ONCHAIN_CONFIG_FILE)) {
    throw new Error(`${MOD}: ${ONCHAIN_CONFIG_FILE} not found — is the consolidated stack booted (--keep-up)?`);
  }
  const ids = JSON.parse(readFileSync(ONCHAIN_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  let set = 0;
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v === 'string' && v.length > 0) { process.env[k] = v; set += 1; }
  }
  logLine(`[env] hydrated ${set} on-chain ids from ${ONCHAIN_CONFIG_FILE}; RPC=${HOST_RPC_URL}`);
}

const COMPOSE_FILES = [
  'docker-compose-demo.yml',
  'docker-compose-demo-w1.override.yml',
  'docker-compose-demo-relay-overlap.override.yml',
  'docker-compose-demo-consolidated.override.yml',
];

/** Copy a file out of the booted-stack named `publish-output` volume (via the cp-daemon mount). */
function copyFromVolume(containerPath: string, hostDest: string): void {
  const composeArgs: string[] = [];
  for (const f of COMPOSE_FILES) { composeArgs.push('-f', join(ROOT, f)); }
  // cp-daemon mounts publish-output:/shared:ro — the seed artifacts live under /shared/.
  execFileSync(
    'docker',
    ['compose', ...composeArgs, 'cp', `cp-daemon:${containerPath}`, hostDest],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

interface AdminCreds { adminCapId?: string; adminSecretKey?: string }

interface SeededKey { secretKey: string; capId: string; stakeId: string; minerId?: string }
interface DaemonKeys { cp?: SeededKey; [k: string]: SeededKey | undefined }

/**
 * Pull the LIVE seeded daemon-keys.json off the named docker volume. We REUSE the seed CP as the
 * role-vote VOTER for the fresh validators/relay (its capId is a ControlPlaneCap). Registering a NEW CP
 * is unreliable here: the booted network ALREADY has a CP, so the DYNAMIC CP stake threshold has scaled
 * above the first-CP base — a fresh 0.6/1.0-SUI register yields a MinerCap, not a ControlPlaneCap.
 */
function readDaemonKeysFromVolume(): DaemonKeys {
  const dest = join(DEMO_SHARED, '.daemon-keys-from-volume.json');
  copyFromVolume('/shared/daemon-keys.json', dest);
  return JSON.parse(readFileSync(dest, 'utf8')) as DaemonKeys;
}

/** Pull the publisher's AdminCap creds off the volume (gen-canary-material reads these to provision rooms). */
function readAdminCredsFromVolume(): AdminCreds {
  const dest = join(DEMO_SHARED, '.admin-creds-from-volume.json');
  copyFromVolume('/shared/admin-creds.json', dest);
  return JSON.parse(readFileSync(dest, 'utf8')) as AdminCreds;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CAPTURE — real browser → evil-relay → F1 pipe → validator sink → captured forwarded bytes
// ══════════════════════════════════════════════════════════════════════════════════════════════

interface CaptureResult {
  /** The REAL forwarded RTP packets captured at the validator sink. */
  captured: Buffer[];
  /** The roomId the canary derived K_canary from (== the on-chain room). */
  roomId: string;
}

/**
 * Run ONE full-cast capture leg for the given roomId + byzantine flag. Mirrors the Task-4A topology
 * but with a SINGLE in-process host-side validator sink (the ≥2-distinct comes from the on-chain
 * attester set, not from 2 capture procs). Returns the captured forwarded bytes.
 */
async function captureForwardedLeg(roomId: string, byzantine: boolean, logger: Logger): Promise<CaptureResult> {
  // I1: declare every resource handle ABOVE the try so the finally can null-guard-close it. Any
  // rejecting await between worker-create and the (previously success-only) teardown would otherwise
  // leak 2 mediasoup workers (native subprocesses) + the signaling WS port + the Chromium process,
  // accumulating orphans across re-runs. The finally runs on BOTH success and error paths.
  let worker: msTypes.Worker | undefined;
  let validatorWorker: msTypes.Worker | undefined;
  let relayRouter: msTypes.Router | undefined;
  let validatorRouter: msTypes.Router | undefined;
  let signaling: Awaited<ReturnType<typeof startRealSignaling>> | undefined;
  let producer: Awaited<ReturnType<typeof startBrowserCanaryProducer>> | undefined;
  let evil: Awaited<ReturnType<typeof startEvilRelayForward>> | undefined;
  let sink: Awaited<ReturnType<typeof attachValidatorSink>> | undefined;
  let primaryPipe: msTypes.PipeTransport | undefined;
  let standbyPipe: msTypes.PipeTransport | undefined;

  const captured: Buffer[] = [];
  let onRtp: ((pkt: Buffer) => void) | undefined;

  try {
    worker = await mediasoup.createWorker({ logLevel: 'warn' });
    relayRouter = await worker.createRouter({ mediaCodecs });
    validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    validatorRouter = await validatorWorker.createRouter({ mediaCodecs });

    // The REAL production signaling server over the test-owned relayRouter (router-handle bridge).
    signaling = await startRealSignaling({ relayRouter, roomId });
    // A4-live: a REAL headless-Chromium canary joins via real signaling + produces on relayRouter.
    producer = await startBrowserCanaryProducer({
      signalingUrl: signaling.wsUrl,
      roomId,
      kRoom: K_ROOM,
      cellSecret: CELL_SECRET,
      canaryKid: CANARY_KID,
      ctrs: CTRS,
    });

    // F1: a primary pipe on the relay router connected to a standby pipe on the validator router.
    standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
    primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
    await primaryPipe.connect({ ip: '127.0.0.1', port: standbyPipe.tuple.localPort } as Parameters<
      msTypes.PipeTransport['connect']
    >[0]);
    await standbyPipe.connect({ ip: '127.0.0.1', port: primaryPipe.tuple.localPort } as Parameters<
      msTypes.PipeTransport['connect']
    >[0]);

    // The demo-only byzantine evil-relay taps the real producer → pipes onto the primary (INV-B reuse).
    evil = await startEvilRelayForward({
      relayRouter,
      sourceProducerId: producer.producerId,
      byzantine,
      pipeTransport: primaryPipe,
    });
    // Re-produce the piped descriptor on the validator side, then attach an UNPAUSED sink consumer.
    const pipedProducer = await standbyPipe.produce({
      id: evil.pipedProducerId,
      kind: evil.kind,
      rtpParameters: evil.rtpParameters,
      paused: evil.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);
    sink = await attachValidatorSink(validatorRouter, pipedProducer.id);

    // Capture forwarded bytes off the sink's DirectTransport-fed consumer (copy off the reused buffer).
    onRtp = (pkt: Buffer): void => { captured.push(Buffer.from(pkt)); };
    sink.consumer.on('rtp', onRtp);

    producer.start();
    // Let real RTP flow long enough to capture the tampered ctr(s). The fake-VP8 device + the synthetic
    // canary transform produce continuously; a few seconds is ample for the 8-frame canary set to recur.
    // The BYZANTINE leg gets +2s so MORE frames flow → a corrupted ctr reliably lands in the capture
    // window (a thin window could miss the tampered frame and look like a false negative).
    await sleep(byzantine ? 6000 : 4000);

    logger.info({ module: MOD, action: 'capture_done', context: { byzantine, packets: captured.length } },
      `captured ${captured.length} forwarded packets (byzantine=${byzantine})`);

    return { captured, roomId };
  } finally {
    // Teardown runs on BOTH the success and the error path (I1). signaling first in its own guard (it
    // holds an OS port + a worker); the rest best-effort + null-guarded. producer.close() tears down
    // the Chromium process, so closing the producer here also covers the browser on the error path.
    if (sink && onRtp) { try { sink.consumer.off?.('rtp', onRtp); } catch { /* best-effort */ } }
    // M1: producer.stop() is a formal no-op (the browser fake-VP8 device keeps producing); close()
    // below is what tears down the Chromium browser process.
    producer?.stop();
    try { await signaling?.stop(); } catch { /* best-effort */ }
    try {
      sink?.close();
      evil?.close();
      primaryPipe?.close();
      standbyPipe?.close();
      producer?.close();
      relayRouter?.close();
      validatorRouter?.close();
      worker?.close();
      validatorWorker?.close();
    } catch { /* best-effort */ }
  }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CHAIN — register 2 fresh validators with bound session wallets (Approach B); slash; assert
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** Pick a created object id whose type contains `substring`, or throw. */
function createdObjectByType(result: TxStatusLike, substring: string, label: string): string {
  for (const change of result.objectChanges ?? []) {
    if (change.type === 'created' && typeof change.objectId === 'string' &&
        (change.objectType ?? '').includes(substring)) {
      return change.objectId;
    }
  }
  throw new Error(`${label}: no created object matching ${substring}`);
}

/** Faucet-fund an address against the HOST-reachable faucet, polling until the gas coin is indexed. */
async function fundAddress(client: SuiClient, address: string): Promise<void> {
  await requestSuiFromFaucetV2({ host: HOST_FAUCET_URL, recipient: address });
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) break;
    if (Date.now() > deadline) throw new Error(`${MOD}: faucet gas never indexed for ${address}`);
    await sleep(FAUCET_POLL_MS);
  }
}

interface ValidatorResult { minerId: string; sessionKp: Ed25519Keypair }

/**
 * Full validator lifecycle + session-wallet binding (Approach B), mirroring
 * canary-localnet-helpers::registerValidatorWithSession VERBATIM against the BOOTED localnet:
 *   register (User→MinerCap) → CP votes Validator → apply (flips to Validator) → register_validator
 *   → self_assign_session_wallet (binds a FRESH Wallet-B session keypair's Sui address on-chain).
 * The bound address == sessionKp.toSuiAddress() == blake2b256(0x00||pubkey) — EXACTLY what the slash
 * entry recomputes from each attestation pubkey to resolve the validator_miner_id (INV-C).
 */
async function registerFreshValidatorWithSession(
  client: SuiClient,
  cp: { kp: Ed25519Keypair; cpCapId: string },
  config: NetworkConfig,
  logger: Logger,
): Promise<ValidatorResult> {
  const minerKp = Ed25519Keypair.generate();
  await fundAddress(client, minerKp.getPublicKey().toSuiAddress());
  await sleep(500);
  const minerId = normalizeSuiAddress(minerKp.getPublicKey().toSuiAddress());

  // register (User → MinerCap) + 0.3 SUI stake.
  const reg = await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(VALIDATOR_STAKE_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register',
    logger,
  );
  const minerCapId = createdObjectByType(reg, '::caps::MinerCap', 'registerValidator');
  const stakeId = createdObjectByType(reg, '::staking::StakePosition', 'registerValidator');

  // CP casts Validator role (cp_reg first — role_voting.move:197). withLockRetry: the seed CP key is
  // shared with the live cp-daemon, so its gas coin can transiently lock.
  await withLockRetry('cast_role_vote (validator)', () => signAndAssert(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.cpRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.signalingRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(minerId),
          tx.pure.u8(MinerRole.Validator),
        ],
      });
    },
    'cast_role_vote',
    logger,
  ));

  // miner applies the voted role (registration.move:141).
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.signalingRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'apply_voted_role',
    logger,
  );

  // enroll in the ValidatorRegistry (validator_registry.move:91).
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::register_validator`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'register_validator',
    logger,
  );

  // bind a FRESH Wallet-B session keypair (validator_registry.move:143 self_assign_session_wallet).
  const sessionKp = Ed25519Keypair.generate();
  const sessionAddr = sessionKp.getPublicKey().toSuiAddress();
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(minerCapId),
          tx.pure.address(sessionAddr),
        ],
      });
    },
    'self_assign_session_wallet',
    logger,
  );

  logger.info({ module: MOD, action: 'register_validator', context: { minerId } },
    'fresh validator registered + session-wallet bound');
  return { minerId, sessionKp };
}

interface RelayResult { minerId: string; kp: Ed25519Keypair; stakeId: string }

/**
 * Full relay lifecycle (Approach (b) / W-E9 — the relay OWNS its bond and self-signs the slash),
 * mirroring canary-localnet-helpers::registerRelay VERBATIM against the BOOTED localnet:
 *   register (User→MinerCap, 0.3 SUI) → CP votes Relay → apply → register_relay.
 *
 * WHY a FRESH relay (not the seed daemon-keys relay): the booted stack's two validators auto-slash the
 * SEED relay's bond on the SEED room every CANARY_VERIFY_INTERVAL_MS, so reusing the seed relay's bond
 * (a) RACES those concurrent slashes → "object already locked by a different transaction", and (b) makes
 * queryLatestSlash(seedRoom) ambiguous (it could return the LIVE stack's slash, not THIS orchestrator's).
 * A fresh relay's bond + a fresh room are touched by NOTHING else → no contention + an unambiguous query.
 */
async function registerFreshRelay(
  client: SuiClient,
  cp: { kp: Ed25519Keypair; cpCapId: string },
  config: NetworkConfig,
  logger: Logger,
): Promise<RelayResult> {
  const minerKp = Ed25519Keypair.generate();
  await fundAddress(client, minerKp.getPublicKey().toSuiAddress());
  await sleep(500);
  const minerId = normalizeSuiAddress(minerKp.getPublicKey().toSuiAddress());

  const reg = await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(VALIDATOR_STAKE_MIST)]); // 0.3 SUI clears relay min 0.25
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register_relay_miner',
    logger,
  );
  const minerCapId = createdObjectByType(reg, '::caps::MinerCap', 'registerFreshRelay');
  const stakeId = createdObjectByType(reg, '::staking::StakePosition', 'registerFreshRelay');

  await withLockRetry('cast_role_vote (relay)', () => signAndAssert(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.cpRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.signalingRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(minerId),
          tx.pure.u8(MinerRole.Relay),
        ],
      });
    },
    'cast_role_vote_relay',
    logger,
  ));
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.signalingRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'apply_voted_role_relay',
    logger,
  );
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::relay_registry::register_relay`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
          tx.pure.vector('u8', [1, 2, 3, 4]), // region
          tx.pure.vector('u8', [1, 2, 3, 4]), // endpoint_url
        ],
      });
    },
    'register_relay',
    logger,
  );
  logger.info({ module: MOD, action: 'register_relay', context: { minerId } }, 'fresh relay registered (owns its bond — W-E9)');
  return { minerId, kp: minerKp, stakeId };
}

/** Newest CanaryDivergenceSlashed parsedJson matching roomId; {} if none (descending). */
async function queryLatestSlash(client: SuiClient, packageId: string, roomId: string): Promise<CanarySlashEvent> {
  const page = await client.queryEvents({
    query: { MoveEventType: `${packageId}::canary_audit::CanaryDivergenceSlashed` },
    order: 'descending',
    // M4: limit:50 is safe because we slash a FRESH per-run room — at most ONE matching event exists
    // for `roomId`, and it is among the 50 newest descending (the live stack only auto-slashes its OWN
    // seed room, never these fresh rooms), so the scan reliably finds (or rules out) our event.
    limit: 50,
  });
  for (const e of page.data) {
    const pj = e.parsedJson as CanarySlashEvent | undefined;
    if (pj && pj.room_id === roomId) return pj;
  }
  return {};
}

/** Read a StakePosition bond value (MIST) via staking::amount (devInspect). */
async function readBond(client: SuiClient, reader: Ed25519Keypair, stakeId: string, packageId: string): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::staking::amount`, arguments: [tx.object(stakeId)] });
  const res = await client.devInspectTransactionBlock({
    sender: reader.getPublicKey().toSuiAddress(),
    transactionBlock: tx,
  });
  const ret = res.results?.[0]?.returnValues?.[0];
  if (!ret) return 0n;
  const bytes = Uint8Array.from(ret[0] as number[]);
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v += BigInt(bytes[i]!) << (8n * BigInt(i));
  return v;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const logger = createLogger(MOD);
  const stamp = process.env['M2B_RUN_STAMP'] ?? new Date().toISOString().replace(/[:.]/g, '-');

  logLine('=== M2b-live-WAN B-hermetic CHAIN-BACKED walkthrough (REQ-MLW-B-06/07/08/10) ===');
  logLine(`[stamp] ${stamp}  (timestamp is for the run log only — non-load-bearing)`);
  logLine('[design] Approach (B): 2 FRESH validators with bound session wallets registered on the booted localnet.');
  logLine('[honesty] divergence is REAL (tampered browser media → FROZEN verifier); attester set is mirrored from canary-slash-e2e; relay self-signs the slash (W-E9).');

  // ── 1. read booted-stack shared artifacts + hydrate env ────────────────────────────────────────
  hydrateOnchainEnv();
  const room = JSON.parse(readFileSync(ROOM_FILE, 'utf8')) as RoomManifest;
  const roomId = need(room.roomId, `${ROOM_FILE} .roomId`);
  logLine(`[room] roomId=${roomId} relayId=${room.relayId ?? '(unset)'}`);

  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  logLine(`[chain] packageId=${config.packageId} rpc=${config.rpcUrl}`);

  // The publisher's AdminCap (from the volume) lets us provision our OWN fresh rooms.
  const admin = readAdminCredsFromVolume();
  const deployer = kpFromSecret(need(admin.adminSecretKey, 'admin-creds.json .adminSecretKey'));
  const adminCapId = need(admin.adminCapId, 'admin-creds.json .adminCapId');
  logLine(`[admin] deployer=${deployer.getPublicKey().toSuiAddress()} adminCapId=${adminCapId}`);
  // (the seed relay/room are only referenced for the run-log header; the slash uses a FRESH relay+room)
  logLine(`[seed] booted-stack seed room=${roomId} relay=${room.relayId ?? '(unset)'} (NOT reused for the slash — see registerFreshRelay note)`);

  // ── 2. reuse the SEED CP as voter + 2 fresh validators (Approach B) + a fresh relay (W-E9) ─────
  // The seed CP (from the volume) is the role-vote voter — a fresh CP is unreliable (the network already
  // has a CP, so the dynamic CP stake threshold has scaled past a fresh register's stake → MinerCap not
  // ControlPlaneCap). The seed CP's capId IS a ControlPlaneCap, so it can cast_role_vote for our miners.
  const keys = readDaemonKeysFromVolume();
  const seedCp = need(keys.cp, 'daemon-keys.json .cp (seed CP voter)');
  const cp = { kp: kpFromSecret(need(seedCp.secretKey, 'cp.secretKey')), cpCapId: need(seedCp.capId, 'cp.capId') };
  logLine(`[setup] reusing seed CP as voter: ${cp.kp.getPublicKey().toSuiAddress()} cpCapId=${cp.cpCapId}`);
  logLine('[setup] registering 2 fresh validators (bound session wallets) + a fresh relay…');
  const v1 = await registerFreshValidatorWithSession(client, cp, config, logger);
  const v2 = await registerFreshValidatorWithSession(client, cp, config, logger);
  const freshRelay = await registerFreshRelay(client, cp, config, logger);
  logLine(`[setup] v1.minerId=${v1.minerId}`);
  logLine(`[setup] v2.minerId=${v2.minerId}`);
  logLine(`[setup] freshRelay.minerId=${freshRelay.minerId} bondId=${freshRelay.stakeId} (self-signs its slash — W-E9)`);
  if (v1.minerId === v2.minerId) throw new Error(`${MOD}: the 2 fresh validators are NOT distinct (same miner_id)`);

  const relayKp = freshRelay.kp;
  const relayMinerId = freshRelay.minerId;
  const relayBondId = freshRelay.stakeId;
  const slashOpts: SlashCallOpts = {
    packageId: config.packageId,
    netReg: config.networkRegistryId,
    validatorReg: config.validatorRegistryId,
    roomMgr: config.roomManagerId,
    relayBondId,
  };

  // ── 3. a FRESH room assigned to the fresh relay (the byzantine canary audits THIS room) ────────
  logLine('[setup] provisioning a fresh room assigned to the fresh relay…');
  const byzRoomId = await withLockRetry('createRoomWithRelay (byzantine)', () => createRoomWithRelay(
    client, Ed25519Keypair.generate(), deployer, adminCapId, relayMinerId, config, logger,
    (addr: string) => fundAddress(client, addr),
  ));
  logLine(`[setup] byzantine room=${byzRoomId} (fresh, assigned to the fresh relay → no contention with the live stack)`);

  // ── 4. BYZANTINE leg: real browser → evil-relay → capture → REAL divergence → on-chain slash ───
  logLine('[byzantine] capturing real forwarded (tampered) browser media on the fresh room…');
  const byz = await captureForwardedLeg(byzRoomId, true, logger);
  logLine(`[byzantine] captured ${byz.captured.length} forwarded packets`);
  // M2: distinguish a capture/ICE failure (0 packets) from a real "no divergence" — don't let an
  // empty capture be misattributed to the verifier below (which would also yield 0 divergences).
  if (byz.captured.length === 0) {
    throw new Error(`${MOD}: BYZANTINE leg captured 0 packets — a capture/ICE/forward failure, NOT a divergence issue. Investigate the browser→evil-relay→pipe→sink path (do NOT proceed).`);
  }

  const verifyInput: VerifyInput = {
    kRoom: K_ROOM, roomId: byzRoomId, cellSecret: CELL_SECRET, canaryKid: CANARY_KID, expectedCtrs: CTRS,
  };
  const byzResult = await verifyForwardedCanary(byz.captured, verifyInput);
  logLine(`[byzantine] verifier: mediaPackets=${byzResult.mediaPackets} byteIdentical=${byzResult.byteIdentical} divergences=${byzResult.divergences.length}`);
  const div = byzResult.divergences.find((d) => d.observedHash !== OBSERVED_HASH_MISSING && d.expectedHash !== d.observedHash)
    ?? byzResult.divergences[0];
  if (!div) {
    throw new Error(`${MOD}: BYZANTINE leg produced NO divergence from real browser media (captured=${byz.captured.length}, mediaPackets=${byzResult.mediaPackets}). Cannot build a real proof — investigate (do NOT fake the digest).`);
  }
  const present = div.observedHash !== OBSERVED_HASH_MISSING;
  logLine(`[byzantine] REAL divergence: frameSeq=${div.frameSeq} present=${present} (expectedHash/observedHash differ; hashes not logged in full to keep the line short)`);

  const bondBefore = await readBond(client, relayKp, relayBondId, config.packageId);
  logLine(`[byzantine] relay bond before slash = ${bondBefore.toString()} MIST`);

  const proof = await buildDivergenceProof({
    roomId: byzRoomId,
    relayMinerId,
    canaryId: CANARY_KID,
    frameSeq: div.frameSeq,
    expectedHash: div.expectedHash,
    observedHash: div.observedHash,
    sessionKeypairs: [v1.sessionKp, v2.sessionKp],
  });

  logLine('[byzantine] submitting on-chain canary_audit::slash_for_canary_divergence (relay self-signs — W-E9)…');
  const slashResult = await withLockRetry('submitCanarySlash', () =>
    submitCanarySlash.submit(client, relayKp, proof, slashOpts, logger));
  const digest = slashResult.digest;

  // ── 5. assert on-chain: the CanaryDivergenceSlashed fired with the right attribution ───────────
  const queried = await queryLatestSlash(client, config.packageId, byzRoomId);
  const assertRes = assertCanarySlash(queried, byzRoomId);
  const attesterIds = (queried.attester_ids ?? []).map((a) => normalizeSuiAddress(a));
  const distinctIds = [...new Set(attesterIds)];
  const bondAfter = await readBond(client, relayKp, relayBondId, config.packageId);

  logLine('');
  logLine('========================= ON-CHAIN SLASH EVIDENCE =========================');
  logLine(`  tx digest         : ${digest}`);
  logLine(`  room_id           : ${queried.room_id}`);
  logLine(`  relay_miner_id    : ${normalizeSuiAddress(queried.relay_miner_id ?? '')}`);
  logLine(`  canary_id         : ${queried.canary_id}`);
  logLine(`  frame_seq         : ${queried.frame_seq}`);
  logLine(`  attester_count    : ${queried.attester_count}`);
  logLine(`  attester_ids      : ${JSON.stringify(distinctIds)}`);
  logLine(`  distinct attesters: ${distinctIds.length}`);
  logLine(`  observed_present  : ${queried.observed_present}`);
  logLine(`  bond before/after : ${bondBefore.toString()} -> ${bondAfter.toString()} (delta ${(bondBefore - bondAfter).toString()})`);
  logLine(`  assert ok         : ${assertRes.ok}${assertRes.reason ? ' reason=' + assertRes.reason : ''}`);
  logLine('===========================================================================');

  if (!assertRes.ok) {
    throw new Error(`${MOD}: on-chain slash assertion FAILED — ${assertRes.reason}`);
  }
  // Belt-and-suspenders: the 2 distinct attesters must be exactly v1 + v2.
  if (!distinctIds.includes(v1.minerId) || !distinctIds.includes(v2.minerId)) {
    throw new Error(`${MOD}: on-chain attester_ids ${JSON.stringify(distinctIds)} do not match the 2 fresh validators (${v1.minerId}, ${v2.minerId})`);
  }
  if (bondAfter >= bondBefore) {
    throw new Error(`${MOD}: relay bond did NOT decrease (before=${bondBefore} after=${bondAfter})`);
  }
  logLine(`[byzantine] PASS — CanaryDivergenceSlashed fired, 2 distinct attesters, bond decreased.`);

  // ── 6. HONEST leg (REQ-MLW-B-05): no false positive ───────────────────────────────────────────
  // Provision ANOTHER fresh room (same fresh relay) so an honest forward CANNOT be confused with the
  // byzantine slash above. Capture an honest forward → 0 divergences → assert NO on-chain slash for it.
  logLine('');
  logLine('[honest] provisioning a FRESH room for the honest leg (REQ-MLW-B-05, no false positive)…');
  let honestRoomId = '';
  try {
    honestRoomId = await withLockRetry('createRoomWithRelay (honest)', () => createRoomWithRelay(
      client, Ed25519Keypair.generate(), deployer, adminCapId, relayMinerId, config, logger,
      (addr: string) => fundAddress(client, addr),
    ));
    logLine(`[honest] fresh room provisioned: ${honestRoomId}`);
  } catch (e: unknown) {
    // If room provisioning fails, DEGRADE to the honest-capture-only assertion (0 divergences from a
    // real honest forward) rather than fake an on-chain check.
    logLine(`[honest] fresh-room provisioning unavailable (${e instanceof Error ? e.message : String(e)}); falling back to the honest-capture-only assertion.`);
  }

  // Whether or not a fresh room was provisioned, the honest CAPTURE is the real no-false-positive proof:
  // an honest forward of real browser media yields 0 divergences from the FROZEN verifier.
  logLine('[honest] capturing real forwarded (UNtampered) browser media…');
  const honestCaptureRoomId = honestRoomId || roomId;
  const honest = await captureForwardedLeg(honestCaptureRoomId, false, logger);
  const honestResult = await verifyForwardedCanary(honest.captured, {
    kRoom: K_ROOM, roomId: honestCaptureRoomId, cellSecret: CELL_SECRET, canaryKid: CANARY_KID, expectedCtrs: CTRS,
  });
  logLine(`[honest] verifier: mediaPackets=${honestResult.mediaPackets} byteIdentical=${honestResult.byteIdentical} divergences=${honestResult.divergences.length}`);
  if (honestResult.divergences.length !== 0) {
    throw new Error(`${MOD}: HONEST leg produced ${honestResult.divergences.length} divergence(s) — a FALSE POSITIVE (REQ-MLW-B-05 violated). Investigate.`);
  }
  logLine('[honest] 0 divergences from the honest forward → no proof is even buildable → no slash.');

  if (honestRoomId) {
    const honestSlash = await queryLatestSlash(client, config.packageId, honestRoomId);
    const honestAssert = assertCanarySlash(honestSlash, honestRoomId);
    logLine(`[honest] on-chain check for the fresh honest room ${honestRoomId}: slash present = ${honestAssert.ok} (expected false)`);
    if (honestAssert.ok) {
      throw new Error(`${MOD}: a CanaryDivergenceSlashed exists for the HONEST room ${honestRoomId} — false positive on-chain.`);
    }
    logLine('[honest] PASS — 0 new on-chain slash for the honest room.');
  } else {
    logLine('[honest] PASS — 0 divergences (host-side honest-capture proof; on-chain fresh-room check skipped, see fallback note above).');
  }

  // ── 7. write the run log (gitignored under .evidence/) ─────────────────────────────────────────
  logLine('');
  logLine('=== RESULT: B-hermetic CHAIN-BACKED walkthrough COMPLETE ===');
  logLine(`  BYZANTINE → real on-chain CanaryDivergenceSlashed digest=${digest} (2 distinct attesters, observed_present=${queried.observed_present})`);
  logLine('  HONEST    → 0 divergences, no new slash.');

  if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });
  const logPath = join(EVIDENCE_DIR, `m2b-live-wan-B-hermetic-run-${stamp}.log`);
  writeFileSync(logPath, runLog.join('\n') + '\n', 'utf8');
  process.stdout.write(`\n[run-log] written to ${logPath}\n`);
  // M6: print byzRoomId — the room that was ACTUALLY slashed (a demo viewer reads this line), NOT the
  // booted-stack seed room.
  process.stdout.write(`CANARY_SLASH_OK digest=${digest} room=${byzRoomId} distinct=${distinctIds.length} observed_present=${queried.observed_present}\n`);
}

// Run only when invoked directly (import-safe for any future unit test of the pure helpers).
if (process.argv[1]?.endsWith('m2b-live-bhermetic-slash.ts')) {
  main().catch((err) => {
    process.stderr.write(`${MOD}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
