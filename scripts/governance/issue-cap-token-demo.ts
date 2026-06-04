/**
 * F5 (W1 defense-demo, Phase 2) — single-CP cap-token ISSUE seeder CLI.
 *
 * Seeds a REAL, revocable `RoomCapability` admission token on-chain so a later
 * demo scenario can revoke it (paired with the sibling `revoke-cap-token.ts`).
 * The production `buildCapTokenTx` is NOT exported from cp-daemon's public API, so
 * this builds the issue PTB INLINE — mirroring `revoke-cap-token.ts` (two chained
 * moveCalls: `cp_quorum_sig::new_quorum_sig` -> the issue entry) and the W-P4
 * integration test `apps/cp-daemon/src/__tests__/integration/cap-token-wiring-e2e
 * .integration.test.ts` (live revoke helper).
 *
 * Single-CP signing (D-014 / ADR-0013 / OQ-CRR-9): the canonical issue message is
 * signed RAW ed25519 (NO Sui intent wrap — else Move `verify_quorum` aborts 906),
 * and the on-chain mint floor reads the CONFIGURABLE `cp_quorum_sig::min_quorum`
 * (NOT a hardcoded 2), so a 1-of-1 quorum mints once `update_threshold(1)` has been
 * run on the QuorumConfigState. This CLI only signs/submits the single-CP path;
 * multi-CP quorum collection is the same deferred boundary as the revoke sibling.
 *
 * Canonical-msg construction is INLINED here (81-byte raw concat, byte-mirroring
 * `cap-token-issuer.ts buildIssueCanonicalMsg` + Move room_capability.move:473-482):
 * `scripts/` cannot resolve the `@dvconf/cp-daemon/...` cross-package specifier at
 * runtime under tsx (no workspace symlink for the root/scripts package), so we copy
 * the construction + the small `hexToBytes`/`u64Le` helpers rather than import them.
 *
 * Run (single-CP demo):
 *   pnpm --dir dvconf-daemons exec tsx scripts/governance/issue-cap-token-demo.ts \
 *     --quorum-state <objectId> [--room-id 0x..] [--role 0] [--nonce 1] [--expires-epoch N]
 * Env (same as the daemons): PACKAGE_ID, NETWORK_REGISTRY_ID, CP_REGISTRY_ID, …,
 *   RPC_URL, SUI_PRIVATE_KEY (the local CP operator key). --quorum-state may instead
 *   be supplied via QUORUM_STATE_OBJECT_ID; CP_REGISTRY_ID falls back to the
 *   NetworkConfig.cpRegistryId field.
 *
 * Prints EXACTLY one machine-parseable line on success (a later scenario sed-parses it):
 *   RoomCapability id=0x<objectId>
 */

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  executeWithRetry,
  loadKeypair,
  extractCreatedObjectByType,
} from '@dvconf/shared';

const MODULE = 'issue-cap-token-demo';

/** Decode a `0x`-prefixed hex string to its raw bytes (mirrors cap-token-issuer.ts). */
function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/** Encode a u64 as 8 little-endian bytes (mirrors Move's `bcs_u64_le`). */
function u64Le(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

/**
 * Build the canonical ISSUE payload the CP quorum signs off-chain. INLINED copy of
 * `cap-token-issuer.ts buildIssueCanonicalMsg` (byte-for-byte parity with Move
 * `room_capability::issue_capability_token` raw concat, room_capability.move:473-482).
 *
 * Layout: id_to_bytes(room_id) || peer_pubkey || role(u8)
 *         || bcs_u64_le(expires_epoch) || bcs_u64_le(nonce)   (= 81 bytes for a
 *         32-byte room_id + 32-byte peer_pubkey)
 */
export function buildIssueCanonicalMsg(opts: {
  roomId: string;
  peerPubkey: number[];
  role: number;
  expiresEpoch: bigint;
  nonce: bigint;
}): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...hexToBytes(opts.roomId));
  bytes.push(...opts.peerPubkey);
  bytes.push(opts.role & 0xff);
  bytes.push(...u64Le(opts.expiresEpoch));
  bytes.push(...u64Le(opts.nonce));
  return new Uint8Array(bytes);
}

