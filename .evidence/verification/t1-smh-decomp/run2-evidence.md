# Static-Mesh-Hardening LIVE — Evidence

OVERALL: PASS

## D2 — PASS

    resolved primary 0x64ff069d756331676f38e6493ecd00169937636f6cb1f9b3c39b8edc1bfd4c81 -> WS port 4004
    fleet: 4 peers on ws://127.0.0.1:4000, ws://127.0.0.1:4002, ws://127.0.0.1:4004 (+1 consumer homed to primary ws://127.0.0.1:4004 for intra-relay forwarding)
    pre-kill fleet consumers established: smh-fleet-peer-0:0 smh-fleet-peer-1:0 smh-fleet-peer-2:1 smh-fleet-consumer:1
    pre-kill media: relay bytesForwarded (server-side) = 500; client bytesReceived (@roamhq/wrtc, informational) = 4939
    chaos kill 4004 (RESOLVED primary, assigned_relays[0]=0x64ff069d756331676f38e6493ecd00169937636f6cb1f9b3c39b8edc1bfd4c81) -> killed:4004:pids=24608
    primary WS 4004 isopen=NOT-OPEN
    RPC pollRelayPromoted(old=0x64ff069d756331676f38e6493ecd00169937636f6cb1f9b3c39b8edc1bfd4c81) -> {"newPrimary":"0x67c8c17fa9b3502ca3a351c9d42393ad762956cfdbaf9f4c8d2962fb4e85dca4","epoch":5,"promotedAtMs":1784212458318}
    --- T1-1 promotion decomposition [primary kill] ---
      kill t0: before=1784212224353 after=1784212226986 (chaos ps-spawn=2633ms, EXCLUDED from kill->submit)
      promote_submit: trace_id=19a836a1-8f97-4152-aaae-d95d4b56fd03 time=1784212456688 (cp log, joined by oldPrimary)
      kill->promote_submit = 229702ms [config-arithmetic: strict >MAX_HEARTBEAT_EPOCHS(3) staleness x 60s localnet epochs; NOT a detection-time measurement, NOT MTTR]
      promote_submit->RelayPromoted = 1630ms [measured localnet consensus-commit floor; NOT client-visible, NOT MTTR]
    RPC get_room_assignment (LIVE assigned_relays) -> ["0x67c8c17fa9b3502ca3a351c9d42393ad762956cfdbaf9f4c8d2962fb4e85dca4","0x67c8c17fa9b3502ca3a351c9d42393ad762956cfdbaf9f4c8d2962fb4e85dca4","0xaa92a556f5a06582868b6bcea29872148d2ab431fc37e80a4ea1900c0dd4e23a"]
    swap: old-primary OUT of [0]=true, new-primary IN as [0]=true, room spans>=K_r(3)=true
    surviving relays (incl. promoted): 4000=OPEN 4002=OPEN
    pre-kill-media-established(true) AND post-kill-survivor-ports-open(true) [TCP LISTEN only, NOT a post-promotion media-continuity proof — no post-kill media re-read]
    chaos kill 4002 (stretch, RESOLVED new primary 0x67c8c17fa9b3502ca3a351c9d42393ad762956cfdbaf9f4c8d2962fb4e85dca4) -> killed:4002:pids=30028
    --- T1-1 promotion decomposition [stretch / 2nd kill — separate population] ---
      kill t0: before=1784212462803 after=1784212465276 (chaos ps-spawn=2473ms, EXCLUDED)
      promote_submit: trace_id=d612d3c3-ecb7-4abf-b33e-b3ca4c53686b time=1784212696521
      kill->promote_submit = 231245ms [config-arithmetic; NOT detection, NOT MTTR]
      promote_submit->RelayPromoted = 1775ms [measured localnet consensus-commit floor; NOT client-visible, NOT MTTR]
    stretch: 2nd RelayPromoted new_primary=0xaa92a556f5a06582868b6bcea29872148d2ab431fc37e80a4ea1900c0dd4e23a epoch=9

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
