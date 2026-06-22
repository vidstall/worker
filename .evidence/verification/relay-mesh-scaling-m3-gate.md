# Relay-Mesh Scaling Lane #17 — Milestone 3 SHIP Gate

**Verdict:** **GATE_PASS_WITH_PARTIALS** — 4/4 REQ-RMS MET, **0 blockers**, **0 confirmed overclaims**, both adversarial lenses PASS.
**Date:** 2026-06-22
**Gate workflow:** `wf_c2d54b99-5c1` (6 read-only auditors [4 per-REQ + hygiene + bench] re-verifying every load-bearing claim vs COMMITTED source @ `88068b3` [file:symbol:line + git diff, not prose] + 2 adversarial lenses honesty/scope + lead synthesis). Mirrors M1 `wf_89ed07f0` / M2 `wf_f5972668`.
**Build:** Stage D legs 1–7 (`CHECKPOINT-stage-D.md`); MAIN edited + subagent-TDD + guard#9 + scoped per-leg commits; leg-6 hot-path pre-commit VERIFY `wf_372d3149-9e2` (GO / 0 blockers).
**Shipped commits:** daemons `937bf15 312a6d6 93d347e 18e91b0 67988f1 367bc9e ec9f1be 2594d50 88068b3` (quangdm_main). **M3 = daemons-only — 0 Move / 0 contracts / 0 client change.** HEAD `88068b3`.

## REQ-RMS coverage (all 4 MET vs source)
| REQ | What | Verdict | Key citation |
|---|---|---|---|
| 012 | Server-side audio last-N (top-k forwarded) | MET | `room-handler.ts:147` suppresses non-top-k audio fan-out; `signaling.ts:448/1480` reads `AUDIO_LASTN_K`; `AudioLevelObserver(maxEntries:k)`; ratio **8.2759 ≥ floor(24/3)−1=7**; `AUDIO_LASTN_FORCE_ALL` RED hook collapses to ~1x → FAILS |
| 014 | Integrated capstone demo (M=5 / R=24 / >100-per-room / +1 Byzantine) | MET | `88068b3` = ADD-only 316-line integration test; real 2-router mediasoup pipe byte-identity; `runCanaryVerifyRound` detects +1 Byzantine at **round 4** with slash-trigger SET; `RMS_DEMO_DISABLE_SCORER` RED hook `placeAllOnFirst` 8640>2160 → FAILS; demo EXCLUDED from default+relay-integration configs (hermetic preserved) |
| 015 | Byzantine relay exclusion from placement | MET | `excludeFlaggedRelays` = pure non-mutating order-preserving filter narrowing the candidate set BEFORE PVR ranking; Option A `capacityCtx.byzantineFlag` thunk (additive/back-compat); **TRAP**: `selectPlacementRelay`/`ballot.slice`/`topRelayIds`/consensus score byte-unchanged, `selectTopRelays` comment-only NOT wired; escrow test observes real `submitProposal` `mock.calls[…][5]` excluding the Byzantine relay |
| 017 | verify-loop mesh-capture + `isRelayFlaggedByCanary` | MET | `isRelayFlaggedByCanary` = byte-faithful read-only mirror of FROZEN `cumulativeBoundCrossed` (rounds≥min && sends>0 && rateBps>budget); attribution test + negative control via the shared-board two-loop quorum; canary suite **124/124** (was 119, +5) |

## Invariants held (independently re-verified by BOTH lenses via `git diff 03e312d 88068b3`)
- **FROZEN surfaces byte-untouched** — `loss-classifier.ts` / `proof.ts` / `DropAccumulator` / 145-byte proof / `canary_audit.move` all empty-diff across the M3 chain.
- **leg-6 TRAP honored** — `selectPlacementRelay`, `ballot.slice`, `topRelayIds`, `computeNodeScore` appear in the diff ONLY as `+` comment lines; `selectTopRelays` is comment-only ("NOT imported"), never wired into the live PVR path; consensus score untouched.
- **RMS-G1 ADD/EXTEND** — `admission-capacity.ts` 9→12 exports, pure-append (0 deletions); `report-rms-bench.ts` / `vitest.rms-bench.config.ts` / `admission-capacity.test.ts` EXTENDED, not overwritten (the lone reporter deletion WIDENS the INCOMPLETE exit-gate into an OR).
- **0 Move/contracts change**; clean commit-scope (16 M3-scoped `.ts` files; pre-existing working-tree dirt `cap-token-issuer.ts` + `relay-overlap-m1-bench-2026-06-05.md` NEVER committed; 0 raw `console.*` added to prod).

