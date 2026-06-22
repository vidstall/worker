/**
 * Multi-CP quorum Phase 1 — Leg 5: the GENERIC quorum claim board.
 *
 * This is the PARAMETRIC sibling of the canary-concrete `InMemoryClaimBoard`
 * (`apps/validator-daemon/src/canary/claim-board.ts`), which STAYS BYTE-IDENTICAL — the canary
 * lane is NOT rewired onto this board. The generic board lives in `@dvconf/shared` so BOTH the
 * canary lane (validator-daemon) and the cap-token Leg-6 collector (cp-daemon) import it WITHOUT a
 * cross-app import violation (the monorepo no-cross-app-import convention: apps never import another
 * app's `src/`; the shared, generic, type-agnostic surface belongs in `packages/shared`).
 *
 * ── What is generic vs per-kind ─────────────────────────────────────────────────────────────────
 * The board is generic over the concrete `<Claim, Attestation>` shapes (it imports NEITHER the
 * canary `DivergenceClaim`/`DivergenceAttestation` NOR the cap-token `CapTokenIssueClaim`/
 * `CapTokenIssueAttestation` — those stay in their owning apps). Every kind-specific behaviour is
 * INJECTED via a `BoardKindConfig`:
 *   - `kind` discriminator: 'canary-divergence' | 'captoken-issue' | 'captoken-refresh' | 'captoken-revoke'
 *   - `cellKey(claim)` — the per-kind identifying-field key; the BOARD prepends `${kind}|` so a canary
 *     cell and a cap-token cell with identical identifying fields can NEVER collide on the shared board.
 *   - `attesterKey(att)` + `distinctCount(atts)` — per-kind distinctness (canary: distinct Wallet-B
 *     pubkey, mirroring `distinctAttesterCount`; cap-token: distinct operator addr/pubkey).
 *   - `gcFailMode` — the per-kind GC FAIL-MODE branch (canary = fail-CLOSED silent-GC-no-slash,
 *     semantically byte-identical to the canary board's gc; cap-token = fail-LOUD bounded-retry +
 *     fresh-nonce escalation, Fork-5: a blocked room-join must be VISIBLE).
 *   - `validateWireSchema(claim, att)` — the per-kind INV-C wire-schema ALLOW-LIST. A canary post
 *     MUST REJECT any payload carrying an auditing-validator miner_id or a salted assignmentSecret
 *     (only the ACCUSED relay public id + Wallet-B pubkeys/sigs are allowed); a captoken-* post uses
 *     its own allow-list (CP operator addresses are PUBLIC). This isolation is a HARD, TEST-GATED
 *     requirement — the per-kind fail-mode branch must not leak canary silent-GC into cap-token nor
 *     cap-token fail-loud into canary.
 *
 * The board is ADVISORY assembly only; the AUTHORITATIVE distinctness/quorum gates stay on-chain
 * (`cp_quorum_sig::verify_quorum` + F-01 VecSet for cap-token; `canary_audit.move` VecSet for canary).
 */

import { createLogger } from './logger.js';

const log = createLogger('quorum/board');

/** The `kind` discriminator carried on the shared carrier (Fork 1 UNIFY). */
export type ClaimKind =
  | 'canary-divergence'
  | 'captoken-issue'
  | 'captoken-refresh'
  | 'captoken-revoke';

/** Default corroboration/quorum window (rounds) before an un-quorumed cell is GC'd. */
export const DEFAULT_W_CORR = 8;

/**
 * The per-kind GC FAIL-MODE branch (Fork-5). Two mutually-exclusive shapes:
 *   - `'fail-closed-silent'` (canary): an un-quorumed cell is silently dropped at expiry — NO slash,
 *     NO escalation (a divergence no >=2-distinct quorum independently corroborated is simply not
 *     prosecuted). Byte-identical in semantics to the canary `InMemoryClaimBoard.gc` body.
 *   - `{ kind: 'fail-loud', onUnquorumedExpiry }` (cap-token): an un-quorumed cell at expiry fires
 *     `onUnquorumedExpiry(namespacedKey)` so the daemon can escalate + bounded-retry with a fresh
 *     nonce — a blocked room-join must be visible (Fork-5).
 */
export type GcFailMode =
  | 'fail-closed-silent'
  | { kind: 'fail-loud'; onUnquorumedExpiry: (namespacedKey: string) => void };

