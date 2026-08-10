/**
 * F62 Stage 4 Item #1 — LocalCpKeystore (Multi-CP quorum Leg 6 collector wiring).
 *
 * Pure extraction from bootstrap.ts: `buildLocalCpKeystore` + its
 * `QuorumCollectorConfig` injection shape. See bootstrap.ts's module doc for
 * the file-ownership boundary (this stays under cap-token/, not index.ts).
 *
 * DESIGN-connection-arch.md build-seams + ROADMAP Leg 6: the `threshold>=2` branch
 * of `collectQuorumSignatures` posts the LOCAL CP's own self-attestation leg to an
 * INJECTED `QuorumClaimBoard`, polls `listOpen()` until the cell reaches `minQuorum`
 * DISTINCT attesters, then folds them with Leg-4 `assembleCapTokenQuorum` into the
 * EXACT single-CP shape the FROZEN `makeCapTokenSubmitter` consumer accepts UNCHANGED.
 *
 * The board is INJECTED (default `InMemoryGenericClaimBoard`) so Leg 7 can swap the
 * live `/quorum/claims` HTTP board behind the SAME `QuorumClaimBoard` port — a pure
 * transport substitution (the protocol core never changes). FAIL-LOUD (Fork-5): if the
 * cell never reaches `minQuorum` within the bounded poll window, the collector escalates
 * (the board's cap-token fail-loud gc fires) + throws so a blocked room-join is VISIBLE.
 */
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { InMemoryGenericClaimBoard } from '@dvconf/shared';
import type { Logger, QuorumClaimBoard } from '@dvconf/shared';
import type { CpKeystore } from './types.js';
import type { CapTokenIssueClaim, CapTokenIssueAttestation } from './canonical-messages.js';
import { assembleCapTokenQuorum, buildCapTokenIssueBoardConfig } from './quorum.js';
import type { CpOperator } from '../sui-chain-state-reader.js';

/**
 * Injectable multi-CP quorum collection config for `buildLocalCpKeystore`. Optional with a
 * sensible default (a fresh `InMemoryGenericClaimBoard` + `minQuorum=2`) so the production
 * single-CP path is unaffected; Leg 7 swaps `board` for the live HTTP carrier.
 */
export interface QuorumCollectorConfig {
  /** The injected board (default: a fresh in-memory board). Leg 7 swaps the live HTTP board. */
  board?: QuorumClaimBoard;
  /** The discovered active-CP operator set (Leg-1 getActiveCpOperators) for the OQ-1 membership gate. */
  discoveredCps?: CpOperator[];
  /** M-of-N threshold (Leg-1 readMinQuorum). Hermetic tests inject; default 2 (D-B4). */
  minQuorum?: number;
  /**
   * Leg 7c (G5 prod promotion) — a PER-ROUND live `cp_quorum_sig::min_quorum` reader. When
   * provided, the threshold>=2 poll loop calls it EVERY round (NO cache) so the off-chain
   * board observes a live `update_threshold` mutation immediately (it can never assemble below
   * the raised on-chain floor). Wired by `startCapTokenIssuer` to
   * `reader.readMinQuorum(QUORUM_STATE_OBJECT_ID)`. Absent (hermetic callers) → the static
   * `minQuorum` above is used unchanged.
   */
  readMinQuorum?: () => Promise<number>;
  /** Poll cadence (ms) between `listOpen()` checks. Default 50. */
  pollIntervalMs?: number;
  /** Max poll rounds before fail-LOUD escalation. Default 200. */
  maxPollRounds?: number;
}

/**
 * The round number passed to `board.gc()` on a fail-LOUD escalation. A cell is posted at
 * round 0; it is "expired" once `currentRound - openedRound >= wCorr`. A large constant
 * guarantees expiry regardless of the board's configured `W_corr`, so the cap-token
 * fail-LOUD branch fires deterministically when the poll window elapses below quorum.
 */