## Bench gates (numbers embedded — the standalone bench md lives at workspace `.evidence` and is ephemeral per the M1 bench-md precedent)
- **REQ-RMS-012 audio last-N:** ratio **8.2759 ≥ 7** (N=24 audio producers, k=3; all-N 135360 B vs top-k 16356 B forwarded outbound-rtp byteCount = wire ground truth). RED hook `AUDIO_LASTN_FORCE_ALL` → ~1x → FAILS (gate is load-bearing).
- **REQ-RMS-014 integrated demo:** **PASS** (independently recomputed by `computeDemoVerdict`, pure fn, own 3/3 test). M=5 / R=24; cascade zero cross-hop loss + E2EE byte-identity = `true` on a real 2-router M2 pipe; Byzantine detect round 4 ≤ 7; slash-trigger SET (ASSERTED, not live on-chain).

## guard#9 — independent MAIN re-run (all GREEN)
- cp-daemon unit **260/260**; canary unit **124/124** (was 119, +5); relay audio last-N **3/3** (`room-handler-lastn.test.ts`); `computeDemoVerdict` **3/3**.
- tsc **0-new real-type** errors (leg-7 +5 are the pre-existing `TS6059` cross-`rootDir` class from cross-package integration-test imports; `apps/relay` tsconfig `rootDir:src`; none reference `verify-loop.ts` or the M3 test files).

## Mechanism-floor honesty bounds — ON RECORD (carried, not blocking)
1. **RMS-014 placement load-reduction is genuinely 1x** — optimized maxLoad 1800 == round-robin baseline 1800 == lower bound 1800 at M=5/R=24 (even-split knob). Load-aware does NOT beat round-robin here; honestly recorded (sidecar `maxLoadReductionVsBaseline:1`; reporter Pass column `—`; NEVER asserted as a load WIN). The demo's certified value = byte-identity + Byzantine-detect + the load-bearing RED-hook contrast (`placeAllOnFirst`=8640 > 2160 fails), NOT a vs-baseline placement win.
2. **Byzantine slash is in-test ASSERTED, not a live on-chain slash** — `slashMode:'asserted (not live on-chain)'` in test name/comment/sidecar/honest_note; `computeDemoVerdict` checks only the `slashTriggerSet` boolean. Live cross-validator capture + on-chain slash submit = **canary-M4b**.
3. **RMS-012 8.2759x ratio + cascade byte-identity are relay-side DirectTransport MECHANISM FLOORS** — synthetic Opus/VP8 RTP, `outbound-rtp` byteCount = wire ground truth, NOT WAN / NOT browser getStats.
4. **">100 users/room" is synthetic path-count accounting** (`L_R=360`), not 100 real browsers; `C_worker` is an order-of-magnitude figure (BENCH-3-deferred).

## Known issues — ACKNOWLEDGED non-regressions (carry, NOT block)
1. **saturation-bench (M1 single-worker, 2 tests) fails in a full `bench:rms` run** — `single-worker-saturation-bench.integration.test.ts` is byte-UNTOUCHED in the M3 chain (`git diff --stat 03e312d 88068b3` empty; last touched at M1 `463c92b`), self-labels "exploratory … NOT a hard pass/fail gate" / "non-reproducible" / "±2-3x variance", `SAT_BENCH`-gated. NOT an M3 regression; no auditor found it masks any M3 defect.
2. **`pnpm bench:rms` POSIX inline-env (`RMS_BENCH=1 … vitest`) rejected by Windows cmd.exe** — `package.json` byte-UNTOUCHED in M3 (RMS-G1 NO-EDIT honored); the bench runs fine under POSIX bash (the Jun-22 sidecars prove it ran). `cross-env` = reasonable out-of-scope follow-up.

