# Static-Mesh-Hardening LIVE — Evidence

OVERALL: PASS

## D1a — PASS

    [informational] curl http://127.0.0.1:8105/canary/load -> HTTP 0 body=(unreachable — coverage server not enabled on single-host rig; see note)
    cp log 'attested-load poller started' (RMS_ATTESTED_PLACEMENT=1): true
    registration readiness: relays=3 validators=4 signaling=1
    room=0xa4f8178904e9b77674fcfa76598a928454b58a0d6764a9c168f4c4a4f27f831c + escrow created (placement trigger)
    placement_basis=defer (expected: defer)

## D1b — PASS

    registration readiness: relays=3 validators=4 signaling=1
    room=0xb34c7a7309f772e63a436ea4f1e4018c9132944f36f43130345e1cc4ecd41edd + escrow created
    RPC readAssignedRelays -> ["0x3184a19445c069984b9eec26d8e3e4bbf3826f509a5618a7027c26fb20cd4117","0x6d68d53333126631588037f99e06555059bbd18e36fc422ec0398f355e556da7","0x768bd7e2efc5ce5cb6d2b0532d40d2f0e9ed07cd5618b547325e7f8a3b3164ca"] (distinct=3, expected >=3)
    placement_basis=legacy-self-report (expected: legacy-self-report)

## D2 — PASS

    resolved primary 0x3184a19445c069984b9eec26d8e3e4bbf3826f509a5618a7027c26fb20cd4117 -> WS port 4002
    fleet: 4 peers on ws://127.0.0.1:4000, ws://127.0.0.1:4002, ws://127.0.0.1:4004 (+1 consumer homed to primary ws://127.0.0.1:4002 for intra-relay forwarding)
    pre-kill fleet consumers established: smh-fleet-peer-0:0 smh-fleet-peer-1:1 smh-fleet-peer-2:0 smh-fleet-consumer:1
    pre-kill media: relay bytesForwarded (server-side) = 4732; client bytesReceived (@roamhq/wrtc, informational) = 3263
    chaos kill 4002 (RESOLVED primary, assigned_relays[0]=0x3184a19445c069984b9eec26d8e3e4bbf3826f509a5618a7027c26fb20cd4117) -> killed:4002:pids=42284
    primary WS 4002 isopen=NOT-OPEN
    RPC pollRelayPromoted(old=0x3184a19445c069984b9eec26d8e3e4bbf3826f509a5618a7027c26fb20cd4117) -> {"newPrimary":"0x6d68d53333126631588037f99e06555059bbd18e36fc422ec0398f355e556da7","epoch":6}
    RPC get_room_assignment (LIVE assigned_relays) -> ["0x6d68d53333126631588037f99e06555059bbd18e36fc422ec0398f355e556da7","0x6d68d53333126631588037f99e06555059bbd18e36fc422ec0398f355e556da7","0x768bd7e2efc5ce5cb6d2b0532d40d2f0e9ed07cd5618b547325e7f8a3b3164ca"]
    swap: old-primary OUT of [0]=true, new-primary IN as [0]=true, room spans>=K_r(3)=true
    surviving relays (incl. promoted): 4000=OPEN 4004=OPEN
    continuity = real-media-flowed(true) AND surviving-relays-serving(true)
    chaos kill 4000 (stretch, RESOLVED new primary 0x6d68d53333126631588037f99e06555059bbd18e36fc422ec0398f355e556da7) -> killed:4000:pids=138072
    stretch: 2nd RelayPromoted new_primary=0x768bd7e2efc5ce5cb6d2b0532d40d2f0e9ed07cd5618b547325e7f8a3b3164ca epoch=10

> **Label correction (CH5-R4-005, 2026-07-13):** the raw stdout line `continuity = real-media-flowed(true) AND surviving-relays-serving(true)` above was an over-claim. `real-media-flowed` is a PRE-kill `bytesForwarded=4732` observation; `surviving-relays-serving` is POST-kill WS-port liveness. No post-kill media re-read or re-consume was performed, so D2 proves **pre-kill-media-established + post-kill-survivor-liveness**, NOT post-promotion media continuity. The generator (`run-smh-live.ts` / `evidence.ts`) now emits the corrected label; this frozen 2026-07-08 transcript keeps the original stdout with this note.

## Honest scope / caveats

- **Live scope = D1a + D1b + D2 ONLY.** This hands-off run proves, on the native N=3
  localnet: D1a (flag-ON strict no-attestation `defer`), D1b (flag-OFF byte-stable
  K_r>=3 placement), and D2 (kill-relay failover with an RPC-verified `RelayPromoted`
  after verified pre-kill media, with the surviving relay processes/ports staying open ---
  post-promotion media continuity is NOT asserted; no post-kill media re-read/re-consume is done).
  Every on-chain claim is re-read by an independent Sui RPC query, never by a daemon log alone.
- **D3 (reopen re-delivery, REQ-RMS-037) is proven HERMETICALLY, not in this live run.**
  On single-host loopback the standby dials the PRIMARY's SHARED client-WS port (there is
  NO dedicated inter-relay port), and Windows Firewall does not filter loopback traffic —
  so a transient standby->primary link flap cannot be injected without a relay test-hook
  (rejected: no daemon-production edit). D3 stays covered by the shipped during-window
  test on `static-mesh-hardening` (REQ-RMS-037 §3.3).
- **Attested-rows admission (`basis=attested`) is NOT proven here** — it is canary-M4b-
  gated; D1a deliberately asserts the strict `defer` (feed wired, zero attested rows).
- Media source is a headless programmatic `mediasoup-client` peer (no browser tab). The
  mesh / failover / placement behaviour under test is entirely server-side, so a headless
  peer does not reduce its liveness (lane charter = 0 client edits).
- **Post-failover the mesh holds 2 DISTINCT relays, not 3.** With N=3 relays, killing the
  primary leaves 2 alive (the physical maximum). `promote_relay` (room_manager.move:888)
  overwrites ONLY the vacated slot [0] with the promoted standby, so that relay then
  occupies BOTH slot [0] and its original standby slot — `assigned_relays` keeps K_r=3
  positional SLOTS but holds 2 DISTINCT relays. This is the static-mesh graceful-degrade-
  no-migration behaviour; re-filling to 3 DISTINCT relays requires runtime relay growth
  (REQ-RMS-023), out of scope. So `spans>=K_r(3)=true` is a POSITIONAL-slot claim, NOT a
  "3 distinct relays still serving" claim. The stretch-kill's 2nd promotion then degrades
  to 1 distinct — it proves the promotion CHAIN survives cascading failure, not sustained
  K_r=3.
