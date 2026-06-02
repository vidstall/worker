/**
 * W-P1 (REQ-ADW-001, D-W6) — production single-CP capability-token SubmitFn.
 *
 * The `CapTokenIssuer` prepares args and delegates submission opaquely to an injected
 * `SubmitFn` (cap-token-issuer.ts:49). In production that slot was `makeDeferredSubmit`
 * (index.ts), which THROWS — so a live CP daemon published nothing on-chain. This module
 * supplies the real dispatcher for the **single-CP (1-of-1) quorum** path: it takes the
 * issuer's prepared args (target + registries + quorum proof + sigs) and builds/dispatches
 * the matching `room_capability` PTB via `executeWithRetry`.
 *
 * Byte-shape mirrors the shipped F5 `scripts/governance/revoke-cap-token.ts` builder +
 * F47 `governance-coordinator.ts makeGovernanceSubmitter` (two chained moveCalls:
 * `cp_quorum_sig::new_quorum_sig` -> the room_capability entry). Arg ORDER is locked
 * against the Move signatures (room_capability.move):
 *   - issue_capability_token   (11 args): registry, cp_reg, quorum_state, room_id,
 *       peer_pubkey, role, expires_epoch, nonce, qs, signer_pubkeys, aggregate_sig
 *   - refresh_capability_token (9 args):  registry, cp_reg, quorum_state, old_token,
 *       new_role, new_expires_epoch, cp_quorum_proof, signer_pubkeys, aggregate_sig
 *       (NO nonce arg — on-chain reads the stored token nonce)
 *   - revoke_capability_token_via_quorum (7 args): registry, cp_reg, quorum_state, cap,
 *       reason, qs, signer_pubkeys   (NO aggregate_sig — D-011)
 * `room_id` is a Move `address` primitive -> `tx.pure.address` (NOT `tx.object`).
 *
 * D-014 orthogonality: this is the PTB-dispatch mechanism for threshold==1 only. The
 * single-CP quorum proof is assembled upstream by `buildLocalCpKeystore` (index.ts) with
 * NO peer CPs. Multi-CP M-of-N peer discovery stays DEFERRED (makeDeferredSubmit at
 * threshold>=2). This module does NOT sign — it serializes the already-collected proof.
 *
 * NOTE (carried, NOT this module): the on-chain signature byte-parity of the single-CP
 * keystore (`buildLocalCpKeystore` signs intent-wrapped via signPersonalMessage, vs the
 * F5 CLI's raw ed25519 — OQ-CRR-9) is verified live in the W-P4 round-trip E2E, not here.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { randomUUID } from 'node:crypto';
import { executeWithRetry, type Logger, type QuorumSig } from '@dvconf/shared';
import type { SubmitFn, SubmitResult } from './cap-token-issuer.js';

const MODULE = 'cap-token-submitter';

/** The three submit labels the issuer emits (cap-token-issuer.ts submit call sites). */
export const CAP_TOKEN_LABELS = {
  ISSUE: 'issue-capability-token',
  REFRESH: 'refresh-capability-token',
  REVOKE: 'revoke-capability-token-via-quorum',
} as const;

type CapTokenLabel = (typeof CAP_TOKEN_LABELS)[keyof typeof CAP_TOKEN_LABELS];

// ── Arg shapes (subset of the issuer's submitFn `args` record this module reads) ──

interface CommonArgs {
  networkRegistryId: string;
  cpRegistryObjectId: string;
  quorumStateObjectId: string;
  cpQuorumProof: QuorumSig;
  signerPubkeys: number[][];
}

export interface IssueCapTokenArgs extends CommonArgs {
  roomId: string;
  peerPubkey: number[];
  role: number;
  expiresEpoch: bigint;
  nonce: number;
  aggregateSig: number[];
}

export interface RefreshCapTokenArgs extends CommonArgs {
  oldTokenId: string;
  newRole: number;
  newExpiresEpoch: bigint;
  aggregateSig: number[];
}

export interface RevokeCapTokenArgs extends CommonArgs {
  capObjectId: string;
  reason: number;
}

/** Reconstruct the on-chain `QuorumSig` from its parallel arrays (nested moveCall). */
function quorumSigArg(tx: Transaction, config: { packageId: string }, qs: QuorumSig) {
  return tx.moveCall({
    target: `${config.packageId}::cp_quorum_sig::new_quorum_sig`,
    arguments: [
      tx.pure.vector('address', qs.signers), // signers: vector<address>
      tx.pure.vector('vector<u8>', qs.signatures), // signatures: vector<vector<u8>>
    ],
  });
}

/** Derive the deployed packageId from the fully-qualified `target` the issuer set. */
function packageIdFromTarget(target: string): string {
  const pkg = target.split('::')[0];
  if (!pkg) throw new Error(`cap-token-submitter: malformed target "${target}"`);
  return pkg;
}

// ── PTB builders (arg order locked vs room_capability.move; exported for unit tests) ──

