# Stage B (REQ-RMS-033) — guard#9 summary (2026-06-28)

Browser-consume-via-standby: G2 (daemons handleJoin re-announce of forwarded
producers) + B1 (client relay-pin). Hermetic RED->GREEN + full regression.

| Check | Result |
|---|---|
| Daemons full unit (`pnpm test`) | 1553 pass / 2 fail — both `scripts/governance/__tests__/revoke-cap-token.test.ts` 10s timeouts, PROVEN PRE-EXISTING (prior stash-baseline; zero overlap with this diff — governance/cap-token, not inter-relay/signaling/registry) |
| Client full suite (`pnpm test`) | 508 pass / 0 fail (72 files; includes 6 new RED-B1-* relay-pin tests) |
| tsc inter-relay-client | 0 errors (clean) |
| tsc relay app | 36 errors = exact pre-existing baseline; 0 reference signaling.ts / inter-relay (grep) -> 0-new |
| tsc client | 0 errors |
| relay-integration (forward path) | 6/6 — rms-active-forward 5 (captured=15 bodyIdentical=15) + rms-live-crossrelay-deadlock 1. No regression on the real-mediasoup active-forward path. |
| relay-livelink (REQ-RO-003) | 1/1 — /api/probe ok flips only after RTP, rtcp_alive=true. REQ-RO-005 paused-keepalive preserved. |
| detect-changes daemons | 6 files / 6 symbols / 7 processes / **HIGH** — coarse (handleJoin is in the createSignalingServer hot flow). The CHANGE is purely ADDITIVE + guarded (`if (interRelay)` block AFTER the existing peer.producers re-announce; PRIMARY registry empty -> no-op). gitnexus impact handleJoin = LOW. Regression-proven green above. |

## Changed scope (exact — never `git add -A`)
- daemons tracked: `apps/relay/src/signaling.ts` (+22), `packages/inter-relay-client/src/inter-relay.ts` (+24, new `listForRoom`), `apps/relay/src/__tests__/inter-relay.test.ts` (+24), `apps/relay/src/__tests__/inter-relay-wiring.test.ts` (+43)
- client tracked: `src/pages/RoomPage.tsx` (+10/-2)
- client new: `src/lib/relay-pin.ts`, `src/lib/__tests__/relay-pin.test.ts`
- evidence (new, daemons): `.evidence/tdd/REQ-RMS-033-stageB-*.log` + this file
- (the 2 MODIFIED `.evidence/verification/*.md` are PRE-EXISTING, NOT Stage B — do not stage)

## Invariants held
- REQ-RO-005 paused-keepalive: untouched (livelink rtcp_alive green; G2 adds only a signaling re-announce, never touches the keepalive consumer).
- Single-standby DEFAULT path byte-stable: G2 re-announce is purely additive newProducer; B1 default (no `relayPin`) is byte-identical primary homing (RED-B1-1).
