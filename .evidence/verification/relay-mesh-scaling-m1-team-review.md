# Relay-Mesh Scaling Lane #17 — Milestone 1 TEAM REVIEW (independent post-ship second opinion)

**Team verdict:** **CONFIRM_SHIP** — shipJustified = YES, **0 confirmed M1-scope blockers** after adversarial verification.
**Date:** 2026-06-21
**Review workflow:** `wf_da7f5f71-7bf` (29 agents · 5 role reviewers → per-finding adversarial verification vs committed source → lead synthesis).
**Why this review exists:** M1 was BUILT *and* SHIP-gated (`wf_89ed07f0`, GATE_PASS_WITH_PARTIALS) by the SAME operator in one prior session. This is the independent second opinion the gate could not give itself — its job was to find what the gate MISSED or UNDER-RATED, not to rubber-stamp.

## Role domain-verdicts (none RAISE_BLOCKER)
| Role | Agent | Verdict |
|---|---|---|
| Architect | general-purpose | **CONFIRM_SHIP** |
| OnChain / Move | general-purpose (grep — gitnexus Move-blind) | **CONFIRM_SHIP** |
| Code-Quality / QC | `superpowers:code-reviewer` | SHIP_WITH_CONCERNS |
| Verification | general-purpose | SHIP_WITH_CONCERNS |
| PM / Scope | general-purpose | SHIP_WITH_CONCERNS |

Lead synthesized → **CONFIRM_SHIP**: every concern is either a gate-disclosed-and-correctly-deferred partial or a new-but-MINOR-and-latent finding; zero are M1-scope blockers.

## Load-bearing invariants — independently re-substantiated (not prose-trusted)
1. **PVR consensus BYTE-FROZEN.** `git show fe8e506 -- apps/cp-daemon/src/scoring.ts` is a pure append of the `CAPACITY_LAYER_IS_ADDITIVE` marker; `computeNodeScore`/`canonicalSort` bodies byte-identical. Golden tripwire `computeNodeScore(...)===7650n` is genuinely hand-derived (76,500,000/10,000) and fails loud on any 7th-weight edit. *(scoring.ts:99-107; __tests__/scoring.test.ts:152-158)*
2. **Capacity is provably an OFF-CHAIN filter applied AFTER `canonicalSort`.** event-handler.ts computes `rankedRelays = timedCanonicalSort(...)` (:396) FIRST, then `selectPlacementRelay`'s argmin narrows the already-sorted set (:423+); ballot back-fills FROM the consensus-sorted set. No capacity math leaks into the consensus path. *(event-handler.ts:396,423-500)*
3. **`room_class_hint:u8` ABI break is genuinely additive across all 3 repos.** Move appends the param/field (no reorder); the daemon decodes RoomCreated by JSON KEY with the field OPTIONAL (events.ts:134-139), so no positional consumer breaks; client adds `tx.pure.u8(0)` in the matching slot; **0 remaining old-arity callers**. *(485a3ae / cb626f7 / 0b246d5)*

## Confirmed findings after adversarial verification

### BLOCKERS: none.

