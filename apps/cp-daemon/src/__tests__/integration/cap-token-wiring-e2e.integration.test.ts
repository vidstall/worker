/**
 * F62 M2 daemon-wiring W-P4 (REQ-ADW-003) — LIVE cap-token round-trip E2E.
 *
 * Proves the DECOUPLED production path end-to-end on a real localnet at
 * THRESHOLD=1 (D-W3 + ADR-0013):
 *
 *   RoomAssigned
 *     → PRODUCTION cp-daemon CapTokenIssuer.onRoomAssigned (via startCapTokenIssuer,
 *       selectProductionSubmitFn → makeCapTokenSubmitter — the REAL single-CP PTB
 *       dispatcher; buildLocalCpKeystore signs RAW ed25519 per the OQ-CRR-9 fix)
 *       publishes `CapabilityIssued` on-chain
 *     → PRODUCTION signaling CapTokenCache.subscribeToChainEvents polls
 *       `capability_events` and populates the cache
 *     → AuthHook.verifyJoin ACCEPTS a valid signed join, REJECTS a missing-token
 *       join, and REJECTS a revoked-token join.
 *
 * NO in-process cache injection (D-W2): the issuer publishes on-chain; signaling's
 * OWN cache + poller reads it. This is the production-faithful cross-process path.
 *
 * ── ADR-0013 unblock ───────────────────────────────────────────────────────
 * `room_capability::issue_capability_token` now asserts the mint floor against
 * the CONFIGURABLE `cp_quorum_sig::min_quorum(quorum_state)` (room_capability.move
 * :512) instead of the compile-time constant 2. So after `update_threshold(1)` a
 * single-CP quorum mints (no abort 918). The matching OQ-CRR-9 fix makes
 * buildLocalCpKeystore sign RAW ed25519 (index.ts:106/120) so the 1-of-1 quorum
 * sig passes Move `verify_quorum` (no abort 906).
 *
 * ── D-W10 peer-pubkey bridge (the key trick) ───────────────────────────────
 * The production issuer at cap-token-issuer.ts:629-638 does
 * `peerPubkey = hexToBytes(peer.id)` — it hex-decodes the miner-ID as the on-chain
 * peer_pubkey (real miner→pubkey resolution is the deferred Phase-3.1 gap). So
 * `AuthHook.verifyJoin` verifies the join signature against `hexToBytes(minerId)`.
 * To make the ACCEPT assertion pass on the REAL path WITHOUT silently capping
 * anything, we construct the RoomAssigned event so the peer ID is the HEX of a
 * REAL ed25519 public key we hold the keypair for:
 *     const peerKp = new Ed25519Keypair();
 *     const peerId = '0x' + hex(peerKp.getPublicKey().toRawBytes());  // 32 bytes
 * Then `hexToBytes(peerId)` === peerKp pubkey, the cache stores that pubkey, and
 * `signedJoin(peerKp, …)` verifies. We use ONLY a signaling peer (role 4) and keep
 * relayIds/validatorIds empty so we issue + assert on exactly one token. This is an
 * HONEST bridge of the Phase-3.1 placeholder (documented, no silent cap).
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), NEVER `pnpm test`.
 *
 * Setup the fixture does NOT provide (handled here):
 *   - QuorumConfigState: bootLocalnet does not create one. We recover the deployer
 *     signer + AdminCap from the sui CLI, call `cp_quorum_sig::create_config`, then
 *     `update_threshold(1)` so the on-chain quorum floor is 1.
 *   - CP enrollment: the issuer's signer must be a registered CP operator (so
 *     `is_operator_registered` passes in verify_quorum). We register 0.6 SUI →
 *     ControlPlaneCap → register_cp the issuer keypair.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { createLogger, type Logger } from '@dvconf/shared';

import { bootLocalnet, fundAddress, type LocalnetHandle, SUI_RPC_URL } from './localnet-fixture.js';
import { registerMiner, CP_STAKE_MIST, type BootstrapCpResult } from './revote-localnet-helpers.js';
import { startCapTokenIssuer } from '../../index.js';
import type { RoomAssignedEvent } from '../../cap-token-issuer.js';
import { CapTokenCache } from '../../../../signaling/src/cap-token-cache.js';
import { AuthHook, type JoinAuthMessage } from '../../../../signaling/src/auth.js';

const EPOCH_DURATION_MS = 2000;

// ── canonical join payload (BYTE-MIRRORS auth.ts buildCanonicalPayload) ─────

function buildCanonicalJoinPayload(roomId: string, peerPubkey: number[], nonce: number): Uint8Array {
  return bcs
    .struct('JoinPayload', {
      roomId: bcs.string(),
      peerPubkey: bcs.vector(bcs.u8()),
      nonce: bcs.u64(),
    })
    .serialize({ roomId, peerPubkey, nonce: BigInt(nonce) })
    .toBytes();
}

async function signedJoin(
  kp: Ed25519Keypair,
  roomId: string,
  tokenId: string,
  nonce: number,
): Promise<JoinAuthMessage> {
  const peerPubkey = Array.from(kp.getPublicKey().toRawBytes());
  const payload = buildCanonicalJoinPayload(roomId, peerPubkey, nonce);
  const sigBytes = await kp.sign(payload);
  const signature = Buffer.from(sigBytes).toString('base64');
  return { type: 'join', roomId, token: tokenId, signature, nonce };
}

/** Minimal ws stub — AuthHook.verifyJoin does not touch it on the verify path. */
function makeWsStub(): unknown {
  return { close: () => undefined, readyState: 1 };
}

