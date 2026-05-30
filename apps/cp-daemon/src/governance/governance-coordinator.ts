/**
 * Governance coordinator — F47 Phase 2.3 (REQ-RV-011 + D-S60-1 daemon surface).
 *
 * Off-chain orchestration for the two CP-quorum-gated governance entries on
 * `role_voting.move`:
 *   - update_revote_cooldown_epochs  (ACTION_UPDATE_COOLDOWN = 1) — Q1 cooldown window
 *   - update_max_idle_epochs         (ACTION_UPDATE_MAX_IDLE  = 2) — Q2 idle threshold
 *
 * D-S60-1: CP-quorum is the DIRECT authority — there is NO AdminCap shim. The
 * coordinator builds the canonical governance message, collects an M-of-N
 * aggregate signature from peer CPs over that EXACT byte payload (reusing the F62
 * quorum infra — structurally the same `collectQuorumSignatures` seam the
 * cap-token-issuer uses), then submits the on-chain update TX.
 *
 * Byte-parity is load-bearing: the canonical message MUST equal Move's
 * `build_governance_msg` (role_voting.move:539) or `verify_quorum` rejects the
 * aggregate (the daemon would sign one payload while the chain hashes another).
 * {@link buildGovernanceCanonicalMsg} mirrors the 25-byte layout; the
 * reproducibility record `scripts/governance/gen-governance-sig-fixture.ts`
 * self-verifies the SAME bytes against the Move EXPECTED_MSG hardcoded in
 * `tests/registry/role_voting_governance_tests.move` (drift forcing-function).
 *
 * OQ-RV-4 (carried, documented): the entries accept `nonce` + `epoch`, but Phase
 * 1.4 ships the Move side replay-OPEN — there is no on-chain nonce ledger yet, so
 * a valid (msg, sig) pair could in principle be replayed. The coordinator already
 * threads a monotonic `nonce` + the current `epoch` into the canonical message so
 * the wire format is replay-ready; on-chain enforcement (a consumed-nonce set) is
 * deferred to a later phase per ADR-0008 § OQ-RV-4.
 *
 * Testability mirrors revote-watcher: chain writes go through the
 * {@link GovernanceSubmitter} seam and quorum collection through
 * {@link QuorumSignatureCollector}, so the orchestration is unit-testable offline.
 * The live {@link makeGovernanceSubmitter} (real PTB with a nested
 * `cp_quorum_sig::new_quorum_sig` call) is wired + exercised on localnet in Phase
 * 4.1 — built now, run live later, exactly like makeMarkSubmitter.
 *
 * Implements REQ-RV-011 (daemon governance surface).
 */

import { randomUUID } from 'node:crypto';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger, type QuorumSig } from '@dvconf/shared';

const MODULE = 'governance-coordinator';

/** Governance action byte — mirrors role_voting.move `ACTION_UPDATE_COOLDOWN` (1). */
export const ACTION_UPDATE_COOLDOWN = 1;
/** Governance action byte — mirrors role_voting.move `ACTION_UPDATE_MAX_IDLE` (2). */
export const ACTION_UPDATE_MAX_IDLE = 2;
/** Canonical governance message length: 1 (action) + 8 + 8 + 8 (three u64 LE). */
export const GOVERNANCE_MSG_LEN = 25;

/** The variable inputs to a single governance update. All u64s as bigint. */
export interface GovernanceUpdate {
  /** New value for the targeted config field (u64). */
  newValue: bigint;
  /** Monotonic anti-replay nonce (u64). OQ-RV-4: on-chain enforcement deferred. */
  nonce: bigint;
  /** Sui epoch stamped into the canonical message (u64). */
  epoch: bigint;
}

/**
 * Build the 25-byte canonical governance message the CP quorum signs. Byte-for-byte
 * mirror of role_voting.move `build_governance_msg` (which appends `u64_to_le_bytes`):
 *   byte 0       : action     (u8)
 *   bytes 1..8   : new_value  (u64 little-endian)
 *   bytes 9..16  : nonce      (u64 little-endian)
 *   bytes 17..24 : epoch      (u64 little-endian)
 *
 * `BigInt.asUintN(64, …)` matches Move's u64 wrap-around so an out-of-range input
 * encodes identically on both sides rather than throwing only off-chain.
 */
export function buildGovernanceCanonicalMsg(action: number, u: GovernanceUpdate): Uint8Array {
  const buf = new Uint8Array(GOVERNANCE_MSG_LEN);
  const dv = new DataView(buf.buffer);
  buf[0] = action & 0xff;
  dv.setBigUint64(1, BigInt.asUintN(64, u.newValue), true); // little-endian
  dv.setBigUint64(9, BigInt.asUintN(64, u.nonce), true);
  dv.setBigUint64(17, BigInt.asUintN(64, u.epoch), true);
  return buf;
}

/**
 * F62 quorum-collection seam. Production wiring passes the SAME CpKeystore instance
 * the cap-token-issuer uses — its `collectQuorumSignatures` return is a superset of
 * this shape (it also yields `aggregateSig`, which the governance entries do not
 * store), so reuse is structural with no new infra. Implementations throw when an
 * M-of-N quorum cannot be assembled; the caller decides whether to absorb.
 */