export interface IssueDemoArgs {
  /** Room id (Move `address` primitive). */
  roomId: string;
  /** Peer ed25519 pubkey — 32 bytes (Move asserts len==32, abort 916). */
  peerPubkey: number[];
  /** Capability role (u8). */
  role: number;
  /** Token expiry epoch (Move asserts > current epoch, abort 901; > issued, abort 917). */
  expiresEpoch: bigint;
  /** Replay nonce (u64). */
  nonce: bigint;
  /** Signing CP's Sui address (parallel to qs.signatures[0]). */
  signerAddr: string;
  /** Raw ed25519 signature over the canonical msg, 64 bytes. */
  signature: number[];
  /** Signing CP's raw ed25519 pubkey, 32 bytes. */
  pubkey: number[];
  /** Aggregate sig prefix-tagged single-CP: [0x01, ...sig64]. */
  aggregateSig: number[];
}

/**
 * Pure inline issue PTB: `cp_quorum_sig::new_quorum_sig` (qsArg) ->
 * `room_capability::issue_capability_token`. Arg order mirrors the Move entry exactly
 * (registry, cp_reg, quorum_state, room_id, peer_pubkey, role, expires_epoch, nonce,
 * qs, signer_pubkeys, aggregate_sig) — `ctx` is implicit in a PTB. `new_quorum_sig`
 * takes (signers: vector<address>, signatures: vector<vector<u8>>) — addresses first.
 */
export function buildIssueDemoTx(
  tx: Transaction,
  config: { packageId: string; networkRegistryId: string; cpRegistryId: string; quorumStateId: string },
  args: IssueDemoArgs,
): void {
  const qsArg = tx.moveCall({
    target: `${config.packageId}::cp_quorum_sig::new_quorum_sig`,
    arguments: [
      tx.pure.vector('address', [args.signerAddr]), // signers: vector<address>
      tx.pure.vector('vector<u8>', [args.signature]), // signatures: vector<vector<u8>>
    ],
  });
  tx.moveCall({
    target: `${config.packageId}::room_capability::issue_capability_token`,
    arguments: [
      tx.object(config.networkRegistryId), // registry: &NetworkRegistry
      tx.object(config.cpRegistryId), // cp_reg: &ControlPlaneRegistry
      tx.object(config.quorumStateId), // quorum_state: &QuorumConfigState
      tx.pure.address(args.roomId), // room_id: address
      tx.pure.vector('u8', args.peerPubkey), // peer_pubkey: vector<u8>
      tx.pure.u8(args.role), // role: u8
      tx.pure.u64(args.expiresEpoch), // expires_epoch: u64
      tx.pure.u64(args.nonce), // nonce: u64
      qsArg, // qs: QuorumSig (threaded)
      tx.pure.vector('vector<u8>', [args.pubkey]), // signer_pubkeys: vector<vector<u8>>
      tx.pure.vector('u8', args.aggregateSig), // aggregate_sig: vector<u8>
    ],
  });
}

