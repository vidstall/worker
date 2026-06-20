# Canary Forwarding-Audit Wave (validate-node, D-M2-20) — MILESTONE 3 SHIP gate

> **GATE_PASS_WITH_PARTIALS** — independent 8-auditor read-only SHIP gate `wf_eb9decb4-625`
> (+ gate synthesizer). **0 blockers · 0 material overclaims.** Every claim re-verified against
> COMMITTED shipped source (file:symbol:line), not prose. 2026-06-20.

## Verdict

All 8 auditors returned **MET / PASS**. All REQ-CFA-023..035 **MET** (chunks 3/4 met as deferred
artifacts). All hard invariants **git-verified EMPTY-diff** in the M3 commit. Independent hermetic
re-run: **23/23** M3 tests (loss-classifier 13 / validator-pool 6 / room-scope-staleness 4) under the
DEFAULT vitest config, no port bound; committed full canary suite **85/85**.

## HEADs gated

| repo | branch | HEAD | scope |
|---|---|---|---|
| dvconf-daemons | quangdm_main | `5cd40bc` (code) + (this commit: gate doc + guard#9 + notation nit) | chunks 1+2 code + WAN script + TDD logs |
| root | master | `302754f` (design docs) + (SOT commit) | DESIGN/REQUIREMENTS/PLAN + ADR-0018 |
| dvconf-contracts | main | `970d656` (UNCHANGED) | zero Move in M3 |

## What M3 closes / proves

- **Chunk 1 — room-scoped co-auditors (REQ-CFA-023/024/025, closes D-CFA-16 / W-M2-3 / P-M2-5):**
  `buildRoomScopedValidatorPool` pure; pool scoped to this daemon's rooms' co-auditors (registry
  discovery DEMOTED to liveness-only — an out-of-room validator is EXCLUDED, test-proven); `validatorIds`
  from the already-parsed `RoomAssigned.validator_ids` (zero new chain read, miner_id/ID only);
  `assignCells`/`cell.ts` byte-identical. A coverage-ACCURACY fix on the SELF-REPORT half, **not** a
  slashing change.
- **Chunk 2 — DROP-path loss classifier (REQ-CFA-026..030, the W-E2 crux):** TAMPER (`observedHash !==
  'MISSING'`) **always promoted p=1, never gated** (`loss-classifier.ts:240-241`); DROP gate = exactly
  **two composed signals** — PRIMARY cumulative mean-rate bound (rate > `stunPacketLossBps + deltaBps`
  budget over `>= MIN_ROUNDS=5`, strict) AND SECONDARY `>= k` distinct receivers (`:265`); the STUN prior
  is **folded into the budget** (`:244`), not a separate gate (the subsumed weak-prior term is genuinely
  absent). **Cross-teeth dedup** (a `frameSeq` reported both tamper and drop is promoted **once as the
  TAMPER**, `:256`); one proof per promoted `frameSeq`.

## Honest verdict ON RECORD (DA-3) — confirmed not overclaimed

- **TAMPER closed STRUCTURALLY (p=1); WITHHOLDING NARROWED, not closed** — residual **W-E2-RES** (a
  sustained sub-budget withholder is never promoted; delta-sizing is the irreducible knob). Test-proven
  (`loss-classifier.test.ts`, 100 rounds 1% vs 3% budget → never promoted).
- **W-M3-OFFCHAIN** — the off-chain classifier **RELAXES the punishing-half invariant** (slash eligibility
  was chain-re-verifiable; now a trusted off-chain gate the chain cannot audit decides it), tied to W-E4,
  explicitly distinguished from W-M2-1-class.
- **W-M3-SIM** — cross-receiver corroboration is **SIMULATED-only** (`verifyForwardedCanary`/
  `classifyDivergences` have ZERO production callers; verify loop = Task 5.2+). Gate claim scoped to
  "classifier logic over synthetic inputs," not live corroboration.
- **W-M3-STUN-PATH** — STUN is a coarse, single-global-probe, **written-now-read-later** prior folded into
  the budget (`relayStunLossBps` written from the validator's OWN probe, zero production readers).
- **W-E2 / D-CFA-17 PARTIALLY closed** — hermetic loss model proven; live WAN/real-camera RUN deferred.
- **No novelty over 0.74** — the loss bound is a ShortMAC **adaptation**; the signal composition is
  engineering hardening, not a contribution.

## Documented partials (none blocking)

W-E2-RES · W-M3-OFFCHAIN · W-M3-SIM · W-M3-STUN-PATH · W-M3-OVERCOUNT (union over-count, narrowed not
eliminated) · W-M3-STALE (event-cursor-trusting; optional `get_active_rooms` reconciliation design-only,
mitigated by the verified Move invariant that `promote_relay`/`swap_relay` never touch `assigned_validators`)
· **WAN demo (chunk 3)** = script+runbook+honesty-label only, live RUN hard-deferred behind a guard,
single-hop (W-E5), W-M3-TAIL fixed-tail sanity gate · **OOB channel (chunk 4)** = ADR-0018 DEFER_POST_THESIS,
doc-only, P-M2-4/D-CFA-19 → DEFERRED-WITH-ADR.

## Non-material nit folded in-flight

One cosmetic notation nit (the gate's only finding): the comment label "1-(1-f)^n bound" overstated the
implemented math (a cumulative MEAN drop-rate threshold, not the literal binomial). Softened to
"1-(1-f)^n-STYLE / cumulative mean-rate (ShortMAC-style adaptation)" in `loss-classifier.ts` + the test,
committed with this gate doc. No behavior change (loss-classifier 13/13 re-confirmed).

## Cross-cutting hard-gates (MAIN guard #9, authoritative re-run)

canary unit + index **85/85** · tsc **0 new** (4 pre-existing cross-repo errors in untouched files) ·
verifier/proof(145-byte)/cell + `canary_audit.move` + `apps/relay/` **EMPTY diff** · Move **361/361 by
byte-identity** · no raw `console.*`. Log: `canary-audit-m3-guard9-2026-06-20.log`.