// ── sui CLI helpers (recover the deployer signer + AdminCap, owned by it) ───

function runCli(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

/** Export the active sui-CLI deployer (which owns the AdminCap created at publish). */
async function loadDeployerSigner(): Promise<Ed25519Keypair> {
  const addr = (await runCli('sui', ['client', 'active-address'])).stdout.trim();
  const exp = await runCli('sui', ['keytool', 'export', '--key-identity', addr, '--json']);
  const parsed = JSON.parse(exp.stdout) as { exportedPrivateKey?: string };
  if (typeof parsed.exportedPrivateKey !== 'string') {
    throw new Error('loadDeployerSigner: keytool export returned no exportedPrivateKey');
  }
  return Ed25519Keypair.fromSecretKey(parsed.exportedPrivateKey);
}

interface SuiObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

/** Find the AdminCap object owned by the deployer. */
async function findAdminCap(client: SuiClient, packageId: string, owner: string): Promise<string> {
  const owned = await client.getOwnedObjects({
    owner,
    filter: { StructType: `${packageId}::network_registry::AdminCap` },
    options: { showType: true },
  });
  const first = owned.data[0];
  if (!first?.data?.objectId) throw new Error('findAdminCap: deployer owns no AdminCap');
  return first.data.objectId;
}

async function signAndExec(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
): Promise<{ status: string; error?: string; objectChanges: SuiObjectChange[]; digest: string }> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(100_000_000);
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const status = (res.effects?.status?.status as string) ?? 'unknown';
  const error = res.effects?.status?.error;
  return {
    status,
    ...(error !== undefined && { error }),
    objectChanges: (res.objectChanges ?? []) as SuiObjectChange[],
    digest: res.digest,
  };
}

/** Create the shared QuorumConfigState then lower its min_quorum floor to 1. */
async function setupQuorumState(
  client: SuiClient,
  deployer: Ed25519Keypair,
  packageId: string,
  networkRegistryId: string,
  adminCapId: string,
): Promise<string> {
  const create = await signAndExec(
    client,
    deployer,
    (tx) => {
      tx.moveCall({
        target: `${packageId}::cp_quorum_sig::create_config`,
        arguments: [tx.object(adminCapId)],
      });
    },
    'create_config',
  );
  if (create.status !== 'success') {
    throw new Error(`create_config failed: ${create.error ?? create.status}`);
  }
  const stateObj = create.objectChanges.find(
    (c) => c.type === 'created' && (c.objectType ?? '').includes('::cp_quorum_sig::QuorumConfigState'),
  );
  if (!stateObj?.objectId) throw new Error('setupQuorumState: QuorumConfigState not created');
  const quorumStateId = stateObj.objectId;

  // Lower the configurable min_quorum to 1 so verify_quorum + the ADR-0013 mint
  // floor both accept a single CP.
  const upd = await signAndExec(
    client,
    deployer,
    (tx) => {
      tx.moveCall({
        target: `${packageId}::cp_quorum_sig::update_threshold`,
        arguments: [
          tx.object(adminCapId),
          tx.object(networkRegistryId),
          tx.object(quorumStateId),
          tx.pure.u64(1n),
          tx.pure.address(deployer.toSuiAddress()),
        ],
      });
    },
    'update_threshold',
  );
  if (upd.status !== 'success') {
    throw new Error(`update_threshold(1) failed: ${upd.error ?? upd.status}`);
  }
  return quorumStateId;
}

