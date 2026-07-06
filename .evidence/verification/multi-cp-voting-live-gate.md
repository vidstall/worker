# Multi-CP Voting Live (N=5) — SHIP gate

- **Date:** 2026-07-01
- **Verdict:** **GATE_PASS_WITH_PARTIALS** (0 blockers, 0 undisclosed material overclaims) → **SHIP**
- **Gate workflow:** `wf_049c9f6e-62f` (9 independent read-only auditors + synthesis)
- **HEADs (frozen at gate time):** contracts `dvconf-contracts` `multi-cp-live` **`d28e894`** (Phase A, Move suite 382/382) · daemons worktree `dvconf-daemons-multicp` `multi-cp-live` **`07d7383`**
- **Live-run evidence:** `.evidence/verification/multi-cp-voting-live-run.md` (+ `-console.log`)

## Milestone claim (independently re-verified)

Both surfaces reached a **genuine 4-of-5 on-chain quorum LIVE** on an N=5 localnet, read from on-chain events against the **frozen honest Phase-A contract**:

- **#6 role-vote:** `RoleAssigned` role=1, **vote_count=4, threshold=4**, 4 DISTINCT `RoleVoteCast.voter` (tx `BzQepZzzhSrVq3CboNdMgAxugj5LCohv3XNxsTF2rDzE`).
- **#7 pairing:** `RoomAssigned` **consensus_reached=true**, winning_cp `0xb2cbd0..` (∈ agreeing set), **verified_score=7756**, 4 DISTINCT `ProposalSubmitted.cp_id` at that score (tx `3m8GoCZj8kJ7EWpWRuUm8eMfkyJ6xMDe8i3q8FeDK1hZ`, room `0x1cd9..`).

The threshold is a real `ceil(5*6667/10000)=4` supermajority — the old scarcity floor-of-1 is removed and dormant (`role_voting.move:678`), so the live `threshold==4` is load-bearing. `consensus_reached=true` is emitted ONLY on the CP-quorum finalize path (`room_manager.move`; admin fallback sets `false`/zero winning_cp and was provably not taken). This closes the **"CP vote ran with only 1 CP"** defense-honesty gap.

## Per-auditor verdicts (9)

| Auditor | Verdict |
|---|---|
| A1 on-chain role-vote threshold (Phase A) | PASS |
| A2 pairing gate + E_ROLE_MISMATCH guard | PASS |
| A3 C4 #6 fail-closed assert logic | PASS |
| A4 C4 #7 escrow path / no admin bypass | PASS |
| A5 live-run evidence ↔ run-log consistency | PASS |
| A6 seed-bootstrap guard + mediasoup env-only fix | PASS |
| A7 test-integrity (51 unit tests + tsc, non-tautological) | PASS |
| A8 adversarial honesty lens | PASS_WITH_PARTIALS |
| A9 adversarial scope lens (HEAD freeze, 0 prod diff) | PASS |

## Disclosed partials (none blocking)

1. **Ephemeral localnet** — the node was torn down after the run, so the two txs are not re-queryable now; the re-verifiability caveat is disclosed in the evidence honesty notes + raw log. (Re-runnable via `.scratch-c4-live-run.ts`.)
2. **Fact-F determinism pin is STRUCTURAL** — the spec's "assert all 5 CPs' relayState/validatorState equal" is infeasible off-chain; replaced by `active_cp_count==5` precondition + canary-off. No fake equality assert made (evidence :47-53).
3. **Canary-off depends on the launching shell not exporting `CANARY_*`** (`mergeChildEnv` scrubs only `IDENTITY_ENV_KEYS`; `buildLaunchPlan` sets none) — mechanism disclosed, but no in-code runtime assert of `CANARY_*` absence. LOW: canary would perturb score determinism only, not the on-chain quorum counts (read from events).
4. **User-miner exit=1** is EXCLUDED from the benign-abort crash gate by design (it is the vote SUBJECT, not a consensus-fleet daemon); benign — the vote finalized ~136s > its own 120s internal `waitForRoleAssignment` (auto-register.ts:123), or a role stake-floor > its fixed 0.1 SUI. Does not affect the #6/#7 proofs (read from events).
5. **Fact-G benign-abort** — deterministic Move aborts (704/711/719/508) were RETRIED 5× then swallowed by `executeWithRetry` (null, no throw, no crash; retrying=71/exhausted=15); all 12 CP-fleet daemons stayed alive through teardown. Disclosed mechanism (tx.ts:38-69), NOT "non-retryable".
6. **Threshold is a strict `>2/3` supermajority via ceil** (N5→4; N3→3 = unanimous) — intentional + disclosed (`role_voting.move:673-678`).

## Optional pre-defense polish (non-blocking, tracked)

1. Add an explicit `CANARY_*`-absence assert in `run-multicp-voting.ts main()` before driving the demos (hardens partial #3).
2. Hoist the ephemeral-localnet caveat from the honesty notes into the evidence headline (partial #1).

## SHIP-gate honesty TODOs (cross-doc, tracked — not this lane's code)

- Log the `ceil(6667bps)` framing ("2/3" ⇒ N3-unanimity / N5→4 / N1→1) in `docs/00-meta/defense-honesty-register.md`.
- Reconcile manuscript `docs/80-research/manuscript/03-07-consensus-mechanism.md` §3.7.2 ("3-of-4 / exactly four") with N=5 / 4-of-5.
- Document the 2 KISS boundaries (role-record stuck on first-mover minority; pairing wedge-on-divergence).

## Recommendation

**SHIP.** No blocker; the sole PASS_WITH_PARTIALS auditor agrees the core claims are MET. All limitations are honestly disclosed.
