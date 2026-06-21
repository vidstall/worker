# Relay-Mesh Scaling Lane #17 — Milestone 2 SHIP Gate

**Verdict:** **GATE_PASS_WITH_PARTIALS** — 7/7 REQ-RMS MET, **0 blockers**, **0 confirmed overclaims**, all 3 lenses PASS.
**Date:** 2026-06-22
**Gate workflow:** `wf_f5972668-097` (7 per-REQ read-only auditors vs COMMITTED source [file:symbol:line, not prose] + 3 adversarial lenses honesty/scope/completeness + lead synthesis). Mirrors the M1 gate `wf_89ed07f0`.
**Build workflows:** Chunk A `wf_bb0b7635` (Tasks 1-4) + `wf_08dac825` (Tasks 5-6) · Chunk B `wf_4499147e` (Tasks 7-8) · Chunk C `wf_d3f3bd41` (Tasks 9-11). Every task spec SPEC_COMPLIANT + qa APPROVE; MAIN re-ran guard#9 independently and committed scoped per-REQ.
**Shipped commits:** contracts `2d631a4` (main) · client `e0547a3` (master) · daemons `48c7523 7f4b9cb 78db0f7 e897682 685de52 7411f9b ec0ef9f` (quangdm_main). Task-12 verification: daemons `e18e6e8` / client `80a0692` / contracts `1a4f041`.