/**
 * The per-kind configuration injected into the generic board. One per `kind` registered on a board.
 */
export interface BoardKindConfig<Claim, Attestation> {
  /** The discriminator this config governs. */
  kind: ClaimKind;
  /** Per-kind identifying-field key (the board namespaces it by `kind`). */
  cellKey: (claim: Claim) => string;
  /** Per-kind dedup key for ONE attestation (idempotency + distinctness). */
  attesterKey: (att: Attestation) => string;
  /** Per-kind distinct-attester count (canary: distinct Wallet-B pubkey; cap-token: distinct addr). */
  distinctCount: (atts: Attestation[]) => number;
  /** Minimum distinct attesters at/above which a cell is "quorumed" (retained past the window). */
  minDistinct: number;
  /** Per-kind GC fail-mode branch (Fork-5). */
  gcFailMode: GcFailMode;
  /**
   * Per-kind INV-C wire-schema ALLOW-LIST. Return a non-null reason string to REJECT the post
   * (fail-closed — nothing is stored), or `null` to ALLOW. For 'canary-divergence' this MUST reject
   * any payload carrying an auditing-validator miner_id or a salted assignmentSecret.
   */
  validateWireSchema: (claim: Claim, att: Attestation) => string | null;
}

/** A snapshot of one open (un-submitted, un-GC'd) board cell. */
export interface OpenGenericCell<Claim, Attestation> {
  /** The KIND-NAMESPACED key (`${kind}|${cellKey(claim)}`) — globally unique on the shared board. */
  key: string;
  kind: ClaimKind;
  claim: Claim;
  attestations: Attestation[];
  openedRound: number;
}

/**
 * The injectable GENERIC claim-board PORT — the parametric sibling of the canary `ClaimBoard` port.
 * `post` takes the `kind` so a single board can host multiple kinds on the shared carrier; `listOpen`
 * / `get` / `markSubmitted` operate on the kind-namespaced key.
 */
export interface QuorumClaimBoard {
  /** Append an attestation for a claim of `kind`; IDEMPOTENT per the kind's `attesterKey`. Rejects an
   *  unregistered kind or an INV-C-allow-list violation (fail-closed — nothing stored). */
  post<Claim, Attestation>(
    kind: ClaimKind,
    claim: Claim,
    attestation: Attestation,
    round: number,
  ): Promise<void>;
  /** Every cell not yet submitted (and not GC'd), across all kinds. */
  listOpen(): Promise<OpenGenericCell<unknown, unknown>[]>;
  /** One cell by its kind-namespaced key (or `undefined` if absent/submitted). */
  get(key: string): Promise<OpenGenericCell<unknown, unknown> | undefined>;
  /** Mark a cell submitted so it is never re-assembled. */
  markSubmitted(key: string): Promise<void>;
  /** GC un-quorumed cells older than `W_corr` rounds (per-kind fail-mode) + drop submitted cells. */
  gc(currentRound: number): Promise<void>;
}

interface GenericBoardCell {
  kind: ClaimKind;
  claim: unknown;
  /** Dedup by the kind's `attesterKey` — a duplicate post of the same attester is idempotent. */
  byAttester: Map<string, unknown>;
  openedRound: number;
  submitted: boolean;
}

/**
 * The hermetic in-memory GENERIC board. Hosts multiple `kind`s on ONE shared in-memory table, keyed
 * by the KIND-NAMESPACED cell key so cross-kind collision is structurally impossible. Bounded by
 * `W_corr` GC with the per-kind fail-mode branch. The live `/quorum/claims` HTTP carrier (Leg 7,
 * DEFERRED) swaps in behind this same `QuorumClaimBoard` port without touching the protocol core.
 */
export class InMemoryGenericClaimBoard implements QuorumClaimBoard {
  private readonly cells = new Map<string, GenericBoardCell>();
  private readonly configs = new Map<ClaimKind, BoardKindConfig<unknown, unknown>>();
  private readonly wCorr: number;

  constructor(configs: BoardKindConfig<any, any>[], opts?: { wCorr?: number }) {
    for (const cfg of configs) {
      if (this.configs.has(cfg.kind)) {
        throw new Error(`quorum/board: duplicate config for kind '${cfg.kind}'`);
      }
      this.configs.set(cfg.kind, cfg as BoardKindConfig<unknown, unknown>);
    }
    this.wCorr = opts?.wCorr ?? DEFAULT_W_CORR;
  }

