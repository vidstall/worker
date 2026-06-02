/**
 * F5 (REQ-CRR-001 / REQ-CRR-002) — pre-TTL capability-token revoke trigger CLI.
 *
 * Lets a CP OPERATOR proactively revoke a RoomCapability admission token BEFORE its
 * TTL expires (operator error / key compromise) by submitting the EXISTING
 * `room_capability::revoke_capability_token_via_quorum` entry. No new Move entry —
 * D2 (CONTEXT): pre-TTL revoke == revoke-before-expires_epoch, which the shipped
 * quorum entry already does; the genuine gap was the proactive daemon trigger.
 *
 * Shape note (resolved vs as-built, NOT the plan default): the ROADMAP said "model
 * on request-revote.ts" — but that sibling calls a 4-object single-signer entry with
 * NO quorum signature. `revoke_capability_token_via_quorum` instead takes a
 * `QuorumSig` value + `signer_pubkeys`, so this builder mirrors
 * `governance-coordinator.ts makeGovernanceSubmitter` (two chained moveCalls:
 * `cp_quorum_sig::new_quorum_sig` -> the revoke entry) and reuses the same
 * `collectQuorumSignatures(canonicalMsg, threshold)` keystore seam the cap-token
 * issuer + governance coordinator use.
 *
 * Deferral boundary (D-014, NO silent cap): multi-CP quorum collection
 * (threshold >= 2, peer-CP discovery) throws cleanly. A single-CP / threshold-1
 * config exercises the full trigger + PTB-construction + sign path. On-chain
 * quorum-signature byte-parity at threshold-1 is the SAME live-verification item
 * deferred for the governance quorum path; this CLI signs RAW ed25519 over the
 * canonical message (matching Move `verify_quorum` + gen-governance-sig-fixture.ts),
 * which differs from index.ts `buildLocalCpKeystore`'s `signPersonalMessage`
 * (intent-wrapped) — see OQ-CRR-9.
 *
 * Idempotency: a re-revoke of an already-revoked token aborts on-chain with
 * E_TOKEN_ALREADY_REVOKED=907 (room_capability.move:599). This layer does NOT catch
 * errors from executeWithRetry, so that abort propagates (-> main() exits 1) rather
 * than being swallowed (unit-proven by the "propagates an executeWithRetry rejection"
 * test). The full LIVE re-revoke round-trip (submit -> re-submit -> observe 907) is a
 * localnet-integration item, deferred with the quorum-submit path (same boundary as
 * governance-coordinator, whose quorum submit is likewise integration-deferred).
 *
 * Run (single-CP demo):
 *   pnpm --dir dvconf-daemons exec tsx scripts/governance/revoke-cap-token.ts \
 *     --cap-token <objectId> --quorum-state <objectId> [--reason 0|1|2] [--threshold 1]
 * Env (same as the daemons): PACKAGE_ID, NETWORK_REGISTRY_ID, CP_REGISTRY_ID, …,
 *   RPC_URL, SUI_PRIVATE_KEY (the local CP operator key).
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  loadKeypair,
  executeWithRetry,
  type NetworkConfig,
  type Logger,
  type QuorumSig,
} from '@dvconf/shared';

const MODULE = 'cap-token-revoke';

/** Revocation reason enum (D-002), shared with the room_capability Move entry. */
export const REVOKE_REASON = { NORMAL: 0, SLASH: 1, ADMIN: 2 } as const;
const MAX_REASON = 2;

/** D-B4 default M-of-N quorum threshold. Single-CP demo passes `--threshold 1`. */
export const DEFAULT_QUORUM_THRESHOLD = 2;

/**
 * Quorum-signature collection seam (subset of cap-token-issuer.ts `CpKeystore`).
 * `revoke` does NOT consume `aggregateSig` (D-011), so this narrows the return to
 * what the revoke PTB needs. Throws when an M-of-N quorum cannot be assembled.
 */
export interface QuorumCollector {
  collectQuorumSignatures(
    canonicalMsg: Uint8Array,
    threshold: number,
  ): Promise<{ qs: QuorumSig; pubkeys: number[][] }>;
}

/** Throw if `reason` is not one of the enum values 0=normal/1=slash/2=admin. */
export function assertValidRevokeReason(reason: number): void {
  if (!Number.isInteger(reason) || reason < 0 || reason > MAX_REASON) {
    throw new Error(
      `revoke-cap-token: reason out of enum (0=normal, 1=slash, 2=admin), got ${reason}`,
    );
  }
}

/** Decode a `0x`-prefixed hex object id to its raw bytes. */
function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Build the canonical revoke message the CP quorum signs. Byte-for-byte parity with
 * room_capability.move:601-605 — `id_to_bytes(cap)` (32 bytes) ++ `[reason]` (1 u8).
 */
export function buildRevokeCanonicalMsg(capId: string, reason: number): Uint8Array {
  return new Uint8Array([...hexToBytes(capId), reason & 0xff]);
}

export interface RevokeCapTokenArgs {
  /** QuorumConfigState object id — NOT carried by NetworkConfig (cap-token-issuer convention). */
  quorumStateId: string;
  /** Target RoomCapability object id to revoke. */
  capId: string;
  /** Revocation reason (validated against the enum). */
  reason: number;
  /** Collected quorum signature struct (parallel signers/signatures arrays). */
  qs: QuorumSig;
  /** ed25519 pubkeys parallel to qs.signers. */
  signerPubkeys: number[][];
}

