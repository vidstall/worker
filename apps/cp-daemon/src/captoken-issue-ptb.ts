/**
 * Pure N-signer capability-token issue PTB (spec 2026-07-06-captoken-cosign-live-run-design §6).
 * Generalizes the shipped single-CP scripts/governance/issue-cap-token-demo.ts:129-157 to a
 * 2-of-N quorum. Byte-mirrors Move room_capability::issue_capability_token (room_capability.move
 * :473-482 canonical concat; :444-457 arg order). RAW ed25519 sigs (NO Sui intent wrap — else
 * Move verify_quorum aborts 906). Depends ONLY on @mysten/sui so both the integration test and
 * the apps/cp-daemon bins import it without the scripts→@dvconf/* tsx-resolution problem.
 */
import type { Transaction } from '@mysten/sui/transactions';

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function u64Le(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (let i = 0; i < 8; i++) { out.push(Number(x & 0xffn)); x >>= 8n; }
  return out;
}

/** Canonical ISSUE payload the CP quorum signs. id_to_bytes(room)||peer_pubkey||role||le(expires)||le(nonce). */
export function buildIssueCanonicalMsg(opts: {
  roomId: string; peerPubkey: number[]; role: number; expiresEpoch: bigint; nonce: bigint;
}): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...hexToBytes(opts.roomId));
  bytes.push(...opts.peerPubkey);
  bytes.push(opts.role & 0xff);
  bytes.push(...u64Le(opts.expiresEpoch));
  bytes.push(...u64Le(opts.nonce));
  return new Uint8Array(bytes);
}

export interface IssueQuorum {
  qs: { signers: string[]; signatures: number[][] }; // parallel arrays (Move QuorumSig)
  pubkeys: number[][];                                // signer_pubkeys, index-aligned to qs.signers
  aggregateSig: number[];                             // [0x01, ...sig64_i...] audit blob
}

export interface IssueParams {
  roomId: string; peerPubkey: number[]; role: number; expiresEpoch: bigint; nonce: bigint;
}

/**
 * Emit the two chained moveCalls (cp_quorum_sig::new_quorum_sig -> room_capability::
 * issue_capability_token) for an N-signer quorum. Arg order mirrors the Move entry exactly.
 */
export function buildIssueQuorumTx(
  tx: Transaction,
  config: { packageId: string; networkRegistryId: string; cpRegistryId: string; quorumStateId: string },
  params: IssueParams,
  quorum: IssueQuorum,
): void {
  const n = quorum.qs.signers.length;
  if (quorum.qs.signatures.length !== n || quorum.pubkeys.length !== n) {
    throw new Error(
      `buildIssueQuorumTx: mismatched quorum length (signers=${n} signatures=${quorum.qs.signatures.length} pubkeys=${quorum.pubkeys.length})`,
    );
  }
  const qsArg = tx.moveCall({
    target: `${config.packageId}::cp_quorum_sig::new_quorum_sig`,
    arguments: [
      tx.pure.vector('address', quorum.qs.signers),
      tx.pure.vector('vector<u8>', quorum.qs.signatures),
    ],
  });
  tx.moveCall({
    target: `${config.packageId}::room_capability::issue_capability_token`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(config.cpRegistryId),
      tx.object(config.quorumStateId),
      tx.pure.address(params.roomId),
      tx.pure.vector('u8', params.peerPubkey),
      tx.pure.u8(params.role),
      tx.pure.u64(params.expiresEpoch),
      tx.pure.u64(params.nonce),
      qsArg,
      tx.pure.vector('vector<u8>', quorum.pubkeys),
      tx.pure.vector('u8', quorum.aggregateSig),
    ],
  });
}
