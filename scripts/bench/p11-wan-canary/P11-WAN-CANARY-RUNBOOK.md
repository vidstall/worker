# P11 — WAN/real-camera CANARY-LOSS demo — RUNBOOK (REQ-CFA-032/033/034, D-CFA-27)

> **HONESTY-BOUNDS LABEL (carry verbatim into any write-up):**
> **OPTIMISTIC FLOOR — loopback ICE, REAL camera, NOT WAN glass-to-glass.**

> ⚠️ **THE LIVE RUN IS DEFERRED** (F2 / user design gate 2026-06-20). M3 ships this
> **script + runbook + acceptance criteria + honesty-bounds label ONLY**. The run is deferred
> to a **viva / M4 milestone** for two reasons:
> 1. **Port lock** — a concurrent session holds the localnet / mediasoup ports during M3; a
>    port-binding run would collide and corrupt that session.
> 2. **Net-new media plane** — the validator-daemon has **no mediasoup dependency**, and a real
>    `WebRtcTransport` consumer does **not** emit a per-packet `'rtp'` event (only a `pipe`-type
>    `DirectTransport` consumer does). A **production** live canary tap therefore needs a
>    **relay-internal pipe-tap** inside `apps/relay/**` — which M3 must **NOT** touch
>    (**INV-B**: zero `apps/relay/` non-test edits). This harness sidesteps that by owning its
>    **own** in-process mediasoup relay + tap (additive under `scripts/bench/**`, importing
>    **no** production media-path module), but a true production run needs that tap wired — the
>    deferred net-new media plane.

This is the **WAN/real-camera counterpart** to the hermetic
`apps/validator-daemon/src/canary/__tests__/loss-classifier.test.ts` unit proof (M3 chunk 2).
The unit test proves the classifier **logic** over synthetic divergence lists; this demo
proves the **same logic survives a real lossy RTP path** end-to-end: a real camera over real
WebRTC, a controlled loss injector, the **SHIPPED** `verifyForwardedCanary` → the **SHIPPED**
`classifyDivergences`, asserting **benign loss is ABSORBED** while the tamper / sustained-
withholding teeth stay intact.

It extends the **P10** real-browser scaffold (`scripts/bench/p10-browser/`); the only media
change is **fake device → real camera**, plus the **loss injector** and the **canary stream**.

---

## What it proves (honest) — when finally run

- **Benign, independent, within-budget loss → ABSORBED.** A uniform-random Bernoulli drop at
  `P11_LOSS_PCT`% at the relay-internal tap is the **benign WAN-loss baseline**. The classifier
  must promote **ZERO** `DROP` (`observedHash:'MISSING'`) proofs from it — the W-E2 crux: a
  network drop is not a withholding divergence.