/**
 * Add the quorum-revoke moveCalls to a PTB. Reconstructs the `QuorumSig` Move struct
 * via a nested `cp_quorum_sig::new_quorum_sig` call (its result threaded into arg 6),
 * then invokes `revoke_capability_token_via_quorum`. Arg order mirrors
 * room_capability.move:586 exactly (registry, cp_reg, quorum_state, cap, reason, qs,
 * signer_pubkeys) — `ctx` is implicit in a PTB.
 */
export function buildRevokeCapTokenTx(
  tx: Transaction,
  config: NetworkConfig,
  args: RevokeCapTokenArgs,
): void {
  assertValidRevokeReason(args.reason);
  const qsArg = tx.moveCall({
    target: `${config.packageId}::cp_quorum_sig::new_quorum_sig`,
    arguments: [
      tx.pure.vector('address', args.qs.signers), // signers: vector<address>
      tx.pure.vector('vector<u8>', args.qs.signatures), // signatures: vector<vector<u8>>
    ],
  });
  tx.moveCall({
    target: `${config.packageId}::room_capability::revoke_capability_token_via_quorum`,
    arguments: [
      tx.object(config.networkRegistryId), // registry: &NetworkRegistry
      tx.object(config.cpRegistryId), // cp_reg: &ControlPlaneRegistry
      tx.object(args.quorumStateId), // quorum_state: &QuorumConfigState
      tx.object(args.capId), // cap: &mut RoomCapability
      tx.pure.u8(args.reason), // reason: u8
      qsArg, // qs: QuorumSig (threaded)
      tx.pure.vector('vector<u8>', args.signerPubkeys), // signer_pubkeys: vector<vector<u8>>
    ],
  });
}

export interface SubmitRevokeArgs {
  quorumStateId: string;
  capId: string;
  reason: number;
  /** M-of-N threshold to collect; defaults to {@link DEFAULT_QUORUM_THRESHOLD}. */
  threshold?: number;
}

/**
 * Collect the CP quorum over the revoke canonical message, then sign + submit the
 * revoke TX. Out-of-enum reasons are rejected BEFORE any signing or submission. The
 * on-chain idempotency guard (E_TOKEN_ALREADY_REVOKED=907) surfaces as a thrown
 * error (not swallowed).
 */
export async function submitRevokeCapToken(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  args: SubmitRevokeArgs,
  keystore: QuorumCollector,
  logger: Logger,
): Promise<void> {
  assertValidRevokeReason(args.reason);
  const traceId = randomUUID();
  const threshold = args.threshold ?? DEFAULT_QUORUM_THRESHOLD;
  const canonicalMsg = buildRevokeCanonicalMsg(args.capId, args.reason);
  const { qs, pubkeys } = await keystore.collectQuorumSignatures(canonicalMsg, threshold);
  await executeWithRetry(
    client,
    signer,
    (tx: Transaction) =>
      buildRevokeCapTokenTx(tx, config, {
        quorumStateId: args.quorumStateId,
        capId: args.capId,
        reason: args.reason,
        qs,
        signerPubkeys: pubkeys,
      }),
    'revoke-cap-token',
    logger,
  );
  logger.info(
    {
      trace_id: traceId,
      module: MODULE,
      action: 'revoke_cap_token',
      context: { capId: args.capId, reason: args.reason },
    },
    'Cap-token pre-TTL revoke TX confirmed on-chain',
  );
}

/**
 * Single-CP quorum collector for the M1 demo. Signs the canonical message with the
 * local operator key (RAW ed25519, no Sui intent wrap — matches Move `verify_quorum`
 * + gen-governance-sig-fixture.ts:76). Throws cleanly at threshold >= 2 because
 * peer-CP discovery is deferred (D-014).
 */
export function makeSingleCpKeystore(signer: Ed25519Keypair): QuorumCollector {
  return {
    async collectQuorumSignatures(canonicalMsg: Uint8Array, threshold: number) {
      if (threshold > 1) {
        throw new Error(
          `revoke-cap-token: multi-CP quorum collection deferred ` +
            `(threshold=${threshold}, peer-CP discovery pending, D-014). Single-CP/threshold-1 only for M1.`,
        );
      }
      const sig = await signer.sign(canonicalMsg);
      const signature = Array.from(sig.slice(0, 64));
      const pubkey = Array.from(signer.getPublicKey().toRawBytes());
      return {
        qs: { signers: [signer.toSuiAddress()], signatures: [signature] },
        pubkeys: [pubkey],
      };
    },
  };
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
  const capId = parseFlag(argv, '--cap-token');
  const quorumStateId = parseFlag(argv, '--quorum-state');
  if (!capId || !quorumStateId) {
    process.stderr.write(
      'revoke-cap-token: --cap-token <objectId> and --quorum-state <objectId> are required\n',
    );
    process.exit(2);
    return;
  }
  const reasonRaw = parseFlag(argv, '--reason');
  const reason = reasonRaw === null ? REVOKE_REASON.NORMAL : Number(reasonRaw);
  assertValidRevokeReason(reason);
  const thresholdRaw = parseFlag(argv, '--threshold');
  const threshold = thresholdRaw === null ? DEFAULT_QUORUM_THRESHOLD : Number(thresholdRaw);

  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const signer = loadKeypair('SUI_PRIVATE_KEY');
  const keystore = makeSingleCpKeystore(signer);
  await submitRevokeCapToken(client, signer, config, { quorumStateId, capId, reason, threshold }, keystore, logger);
  process.stdout.write(`${JSON.stringify({ ok: true, capId, reason })}\n`);
}

// Only run when executed directly (`tsx revoke-cap-token.ts …`); stays inert on
// import so the unit test can exercise the builder without firing the CLI.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`revoke-cap-token: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