const QUORUM_FAIL_LOUD_GC_ROUND = 1_000_000;

/** lowercase hex (no 0x) of bytes — the captoken-issue board cellKey. */
function canonicalBytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Build a local-CP keystore backed by the daemon's Ed25519 keypair. The `sign()`
 * path is fully functional; `collectQuorumSignatures()` at threshold ≥ 2 runs the
 * Leg-6 board-backed collector (post-own-leg + poll + assemble) over an INJECTED
 * `QuorumClaimBoard`, FAIL-LOUD if the M-of-N quorum is not reached in the window —
 * the issuer's handlers catch + ERROR-log so operators see the degraded state
 * without a daemon crash.
 */
export function buildLocalCpKeystore(opts: {
  signer: Ed25519Keypair;
  logger: Logger;
  quorumCollector?: QuorumCollectorConfig;
}): CpKeystore {
  const { signer, logger: kLogger } = opts;
  const localAddr = signer.toSuiAddress();
  const cc = opts.quorumCollector ?? {};
  const minQuorum = cc.minQuorum ?? 2;
  const pollIntervalMs = cc.pollIntervalMs ?? 50;
  const maxPollRounds = cc.maxPollRounds ?? 200;
  let escalated = false;
  const board: QuorumClaimBoard =
    cc.board ??
    new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({
        minDistinct: minQuorum,
        onUnquorumedExpiry: () => {
          escalated = true;
        },
      }),
    ]);
  // The discovered active-CP operator set: when an explicit set is injected (production /
  // hermetic E2E) it is the OQ-1 membership gate; absent it, the local CP is the only
  // known operator (single-host hermetic default — quorum unreachable → fail-LOUD).
  const discoveredCps: CpOperator[] =
    cc.discoveredCps ?? [{ minerId: localAddr, operator: localAddr }];
  return {
    async sign(message: Uint8Array) {
      // RAW 64-byte ed25519 over the canonical message (NO Sui intent wrap) —
      // matches Move `cp_quorum_sig::verify_quorum` (`ed25519_verify` over RAW
      // bytes) and revoke-cap-token.ts `makeSingleCpKeystore` (OQ-CRR-9). Was
      // `signer.signPersonalMessage`, which intent-wraps and fails Move verify.
      const sig = await signer.sign(message);
      const sig64 = Array.from(sig.slice(0, 64));
      const pubkey = Array.from(signer.getPublicKey().toRawBytes());
      return { signature: sig64, pubkey, addr: localAddr };
    },
    getCpAddress() {
      return localAddr;
    },
    async collectQuorumSignatures(canonicalMsg, threshold) {
      if (threshold <= 1) {
        // RAW 64-byte ed25519 over the canonical message (NO Sui intent wrap) —
        // matches Move `cp_quorum_sig::verify_quorum` + makeSingleCpKeystore
        // (OQ-CRR-9). Was `signer.signPersonalMessage`, which intent-wraps so the
        // single-CP issue path's quorum sig failed Move verify (abort 906).
        const sig = await signer.sign(canonicalMsg);
        const sig64 = Array.from(sig.slice(0, 64));
        const pubkey = Array.from(signer.getPublicKey().toRawBytes());
        const aggregateSig = [0x01, ...sig64];
        return {
          qs: { signers: [localAddr], signatures: [sig64] },
          pubkeys: [pubkey],
          aggregateSig,
        };
      }

      // ── Leg 6 — board-backed M-of-N collector (threshold >= 2) ───────────────
      // The effective quorum is max(on-chain min_quorum, the caller's threshold) — the
      // board must never assemble below the on-chain floor (G5 fail-closed). When a live
      // per-round reader is wired (Leg 7c prod path) min_quorum is re-read EVERY round (no
      // cache) so a live `update_threshold` is honored immediately; otherwise the static
      // `minQuorum` (hermetic default) is used.
      const canonicalMsgHex = canonicalBytesToHex(canonicalMsg);
      // The cell CLAIM: the only identifying field the collector needs is the cell key
      // (canonicalMsgHex) — every CP that re-derived these exact bytes opens the SAME cell.
      // The other fields are advisory (the attestations already carry the signed bytes).
      //
      // Leg 7d (wire-safety): `expiresEpoch` is advisory + UNUSED downstream (assembleCapTokenQuorum
      // takes `_claim`; the board cellKey is canonicalMsgHex; validateWireSchema reads only
      // `claim.kind`). The LIVE HTTP board (`HttpQuorumClaimBoard.post`) `JSON.stringify`s this claim
      // over the wire, and `JSON.stringify` cannot serialize a `bigint` — so the advisory expiry is
      // carried as a JSON-safe `0` (the hermetic InMemory path is byte-identical in observable behavior:
      // no test reads the collector cell's `expiresEpoch`, and the assembled proof is independent of it).
      const claim: CapTokenIssueClaim = {
        kind: 'captoken-issue',
        roomId: '0x' + '00'.repeat(32),
        peerPubkey: new Array(32).fill(0),
        role: 0,
        // wire-safe advisory expiry (number, not bigint) — JSON.stringify-able for the live HTTP board.
        expiresEpoch: 0 as unknown as bigint,
        nonce: 1,
        canonicalMsgHex,
      };

      // 1) POST the LOCAL CP's own self-attestation leg (RAW ed25519, single-CP shape).
      const selfSig = await signer.sign(canonicalMsg);
      const selfAtt: CapTokenIssueAttestation = {
        signature: Array.from(selfSig.slice(0, 64)),
        pubkey: Array.from(signer.getPublicKey().toRawBytes()),
        addr: localAddr,
      };
      await board.post('captoken-issue', claim, selfAtt, 0);

      const cellKey = `captoken-issue|${canonicalMsgHex}`;

      // 2) POLL listOpen() until the cell reaches the (per-round) effective quorum of DISTINCT
      // operators. `effectiveQuorum` is recomputed inside the loop so a live `readMinQuorum`
      // (Leg 7c G5) reflects an on-chain `update_threshold` immediately (NO cache).
      let effectiveQuorum = Math.max(minQuorum, threshold);
      for (let round = 0; round < maxPollRounds; round++) {
        if (cc.readMinQuorum) {
          // PER-ROUND live read (Leg 7c) — never cached; the board can never assemble below the
          // current on-chain floor even if it was raised mid-poll.
          const liveMinQuorum = await cc.readMinQuorum();
          effectiveQuorum = Math.max(liveMinQuorum, threshold);
        }
        const open = await board.listOpen();
        const cell = open.find((c) => c.key === cellKey);
        if (cell) {
          const atts = cell.attestations as CapTokenIssueAttestation[];
          // distinct registered operators among the accrued attestations (OQ-1 membership).
          const assembled = assembleCapTokenQuorum(claim, atts, discoveredCps);
          if (assembled.qs.signers.length >= effectiveQuorum) {
            await board.markSubmitted(cellKey);
            return assembled;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // 3) FAIL-LOUD (Fork-5): the window elapsed below quorum. Drive the board GC past the
      // correlation window so the cap-token fail-LOUD branch escalates (a blocked room-join
      // must be VISIBLE), then ERROR-log + throw so the caller surfaces the degraded state.
      await board.gc(QUORUM_FAIL_LOUD_GC_ROUND);
      kLogger.error(
        {
          module: 'cap-token-bootstrap',
          context: {
            threshold,
            effective_quorum: effectiveQuorum,
            local_cp: localAddr,
            escalated_via_board_gc: escalated,
          },
        },
        'multi-CP quorum NOT reached within the bounded poll window — fail-LOUD escalation (bounded-retry w/ fresh nonce required)',
      );
      throw new Error(
        `multi-CP quorum unreached: needed ${effectiveQuorum} distinct CP signatures over the canonical message but only the local CP (and any peers within the window) attested`,
      );
    },
  };
}
