# P10 Step-2 — Real-browser relay-blind capture (REQ-MCS-014) — RUNBOOK

The **thesis-headline** real-browser leg of P10. Drives a real headless Chrome (fake
media) over **production WebRTC** into an **E2EE room** whose VP8 frames are
SFrame-encrypted by the **shipped client crypto**, and proves at a **relay-internal
tap** that the relay receives the SFrame ciphertext but cannot read or forward it —
against a **non-E2EE control** that forwards cleartext VP8 over the same path.

This is **build-now / run-the-dated-capture-later**: the harness is committed; running
it emits a dated `.evidence` artifact. It is **additive / test-only** (lives under
`scripts/bench/p10-browser/**`), imports **no production media-path module**, and never
edits `useRelay.ts` / `room-handler.ts` / `signaling.ts` / `sframe-transform.ts` /
`mediasoup-manager.ts`.

> Relationship to the rest of P10:
> - **P5** proved the STRUCTURAL blind-forward with a stand-in opaque body.
> - **Step-1** (`apps/relay/src/__tests__/integration/relay-blind-realsframe.integration.test.ts`)
>   proved a hermetic, CI-reproducible floor over REAL P2/P3 SFrame ciphertext through a
>   synthetic DirectTransport relay source.
> - **Step-2 (this)** is the real-browser SFrame-over-VP8 leg under production WebRTC
>   (real getUserMedia → real createEncodedStreams insertable-streams SFrame →
>   WebRtcTransport, real ICE/DTLS → real mediasoup relay). Do **not** double-claim
>   P5/Step-1 — the delta is this real-browser leg + a NEW interop finding (below).

---

## What it proves (honest)

