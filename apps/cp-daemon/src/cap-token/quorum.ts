/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer (cp-daemon module) — Multi-CP
 * quorum Leg 4 (G2) assembler + Leg 6 collector board config.
 *
 * Split out of the former monolithic `cap-token-issuer.ts` (god-file split).
 */
import type { QuorumSig, BoardKindConfig } from '@dvconf/shared';
import type { CpOperator } from '../sui-chain-state-reader.js';
import type { CapTokenIssueClaim, CapTokenIssueAttestation } from './canonical-messages.js';

// ── Multi-CP quorum Leg 4 (G2) — quorum assembler ──────────────────────────
//
// DESIGN-connection-arch.md G2 + ROADMAP Leg 4: take the cell CLAIM + the accrued CP
// self-attestations (Leg-2 `rebuildCanonicalAndSignIfMatches` outputs) + the discovered
// active-CP operator set (Leg-1 `getActiveCpOperators`), and emit the EXACT single-CP
// shape `{ qs:{signers,signatures}, pubkeys, aggregateSig }` (index.ts:147-151) that the
// FROZEN consumer chain accepts UNCHANGED:
//   submitIssue → makeCapTokenSubmitter → buildIssueCapTokenTx → Move
//   room_capability::issue_capability_token → cp_quorum_sig::verify_quorum.
//
// `verify_quorum` (cp_quorum_sig.move:129-192) iterates the THREE index-aligned arrays in
// lock-step: `qs.signers[i]` (operator ADDRESS — F-01 VecSet dedup-by-address +
// is_operator_registered) · `qs.signatures[i]` (RAW 64-byte sig) · `pubkeys[i]` (32-byte
// ed25519 key — passed as a SEPARATE parallel arg, NOT a QuorumSig field). The assembler
// emits the columns INDEX-ALIGNED in signature/attestation order, matching the single-CP
// branch shape at index.ts:148.
//
// FAIL-CLOSED (OQ-1): a poster whose pubkey resolves to NO operator in the discovered
// active-CP snapshot (just-joined / stranger) is DROPPED — never a silent index-
// misalignment (it would fail `is_operator_registered` on-chain anyway). The operator
// ADDRESS is resolved from the DISCOVERED snapshot (pubkey→operator), NOT trusted from the
// poster's self-declared `addr`, so a malicious poster cannot inject a foreign address
// column. Registry stores NO CP pubkeys today (Phase-2.x) → the poster's self-declared
// `addr` is the pubkey→address binding, checked for membership against the discovered
// operator set; a binding to an unknown operator is a stranger DROP.
//
// OQ-BUILD-1 (resolved): the on-chain AUTHORITATIVE gate `verify_quorum` consumes ONLY
// `qs`(signers+signatures) + `pubkeys` + `msg` — it NEVER reads `aggregate_sig`.
// `issue_capability_token` (room_capability.move:455,527) stores `aggregate_sig` VERBATIM
// into `RoomCapability.aggregate_sig` for off-chain audit replay; it is never parsed or
// verified on-chain. `aggregate_sig` is therefore VESTIGIAL vs the per-index `pubkeys[]`
// ed25519_verify path. The single-CP branch hardcodes `[0x01, ...sig64]`; the multi-CP
// generalization is `[0x01, ...sig64(0), ...sig64(1), ...]` (the 0x01 version/marker +
// the concatenated RAW sigs in signer order) — a self-describing audit blob a future
// reader splits on the 64-byte boundary. Since it is never on-chain-parsed, this encoding
// is safe by construction; it preserves the single-CP shape (1 signer → byte-identical
// `[0x01, ...sig64]`) and carries every real signature for audit replay.
//
// ADDITIVE: no frozen surface edited; the single-CP branch (index.ts:138-152) and
// `makeCapTokenSubmitter` are UNCHANGED — this assembler simply produces the same shape
// for N>=2 signers that the single-CP branch produces for 1.

/**
 * G2 quorum assembler — fold the accrued CP attestations into the single-CP-shaped
 * `{ qs:{signers,signatures}, pubkeys, aggregateSig }` proof, INDEX-ALIGNED in
 * attestation order, dropping any poster not in the discovered active-CP snapshot
 * (OQ-1 fail-closed).
 *
 * @param _claim         the cell claim (declared for call-site symmetry + future
 *                       per-claim policy hooks; the attestations already carry the bytes
 *                       each CP signed, so no re-derivation happens here).
 * @param attestations   the accrued CP self-attestations (Leg-2 outputs: RAW sig + pubkey
 *                       + self-declared operator addr).
 * @param discoveredCps  the Leg-1 `getActiveCpOperators()` projection — the operator
 *                       ADDRESS set `verify_quorum` requires for `qs.signers`.
 */