/** Register the issuer keypair as a CP (0.6 SUI → ControlPlaneCap → register_cp). */
async function enrollIssuerCp(
  client: SuiClient,
  config: LocalnetHandle['config'],
  logger: Logger,
): Promise<BootstrapCpResult> {
  const kp = Ed25519Keypair.generate();
  await fundAddress(kp.getPublicKey().toSuiAddress());
  await new Promise((r) => setTimeout(r, 1500));
  const reg = await registerMiner(client, kp, config, CP_STAKE_MIST, logger);
  if (reg.cpCapId === null) throw new Error('enrollIssuerCp: expected a ControlPlaneCap from 0.6 SUI register');
  const cpCapId = reg.cpCapId;
  const enroll = await signAndExec(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(cpCapId),
          tx.object(reg.stakeId),
        ],
      });
    },
    'register_cp',
  );
  if (enroll.status !== 'success') throw new Error(`register_cp failed: ${enroll.error ?? enroll.status}`);
  return { kp, minerId: reg.minerId, cpCapId, stakeId: reg.stakeId };
}

describe('Cap-token wiring LIVE round-trip E2E (REQ-ADW-003, W-P4)', () => {
  let handle: LocalnetHandle;
  let deployer: Ed25519Keypair;
  let adminCapId: string;
  let quorumStateId: string;
  let cp: BootstrapCpResult;
  const logger: Logger = createLogger('wp4-cap-token-wiring-e2e');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    deployer = await loadDeployerSigner();
    adminCapId = await findAdminCap(handle.client, handle.config.packageId, deployer.toSuiAddress());
    quorumStateId = await setupQuorumState(
      handle.client,
      deployer,
      handle.config.packageId,
      handle.config.networkRegistryId,
      adminCapId,
    );
    cp = await enrollIssuerCp(handle.client, handle.config, logger);
  }, 300_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('RoomAssigned → issuer publishes CapabilityIssued → poller fills cache → verifyJoin accept / reject(missing) / reject(revoked)', async () => {
    const client = new SuiClient({ url: SUI_RPC_URL });

    // D-W10 bridge: peer ID = hex of a REAL ed25519 pubkey we hold (32 bytes).
    const peerKp = new Ed25519Keypair();
    const peerId = '0x' + Buffer.from(peerKp.getPublicKey().toRawBytes()).toString('hex');

    // The room id is a Move `address` primitive — any 32-byte hex works for the test.
    const roomId = '0x' + Buffer.from(new Ed25519Keypair().getPublicKey().toRawBytes()).toString('hex');

    // ── Wire the PRODUCTION issuer at THRESHOLD=1 with the REAL client/signer ──
    // selectProductionSubmitFn picks makeCapTokenSubmitter (live PTB dispatch).
    const { issuer, stop } = await startCapTokenIssuer({
      client,
      signer: cp.kp, // the enrolled CP operator key — buildLocalCpKeystore signs RAW with it
      packageId: handle.config.packageId,
      networkRegistryId: handle.config.networkRegistryId,
      cpRegistryObjectId: handle.config.cpRegistryId,
      quorumStateObjectId: quorumStateId,
      quorumThreshold: 1,
      logger,
    });

    // ── Stand up signaling's OWN cache + REAL poller (decoupled path, D-W2) ──
    const cache = new CapTokenCache({ logger, ttlMs: 600_000 });
    const unsubscribe = await cache.subscribeToChainEvents(client, handle.config.packageId, {
      pollIntervalMs: 2000,
    });

    // currentEpoch is fixed at verify time (the token expires far in the future).
    const epochAtVerify = BigInt((await client.getLatestSuiSystemState()).epoch);
    const hook = new AuthHook({
      cache,
      currentEpoch: () => epochAtVerify,
      logger,
    });

    try {
      // ── Stage A: drive RoomAssigned through the PRODUCTION issuer ──────────
      const event: RoomAssignedEvent = {
        roomId,
        relayIds: [],
        signalingId: peerId, // role 4; hex of peerKp's pubkey (D-W10)
        relayMode: 1,
        verifiedScore: '900',
        consensusReached: true,
        winningCp: cp.minerId,
        validatorIds: [],
      };
      await issuer.onRoomAssigned(event, 'wp4-room-assigned');

      // ── Stage B: read the issued token's object id from the chain event ────
      const peerPubkeyArr = Array.from(peerKp.getPublicKey().toRawBytes());
      const tokenId = await pollForIssuedTokenId(client, handle.config.packageId, peerPubkeyArr, 30_000);
      expect(tokenId).not.toBeNull();

      // ── Stage C: await the REAL poller landing the token in the cache ──────
      await pollUntil(() => cache.get(tokenId!) !== null, 30_000, 'cache populated by poller');
      const cached = cache.get(tokenId!);
      expect(cached).not.toBeNull();
      expect(cached!.roomId).toBe(roomId);
      expect(cached!.peerPubkey).toEqual(peerPubkeyArr);
      expect(cached!.role).toBe(4);

      // ── Stage D: ACCEPT a valid signed join ────────────────────────────────
      const okJoin = await signedJoin(peerKp, roomId, tokenId!, cached!.nonce + 1);
      const okResult = await hook.verifyJoin(okJoin, makeWsStub() as never, 'wp4-accept');
      expect(okResult.accepted).toBe(true);
      expect(okResult.reason).toBeUndefined();

      // ── Stage E: REJECT a missing-token join ───────────────────────────────
      const missingJoin = await signedJoin(peerKp, roomId, '0xunknown', 99);
      const missingResult = await hook.verifyJoin(missingJoin, makeWsStub() as never, 'wp4-missing');
      expect(missingResult.accepted).toBe(false);
      expect(missingResult.reason).toBe('no-token');
      expect(missingResult.closeCode).toBe(4401);

      // ── Stage F: REJECT a revoked-token join ───────────────────────────────
      // REAL on-chain revoke at threshold=1 (direct PTB mirroring F5
      // revoke-cap-token.ts arg order: registry, cp_reg, quorum_state, cap, reason,
      // qs, signer_pubkeys — NO aggregate_sig per D-011). Signed RAW ed25519 over
      // BCS(cap_id || reason), matching Move verify_quorum.
      await revokeCapTokenLive(client, cp.kp, handle.config, quorumStateId, tokenId!, 1, logger);
      // Poll until the poller's CapabilityRevoked eviction lands.
      await pollUntil(() => cache.get(tokenId!) === null, 30_000, 'cache evicted after revoke');
      const revokedJoin = await signedJoin(peerKp, roomId, tokenId!, cached!.nonce + 2);
      const revokedResult = await hook.verifyJoin(revokedJoin, makeWsStub() as never, 'wp4-revoked');
      expect(revokedResult.accepted).toBe(false);
      // Cache eviction → 'no-token' (no chainProbe wired here). Either is correct
      // per the brief; we assert the join is REJECTED.
      expect(['no-token', 'revoked']).toContain(revokedResult.reason);
    } finally {
      await unsubscribe();
      stop();
    }
  });
});

