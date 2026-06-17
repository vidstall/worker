# W5 M1 — Single-worker forwarding-ceiling bench (advisor-gate-2 follow-up)

**Date:** 2026-06-17
**Repo/branch:** dvconf-daemons @ quangdm_main
**Harness:** `apps/relay/src/__tests__/integration/single-worker-saturation-bench.integration.test.ts`
**Sidecar:** `.evidence/verification/transmission-m1-single-worker-saturation.json`
**Status:** EXPLORATORY (not a hard gate). Supports the advisor-gate-2 narrative; does NOT block M1.

## Question

The P9 hard-gate proved the **bandwidth** math (layer-select + off-page-pause forwards ≥3× fewer
bytes). It did **not** answer *"how large a room can ONE relay node hold?"* — the single mediasoup
Worker (= one CPU core) **forwarding** ceiling. This is the only scale question a **single developer
machine** can attempt honestly: 100 real browser clients on one box would saturate the *clients'*
encoders, not the relay (a meaningless number).

## Method

Fan-out model (the real SFU cost is *forwarding*, not encoding): **P = 9 visible producers**
(1 active speaker + 8 thumbnails) fanned out to **M viewers**, each viewer = 1 transport carrying
9 consumers. Worker forwarding copies ≈ `9 × M` — the same `O(viewers × page_size)` load a real
room imposes. Injection is **M-independent** (only 9 producers to feed), so the JS injector never
becomes the M-dependent bottleneck — the worker's C++ forwarding does. `worker.getResourceUsage()`
reads the worker subprocess CPU cleanly. `cpuCores = (Δru_utime + Δru_stime) ms / windowMs`.
`injectionHealth` (injected bytes/window vs the M=ref point) flags single-box JS starvation.

## Results — healthy regime (clean final run, settle 2.5s / window 4s)

| M viewers | forward paths (9×M) | CPU (cores) | delivery | injection | verdict |
|---|---|---|---|---|---|
| 10 | 90  | 0.29 | 1.00 | 1.00 | healthy |
| 20 | 180 | 0.50 | 1.00 | 1.06 | healthy |
| 30 | 270 | **30.9** | **18.2** | 1.24 | **OVER CAPACITY** |

At M=30 the worker is past capacity: RSS balloons **41 → 471 MB** (packet backlog queue), then the
measurement window catches a pathological **backlog flush** (CPU spike, 18× byte burst). Beyond the
knee, mediasoup channel ops (`consume`/`getStats`) also crawl — i.e. saturation here is **catastrophic,
not graceful**. BASELINE (all `:2`) showed the same shape (M=20 → 0.64 cores, M=30 → over capacity).

## THE headline finding: a single box cannot pin a reproducible number

CPU-per-path varied **2–3× run-to-run** with ambient OS/session load:

| ~paths | observed CPU across runs (cores) |
|---|---|
| 90 (M=10)  | 0.14 · 0.20 · 0.29 · 0.36 |
| 225 (M=25) | 0.35 · 0.73 |
| 450 (M=50) | 0.63 (a *lightly-loaded* run stayed healthy all the way to M=50) |

So the "knee" landed anywhere from **M≈25 (270 paths)** in a loaded run to **>M=50 (450 paths)** in a
quiet one. The load generator, the OS, and the dev session contend with the worker on the **same cores**
— exactly why a trustworthy ceiling needs a **dedicated multi-host load rig (BENCH-3)**, not one laptop.
This bench *empirically demonstrates* that limitation rather than papering over it.

## Three robust (run-independent) findings

1. **One worker handles the low-hundreds of active forward paths** (~180–450, i.e. M≈20–50 viewers of a
   9-stream page) before CPU approaches a core / the backlog turns pathological — *order of magnitude*,
   not a precise number.
2. **Forwarding CPU tracks PACKET/path count, not payload bytes.** OPTIMIZED ≈ BASELINE CPU in the
   healthy regime (M=10: 0.29 vs 0.31; M=20: 0.50 vs 0.64). ⇒ M1's **layer-select saves downlink
   BANDWIDTH; PAGINATION + off-page PAUSE (fewer paths) is what saves relay CPU.** They are
   complementary, not the same lever.
3. **Over-capacity fails catastrophically** (RSS balloon → backlog flush → channel stall), not
   gracefully — so a production deployment must cap room size *below* the knee, not ride up to it.

## Answer to "phòng 100 người chịu được không?"

- **100 viewers × 9-stream page = ~900 forward paths ≫ the ~180–450 one-worker healthy ceiling on this
  box.** A room where **100 people simultaneously have camera on AND are being watched** needs **multiple
  workers / multiple nodes (cascade)** — which is **not built** (DA-5) and is M3/future work.
- **BUT** the load driver is **active watched publishers**, not headcount. A 100-person room where most
  are audio-only / off-page (Zoom-style) keeps active paths low and is well within one worker. That is
  exactly the regime M1's pagination + pause is designed for.

## Honesty bounds (on record)

1. **DirectTransport SKIPS SRTP** encrypt/decrypt — real WebRTC pays that per packet, so measured CPU is
   **optimistic**; the real ceiling is **lower**.
2. **Single box, synthetic RTP**, no WAN / jitter / congestion control. CPU is **not reproducible** (2–3×).
3. **One worker = one core.** Multi-worker (`NUM_WORKERS`) spreads *separate rooms* across cores; splitting
   *one big room* across cores/hosts (cascade) is **not implemented**. Extrapolating past one worker is a
   **documented assumption**, not a measurement.

## Recommendation

Report this as an **order-of-magnitude single-worker floor** ("one relay worker on a dev-class CPU
sustains a few hundred forward paths; a 100-active-publisher room needs cascade → future work"), paired
with the mechanism finding (#2). A **trustworthy capacity curve requires a multi-host load rig (BENCH-3)**
and is consciously deferred to M3. This strengthens — does not weaken — the advisor-gate-2 mechanism-floor
posture: we measured what one box *can* measure and named precisely what it *cannot*.
