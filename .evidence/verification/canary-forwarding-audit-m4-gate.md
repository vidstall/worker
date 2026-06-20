# Canary Forwarding-Audit Wave (validate-node, D-M2-20) — MILESTONE 4a SHIP gate

> **GATE_PASS_WITH_PARTIALS** — independent 11-agent read-only SHIP gate `wf_648d0d56-7d8`
> (7 REQ-slice auditors + honesty/scope/completeness lenses + a gate synthesizer). **0 blockers · 0 confirmed
> overclaims.** Every claim re-verified against COMMITTED shipped source (file:symbol:line), not prose. 2026-06-20.

## Verdict

All 6 auditors returned **PASS**; all 3 lenses **PASS** (0 material issues). All **REQ-CFA-036..046 MET**.
Guard #9 (MAIN authoritative, hermetic): **daemons 170/170 + client 99/99 unit GREEN, tsc 0 errors.**

## HEADs gated

| repo | branch | HEAD | scope |
|---|---|---|---|
| dvconf-daemons | quangdm_main | `5e76c1e` (code) + (this commit: gate doc) | per-relay scoping + WAN-harness fix + verify-loop hermetic half |
| dvconf-client | master | `ecd83d3` | OOB sealed-box cellSecret crypto core |
| root | master | `13455c2` (design + ADR + M3 flip) + (SOT commit) | M4 DESIGN/REQUIREMENTS/PLAN + ADR-0019 |
| dvconf-contracts | main | `970d656` (UNCHANGED) | zero Move in M4a (byte-frozen by construction) |

## What M4a closes / proves (per chunk)

- **Chunk 1 — per-relay room-scoping (REQ-CFA-036/037/038):** `buildRelayScopedValidatorPool`
  (`validator-pool.ts:136-153`) returns ONLY a relay's own room's co-auditors (a room-B-only co-auditor is
  EXCLUDED, test-proven); the `cell.ts` tick loops per-`(relay,room)` so a multi-homed relay emits ONE cell per
  pair with **NO silent re-union** (re-union fails RED); `assignCells` body (`cell.ts:196-235`, the M2 salt/score/
  dedup) is **byte-IDENTICAL** parent↔HEAD. Zero new chain read. **Closes W-M3-OVERCOUNT CONDITIONAL on the
  non-union disposition, fixture-pinned.** A coverage-ACCURACY fix on the SELF-REPORT half (D-CFA-15).
- **Chunk 2 — WAN-harness config-shape FIX (REQ-CFA-039/040/041):** the `classifyDivergences` call
  (`p11-wan-canary-loss.ts`) now matches the real signature (`newDropAccumulator()` `byRelay`, supplied
  `relayMinerId`, `bigint deltaBps`) and the `as unknown as` cast is **REMOVED** — so `tsc` now enforces the
  shape (a live run no longer silently mis-gates withholding as benign). Import-shape smoke + synthetic
  lossy/tail-abort/sub-budget chain test. **Closes W-M4-HARNESS-SHAPE.** **RUN stays DEFERRED**
  (`P11_I_ACKNOWLEDGE_DEFERRED_RUN` + `isEntryPoint`; imports only `canary/*`, never `apps/relay/`).
- **Chunk 3 — verify/publish loop HERMETIC HALF (REQ-CFA-042/043):** `startCanaryVerifyLoop`
  (`verify-loop.ts:277-336`) is the **first real reader** of `state.relayStunLossBps` (parent `5e76c1e~1` had
  decl/init/write but ZERO `.get` readers — **genuinely CLOSES W-M3-STUN-PATH**); injectable
  `CanaryForwardCapture`+submit seam, synthetic peer keypairs for the `MIN_ATTESTERS=2` floor, crash-safe.
  **NARROWS (does NOT close) W-M3-SIM** — `W-M4-COSIGN` (the real ≥2-distinct-Wallet-B co-sign protocol) is
  UNBUILT = M4b. **AMPLIFIES W-M3-OFFCHAIN** (never "resolved", tied to W-E4). NO live media / NO `apps/relay`
  edit (INV-B).