### MAJOR (1 — gate-disclosed, correctly M2/M4b-deferred)
- **VER-2 / ARCH-5 — REQ-RMS-005 "attested-over-self-report" is exercised ONLY hermetically (= the gate's load-bearing partial #2 / W-M3-SIM).** Independently reproduced in shipped source: cp-daemon `index.ts:622` calls `createEventHandler(logger, undefined, {txContext})` with NO 4th `capacityCtx` arg → `attestedLoad` undefined → `feedActive=false` (event-handler.ts:444) → falls back to `Number(node.load)` self-report (line 452); validator-daemon `index.ts:454` calls `startCoverageServer({...})` with NO `loadProvider` → `GET /canary/load` 404s (coverage-server.ts:216). So in a RUNNING daemon the relay-blind-capacity novelty wedge is design-complete but live-unproven. The gate names it as partial #2 with an explicit "(load-bearing caveat)" tag and queues live wiring as M2 item (a) — **fairly characterized, NOT under-rated.**

### NEW findings the SHIP gate MISSED (all MINOR / latent — none block M1)
- **QC-1 (strongest new) — `selectPlacementRelay` never consults `canaryHealthy`.** admission-capacity.ts:66-82 filters candidates ONLY by capacity ceiling; the event-handler.ts:452 self-report fallback is PER-RELAY (fires when a relay is absent from the feed), not feed-wide; `poolHealthGate` only COUNTS healthy relays without removing the unhealthy one from the `capacities` array handed to `selectPlacementRelay` (line 473). Net: **in feed-active mode a canary-unattested relay can still WIN placement on untrusted self-report load**, contradicting REQ-RMS-005. Adjusted MAJOR→MINOR: **LATENT only** — production never enables the feed (`feedActive` always false today), so M1 blast radius is zero; becomes a real trust hole the moment M4b wires the feed. No test pins the feed-active-but-relay-missing case. **MUST-FIX BEFORE M4b wires the feed.**
- **ARCH-4 — daemon hardcodes `MIN_RELAY=2` vs the MUTABLE on-chain `room_rules.min_relay`.** admission-capacity.ts:97 + event-handler.ts:500 emit `ballot.slice(0,MIN_RELAY)`; no daemon-side read of `room_rules.min_relay`, which is mutable via `update_room_rules`. An admin raising it >2 → every CP ballot aborts with `E_INVALID_BALLOT=509` → admission silently stalls. Pre-existing (baseline `d5cd7c3^` also capped at `Math.min(2,...)`), NOT an M1 regression — new code is strictly more robust and fails LOUD via on-chain abort. `RoomRulesUpdated` is typed (events.ts:158) but unhandled.
- **ONCHAIN-4 — REQ-RMS-004 ballot floor is governance-dependent, not structural.** `update_room_rules` (room_manager.move:313-323) assigns `min_relay` from an arbitrary `u64` with NO lower-bound assert (accepts 0/1); a misconfigured/compromised AdminCap could lower the floor and let a length-1/empty ballot pass `E_INVALID_BALLOT`. `E_INVALID_MIN=505` already exists but is declaration-only (single grep hit at room_manager.move:29, `#[allow(unused_const)]`) — a strong tell a floor assert was intended. Pre-existing (485a3ae is additive-only), AdminCap-gated; one-line fix: `assert!(min_relay >= 2, E_INVALID_MIN)`.
- **ONCHAIN-3 — `cb626f7` silently repaired a pre-existing 4-arg drift in smoke-test.ts/load-test.ts** (missing `expected_participants` from the earlier PVR lane `cf33f8b`) while adding `room_class_hint` — a signal these two scripts are not in routine live-chain CI. Corrected now, not a blocker.
- **QC-4 — REFUTED → NIT.** The claim that a bad `RMS_C_WORKER_PATHS` causes a SILENT defer was refuted: the null-deferral path (event-handler.ts:475) emits `logger.warn({...,cWorker},...)` carrying the offending value; the deferral is observable. The finding's example was also wrong (`parseInt('300paths',10)===300`, not NaN). Residual = cosmetic log-clarity only.

## Assessment of the 9 gate-disclosed partials
All 9 are **fairly characterized; none under-rated**. Partial #2 (W-M3-SIM) is the most carefully-hedged entry in the doc — both unwired ends independently reproduced (no `capacityCtx` at cp-daemon index.ts:622; no `loadProvider` at validator-daemon index.ts:454 → 404). Marking REQ-RMS-005 **"MET" is defensible**: the structural selection mechanism (PURE `buildLoadPayload`, fail-open reader, attested-over-self-report argmin) IS shipped and feed-ready; only the live injection seam is unwired — the same mechanism-floor honesty precedent (DESIGN §7) the lane has used before. Only residual = a doc-clarity nit (the REQ-005 RTM row prints flat "MET" and would read more honestly as "MET-HERMETIC", but it is tethered to the load-bearing partial in the same doc). Partials #3/#5/#6/#7/#8/#9 all reproduced exactly as described.

## M1 vs M2 disposition
- **Correctly M2/M4b-deferred (do NOT block M1):** W-M3-SIM live canary feed wiring (VER-2/ARCH-5/QC-2/PM-2). QC-1 selection-path `canaryHealthy` gap is latent behind `feedActive=false` → fix BEFORE M4b enables the feed, not in M1 (zero live blast radius today). REQ-RMS-012 audio last-N fan-out (partial #4) deferred to M3 by design.
- **Deferrable but worth an M2 note:** ARCH-4 (read live `room_rules.min_relay` + handle the already-typed `RoomRulesUpdated`) and ONCHAIN-4 (`assert!(min_relay>=2, E_INVALID_MIN)`) — both pre-existing, AdminCap-gated, fail-loud; harden the REQ-RMS-004 invariant M1's pool-sizing leans on, neither exercised by M1's paths.
- **M1-hygiene, cheap to close (none block SHIP):** partial #5 re-tune `RMS_C_WORKER_PATHS` 300→540 before any demo; partial #7 commit the bench .md + RED/GREEN logs for a reproducible TDD trail at defense; NIT cluster (#9 duplicated `HEARTBEAT_STALE_EPOCHS`, dual-concern golden test).
- **Not M1 build items at all:** PM-6 Huddle01 novelty-axis verification = a pre-submission thesis-defense checklist item (triple-recorded in DESIGN/ROADMAP/gate), downgraded to NIT.

## Recommendation
**CONFIRM_SHIP.** The M1 `GATE_PASS_WITH_PARTIALS` verdict stands; zero confirmed M1-scope blockers. M2 carry-forwards:
- (a) wire the live feed **+ add the `canaryHealthy` exclusion in selection** (closes QC-1 + W-M3-SIM together);
- (b) read live `room_rules.min_relay` and/or add the `E_INVALID_MIN` floor assert (ARCH-4 / ONCHAIN-4);
- (c) re-tune `C_WORKER` 300→540 and commit the bench / RED-GREEN evidence before defense.

None of these qualify the M1 SHIP.
