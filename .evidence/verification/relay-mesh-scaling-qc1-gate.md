# SHIP gate — QC-1: selectPlacementRelay honors canaryHealthy (MUST-FIX-BEFORE-M4b)

- **Date:** 2026-06-22
- **Item:** QC-1 (carried from `relay-mesh-scaling-m3-gate.md` "Deferred items") — `selectPlacementRelay` ignored `canaryHealthy`, so the per-room placement scorer could pick a PROVEN canary-unhealthy relay even though `poolHealthGate` excludes it from the pool-health count.
- **Workflow:** `wf_13361f44-b97` (3 phase: Recon → Implement[TDD] → Verify[3 adversarial lenses]).
- **Verdict:** **GATE_PASS** — 0 blockers, 0 confirmed overclaims (3/3 lenses PASS).
- **Commit under gate:** dvconf-daemons `quangdm_main` — code `apps/cp-daemon/src/admission-capacity.ts` + test `apps/cp-daemon/src/__tests__/admission-capacity.test.ts`.

## Fix (3-line src diff, additive)

```ts
for (const r of relays) {
  // QC-1 (REQ-RMS-018): never place onto a PROVEN canary-unhealthy relay. Strict
  // `=== false` only — field-absent (undefined) / no-feed (true) stay eligible (back-compat).
  if (r.canaryHealthy === false) continue;
  const projected = r.attestedLoadPaths + roomLoad;
  ...
```

**Predicate rationale** — `canaryHealthy?` is OPTIONAL (3 states): field-absent `undefined` (M1/M2 + existing unit tests) → eligible; no-feed path `true` (event-handler.ts:474 `feedActive ? attested!==undefined : true`) → eligible; feed-active PROVEN-unhealthy `false` → **excluded**. STRICT `=== false` (not falsy `!r.canaryHealthy`, which would wrongly drop `undefined` and break back-compat). Deliberately ASYMMETRIC with `poolHealthGate`'s `=== true` (a count-the-healthy gate requires positive proof; the placement scorer excludes only proven-unhealthy). Heartbeat staleness deliberately NOT folded in (owned by `poolHealthGate`, run BEFORE selection at event-handler.ts:481).

**Live path closed:** the only production caller is `selectPlacementRelay(capacities, roomLoad)` at event-handler.ts:489 (the EscrowCreated arm's serving `chosen`).

## Evidence

- TDD: `.evidence/tdd/REQ-RMS-018-qc1-red.log` (2 failed | 17 passed pre-fix) → `.evidence/tdd/REQ-RMS-018-qc1-green.log` (19/19).
- 3 new teeth-bearing tests (asserting the SPECIFIC healthy `minerId` chosen / `null` defer / undefined stays eligible — never a bare truthy).
- guard#9 (MAIN, clean `--no-cache`): cp-daemon **365/365** (362 baseline + 3), `tsc -p apps/cp-daemon` exit 0. validator-daemon + signaling structurally unaffected (grep: neither imports `admission-capacity`).
- RED independently reproduced by the teeth lens (git-stash the src fix, keep tests → exactly 2 failed | 17 passed with identical assertion messages).

## Adversarial lenses (3/3 PASS, read-only)

| Lens | Verdict | Key finding |
|---|---|---|
| TEETH/HONESTY | PASS | tests assert the named healthy `HEALTHY-WORSE` minerId (not truthy); RED reproduced; GREEN 19/19; live path event-handler.ts:489 closed |
| SCOPE+INV | PASS | only the 2 fix files in the diff; canary `proof.ts`/`loss-classifier.ts`/145-byte proof/`canary_audit.move` + leg-6 TRAP surfaces (`ballot.slice`/`topRelayIds`/`computeNodeScore`/`selectTopRelays`) byte-UNTOUCHED; no raw `console.*` |
| BACK-COMPAT | PASS | no-feed (`true`) + field-absent (`undefined`) eligible; existing 3 selectPlacementRelay + poolHealthGate tests unchanged; only behavior change = feed-active proven-unhealthy now skipped (correct QC-1, removes a pre-existing gate/scorer contradiction) |

## Carried (on record — NOT QC-1 scope, no blocker)

1. **Ballot back-fill** — the RECORDED ballot (event-handler.ts:502-508, eligiblePeers + restByConsensus) is NOT filtered by `=== false`, so a proven-unhealthy relay can still appear at index≥1; it is NEVER the serving `chosen` (index-0). Consistent with QC-1's "never PLACE onto" scope + "a ballot, not a live assignment" (event-handler.ts:499).
2. **Defer-storm** — a degraded feed marking many relays unhealthy increases deferrals (event-handler.ts:490-495 graceful-degrade pend). Intended safety behavior.
3. **M4b TRAP re-baseline (action for M4b gate)** — the M3 leg-6 TRAP asserted `selectPlacementRelay` appeared in the M3 diff only as `+` comment lines. This fix changes ONE executable line in its body (gate-sanctioned: QC-1 is the explicit MUST-FIX-BEFORE-M4b). The M4b gate must re-baseline the TRAP to allow this single additive guard and re-confirm the argmin/tie-break formula + consensus score are otherwise byte-unchanged.

## Status

QC-1 **CLOSED**. The MUST-FIX-BEFORE-M4b precondition for the mesh placement path is satisfied. Remaining M4b-gated work (canary M4b-live capture + multi-cp OQ-7 multi-host) stays deferred on the W5 connection-arch operator sign-off.