/** issue_capability_token — 11 args (room_capability.move:444). */
export function buildIssueCapTokenTx(
  tx: Transaction,
  args: IssueCapTokenArgs & { target: string },
): void {
  const packageId = packageIdFromTarget(args.target);
  const qsArg = quorumSigArg(tx, { packageId }, args.cpQuorumProof);
  tx.moveCall({
    target: args.target,
    arguments: [
      tx.object(args.networkRegistryId), // registry: &NetworkRegistry
      tx.object(args.cpRegistryObjectId), // cp_reg: &ControlPlaneRegistry
      tx.object(args.quorumStateObjectId), // quorum_state: &QuorumConfigState
      tx.pure.address(args.roomId), // room_id: address
      tx.pure.vector('u8', args.peerPubkey), // peer_pubkey: vector<u8>
      tx.pure.u8(args.role), // role: u8
      tx.pure.u64(args.expiresEpoch), // expires_epoch: u64
      tx.pure.u64(BigInt(args.nonce)), // nonce: u64
      qsArg, // qs: QuorumSig (threaded)
      tx.pure.vector('vector<u8>', args.signerPubkeys), // signer_pubkeys: vector<vector<u8>>
      tx.pure.vector('u8', args.aggregateSig), // aggregate_sig: vector<u8>
    ],
  });
}

/** refresh_capability_token — 9 args, NO nonce arg (room_capability.move:975). */
export function buildRefreshCapTokenTx(
  tx: Transaction,
  args: RefreshCapTokenArgs & { target: string },
): void {
  const packageId = packageIdFromTarget(args.target);
  const qsArg = quorumSigArg(tx, { packageId }, args.cpQuorumProof);
  tx.moveCall({
    target: args.target,
    arguments: [
      tx.object(args.networkRegistryId), // registry: &NetworkRegistry
      tx.object(args.cpRegistryObjectId), // cp_reg: &ControlPlaneRegistry
      tx.object(args.quorumStateObjectId), // quorum_state: &QuorumConfigState
      tx.object(args.oldTokenId), // old_token: &mut RoomCapability
      tx.pure.u8(args.newRole), // new_role: u8
      tx.pure.u64(args.newExpiresEpoch), // new_expires_epoch: u64
      qsArg, // cp_quorum_proof: QuorumSig (threaded)
      tx.pure.vector('vector<u8>', args.signerPubkeys), // signer_pubkeys: vector<vector<u8>>
      tx.pure.vector('u8', args.aggregateSig), // aggregate_sig: vector<u8>
    ],
  });
}

/** revoke_capability_token_via_quorum — 7 args, NO aggregate_sig (room_capability.move:586, D-011). */
export function buildRevokeCapTokenTx(
  tx: Transaction,
  args: RevokeCapTokenArgs & { target: string },
): void {
  const packageId = packageIdFromTarget(args.target);
  const qsArg = quorumSigArg(tx, { packageId }, args.cpQuorumProof);
  tx.moveCall({
    target: args.target,
    arguments: [
      tx.object(args.networkRegistryId), // registry: &NetworkRegistry
      tx.object(args.cpRegistryObjectId), // cp_reg: &ControlPlaneRegistry
      tx.object(args.quorumStateObjectId), // quorum_state: &QuorumConfigState
      tx.object(args.capObjectId), // cap: &mut RoomCapability
      tx.pure.u8(args.reason), // reason: u8
      qsArg, // qs: QuorumSig (threaded)
      tx.pure.vector('vector<u8>', args.signerPubkeys), // signer_pubkeys: vector<vector<u8>>
    ],
  });
}

/** Dispatch the issuer's `{label, args}` to the matching PTB builder. */
function buildCapTokenTx(tx: Transaction, label: string, args: Record<string, unknown>): void {
  switch (label) {
    case CAP_TOKEN_LABELS.ISSUE:
      buildIssueCapTokenTx(tx, args as unknown as IssueCapTokenArgs & { target: string });
      return;
    case CAP_TOKEN_LABELS.REFRESH:
      buildRefreshCapTokenTx(tx, args as unknown as RefreshCapTokenArgs & { target: string });
      return;
    case CAP_TOKEN_LABELS.REVOKE:
      buildRevokeCapTokenTx(tx, args as unknown as RevokeCapTokenArgs & { target: string });
      return;
    default:
      throw new Error(`cap-token-submitter: unknown submit label "${label}"`);
  }
}

const KNOWN_LABELS: ReadonlySet<string> = new Set<CapTokenLabel>([
  CAP_TOKEN_LABELS.ISSUE,
  CAP_TOKEN_LABELS.REFRESH,
  CAP_TOKEN_LABELS.REVOKE,
]);

/**
 * Production single-CP `SubmitFn` for the `CapTokenIssuer`. Builds the room_capability
 * PTB matching the issuer's label and dispatches it via `executeWithRetry`. Returns the
 * on-chain digest; surfaces Move aborts (e.g. E_TOKEN_ALREADY_REVOKED=907) and
 * retry-exhaustion as thrown errors (never swallowed). Wired in only at threshold==1
 * (D-W6 / D-014); threshold>=2 keeps `makeDeferredSubmit`.
 */
export function makeCapTokenSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  logger: Logger,
): SubmitFn {
  return async ({ label, args }): Promise<SubmitResult> => {
    if (!KNOWN_LABELS.has(label)) {
      throw new Error(`cap-token-submitter: unknown submit label "${label}"`);
    }
    const traceId = randomUUID();
    const result = await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => buildCapTokenTx(tx, label, args),
      `cap-token-${label}`,
      logger,
    );
    if (result === null) {
      throw new Error(`cap-token-submitter: "${label}" exhausted retries (executeWithRetry returned null)`);
    }
    logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'submit_cap_token',
        context: { label, digest: result.digest },
      },
      'Cap-token submit TX confirmed on-chain',
    );
    return { digest: result.digest };
  };
}
