# Relay-Mesh Scaling Lane #17 — Milestone 2 — Task 12 non-regression + impact summary

**Date:** 2026-06-22
**Verdict:** M2 build (REQ-RMS-006/007/008/009/010/011/020) GREEN across all repos; M1 untouched. Build via 4 workflows (Chunk A `wf_bb0b7635` Tasks1-4 + `wf_08dac825` Tasks5-6, Chunk B `wf_4499147e` Tasks7-8, Chunk C `wf_d3f3bd41` Tasks9-11); every task spec SPEC_COMPLIANT + qa APPROVE; MAIN re-ran guard#9 independently and committed scoped per-REQ.

## Shipped commits
| Repo | Branch | Commits |
|---|---|---|
| dvconf-daemons | quangdm_main | `48c7523` (RMS-006) · `7f4b9cb` (RMS-007) · `78db0f7` (RMS-008 frames) · `e897682` (RMS-008 cascade keying) · `685de52` (RMS-009 cp-daemon PTB) · `7411f9b` (RMS-011) · `ec0ef9f` (RMS-020) |
| dvconf-contracts | main | `2d631a4` (RMS-009 authorize_spill_relay + ONCHAIN-4 fold) |
| dvconf-client | master | `e0547a3` (RMS-010 E2EE hop-invariant) |

## guard#9 — independent re-run (Task 12 gate)
| Suite | Result | Log |
|---|---|---|
| daemons relay unit | **371 passed / 3 skipped** (54 files) | rms-m2-daemons-unit.log |
| daemons cp-daemon unit (hermetic, excl integration) | **264 passed** (27 files) | rms-m2-daemons-unit.log |
| daemons relay INTEGRATION (spike + simulcast-cascade + multi-hop byte-id + relay-blind) | **20 passed / 3 skipped** (11 files); byte-identity holds across 2-hop/3-hop/layer-select/speaker-change (byteIdentical===mediaPackets===decryptedOk) | rms-m2-relay-integration.log |
| client | **475 passed** (67 files), tsc 0 | rms-m2-client-unit.log |
| Move (`sui move test`, testnet env) | **366 passed / 366** (362 baseline + 4 new spill tests) | rms-m2-move.log |

PVR consensus remains byte-frozen (scoring.ts untouched). The M1 single-room path is byte-stable: the per-`(roomId,peerRelayId)` re-key degrades to the legacy single-key via `DEFAULT_PEER_RELAY_ID`; the M1 relay-overlap MTTR bench (P95<=100/P99<=200, N=30) + warmpipe-rtp integration stay green inside the relay suite.

## Blast radius (gitnexus impact on modified TS symbols; Move = grep, gitnexus-blind)
- **getWorkerExcluding / pipeRoomToSecondWorker** (relay-role-manager, mediasoup-manager) — LOW; pipeRoomToSecondWorker return widened to `{pipeProducer,pipeConsumer}` is additive, **0 production callers** (only tests), Task-3 tests updated.
- **PipeProducerAnnounce/PipeConnectFrame guards+builders** (inter-relay.ts, Task 4) — LOW; trailing-optional `peerRelayId?`, 1 caller each, back-compat preserved.
- **StandbyWarmPipeCoordinator / PrimaryPipeCoordinator / InterRelayProducerRegistry** (Task 5) — LOW; impactedCount 1 (index.ts); every live caller uses the legacy DEFAULT form.
- **createSignalingServer / handleProduce / attachedInterRelaySocket** (Task 6) — LOW/0; additive map + env-gated SpillTrigger; 5-arg signature unchanged.
- **submitProposal / submitSpillAuthorization** (cp-daemon room-assignment, Task 8) — LOW/0; new additive export, ABI-lockstep-verified vs the as-built Move entry (7 args: 5 obj + 2 id).
- **reconsumeStandbyOnFreshReceiver** (useRelay.ts, Task 9) — gitnexus reported HIGH, but the actual diff is **doc-comment ONLY** (475/475 green); the HIGH is a stale-index region heuristic, NOT a true behavioral blast radius. (Note: client gitnexus alias is `--repo client`, not `dvconf-client`.)
- **Move authorize_spill_relay** (Task 7) — gitnexus-blind; grep of `assigned_relays` consumers confirms a zero-proof appended relay is under-covered (economic skip) + membership-gated (canary), so the `push_back` APPEND is non-breaking.

## Out-of-scope (left UNCOMMITTED on purpose — not mesh M2)
- `dvconf-daemons/apps/cp-daemon/src/cap-token-issuer.ts` (M) + `apps/cp-daemon/src/__tests__/resolve-peer-pubkey.test.ts` (??) — sibling lane (REQ-MCS-012), pre-existing dirty.
- `dvconf-contracts/Move.lock` (M) — env/publish-hash drift, left uncommitted (M1 precedent).

## Pre-existing non-mesh failure (NOT an M2 regression)
- `dvconf-daemons/scripts/governance/__tests__/revoke-cap-token.test.ts` — 2 tests `Test timed out in 10000ms` (11/13 pass). This is the W1 F5 cap-token-revoke lane (last touched `64e829b`, pre-mesh). It imports NO mesh code, and the mesh daemon commits (`6059d73..ec0ef9f`) touched EXACTLY `apps/relay` + `apps/cp-daemon/room-assignment` (verified via `git diff --name-only`) — so this timeout is pre-existing and out of mesh M2 scope. Surfaced only by the broad `pnpm test` (the mesh per-suite runs are all green). Tracked for the W1/governance lane, not this milestone.

## Known untested seam (Done-Criteria Issue #4)
- `signaling.ts` live wiring DECISIONS (header->peerId attach/detach + recordPath-on-produce gate) are unit-covered RED-first via the pure helpers `resolveInterRelayPeerId`/`shouldRecordPath` (Task 6); the thin `createSignalingServer` closure plumbing that calls them with live `ws`/`req` is integration-only (`inter-relay-auth-wiring.test.ts` + demo stack), NOT unit-isolated.

## SpillTrigger lifecycle decision (Task 6, recorded)
- `recordPath` fires on produce; `releasePath`/`clearRoom` are **FIRE-ONCE / not decremented** in M2 (a spill REQUEST is monotonic, latched by the `fired` Set). The methods stay on the interface for a future M3 re-arm lane.