export function assembleCapTokenQuorum(
  _claim: CapTokenIssueClaim,
  attestations: CapTokenIssueAttestation[],
  discoveredCps: CpOperator[],
): { qs: QuorumSig; pubkeys: number[][]; aggregateSig: number[] } {
  // Membership set of registered operator addresses (F-01 / is_operator_registered).
  const registeredOperators = new Set<string>(discoveredCps.map((cp) => cp.operator));

  const signers: string[] = [];
  const signatures: number[][] = [];
  const pubkeys: number[][] = [];
  // aggregateSig = [0x01 version/marker, ...concatenated RAW 64-byte sigs in signer order].
  const aggregateSig: number[] = [0x01];

  for (const att of attestations) {
    // OQ-1 FAIL-CLOSED: MEMBERSHIP-GATE the poster's SELF-DECLARED operator addr against
    // the discovered active-CP snapshot. Registry holds no CP pubkeys (Phase-2.x = design
    // -drift #5), so there is NO on-chain pubkey→address oracle — `att.addr` is the poster's
    // self-declared binding and we accept it ONLY if it is a registered operator. A stranger
    // (unknown operator) is DROPPED — never appended, so the three arrays STAY index-aligned.
    // KNOWN LIMITATION (design-deferred, carry to SHIP gate): membership does NOT prove
    // att.pubkey derives att.addr, so a poster could pair its OWN valid sig with a DIFFERENT
    // registered operator's address; on-chain verify_quorum cannot catch this either until
    // the registry stores CP pubkeys. Faithful to the approved design (OQ-1 / drift #5).
    if (!registeredOperators.has(att.addr)) {
      continue;
    }
    signers.push(att.addr);
    signatures.push(att.signature);
    pubkeys.push(att.pubkey);
    aggregateSig.push(...att.signature);
  }

  return {
    qs: { signers, signatures },
    pubkeys,
    aggregateSig,
  };
}

// ── Multi-CP quorum Leg 6 (collector wiring) — captoken-issue board config ───
//
// DESIGN-connection-arch.md Fork-1 (UNIFY) + Fork-5 (fail-LOUD) + ROADMAP Leg 5/6:
// the per-kind `BoardKindConfig` that registers a `captoken-issue` cell on the generic
// `InMemoryGenericClaimBoard` (`@dvconf/shared`). It is built HERE (not in @dvconf/shared)
// so the board stays type-agnostic and the cap-token concrete `CapTokenIssueClaim` /
// `CapTokenIssueAttestation` shapes live in their owning app.
//
//   - cellKey      = the cell's `canonicalMsgHex` (the exact bytes every CP signs — two CPs
//                    that re-derive the identical canonical message open the SAME cell;
//                    the board prepends `captoken-issue|` so a canary cell never collides).
//   - attesterKey  = the operator `addr` (F-01 dedup-by-address column, mirroring on-chain).
//   - distinctCount= distinct operator addresses (the M-of-N quorum count).
//   - gcFailMode   = fail-LOUD (Fork-5): an un-quorumed cell at expiry escalates so a blocked
//                    room-join is VISIBLE (the daemon bounded-retries with a fresh nonce).
//   - validateWireSchema = the captoken INV-C allow-list. CP operator addresses are PUBLIC,
//                    so the allow-list only enforces well-formedness (64-byte sig + 32-byte
//                    pubkey + a captoken-issue claim) — it NEVER carries an auditing-validator
//                    miner_id or a salted assignmentSecret (those belong to the canary kind).

/**
 * Build the per-kind `BoardKindConfig` for a `captoken-issue` cell on the shared generic board.
 *
 * @param opts.minDistinct        the M-of-N threshold (sourced from on-chain `min_quorum` via
 *                                Leg-1 `readMinQuorum`; hermetic tests inject it directly).
 * @param opts.onUnquorumedExpiry Fork-5 fail-LOUD escalation hook fired when an un-quorumed cell
 *                                expires (the daemon escalates + bounded-retries w/ a fresh nonce).
 */
export function buildCapTokenIssueBoardConfig(opts: {
  minDistinct: number;
  onUnquorumedExpiry: (namespacedKey: string) => void;
}): BoardKindConfig<CapTokenIssueClaim, CapTokenIssueAttestation> {
  return {
    kind: 'captoken-issue',
    cellKey: (claim) => claim.canonicalMsgHex.toLowerCase(),
    attesterKey: (att) => att.addr,
    distinctCount: (atts) => new Set(atts.map((a) => a.addr)).size,
    minDistinct: opts.minDistinct,
    gcFailMode: { kind: 'fail-loud', onUnquorumedExpiry: opts.onUnquorumedExpiry },
    validateWireSchema: (claim, att) => {
      // INV-C allow-list (captoken kind): CP operator addresses are PUBLIC, so this only
      // rejects malformed payloads (fail-closed — nothing stored). NO canary-only fields.
      if (claim.kind !== 'captoken-issue') return 'claim.kind is not captoken-issue';
      if (!Array.isArray(att.signature) || att.signature.length !== 64) {
        return 'attestation.signature must be a 64-byte RAW ed25519 signature';
      }
      if (!Array.isArray(att.pubkey) || att.pubkey.length !== 32) {
        return 'attestation.pubkey must be a 32-byte ed25519 key';
      }
      if (typeof att.addr !== 'string' || att.addr.length === 0) {
        return 'attestation.addr (operator address) must be a non-empty string';
      }
      return null;
    },
  };
}