  private requireConfig(kind: ClaimKind): BoardKindConfig<unknown, unknown> {
    const cfg = this.configs.get(kind);
    if (!cfg) throw new Error(`quorum/board: no config registered for kind '${kind}' (fail-closed)`);
    return cfg;
  }

  /** `${kind}|${cellKey(claim)}` — the namespace prefix guarantees no cross-kind collision. */
  private namespacedKey(cfg: BoardKindConfig<unknown, unknown>, claim: unknown): string {
    return `${cfg.kind}|${cfg.cellKey(claim)}`;
  }

  async post<Claim, Attestation>(
    kind: ClaimKind,
    claim: Claim,
    attestation: Attestation,
    round: number,
  ): Promise<void> {
    const cfg = this.requireConfig(kind);
    // INV-C wire-schema ALLOW-LIST (fail-closed: reject BEFORE any state mutation).
    const reject = cfg.validateWireSchema(claim, attestation);
    if (reject) {
      throw new Error(`quorum/board: INV-C wire-schema rejected a '${kind}' post: ${reject}`);
    }
    const key = this.namespacedKey(cfg, claim);
    let cell = this.cells.get(key);
    if (!cell) {
      cell = { kind, claim, byAttester: new Map(), openedRound: round, submitted: false };
      this.cells.set(key, cell);
    }
    // Idempotent per the kind's attesterKey — re-posting the same attester never inflates the count.
    cell.byAttester.set(cfg.attesterKey(attestation), attestation);
  }

  async listOpen(): Promise<OpenGenericCell<unknown, unknown>[]> {
    const out: OpenGenericCell<unknown, unknown>[] = [];
    for (const [key, c] of this.cells) {
      if (c.submitted) continue;
      out.push({
        key,
        kind: c.kind,
        claim: c.claim,
        attestations: [...c.byAttester.values()],
        openedRound: c.openedRound,
      });
    }
    return out;
  }

  async get(key: string): Promise<OpenGenericCell<unknown, unknown> | undefined> {
    const c = this.cells.get(key);
    if (!c || c.submitted) return undefined;
    return {
      key,
      kind: c.kind,
      claim: c.claim,
      attestations: [...c.byAttester.values()],
      openedRound: c.openedRound,
    };
  }

  async markSubmitted(key: string): Promise<void> {
    const c = this.cells.get(key);
    if (c) c.submitted = true;
  }

  async gc(currentRound: number): Promise<void> {
    for (const [key, c] of this.cells) {
      const expired = currentRound - c.openedRound >= this.wCorr;
      if (!expired) continue; // within the window — keep accruing
      const cfg = this.requireConfig(c.kind);
      const belowQuorum = cfg.distinctCount([...c.byAttester.values()]) < cfg.minDistinct;
      // A SUBMITTED cell is always dropped past the window (its on-chain action is settled; retaining
      // it within the window blocked a re-submit). A quorumed-but-unsubmitted cell is RETAINED
      // (defensive). The per-kind FAIL-MODE governs ONLY the un-quorumed-at-expiry path.
      if (c.submitted) {
        this.cells.delete(key);
        continue;
      }
      if (!belowQuorum) continue; // quorumed but unsubmitted → retain (defensive)
      // ── un-quorumed at expiry → per-kind FAIL-MODE branch (Fork-5, ISOLATED per kind) ──
      if (c.kind === 'canary-divergence' || cfg.gcFailMode === 'fail-closed-silent') {
        // fail-CLOSED silent-GC-no-slash: drop, no escalation (byte-identical to the canary board).
        this.cells.delete(key);
      } else {
        // fail-LOUD (cap-token, Fork-5): escalate so the blocked room-join is VISIBLE, then drop the
        // doomed cell (the daemon bounded-retries with a fresh nonce → a NEW cell key).
        cfg.gcFailMode.onUnquorumedExpiry(key);
        log.warn(
          { kind: c.kind, key, distinct: cfg.distinctCount([...c.byAttester.values()]), minDistinct: cfg.minDistinct },
          'quorum/board: un-quorumed cell expired (fail-LOUD) — escalating for bounded-retry w/ fresh nonce',
        );
        this.cells.delete(key);
      }
    }
  }
}