export interface QuorumSignatureCollector {
  collectQuorumSignatures(
    canonicalMsg: Uint8Array,
    threshold: number,
  ): Promise<{ qs: QuorumSig; pubkeys: number[][] }>;
}

/** Submits a single governance update TX. Injected so coordinator logic stays chain-free. */
export type GovernanceSubmitter = (
  action: number,
  u: GovernanceUpdate,
  qs: QuorumSig,
  pubkeys: number[][],
  traceId: string,
) => Promise<void>;

export interface GovernanceCoordinatorOptions {
  /** M-of-N threshold (D-B4 default M=2). */
  quorumThreshold?: number;
}

/**
 * Orchestrates a governance config update: build canonical msg → collect CP quorum
 * → submit. Pure orchestration over a {@link QuorumSignatureCollector} +
 * {@link GovernanceSubmitter} — no SuiClient dependency.
 */
export class GovernanceCoordinator {
  private readonly threshold: number;

  constructor(
    private readonly collector: QuorumSignatureCollector,
    private readonly submitter: GovernanceSubmitter,
    private readonly logger: Logger,
    options: GovernanceCoordinatorOptions = {},
  ) {
    this.threshold = options.quorumThreshold ?? 2;
  }

  /** Propose `update_revote_cooldown_epochs` (Q1 cooldown window). */
  async proposeCooldownUpdate(u: GovernanceUpdate): Promise<void> {
    return this.propose(ACTION_UPDATE_COOLDOWN, u);
  }

  /** Propose `update_max_idle_epochs` (Q2 idle threshold). */
  async proposeMaxIdleUpdate(u: GovernanceUpdate): Promise<void> {
    return this.propose(ACTION_UPDATE_MAX_IDLE, u);
  }

  private async propose(action: number, u: GovernanceUpdate): Promise<void> {
    const traceId = randomUUID();
    const msg = buildGovernanceCanonicalMsg(action, u);
    const { qs, pubkeys } = await this.collector.collectQuorumSignatures(msg, this.threshold);
    this.logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'collect_quorum',
        context: {
          govAction: action,
          newValue: u.newValue.toString(),
          nonce: u.nonce.toString(),
          epoch: u.epoch.toString(),
          signers: qs.signers.length,
        },
      },
      'Governance: CP quorum collected over canonical message',
    );
    await this.submitter(action, u, qs, pubkeys, traceId);
    this.logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'submit_governance',
        context: { govAction: action, newValue: u.newValue.toString() },
      },
      'Governance: update TX submitted',
    );
  }
}

/**
 * Build a real {@link GovernanceSubmitter} that constructs the `QuorumSig` Move
 * struct via a nested `cp_quorum_sig::new_quorum_sig` PTB call, then invokes the
 * matching `update_*` entry. Arg order mirrors role_voting.move exactly
 * (net_reg, vote_box, cp_reg, quorum_state, qs, signer_pubkeys, new_value, nonce,
 * epoch) — `ctx` is implicit in a PTB.
 *
 * `quorumStateObjectId` is a separate param because `NetworkConfig` does not carry
 * the QuorumConfigState ID (same convention as cap-token-issuer's
 * `quorumStateObjectId` opt).
 *
 * NOTE (Phase 4.1): index.ts does not wire this yet; the QuorumSig struct +
 * vector<vector<u8>> serialization is exercised live on localnet in Phase 4.1
 * (mirrors revote-watcher's makeMarkSubmitter deferral).
 */
export function makeGovernanceSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  quorumStateObjectId: string,
  logger: Logger,
): GovernanceSubmitter {
  const fnFor: Record<number, string | undefined> = {
    [ACTION_UPDATE_COOLDOWN]: 'update_revote_cooldown_epochs',
    [ACTION_UPDATE_MAX_IDLE]: 'update_max_idle_epochs',
  };
  return async (action, u, qs, pubkeys, traceId) => {
    const fn = fnFor[action];
    if (fn === undefined) {
      throw new Error(`makeGovernanceSubmitter: unknown governance action ${action}`);
    }
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        // Reconstruct the QuorumSig Move struct on-chain from its parallel arrays.
        const qsArg = tx.moveCall({
          target: `${config.packageId}::cp_quorum_sig::new_quorum_sig`,
          arguments: [
            tx.pure.vector('address', qs.signers), // signers: vector<address>
            tx.pure.vector('vector<u8>', qs.signatures), // signatures: vector<vector<u8>>
          ],
        });
        tx.moveCall({
          target: `${config.packageId}::role_voting::${fn}`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.roleVoteBoxId), // vote_box: &mut RoleVoteBox
            tx.object(config.cpRegistryId), // cp_reg: &ControlPlaneRegistry
            tx.object(quorumStateObjectId), // quorum_state: &QuorumConfigState
            qsArg, // qs: QuorumSig
            tx.pure.vector('vector<u8>', pubkeys), // signer_pubkeys: vector<vector<u8>>
            tx.pure.u64(u.newValue), // new_value: u64
            tx.pure.u64(u.nonce), // nonce: u64
            tx.pure.u64(u.epoch), // epoch: u64
          ],
        });
      },
      `governance-${fn}`,
      logger,
    );
    logger.info(
      { trace_id: traceId, module: MODULE, action: 'submit_governance', context: { fn, newValue: u.newValue.toString() } },
      'Governance: update TX confirmed on-chain',
    );
  };
}