- **E2EE room (relay-blind):** the relay RECEIVES the SFrame ciphertext over real WebRTC
  (`relayReceived > 0`, from the relay's own mediasoup producer stats) but FORWARDS NONE
  of it (`forwarded == 0` at the tap) — a real mediasoup SFU cannot forward a full-frame
  SFrame stream because SFrame encrypts the VP8 keyframe markers the SFU needs to begin
  forwarding (it sends PLIs and never gets a detectable keyframe). The captured SFrame
  ciphertext carries the **real config-0x01 + 13-byte header** and **fails AES-GCM
  decrypt WITHOUT the key**.
- **Non-E2EE control (cleartext):** over the SAME relay + tap, the relay forwards
  cleartext VP8 verbatim and a keyless reader recovers the frame (VP8 keyframe magic
  `0x9d012a`).
- **The contrast is the proof.** Identical relay mechanics; E2EE is what makes the
  forwarded bytes meaningless to a keyless reader.

### Honesty bounds (DA-2/DA-3/DA-8, D-M2-7/8) — carry verbatim into any write-up
- Relay-blindness = **STRUCTURAL** (mediasoup has no decode path); M2 validator-blindness
  = **ECONOMIC/OPERATIONAL** (the validator HOLDS the key). **NEVER** "relay cannot
  decrypt" as a crypto fact — that is **Path C → M3**.
- "Undecodable" = structure (header present) + AES-GCM decrypt failure without the key,
  **not** a known-plaintext attack. The negative control is load-bearing.
- Disclose the platform: **headless Chromium on Windows, FAKE media, LOOPBACK ICE** —
  NOT WAN glass-to-glass.
- **NEW finding (surfaced only by the real leg):** the shipped full-frame SFrame breaks
  the SFU's keyframe detection, so a stock mediasoup relay cannot forward an E2EE stream
  as-is. Step-1's hand-built VP8 keyframe headers (outside the encrypted body) could not
  show this. Worth a sentence in the thesis as an honest M2→M3 interop note (a real SFU
  deployment needs SFrame to leave the codec's keyframe metadata readable, or the SFU to
  treat the stream as opaque/pipe-forwarded).

---

## One-time setup (per machine)

From `C:\Thesis\dvconf\dvconf-daemons`:

```powershell
# 1. Additive devDeps (already in package.json/pnpm-lock if the harness was committed):
pnpm add -D -w playwright esbuild@0.27.3 mediasoup@3.19.17
# (mediasoup-client is already a devDep; it is the page's WebRTC client.)

# 2. Download the Chromium Playwright build (one-time, ~150 MB to the ms-playwright cache):
npx playwright install chromium
```

Notes:
- `esbuild` + `mediasoup` are added as **root** devDeps because the harness runs from the
  workspace root `scripts/` dir and `mediasoup` is otherwise only a dep of `apps/relay`.
  `mediasoup@3.19.17` is pinned to the relay app's version. All three are additive.
- `mediasoup` is **ESM-only** — the harness is an ESM `.ts` run via `tsx` (fine).

---

## Run the dated capture

```powershell
# Dry run (prints the verdict, writes NO artifact):
pnpm run bench:p10:browser

# Emit the dated artifact (GREEN-ONLY: a FAIL writes nothing):
pnpm run bench:p10:browser -- --write-artifact
```

Or directly:

```powershell
node_modules/.bin/tsx scripts/bench/p10-browser/p10-relayblind-browser.ts --write-artifact
```

Output (on PASS): `.evidence/verification/transmission-m2-relayblind-YYYY-MM-DD.md`
(marked **PROVISIONAL** + platform disclosed; schema = env/platform/browser/HEADs, the
E2EE received-vs-forwarded counts + ciphertext hex + decode-attempt, the non-E2EE
cleartext recovery, a side-by-side table, and PASS/FAIL).

The green-only logic lives **at the generator** (relay-overlap N1 lesson) — never edit
the output `.md` to make it green; fix the harness and re-run.

---

## Environment requirements & platform caveats

- **Secure context (REQUIRED):** `getUserMedia` and insertable streams need a secure
  context. The harness serves the page over `http://127.0.0.1:<port>` (loopback is
  treated as secure). On `about:blank`, `navigator.mediaDevices` is `undefined`.
- **Insertable streams (REQUIRED for E2EE):** `sender.createEncodedStreams()` needs the
  RTCPeerConnection created with `encodedInsertableStreams: true`. The harness passes
  `additionalSettings: { encodedInsertableStreams: true }` into the mediasoup-client
  `createSendTransport` for the E2EE room. **HONESTY/FINDING:** the production
  `useRelay.createSendTransport` does NOT currently pass this flag — a separate latent
  gap for the live E2EE path (out of P10 scope; the harness sets it so SFrame attaches).
- **Dual-API caveat (NOT a production edit):** Chromium 149 exposes BOTH
  `createEncodedStreams` and the standard `RTCRtpScriptTransform`. The shipped
  `detectEncodedTransformApi()` PREFERS the standard API, whose path is an M3 worker
  scaffold that no-ops without a worker — and production supplies none, so production
  today ALSO relies on the `createEncodedStreams` branch. The harness masks
  `RTCRtpScriptTransform` on its OWN page and drives the `createEncodedStreams` branch
  with the SHIPPED `encryptFrame` (byte-identical ciphertext).
- **Headless / no display:** `chromium.launch({ headless: true })` with fake media — no
  real camera or display server needed. Verified on Windows 11 with Chromium
  149.0.7827.55.
- **Windows:** the `@roamhq/wrtc` Node WebRTC harness is broken on Windows (DA-4); this
  is exactly why P10 uses a real browser. Real Chrome ICE/DTLS completes on localhost
  host candidates (no STUN/TURN needed).
- **Ports:** the harness binds ephemeral loopback ports (http + ws) per room; nothing to
  configure.

### If a live run cannot connect (other machines / CI)
- Re-confirm `npx playwright install chromium` populated the `ms-playwright` cache.
- Headless Chrome must be launchable; in a locked-down CI add the usual
  `--no-sandbox`-style flags to the `chromium.launch` args (the harness uses only the
  fake-media flags by default — keep them).
- The capture is intentionally NOT a blocking gate: the harness exits non-zero on FAIL
  and writes no artifact. Diagnose from the `PAGE>` console lines and the
  `E2EE/CTRL relayReceived/forwarded` summary.

---

## Files

- `scripts/bench/p10-browser/p10-relayblind-browser.ts` — the Node harness (owns the
  in-process mediasoup relay + WS + http page server + the pipe tap; drives both rooms;
  analyses; green-only artifact generator).
- `scripts/bench/p10-browser/harness-entry.js` — the browser entry (esbuild-bundled):
  real `mediasoup-client` Device + real getUserMedia + the SHIPPED client SFrame crypto
  (`encryptFrame`/`KeyManager`/`createSessionKeypair`), captures ciphertext samples.
- `scripts/bench/p10-browser/harness-page.html` — the secure-context page shell.
- `scripts/bench/p10-browser/p10-relayblind-browser-spike.ts` (+ `browser-entry.js` +
  `index.html`) — the de-risking spike (browser media → relay → tap, no SFrame). Kept
  for reference; not part of the headline run.
- Evidence: `.evidence/verification/transmission-m2-relayblind-YYYY-MM-DD.md` (artifact),
  `.evidence/tdd/REQ-MCS-014-p10-browser-*.log` (run logs).