- **Chunk 4 — OOB sealed-box crypto CORE (REQ-CFA-044):** `cell-secret-oob.ts` proves one minted `cellSecret`
  sealed to N synthetic member pubkeys yields the **IDENTICAL** secret for every member + a wrong key is
  rejected. OFF-CHAIN (does NOT re-open D-CFA-11), ADDITIVE (env fallback intact), ZERO Move. **NARROWS
  P-M2-4/D-CFA-19** — proven over SYNTHETIC keys only (**W-M4-OOB-SYNTHETIC**); stays **DEFERRED-WITH-ADR, NOT
  RESOLVED**.
- **Chunk 5 — on-chain loss-aware slash DEFERRAL ADR (REQ-CFA-045):** ADR-0019 (PROPOSED / DEFER_POST_THESIS)
  records the chain-cannot-observe-loss crux (STUN + cumulative accumulator both off-chain-sourced → an
  on-chain field only RELOCATES the W-M3-OFFCHAIN trust), the 4-repo byte-mirror + golden-vector regen cost,
  and names **W-E3** as the precondition. **W-M3-OFFCHAIN flipped → DEFERRED-WITH-ADR** (NOT RESOLVED).
  Byte-frozen 145-byte proof + Move 361/361 **UNTOUCHED**.

## Honest verdict ON RECORD (DA-3) — confirmed not overclaimed

- **CLOSED:** W-M3-OVERCOUNT (conditional/fixture-pinned), W-M4-HARNESS-SHAPE (new), W-M3-STUN-PATH (genuine).
- **NARROWED, not closed:** W-M3-SIM (W-M4-COSIGN unbuilt = M4b), P-M2-4/D-CFA-19 (synthetic keys; live
  distribution + directory = M4b).
- **AMPLIFIED, never resolved:** W-M3-OFFCHAIN (the off-chain gate going live; tied to W-E4).
- **DEFERRED to M4b:** the live WAN/real-camera RUN (W-E2/D-CFA-17 stays open), the live cross-receiver media
  plane + localnet slash, W-M4-COSIGN, the live OOB distribution + validator-pubkey directory, the on-chain
  loss-aware slash BUILD (paired with W-E3).
- **Novelty FROZEN at 0.74** — every M4 item is engineering hardening, zero increment.

## Cross-cutting hard-gates (MAIN guard #9, authoritative re-run)

validator-daemon unit **170/170** + client crypto **99/99** · tsc **0 errors** · INV-A `proof.ts` (145-byte
`canonicalProofMessage`) + `verifier.ts extractCanaryBody` **EMPTY diff** · INV-B `apps/relay/` non-test diff
**EMPTY** · INV-C no raw `console.*` / no secret logged · Move `canary_audit.move` + tests **byte-frozen** (no
M4a Move commit). Log: `canary-audit-m4-guard9-2026-06-20.log` (+ per-suite daemons/client logs).

## Non-material nits (non-blocking, on record)

- ADR-0019 cites `canary_audit_tests.move` lines ~353/354/357/358/368 while the live committed assertions sit a
  few lines lower in the 353-368 region — doc-only line drift, all named symbols present.
- `dvconf-contracts/Move.lock` shows a working-tree modification, but `git diff 970d656~1 970d656 -- Move.lock`
  is EMPTY — an uncommitted concurrent-session toolchain-rev artifact, NOT in any audited commit; does not break
  `canary_audit.move` byte-identity.

**Documented partials (7, none blocking):** W-M3-OVERCOUNT-conditional · W-M3-SIM-narrowed (W-M4-COSIGN) ·
W-M3-OFFCHAIN-amplified · W-M4-OOB-SYNTHETIC / P-M2-4-narrowed-not-resolved · on-chain-slash deferred (ADR-0019)
· WAN RUN deferred · the two cosmetic nits above.
