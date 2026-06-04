# Relay-Overlap M1 — Client-Perceived Cutover MTTR Bench

**Date:** 2026-06-05  
**Branch:** bench-3b-client-mttr (off spike-warmpipe-rtp)  
**Verdict:** **PASS** vs success-metric P95 <= 100 ms / P99 <= 200 ms

## Result

| Metric | Value (ms) | Target | Pass |
|---|---:|---|:--:|
| N (runs) | 30 | >=30 | yes |
| P50 MTTR | 60.0 | - | - |
| **P95 MTTR** | **69.0** | <= 100 | yes |
| **P99 MTTR** | **69.0** | <= 200 | yes |
| mean | 60.3 | - | - |
| min / max | 50.0 / 69.0 | - | - |
| failed runs | 0 | 0 | yes |

### MTTR component breakdown

| Component | P50 (ms) | P95 (ms) |
|---|---:|---:|
| detection window (kill -> watcher fired) | 59.0 | 65.0 |
| relay + resume (watcher fired -> first standby RTP) | 0.0 | 15.0 |

## Knob values

| Knob | Value |
|---|---:|
| RTP_TIMEOUT_MS | 50 |
| JITTER_BUFFER_MS | 0 |
| HEARTBEAT_INTERVAL_MS | 0 (reserved; no-op in this rig) |
| BENCH_WARMUP_MS | 250 |
| BENCH_SETTLE_MS | 400 |

## Methodology

- **In-process, real-mediasoup**: two real Workers (primary + standby relays, distinct child processes), two Routers, real PipeTransports, real Opus RTP. Warm pipe built by the production-faithful manual cross-PipeTransport pairing proven by the step-3a spike.
- **Client model**: dual DirectTransport consumers — primary router (active) + standby router piped producer (pre-created PAUSED, REQ-RO-005). DirectTransport emits a per-packet rtp event -> sub-ms client-perceived arrival timestamps.
- **Detection**: the dvconf-client rtp-timeout-watcher replicated verbatim (fire once after RTP_TIMEOUT_MS of silence, reset per packet), attached to the primary sink.
- **t0** = client's last RTP from the primary sink (the primary relay drops the client). **t1** = client's first RTP from the standby after resume. **MTTR = t1 - t0.**
- **"Kill primary"** = the PRIMARY RELAY drops the client, modelled by closing the client's PRIMARY sink consumer (`primarySink.close()`). The room peer (publisher) keeps sending and the warm pipe keeps carrying RTP to the standby — exactly the failure relay-overlap redundancy protects against, so the resumed standby sink has real RTP to deliver. (Deliberately NOT "stop the publisher": starving the source would also starve the standby — a source outage, not a relay failover, which M1 does not address.)

## Honesty / bounds

- **Optimistic floor** for the detection + relay/resume mechanism, **not** a WAN glass-to-glass latency. In-process loopback omits real-deployment terms a cross-process / WAN client adds: WebRTC jitter-buffer playout (~20-60 ms), OS UDP scheduling, network RTT.
- The inter-relay WS connect-param exchange is **genuinely ~0 at cutover**: the warm pipe is pre-established before the kill (the point of REQ-RO-004/005), so it is off the cutover critical path.
- MTTR is **bounded below by RTP_TIMEOUT_MS (50 ms)**; the detection window dominates (relay-level resume ~0-1 ms, spike-confirmed). Lowering RTP_TIMEOUT_MS lowers MTTR at the cost of false-positive cutovers on transient jitter.