/** Parse `<flag> <value>` from an argv slice. Returns null when absent/empty. */
export function parseFlag(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) return next;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  const argv = process.argv.slice(2);

  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const signer = loadKeypair('SUI_PRIVATE_KEY'); // the single CP operator

  // ── QuorumConfigState id (NOT carried by NetworkConfig) ──────────────────
  const quorumStateId = parseFlag(argv, '--quorum-state') ?? process.env['QUORUM_STATE_OBJECT_ID'] ?? null;
  if (!quorumStateId) {
    process.stderr.write(
      'issue-cap-token-demo: --quorum-state <objectId> (or QUORUM_STATE_OBJECT_ID) is required\n',
    );
    process.exit(2);
    return;
  }
  // CP registry id: NetworkConfig.cpRegistryId, with an explicit env fallback.
  const cpRegistryId = config.cpRegistryId || process.env['CP_REGISTRY_OBJECT_ID'] || '';
  if (!cpRegistryId) {
    process.stderr.write('issue-cap-token-demo: no cpRegistryId (set CP_REGISTRY_ID)\n');
    process.exit(2);
    return;
  }

  // ── demo args (defaults sane for a seed token) ───────────────────────────
  // room id: a fresh random 32-byte 0x hex unless overridden.
  const roomId = parseFlag(argv, '--room-id') ?? `0x${randomBytes(32).toString('hex')}`;
  const roleRaw = parseFlag(argv, '--role');
  const role = roleRaw === null ? 0 : Number(roleRaw);
  const nonceRaw = parseFlag(argv, '--nonce');
  const nonce = nonceRaw === null ? 1n : BigInt(nonceRaw);

  // expires-epoch: explicit flag, else current epoch + 100 (sane margin > current,
  // satisfying Move asserts 901 expires>current and 917 expires>issued).
  const expiresRaw = parseFlag(argv, '--expires-epoch');
  let expiresEpoch: bigint;
  if (expiresRaw !== null) {
    expiresEpoch = BigInt(expiresRaw);
  } else {
    const sys = await client.getLatestSuiSystemState();
    expiresEpoch = BigInt(sys.epoch) + 100n;
  }

  // peer_pubkey: for a seed token, use the CP's OWN raw ed25519 pubkey (32 bytes,
  // satisfies the len==32 assert 916). Documented choice — a later scenario only
  // needs the token to EXIST and be revocable, not to be join-verifiable here.
  const peerPubkey = Array.from(signer.getPublicKey().toRawBytes());

  // ── single-CP RAW ed25519 quorum signature over the canonical issue msg ──
  const canonicalMsg = buildIssueCanonicalMsg({ roomId, peerPubkey, role, expiresEpoch, nonce });
  const sig = await signer.sign(canonicalMsg);
  const sig64 = Array.from(sig.slice(0, 64));
  const pubkey = Array.from(signer.getPublicKey().toRawBytes());
  const signerAddr = signer.toSuiAddress();
  const aggregateSig = [0x01, ...sig64];

  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) =>
      buildIssueDemoTx(
        tx,
        { packageId: config.packageId, networkRegistryId: config.networkRegistryId, cpRegistryId, quorumStateId },
        { roomId, peerPubkey, role, expiresEpoch, nonce, signerAddr, signature: sig64, pubkey, aggregateSig },
      ),
    'issue-capability-token',
    logger,
  );
  if (result === null) {
    throw new Error('issue-cap-token-demo: executeWithRetry exhausted retries (no TxResult)');
  }

  // Assert the CapabilityIssued event is present (room_capability emits it via the
  // shared base `capability_events::CapabilityIssued` struct).
  const issuedEvent = result.events.find(
    (e) => typeof e['type'] === 'string' && (e['type'] as string).endsWith('::capability_events::CapabilityIssued'),
  );
  if (!issuedEvent) {
    throw new Error(
      `issue-cap-token-demo: no ::capability_events::CapabilityIssued event in tx ${result.digest}`,
    );
  }

  // Parse the created RoomCapability object id from objectChanges.
  const capId = extractCreatedObjectByType(result, '::room_capability::RoomCapability');
  if (!capId) {
    throw new Error(
      `issue-cap-token-demo: no created ::room_capability::RoomCapability in tx ${result.digest}`,
    );
  }

  logger.info(
    {
      module: MODULE,
      action: 'issue_cap_token',
      context: { capId, roomId, role, nonce: nonce.toString(), expiresEpoch: expiresEpoch.toString() },
      digest: result.digest,
    },
    'Cap-token issued on-chain (seed for revoke demo)',
  );
  // Machine-parseable line (later scenario sed-parses this EXACT shape).
  process.stdout.write(`RoomCapability id=${capId}\n`);
}

// Only run when executed directly (`tsx issue-cap-token-demo.ts …`); stays inert on
// import so the unit test can exercise the builder without firing the CLI.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`issue-cap-token-demo: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
