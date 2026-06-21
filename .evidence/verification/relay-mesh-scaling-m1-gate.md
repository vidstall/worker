# Relay-Mesh Scaling Lane #17 — Milestone 1 SHIP Gate

**Verdict:** **GATE_PASS_WITH_PARTIALS** — 9/9 REQ-RMS MET, **0 blockers**, all 3 lenses PASS.
**Date:** 2026-06-21
**Gate workflow:** `wf_89ed07f0-9bc` (5 read-only auditors + 3 adversarial lenses + synthesis).
**Build workflows:** `wf_037dcd45` (Tasks 1-4 foundation) + `wf_1c4a4ced` (Tasks 5-10 wiring).
**Shipped commits:** contracts `485a3ae` (main) · client `0b246d5` (master) · daemons `a5c1ad5 463c92b 4afabbf c23de41 cb626f7 d5acacd 2a6b195 fe8e506 d5cd7c3` (quangdm_main).

## Method
Independent multi-auditor read-only audit re-verifying every claim against **shipped committed source** (file:symbol:line), NOT prose/ROADMAP. Plus an independent live re-run of every suite. Mirrors the canary-forwarding-audit and relay-overlap M1 gates.

## REQ-RMS coverage (all 9 MET vs source)
| REQ | What | Status | Key citation |
|---|---|---|---|
| 001 | Calibration bench (C_worker/C_relay, 3 audio modes) | MET | audio-spike `a5c1ad5` + saturation bench `463c92b` + reporter `4afabbf`; bench .md C_worker=540@M60 / C_relay=10800 |
| 002 | argmin i* placement | MET | `admission-capacity.ts:selectPlacementRelay` + `event-handler.ts` EscrowCreated REPLACES old top-2 PVR slice |
| 003 | L_r model | MET | `estimateRoomLoad` = V_active·min(9,P_active)+audio_term; MCU→1 |
| 004 | on-chain N-vector via PVR | MET | `room-assignment.ts` UNCHANGED (verify-only); ballot never length-1 (on-chain `E_INVALID_BALLOT` floor=2) |
| 005 | canary-attested ℓ_i, self-report not trusted | MET | `coverage-server.ts:buildLoadPayload` (PURE, INV-C) + `coverage-load-reader.ts` (fail-open) + `event-handler.ts:452` attested over self-report |
| 013 | pool-sizing M | MET | `poolSize` = ceil(ΣL/C_relay)·(1+r)+byz clamped ≥ MIN_RELAY(2); tests 9 & 3 |
| 016 | room_class_hint additive ABI | MET | Move additive field+param+emit; **0 remaining 5-arg callers** across 3 repos |
| 018 | pool-health gating | MET | `poolHealthGate` (fresh hb<7 + canary-healthy ≥K_r); graceful defer, no migration |
| 019 | live ℓ_i telemetry + heartbeat freshness | MET | `RelayHeartbeat` arm refreshes heartbeatAge (was stuck 0n); feed carries heartbeatFreshEpochs |

## Live re-run (independent reproduction — all GREEN)
- **daemons hermetic 97/97** = admission-capacity 10 + coverage-load-reader 2 + scoring 22 (incl golden tripwire `computeNodeScore=7650n`) + event-handler 25 + coverage-server 9 + shared types 29
- **client `tsc --noEmit` exit 0**
- **`sui move test` 362/362** (active-env captured→testnet compile-only→restored to `phase40-1782040765576`; no config side-effect)

## Key invariant HELD — PVR consensus byte-frozen
`git show fe8e506 -- scoring.ts` = ONLY the additive `CAPACITY_LAYER_IS_ADDITIVE` marker; `computeNodeScore`/`canonicalSort` bodies untouched; golden tripwire `7650n` green (hand-derived 76,500,000/10,000). Capacity is a strictly **off-chain filter applied AFTER `canonicalSort`**.

## Scope hygiene — clean
`git show --name-only` across all 11 RMS commits: **zero** hits for the out-of-scope `cap-token-issuer.ts` / `resolve-peer-pubkey.test.ts` (REQ-MCS-012) / `Move.lock` (drift). All three remain dirty/untracked in the working tree only.

## Documented partials ON RECORD (all disclosed, none blocking)
1. **Mechanism-floor capacity** — C_worker=540 (measured knee, delivery-bound @ M=60) / C_relay=10800 (=cores·C_worker, **EXTRAPOLATION**). DirectTransport skips SRTP → optimistic ±2-3×, single-box, synthetic RTP. NOT a production-capacity claim.
2. **Canary ℓ_i feed is HERMETIC / unit-only (W-M3-SIM)** — the LIVE validator-daemon passes no `loadProvider` (route 404s) and the live cp-daemon passes no `capacityCtx`, so a running daemon has `feedActive=false` and falls back to relay self-report. The "attested over self-report" property is proven HERMETICALLY (injected `attestedLoad`), NOT exercised by a running daemon. Live cross-validator capture/feed/quorum is M4b-style deferred. Mechanism is structurally correct + feed-ready; only injection is unwired. **(load-bearing caveat)**
3. **REQ-RMS-018 thin integration** — the pool-health defer-below-K_r branch in `event-handler.ts` has only pure-function unit coverage; no dedicated handler-level assertion.
4. **expected_participants=0 live** → audio_term=0 in live L_r seeding (room-class video preset drives L_r). Disclosed O(N) floor; true audio fan-out ~O(N²); audio last-N (REQ-RMS-012) deferred to M3.
5. **Config skew** — production default `RMS_C_WORKER_PATHS=300` ≠ bench-measured 540. Disclosed in PLAN Open Issues ("re-tune before any demo"); env knob exists.
6. **feedActive fallback** — honest deviation/improvement over PLAN text (preserves pre-canary legacy behavior when no feed is wired; "never trust self-report" still holds when the feed IS active).
7. **Evidence-availability gap** — `.evidence/tdd/REQ-RMS-*.log` are gitignored (per-session) and the bench .md is untracked, so the RED→GREEN trail is not reproducible from committed artifacts; re-substantiated against source + live re-run (per-suite counts matched bit-for-bit; RED logs show genuine module-not-found + assertion failures, not no-ops).
8. **Stale headline label** — guard#9 "daemons hermetic 58" undercounts the real 68 (97 with types). Corrected to **97**.
9. **NIT** — REQ-RMS-005 RED log consolidated (tee -a); `HEARTBEAT_STALE_EPOCHS=7` (admission-capacity.ts) duplicates `PVR_HEARTBEAT_STALE=7n` (scoring.ts) — currently consistent, silent-drift risk.

## Recommendation — SHIP M1
0 blockers, all lenses PASS, every claim source-substantiated + live-reproduced. Queue for M2/demo (NOT M1 scope):
- (a) wire `loadProvider` into the live validator-daemon + `capacityCtx` into the live cp-daemon → exercise attested placement live (closes partial #2 / W-M3-SIM).
- (b) dedicated handler-level assertion for the pool-health defer branch (partial #3).
- (c) re-tune `RMS_C_WORKER_PATHS` from the bench .md before any capacity demo (partial #5).

**Thesis-defense carry-forward (not a build task):** verify Huddle01's latest litepaper for the relay-blindness novelty axis (DESIGN §6/§10).