## Evidence-hygiene gap — RESOLVED at this gate
The Stage-D builder wrote the M3 TDD red/green logs to the **workspace** `.evidence/tdd/` (gitignored) instead of `dvconf-daemons/.evidence/tdd/` (tracked) — where every prior RMS leg (006/007/008/009/011/020) committed theirs — because `tee ../.evidence/tdd/` (cwd=`dvconf-daemons`) escaped one level to the workspace root. The 8 M3 logs (`REQ-RMS-012/014/015/017` red+green+spike) are **relocated into the tracked daemons tree and committed alongside this gate doc**. The standalone bench md stays at workspace `.evidence` (ephemeral, matching the M1 bench-md precedent); its numbers are embedded above. All numbers independently corroborated by the live sidecars `.logs/bench/rms/{audio-lastn,mesh-demo}.json` + in-source RED hooks — so this was a bookkeeping gap, NOT fabrication, with no correctness/scope/TRAP/FROZEN impact (→ PARTIAL, not NO_GO).

## Backlog (LOW, post-gate)
- **Harden the cascade sidecar booleans** — `zeroCrossHopLoss` / `e2eeByteIdentity` are written as HARDCODED literals in the demo's sidecar-writer block, decoupled from the leg's own assertions (unlike the Byzantine fields, which are gated via `globalThis.__rmsByz`). Currently matches reality (the live cascade leg passes on a real 2-router mediasoup pipe) and a broken cascade still exits non-zero at suite level, so this is latent-integrity only — tighten to derive from the actual leg result.

## Deferred items (carried for a self-contained evidence trail)
- **QC-1** — ~~`selectPlacementRelay` ignores `canaryHealthy` → **MUST-FIX-BEFORE-M4b**~~ **FIXED 2026-06-22** (workflow `wf_13361f44-b97`, gate `relay-mesh-scaling-qc1-gate.md`). Added `if (r.canaryHealthy === false) continue;` as the first loop statement in `selectPlacementRelay` (admission-capacity.ts) — STRICT `=== false` only, so field-absent (undefined) + no-feed (`true`) relays stay eligible (back-compat); only PROVEN-unhealthy relays on the live feed-active path are excluded from i*=argmin. Live caller event-handler.ts:489 closed. TDD red→green (3 new teeth-bearing tests; cp-daemon 365/365, tsc 0); 3 adversarial lenses PASS / 0 blockers. **Carried (not QC-1 scope):** the RECORDED ballot back-fill (event-handler.ts:502-508) can still list an unhealthy relay at index≥1 but it is never the serving `chosen` (index-0); a degraded feed now defers more (intended safety); **M4b gate MUST re-baseline the M3 leg-6 TRAP** (it asserted `selectPlacementRelay` appeared only as `+` comments — this fix changes one executable line in its body, gate-sanctioned).
- **Live spill FLOW** (trigger→CP-approval→pipe-execution→multi-peer dispatch) — builds on the M2 mechanism-proven surface; demo proves placement + cascade + Byzantine-detect in-process, not the live end-to-end flow.
- **canary-M4b live capture** — live cross-validator media capture + live on-chain slash submit (the Byzantine slash here is ASSERTED).

## Recommendation — SHIP M3
0 blockers, 0 confirmed overclaims; every claim source-substantiated + re-verified vs HEAD `88068b3`; FROZEN / leg-6 TRAP / RMS-G1 invariants held under independent git-diff; mechanism-floor honesty bounds + both known issues disclosed (not silently dropped); the lone evidence-hygiene gap resolved in this same commit. Mirrors the M1/M2 `GATE_PASS_WITH_PARTIALS` style. **M3 SHIPPED — mesh lane #17 M1+M2+M3 complete.** Next: the live spill FLOW + canary-M4b live capture (deferred). ~~QC-1 remains the MUST-FIX-BEFORE-M4b~~ — **QC-1 FIXED 2026-06-22** (see Deferred items above); M4b gate must re-baseline the leg-6 TRAP to allow the single sanctioned `selectPlacementRelay` body change.