- **TAMPER (present-but-wrong-bytes) → ALWAYS promoted, p=1, never gated** (D-CFA-22). Loss can
  never manufacture a wrong-bytes-on-a-delivered-frame divergence; the demo keeps this tooth
  unblunted (exercised in the unit test; the live demo's loss injector only drops, it cannot
  forge — so the tamper leg is the unit test's job, restated here for completeness).
- **Sustained sub-budget withholding → eventually promoted by the cumulative `1-(1-f)^n`
  bound** (PRIMARY signal, keyed by `relayMinerId`). The demo can drive multiple rounds
  (`P11_ROUNDS`) to show the cumulative bound crossing where a single window would not.

### The contrast that is the proof
Same relay + same tap + same SHIPPED verifier/classifier: **uniform benign loss is absorbed**;
**targeted/sustained withholding is promoted**. The loss injector is what makes the benign
baseline real.

---

## Honesty bounds (DA-2/DA-3/DA-8 — load-bearing; do NOT soften)

1. **OPTIMISTIC FLOOR — loopback ICE, real camera, NOT WAN glass-to-glass.** Transport is real
   WebRTC (`WebRtcTransport`, real ICE/DTLS) but over **loopback (127.0.0.1)**. The "WAN" in
   the name is the **loss profile** (the injector), not a real wide-area path. Real WAN adds
   **jitter, reordering, MTU re-fragmentation, ECN** that loopback does not — and those make
   the **W-M3-TAIL** hazard (below) **worse**, not better. A PASS here is a **floor**.
2. **Cross-receiver (SECONDARY) signal is SIMULATED even here (W-M3-SIM).**
   `verifyForwardedCanary` has **zero `index.ts` callers** (the live verify loop is **Task
   5.2+**), so a second co-homed verifier's divergence list is **synthesised**, not captured
   from a second live consumer. The demo exercises the **PRIMARY (cumulative)** + **WEAK-PRIOR
   (STUN/loss budget)** signals over live loss; the SECONDARY stays synthetic. **Do NOT claim
   "cross-receiver corroboration exercised live."**
3. **STUN budget is a WEAK PRIOR (D-CFA-25 / W-M3-STUN-PATH).** STUN-UDP loss ≠ canary-RTP
   loss; an egress-only withholder answers STUN at p≈1 while withholding canary RTP. The demo
   feeds the **measured live loss** as the prior; it is a coarse sanity floor, not a binding
   signal.
4. **Relay-blindness is STRUCTURAL** (the relay forwards the opaque canary body, never reads
   it — INV-B); **validator-blindness is ECONOMIC/OPERATIONAL** (the validator holds
   `cellSecret`). **Never** a cryptographic "relay/validator CANNOT decrypt" claim.
5. **Single-hop only (W-E5, load-bearing).** Publisher + consumer are co-homed on the **same**
   relay R_k. A multi-relay path makes a drop attributable to **either** relay or the inter-
   relay link → the isolated-slash claim degrades to **Miranda et al.'s pair/link prior art**.
   Keep it one hop.
6. **Metadata fingerprinting (W-E6) is amplified by real media.** A real VP8 stream has
   realistic keyframe/interframe cadence + variable frame size; the canary frames must stay
   size/timing/cadence-plausible against it. The demo does **not** prove statistical
   indistinguishability — that is on record (W-E6), not closed here.
7. **No novelty.** The loss bound is an **adaptation of ShortMAC's probabilistic bound**; the
   WAN demo is **engineering hardening that removes the W-E2 caveat**, **not** a novelty
   increment. The headline stays the four-way combination on a real-time content-blind E2EE
   SFU.

---

## Acceptance criteria (the gate the live run must meet)

| # | Criterion | Pass condition |
|---|-----------|----------------|
| **AC-1** | **Tail-extraction sanity gate (W-M3-TAIL)** runs **BEFORE** classification | `extractRate ≥ 0.50` on canary-sized forwarded packets, OR the run **ABORTS** (no classify, no proof, no artifact). See "The W-M3-TAIL gate" below. |
| **AC-2** | **Benign loss absorbed** | At `P11_LOSS_PCT` benign uniform loss, the classifier promotes **0** `DROP` (`observedHash:'MISSING'`) proofs. |
| **AC-3** | **Real camera, not fake device** | The launcher passes **no** `--use-fake-device-for-media-stream`; `track.label` is a real device. (If no camera is present, the run cannot proceed — this is a real-camera demo.) |
| **AC-4** | **Single hop** | Exactly **one** in-process relay; publisher + tap consumer co-homed on it. |
| **AC-5** | **Secret set** | `CANARY_CELL_SECRET` (hex) exported, or the run **fatals** (the canary loop fails safe-off, `index.ts:347-353` — nothing to lose). |
| **AC-6** | **Honesty label on the artifact** | The generated `.evidence` artifact carries the OPTIMISTIC-FLOOR label + the W-M3-SIM / W-E5 / W-E6 bounds verbatim. |
| **AC-7** | **Green-only artifact** | A FAIL writes **no** artifact (relay-overlap N1: green-only at the generator). |
| **AC-8** | **No production media-plane edit** | `git diff apps/relay/` is **empty** (INV-B); the harness imports no production media-path module. |

---

## The W-M3-TAIL pre-classifier sanity gate (load-bearing acceptance precondition)

`verifier.ts:extractCanaryBody` (`verifier.ts:164-177`) reads the canary SFrame body as the
**last `CANARY_SFRAME_LEN` bytes** of a forwarded packet. A real WAN path can **re-packetize /
re-fragment / pad** RTP, which **moves or splits** that fixed tail — so the verifier finds **no**
canary body in **any** packet and reports **every** expected ctr as `observedHash:'MISSING'`.

That is an **extraction bug** (the body is on the wire, at the wrong offset), **not** genuine
withholding — but a downstream classifier fed an **all-MISSING** list would read it as
**catastrophic withholding** and (via the cumulative bound) promote a slash. **This is a
fragmentation bug masquerading as total withholding.**

The harness runs `runTailSanityGate(...)` **before** `classifyDivergences`:

```
tail-extractable rate = (forwarded packets whose fixed-tail trailer parsed as our canaryKid)
                      / (forwarded packets large enough to HOLD a canary body)
```

- **Extraction healthy** (`rate ≥ 0.50`): a MISSING means **genuine drop/withholding** →
  classify on.
- **Extraction broke** (`rate < 0.50` **AND** all expected ctrs MISSING): **ABORT** — do **not**
  classify, do **not** slash, write **no** artifact. **Fix RTP framing** (MTU-safe canary frame
  / no re-fragmentation on the path) before re-running.

A real lossy run still extracts the tail on **every frame it DID forward**; only re-fragmentation
collapses the rate toward 0. The threshold is deliberately loose so benign loss never trips it.

---

## One-time setup (per machine — same as P10)

From `C:\Thesis\dvconf\dvconf-daemons`:

```powershell
# Additive devDeps (already in package.json if P10 was committed): playwright, esbuild, mediasoup.
pnpm add -D -w playwright esbuild@0.27.3 mediasoup@3.19.17
npx playwright install chromium
# A REAL camera must be attached (this is the P10→P11 delta). On a headless server use a
# loopback/virtual camera (e.g. v4l2loopback on Linux, OBS virtual cam on Windows).
```

---

## Run (DEFERRED — only at a viva/M4, after the port lock clears + a real camera is present)

The script **refuses to run** unless the deferred-run acknowledgement is set (so it can never
collide with the concurrent session holding the ports):

```powershell
# DEFERRED — do NOT run during M3. At a viva/M4:
$env:P11_I_ACKNOWLEDGE_DEFERRED_RUN = "yes"
$env:CANARY_CELL_SECRET = "<hex-secret>"   # REQUIRED — the loop fails safe-off without it.
$env:P11_LOSS_PCT = "5"                     # benign loss to inject (default 5).
# Optional sweep knobs: P11_SEND_RATE, P11_DELTA_BPS, P11_K, P11_ROUNDS, --canary-every.

pnpm exec tsx scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts
# Green-only dated artifact:
pnpm exec tsx scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts --write-artifact
```

Without the acknowledgement, the script prints a refusal and exits `2`. This is intentional:
**the run is deferred**, and the guard makes an accidental run loud, not silent.

**Loss-injection alternative (OS-level, closer to WAN):** instead of the app-level Bernoulli
injector, shape the loopback with `tc`/`netem` before the run (Linux) — e.g.
`tc qdisc add dev lo root netem loss 5%`. This adds **reordering/jitter** the app-level injector
does not, exercising the **W-M3-TAIL** gate harder. (Windows has no direct `netem`; use the
app-level injector or run under WSL2/Linux for `netem`. Clean up with
`tc qdisc del dev lo root` afterward.) Document whichever was used in the artifact.

Output (on PASS): `.evidence/verification/canary-wan-loss-YYYY-MM-DD.md` (PROVISIONAL +
platform disclosed + the W-M3-TAIL gate result + the honesty bounds). The green-only logic lives
**at the generator** — never edit the output `.md` to make it green; fix the harness and re-run.

---

## Open wiring (deferred to the live run — on record, not hidden)

1. **`kRoom` export.** The validator-daemon verifier's `VerifyInput` needs `kRoom`. `KeyManager`
   does **not** currently expose a `kRoom`/`roomKeyHex` getter (verified: its public surface is
   `kid` / `contentKeyForSenderAtKid` / `keyLookupForSender`). The page guards this (`typeof
   meKm.roomKeyHex === 'function' ? … : null`) and the canary leg is self-consistent without it
   (the canary is encrypted with `kContent` + a fixed `canaryKid` the Node `verifyInput`
   mirrors); but a verifier that re-derives `K_canary` on the Node side from `kRoom` needs that
   getter added at run time.
2. **Relay-internal pipe-tap for production.** This harness owns its own relay+tap; a production
   live run needs the tap inside `apps/relay/**` (the net-new media plane, INV-B-respecting only
   as a separate post-thesis lane).
3. **A second live consumer** to make the cross-receiver (SECONDARY) signal **live** instead of
   simulated (W-M3-SIM) — gated on the live verify loop (Task 5.2+).

---

## Files

- `scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts` — the Node harness (own in-process
  single-hop mediasoup relay + WS + page server + **loss-injecting tap**; runs the SHIPPED
  verifier + the W-M3-TAIL sanity gate + the SHIPPED classifier; green-only artifact generator;
  hard deferred-run guard).
- `scripts/bench/p11-wan-canary/wan-canary-entry.js` — the browser entry (esbuild-bundled): real
  `mediasoup-client` + **real getUserMedia camera** + the SHIPPED client SFrame crypto +
  the SHIPPED canary PRF (`deriveCanarySeed`/`canaryPlaintext`), emits the deterministic canary
  stream interleaved with the camera frames.
- `scripts/bench/p11-wan-canary/wan-canary-page.html` — the secure-context page shell.
- Evidence (on a deferred live PASS): `.evidence/verification/canary-wan-loss-YYYY-MM-DD.md`.

**NOT wired into CI / NOT a pnpm script** (by design — the run is deferred and a concurrent
session holds the ports). It is additive/test-only; imports no production media-path module;
never edits `apps/relay/**`; never logs key material.