// ── live revoke (direct PTB, single-CP, raw-ed25519 quorum sig) ─────────────

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

async function revokeCapTokenLive(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: LocalnetHandle['config'],
  quorumStateId: string,
  capId: string,
  reason: number,
  logger: Logger,
): Promise<void> {
  // Canonical msg = id_to_bytes(cap) || reason (room_capability.move:601-605).
  const canonicalMsg = new Uint8Array([...hexToBytes(capId), reason & 0xff]);
  const sig = await signer.sign(canonicalMsg); // RAW ed25519 (matches verify_quorum)
  const signature = Array.from(sig.slice(0, 64));
  const pubkey = Array.from(signer.getPublicKey().toRawBytes());
  const signerAddr = signer.toSuiAddress();

  const tx = new Transaction();
  const qsArg = tx.moveCall({
    target: `${config.packageId}::cp_quorum_sig::new_quorum_sig`,
    arguments: [
      tx.pure.vector('address', [signerAddr]),
      tx.pure.vector('vector<u8>', [signature]),
    ],
  });
  tx.moveCall({
    target: `${config.packageId}::room_capability::revoke_capability_token_via_quorum`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(config.cpRegistryId),
      tx.object(quorumStateId),
      tx.object(capId),
      tx.pure.u8(reason),
      qsArg,
      tx.pure.vector('vector<u8>', [pubkey]),
    ],
  });
  tx.setGasBudget(100_000_000);
  const res = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  const status = (res.effects?.status?.status as string) ?? 'unknown';
  if (status !== 'success') {
    throw new Error(`revoke_capability_token_via_quorum failed: ${res.effects?.status?.error ?? status}`);
  }
  logger.info({ module: 'wp4-e2e', digest: res.digest }, 'live revoke confirmed');
}

// ── poll helpers ────────────────────────────────────────────────────────────

async function pollForIssuedTokenId(
  client: SuiClient,
  packageId: string,
  peerPubkey: number[],
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const target = peerPubkey.join(',');
  while (Date.now() < deadline) {
    const page = await client.queryEvents({
      query: { MoveEventModule: { package: packageId, module: 'capability_events' } },
      limit: 50,
      order: 'descending',
    });
    for (const ev of page.data) {
      if (!ev.type.endsWith('::CapabilityIssued')) continue;
      const data = ev.parsedJson as { token_id?: string; peer_pubkey?: number[] };
      if (Array.isArray(data.peer_pubkey) && data.peer_pubkey.join(',') === target && data.token_id) {
        return data.token_id;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function pollUntil(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`pollUntil timed out (${timeoutMs}ms): ${label}`);
}
