# Static-Mesh-Hardening LIVE — Evidence

OVERALL: PASS

## D2 — PASS

    resolved primary 0x397e8000d5099ebd2a5c21193bc1b64efa7a7a5bed759e3d14cf7a3af24e2bb2 -> WS port 4002
    fleet: 4 peers on ws://127.0.0.1:4000, ws://127.0.0.1:4002, ws://127.0.0.1:4004 (+1 consumer homed to primary ws://127.0.0.1:4002 for intra-relay forwarding)
    pre-kill fleet consumers established: smh-fleet-peer-0:0 smh-fleet-peer-1:1 smh-fleet-peer-2:0 smh-fleet-consumer:1
    pre-kill media: relay bytesForwarded (server-side) = 6942; client bytesReceived (@roamhq/wrtc, informational) = 4943
    chaos kill 4002 (RESOLVED primary, assigned_relays[0]=0x397e8000d5099ebd2a5c21193bc1b64efa7a7a5bed759e3d14cf7a3af24e2bb2) -> killed:4002:pids=27312
    primary WS 4002 isopen=NOT-OPEN
    RPC pollRelayPromoted(old=0x397e8000d5099ebd2a5c21193bc1b64efa7a7a5bed759e3d14cf7a3af24e2bb2) -> {"newPrimary":"0x6f0649b57934dad9f2264a0bb9184bfe926fc30af42538633a7bd76a4e4197f9","epoch":5,"promotedAtMs":1784211801221}
    --- T1-1 promotion decomposition [primary kill] ---
      kill t0: before=1784211568772 after=1784211571811 (chaos ps-spawn=3039ms, EXCLUDED from kill->submit)
      promote_submit: trace_id=69af3d34-f6a6-4e2c-bcfc-f60b1e6d9f6f time=1784211799257 (cp log, joined by oldPrimary)
      kill->promote_submit = 227446ms [config-arithmetic: strict >MAX_HEARTBEAT_EPOCHS(3) staleness x 60s localnet epochs; NOT a detection-time measurement, NOT MTTR]
      promote_submit->RelayPromoted = 1964ms [measured localnet consensus-commit floor; NOT client-visible, NOT MTTR]
    RPC get_room_assignment (LIVE assigned_relays) -> ["0x6f0649b57934dad9f2264a0bb9184bfe926fc30af42538633a7bd76a4e4197f9","0x6f0649b57934dad9f2264a0bb9184bfe926fc30af42538633a7bd76a4e4197f9","0x89747b950ef50faebfcfacb82b4af437abf727f007299e09a98dda25e3784b0e"]
    swap: old-primary OUT of [0]=true, new-primary IN as [0]=true, room spans>=K_r(3)=true
    surviving relays (incl. promoted): 4000=OPEN 4004=OPEN
    pre-kill-media-established(true) AND post-kill-survivor-ports-open(true) [TCP LISTEN only, NOT a post-promotion media-continuity proof — no post-kill media re-read]
    chaos kill 4000 (stretch, RESOLVED new primary 0x6f0649b57934dad9f2264a0bb9184bfe926fc30af42538633a7bd76a4e4197f9) -> killed:4000:pids=20948
    --- T1-1 promotion decomposition [stretch / 2nd kill — separate population] ---
      kill t0: before=1784211805663 after=1784211808227 (chaos ps-spawn=2564ms, EXCLUDED)
      promote_submit: trace_id=44c5f8aa-3e54-470d-bfcb-439cf1217c44 time=1784212039101
      kill->promote_submit = 230874ms [config-arithmetic; NOT detection, NOT MTTR]
      promote_submit->RelayPromoted = 1964ms [measured localnet consensus-commit floor; NOT client-visible, NOT MTTR]
    stretch: 2nd RelayPromoted new_primary=0x89747b950ef50faebfcfacb82b4af437abf727f007299e09a98dda25e3784b0e epoch=9

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
