/**
 * REQ-CFA-047/050/051 (W-M4-COSIGN, DESIGN-COSIGN.md D-CFA-38/41/43/44) — the pull-corroboration
 * CLAIM BOARD: the off-chain rendezvous a validator PUBLISHES its own Wallet-B self-attestation to
 * and POLL-CORROBORATEs open cells against.
 *
 * No peer is ever ADDRESSED (pull, not push) — so there is no who-asks-whom discovery surface to
 * leak the salted cell coverage (M2, D-CFA-46) or a Wallet-A<->Wallet-B link (INV-C), and "signing
 * on another's word" is structurally impossible: a validator only ever appends its OWN independent
 * observation via `attestIfIndependentlyObserved` (D-CFA-41, the load-bearing anti-fabrication gate).
 *
 * HERMETIC SLICE: the board is an injected PORT with an in-memory fake here. The LIVE binding — a
 * bounded `/canary/claims` append+poll table on the OFF-MEDIA-PATH cp-daemon (D-CFA-43/47) — is M4b
 * (port-locked + couples to the W5 connection-arch carrier-host-independence precondition). ZERO
 * `apps/relay/` edit (INV-B): the board never touches the audited media path.
 *
 * LOGGING / INV-C (HARD-GATE): a board key + an attestation carry ONLY the ACCUSED relay's PUBLIC
 * id + Wallet-B pubkeys/sigs — never a `minerId`/Wallet-A of an AUDITING validator, never the salted
 * `assignmentSecret` (D-CFA-46). Nothing secret crosses the wire.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  canonicalProofMessage,
  signSelfAttestation,
  distinctAttesterCount,
  attesterPubkeyHex,
  MIN_ATTESTERS,
  type DivergenceClaim,
  type DivergenceAttestation,
} from './proof.js';
import type { CanaryDivergence } from './verifier.js';

/** Default corroboration window (rounds) before an un-quorumed cell is GC'd (fail-closed, D-CFA-44). */
export const DEFAULT_W_CORR = 8;

/**
 * Deterministic cell key over the 4 IDENTIFYING fields ONLY (D-CFA-38). `expectedHash` /
 * `observed_present` / `observedHash` are carried in the cell's CLAIM (each attestation signs them),
 * NOT in the key — so a disagreeing attester's signature simply does not validate the cell's claim
 * on-chain rather than being silently merged into the wrong divergence bucket.
 */
export function cellKey(claim: DivergenceClaim): string {
  return `${claim.roomId}|${claim.relayMinerId}|${claim.canaryId}|${claim.frameSeq}`;
}

/** A snapshot of one open (un-submitted, un-GC'd) board cell. */
export interface OpenClaimCell {
  key: string;
  claim: DivergenceClaim;
  attestations: DivergenceAttestation[];
  openedRound: number;
}

/** The injectable claim-board PORT (D-CFA-43). In-memory fake here; the live cp-daemon carrier = M4b. */
export interface ClaimBoard {
  /** Append a Wallet-B attestation for a divergence claim; IDEMPOTENT per `sessionPublicKey`. */
  post(claim: DivergenceClaim, attestation: DivergenceAttestation, round: number): Promise<void>;
  /** Every cell not yet submitted (and not GC'd). */
  listOpen(): Promise<OpenClaimCell[]>;
  /** One cell by key (or `undefined` if absent/submitted). */
  get(key: string): Promise<OpenClaimCell | undefined>;
  /** Mark a cell submitted so it is never re-assembled. */
  markSubmitted(key: string): Promise<void>;
  /** GC un-quorumed cells older than `W_corr` rounds (fail-closed) + drop submitted cells. */
  gc(currentRound: number): Promise<void>;
}

interface BoardCell {
  claim: DivergenceClaim;
  /** Dedup by raw-pubkey hex — a duplicate post of the same Wallet-B is idempotent. */
  byPubkey: Map<string, DivergenceAttestation>;
  openedRound: number;
  submitted: boolean;
}

/**
 * The hermetic in-memory `ClaimBoard` fake (D-CFA-43). Bounded by `W_corr` GC. Dedups attestations
 * by `sessionPublicKey` so a validator that posts twice never inflates the distinct count. The live
 * cp-daemon-bound carrier swaps in behind this same port (M4b) without touching the protocol core.
 */
export class InMemoryClaimBoard implements ClaimBoard {
  private readonly cells = new Map<string, BoardCell>();
  private readonly wCorr: number;

  constructor(opts?: { wCorr?: number }) {
    this.wCorr = opts?.wCorr ?? DEFAULT_W_CORR;
  }

  async post(claim: DivergenceClaim, attestation: DivergenceAttestation, round: number): Promise<void> {
    const key = cellKey(claim);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { claim, byPubkey: new Map(), openedRound: round, submitted: false };
      this.cells.set(key, cell);
    }
    // Idempotent per Wallet-B pubkey — re-posting the same attester never adds a distinct attester.
    cell.byPubkey.set(attesterPubkeyHex(attestation.sessionPublicKey), attestation);
  }

  async listOpen(): Promise<OpenClaimCell[]> {
    const out: OpenClaimCell[] = [];
    for (const [key, c] of this.cells) {
      if (c.submitted) continue;
      out.push({ key, claim: c.claim, attestations: [...c.byPubkey.values()], openedRound: c.openedRound });
    }
    return out;
  }

  async get(key: string): Promise<OpenClaimCell | undefined> {
    const c = this.cells.get(key);
    if (!c || c.submitted) return undefined;
    return { key, claim: c.claim, attestations: [...c.byPubkey.values()], openedRound: c.openedRound };
  }

  async markSubmitted(key: string): Promise<void> {
    const c = this.cells.get(key);
    if (c) c.submitted = true;
  }

  async gc(currentRound: number): Promise<void> {
    for (const [key, c] of this.cells) {
      const expired = currentRound - c.openedRound >= this.wCorr;
      if (!expired) continue; // within the corroboration window — keep accruing
      // After the window: drop a SUBMITTED cell (its slash is on-chain — retaining it within the
      // window blocked a re-submit), and drop an un-quorumed cell (FAIL CLOSED — no slash). A cell
      // that reached the >=2-distinct quorum but was never submitted is retained (defensive).
      const belowQuorum = distinctAttesterCount([...c.byPubkey.values()]) < MIN_ATTESTERS;
      if (c.submitted || belowQuorum) this.cells.delete(key);
    }
  }
}

/**
 * The load-bearing INDEPENDENCE gate (D-CFA-41). A validator appends to a cell ONLY if its OWN
 * locally-observed divergence set carries a byte-MATCH for the cell's claim — same `frameSeq`,
 * `expectedHash`, and `observedHash` (the drop sentinel `'MISSING'` included). No local match → `null`
 * (the validator cannot be COERCED into attesting a divergence it did not independently observe). On a
 * match it returns the validator's Wallet-B self-attestation over the UNCHANGED canonical message.
 */
export async function attestIfIndependentlyObserved(
  claim: DivergenceClaim,
  localDivergences: CanaryDivergence[],
  selfSessionKeypair: Ed25519Keypair,
): Promise<DivergenceAttestation | null> {
  const matches = localDivergences.some(
    (d) =>
      d.frameSeq === claim.frameSeq &&
      d.expectedHash === claim.expectedHash &&
      d.observedHash === claim.observedHash,
  );
  if (!matches) return null;
  return signSelfAttestation(
    canonicalProofMessage({ ...claim, sessionKeypairs: [] }),
    selfSessionKeypair,
  );
}