## REQ-RMS coverage (all 7 MET vs source)
| REQ | What | Verdict | Key citation |
|---|---|---|---|
| 006 | Self-observed spill trigger (shared `RMS_C_WORKER_PATHS` knob, fire-once) | MET | `spill-trigger.ts:50` readCWorker == cp-daemon `event-handler.ts:439` (SAME env, no new C_WORKER — must-fix #1); `fired` Set de-dup; signaling `:1248-1250` recordPath gated by shouldRecordPath |
| 007 | Tier-2 intra-box cross-worker pipe | MET | spike asserts `workerA.pid!==workerB.pid` + `pipeToRouter` live RTP (captured=42/44); `getWorkerExcluding` additive (getNextWorker byte-unchanged); `pipeRoomToSecondWorker` |
| 008 | Tier-3 cascade per-`(roomId,peerRelayId)` keying | MET | optional `peerRelayId?` on both frames+guards (back-compat); 3 F1 structures re-keyed via `meshKey`/`primaryPortKey`; `resolveAll`; `DEFAULT_PEER_RELAY_ID` keeps M1 path; socket-map reuses `InterRelaySocketLike`; 59 legacy F1 tests green |
| 009 | On-chain `authorize_spill_relay` + cp-daemon PTB + ONCHAIN-4 | MET | `room_manager.move:934` push_back APPEND (vs promote_relay `:877` swap); fresh 565/566/567 (561 untouched); guards reuse promote_relay + mirror submit_pairing_proposal; `:339` `assert!(min_relay>=2,E_INVALID_MIN)` + `#[expected_failure(505)]` + allow(unused_const) dropped; cp-daemon PTB 7-arg ABI lockstep |
| 010 | E2EE cascade hop-invariant (zero new crypto) | MET | `useRelay.ts` diff DOC-COMMENT ONLY; test pins ORIGINAL `producerPeerId` (not `producerId`) + relay-leg no-receiver short-circuit; mutation-check proves NON-VACUOUS; 0 crypto added |
| 011 | Simulcast full-ladder across the hop (must-fix #2) | MET | destination piped-producer `encodings===3` + `setPreferredLayers` read-back `spatialLayer 2/0` (NOT `>=1`); real mediasoup v3.2.4 carried 3 layers → honesty-fallback present-but-not-triggered; `pipeRoomToSecondWorker` return widened additive (0 prod callers) |
| 020 | Multi-hop SFrame byte-identity | MET | 2/3-hop/layer-select/speaker-change `byteIdentical===mediaPackets===decryptedOk`; genuine `P10_FORCE_TAMPER` RED (byteIdentical=0 vs mediaPackets 55-58); 4 helpers EXTRACTED (single source, no crypto reimpl) |

## M1 team-review carry-forwards — verified addressed IN SOURCE
- **must-fix #1** (shared knob): `spill-trigger.ts:50` + cp-daemon `event-handler.ts:439` read the IDENTICAL `process.env['RMS_C_WORKER_PATHS'] ?? '300'` — no new C_WORKER.
- **must-fix #2** (simulcast): proven `encodings===3` (source + post-hop) + real `setPreferredLayers` read-back — not the `>=1` tautology the M1 review flagged.
- **ONCHAIN-4**: `update_room_rules` `assert!(min_relay>=2,E_INVALID_MIN=505)` + `#[expected_failure(505)]` test + `#[allow(unused_const)]` dropped.

## guard#9 — independent MAIN re-run (all GREEN)
- `sui move test` **366/366** (362 baseline + 4 new spill tests; under `testnet` env — the orphaned localnet `phase40-*` active env aborts, switch→testnet→restore, M1 precedent). **NOTE: 366/366, not the stale PLAN-prose "361/361".**
- daemons relay unit **371**/3-skip (incl M1 relay-overlap-mttr P95<=100/P99<=200 + warmpipe-rtp 4/4) + cp-daemon unit **264**.
- daemons relay INTEGRATION **20**/3-skip (cross-worker spike + simulcast-cascade + multi-hop byte-identity + relay-blind).
- client **475/475**, tsc **0**. PVR `scoring.ts` byte-frozen.

## Partials ON RECORD (all disclosed, none blocking)
1. **CASCADE IS MECHANISM-PROVEN, NOT FLOW-WIRED (headline)** — `pipeRoomToSecondWorker` has 0 production callers; signaling `onSpillRequested` (`signaling.ts:521`) only `logger.info()`s. M2 ships the keying + pipe primitive + on-chain authorization + multi-hop byte-identity PROOF, but the end-to-end live spill flow (trigger→CP-approval→pipe-execution→multi-peer dispatch) is **M3/demo scope** (PLAN Open Issues: spill-request→CP-approval transport = placement-scorer concern).
2. **SpillTrigger FIRE-ONCE / not decremented** — `recordPath` fires once per room on produce (latched by `fired` Set); `releasePath`/`clearRoom` stay on the interface but are unwired in production today (count only grows). Correct for a one-shot monotonic REQUEST; re-arm deferred to M3.
3. **Live multi-peer cascade dispatch deferred** — the per-peer `interRelaySockets` map is attach/detach'd but its `.get()` is not yet read in signaling; fanning a producer announce to K_r peers is not wired. Map SEMANTICS unit-tested + keying + in-process multi-hop byte-identity proven.
4. **M1 byte-stability is BEHAVIORAL (in-memory key)** — `meshKey()` returns `${roomId}::__default__` (single stable bucket, behaviorally equiv, not literal-identical to the M1 `${roomId}` key); `primaryPortKey()` DOES literally degrade to `${roomId}:primary` (the external string index.ts/warmpipe depend on). 53 legacy F1 tests green.
5. **Move abort-path coverage partial** — 4 spill tests exercise 565 + append/event + ONCHAIN-4 505, but no dedicated abort tests for 566 (already-assigned) / 567 (relay-not-registered); both guards present + correct in source (`room_manager.move:927,930`). Matches the PLAN's stated test scope.
6. **Pre-existing revoke-cap-token failure** — `dvconf-daemons/scripts/governance/__tests__/revoke-cap-token.test.ts` = 2 `Test timed out` (11/13 pass). PROVEN out-of-mesh-scope: imports no mesh code, last touched `64e829b` (pre-mesh W1 F5 lane); the mesh daemon commits (`6059d73..ec0ef9f`) touched EXACTLY `apps/relay` + `cp-daemon/room-assignment` (verified `git diff --name-only`). The committed `rms-m2-daemons-unit.log` is the per-app-filtered hermetic run (relay 371 + cp-daemon 264); the broad `pnpm test` surfacing the 11/13 is annotated in the impact-summary, not in the committed per-app log.
7. **REQ-RMS-020 layer-select case (idx 2)** does not invoke `setPreferredLayers` — its executed assertion IS the byte-identity gate (a 2-hop single-layer run; layer-select read-back is proven separately in REQ-RMS-011). Naming texture only.

## Deferred items (carried here from PLAN Open Issues for a self-contained evidence trail — Action 2)
- **QC-1** — `selectPlacementRelay` ignores `canaryHealthy` → **DEFER-M4b** (a spill REQUEST is request-side + CP-quorum-gated on-chain; does NOT re-open QC-1).
- **ARCH-4** — daemon hardcodes `MIN_RELAY=2` vs mutable on-chain `room_rules.min_relay` → **DEFERRED** (fail-loud today via `E_INVALID_BALLOT`; `RoomRulesUpdated` typed-but-unhandled).
- **Cross-host / cross-process cascade** — tier-3 over a real inter-relay WS link with `enableSrtp:true` → **STRETCH** (loopback hardcodes `enableSrtp:false`). M2 proves keying + frames + in-process multi-hop byte-identity.
- **Roster-subset co-serving** + **atomic K-relay slash-vector** + **spill-request→CP-approval transport** → demo / later-lane / DESIGN §9 scope.
- **Issue #4** — `createSignalingServer` live WS-object plumbing around the unit-tested `resolveInterRelayPeerId`/`shouldRecordPath` helpers is integration-only (not unit-isolated).

## Recommendation — SHIP M2
0 blockers, 0 confirmed overclaims, every claim source-substantiated + live-reproduced; all 3 M1 carry-forwards addressed in source; deferrals disclosed (not silently dropped). Mirrors the M1 `GATE_PASS_WITH_PARTIALS` style. **M2 SHIPPED.** Next: M3 (REQ-RMS-012/014/015/017 = Byzantine canary-exclusion + audio last-N + M=5/R=20-30/+1-Byzantine demo); the live spill FLOW (trigger→approval→pipe-execution + multi-peer dispatch) is the M3/demo integration that builds on this mechanism-proven M2 surface.
