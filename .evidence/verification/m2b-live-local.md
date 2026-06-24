# M2b-live LOCAL slice — verification evidence (guard#9)

> Lane: **M2b-live-local** — canary divergence DETECTED from REAL forwarded media across REAL OS
> processes on localhost (no WAN). A Node mediasoup producer (canonical canary from the daemon
> `CanaryPublisher`) → a real relay-role forward over the F1 router→router PipeTransport (with an
> additive demo-only byzantine re-produce hop BEFORE the pipe) → a REAL validator-daemon runtime
> consumer → the UNCHANGED `runCanaryVerifyRound` → a ≥2-distinct Wallet-B 145-byte proof.
> Closes M2b capture-core's "tamper harness-side" caveat.

- **Date:** 2026-06-24 / 2026-06-25
- **Branch:** `m2b-live-local` (FROM `cb414be` = `m2b-capture-core`, UNMERGED)
- **HEAD (daemons):** `c3fecc9` (Task 5 / N6 cross-process e2e) — Task 6 adds only this evidence note.
- **Spec:** `docs/superpowers/specs/2026-06-24-m2b-live-local-design.md` (REQ-MLL-01..11)
- **Plan:** `docs/superpowers/plans/2026-06-24-m2b-live-local.md`
- **Contracts HEAD:** `f9d37ab/main` (0 Move source change — verified)

---

## Task-0 GATE — evil-relay re-produce / tail-locator spike

**VERDICT: GO** (`.evidence/verification/m2b-live-task0-spike.log`).

The new relay-side DirectTransport consume → (corrupt|passthrough) → `producer.send()` RE-PRODUCE
hop, placed BEFORE the F1 PipeTransport, does NOT re-packetize the canary body off the fixed tail
anchor (`verifier.ts:169` = `pkt.subarray(pkt.length - CANARY_SFRAME_LEN)`), and the byzantine
single-byte flip at `(len - SFRAME_TRAILER_LEN - 1)` lands inside the extracted tail body.

Observed (production `VerifyResult` fields, NO `verifier.ts` edit needed):

| Path | mediaPackets | byteIdentical | divergences |
|---|---|---|---|
| HONEST re-produce | 77 | 77 | 0 |
| BYZANTINE re-produce | 77 | 0 | 8 |

⇒ the `verifier.ts` / `proof.ts` / `claim-board.ts` frozen-proof invariant holds; REQ-MLL-04/05/06
authored unconditional. Throwaway spike deleted on GO.

---

## REQ-MLL traceability (REQ-MLL-01..10 gated; -11 demo, not gated)

| REQ | Statement | Evidence (test → counts) | Result |
|---|---|---|---|
| **REQ-MLL-01** | Real cross-process F1 PipeTransport between TWO OS processes over localhost UDP; capture >0 on each validator sink. | `canary-m2b-live-local.integration.test.ts` (2 tests: HONEST + BYZANTINE) — `fork()`ed relay parent + 2 validator children, real router→router pipe per leg. | **PASS** |
| **REQ-MLL-02** | Production tail-locator survives the real forward incl. the N4 re-produce hop; honest `mediaPackets>0 / byteIdentical==mediaPackets`. | Task-0 GATE (77/77/0 honest); `canary-m2b-live-producer` + `canary-m2b-live-evilrelay` HONEST 0-divergence. | **PASS** |
| **REQ-MLL-03** | HONEST forward → 0 divergence (INV-A, no false positive) on BOTH validators. | `canary-m2b-live-evilrelay` HONEST (0 divergence); `canary-m2b-live-local` HONEST → 0 proofs across 2 processes. | **PASS** |
| **REQ-MLL-04** | BYZANTINE evil-relay forward (real relay-role corruption on the wire, N4) → TAMPER detected from captured bytes. | `canary-m2b-live-evilrelay` BYZANTINE → submitted>0; `canary-m2b-live-consumer` byzantine → detected; `canary-m2b-live-local` BYZANTINE → both detect. | **PASS** |
| **REQ-MLL-05** | ≥2-distinct Wallet-B from 2 INDEPENDENT validator processes, accrued across the loopback claims-server. | `canary-m2b-live-local` BYZANTINE → `Math.max(attesters) ≥ 2` (2 forked children, each own `Ed25519Keypair` + loopback `startClaimsServer`/`HttpClaimBoard` cross-post). | **PASS** |
| **REQ-MLL-06** | Frozen proof: 145-byte canonical msg; `attester_count=2`; relay/room pinned. | `proof.ts` UNCHANGED (`CANARY_PROOF_MSG_LEN=145`, `MIN_ATTESTERS=2`); `distinctAttesterCount(...) ≥ 2` asserted in evilrelay + consumer + local tests. | **PASS** |
| **REQ-MLL-07 (INV-B)** | Production relay media-path byte-stable; corruption ONLY in demo-only N4; relay byte-identity suites GREEN; no decrypt. | `git diff cb414be -- apps/relay/ packages/inter-relay-client/` = **EMPTY**; relay `multi-hop-byte-identity` (4) + `relay-blind-realsframe` (2) + canary-forward POSITIVE (`byteIdentical==mediaPackets`) GREEN. | **PASS** |
| **REQ-MLL-08 (INV-C)** | Wallet-B only; attestations via `selfSessionKeypair`/`sessionPublicKey`; no Wallet-A, no minerId in proof. | All M2b-live tests pass `selfSessionKeypair: new Ed25519Keypair()`; child signs via `signSelfAttestation` over the 145-byte msg; proof carries `{pubkey,sig}` only. | **PASS** |
| **REQ-MLL-09** | Additive + flag-gated (`CANARY_LIVE_CAPTURE=pipe`); default path byte-identical; Move 0-change; 0 `console.*` in N2/N3. | `live-seams-capture-flag.test.ts` (2 tests: default `injected`, explicit `pipe`); `live-seams.ts` additive (1 new export + comments); INV-A diff EMPTY; 0 console hits in `live-consumer.ts`/`live-consumer-runtime.ts`/`live-seams.ts`. | **PASS** |
| **REQ-MLL-10** | Non-vacuity RED-hook: HONEST vs BYZANTINE diverge (proves detection reads real captured cross-process bytes). | Every M2b-live integration test pairs HONEST (0) vs BYZANTINE (≥2-distinct); disabling N4 corruption flips BYZANTINE assertion RED while HONEST stays GREEN. | **PASS** |
| **REQ-MLL-11** | (demo, NOT gated) manual localnet-slash producing an on-chain `CanaryDivergenceSlashed`. | OPTIONAL `scripts/demo-m2b-live-localnet-slash.ts` — **DEFERRED** (per plan: "MAY be deferred — not part of the gated suite"; localnet faucet/epoch/RPC flake kept out of green). PARTIAL-by-design. | **DEFERRED** |

---

## guard#9 — test re-run counts

| Suite | Command | Result |
|---|---|---|
| **Validator-daemon unit** (hermetic) | `npx vitest run apps/validator-daemon` | **36 files / 249 tests PASS** (incl. `live-seams-capture-flag.test.ts` 2/2). |
| **Canary integration — M2b-live** | `npx vitest run --config vitest.canary.config.ts canary-m2b-live` | **4 files / 6 tests PASS** (producer 1, evilrelay 2, consumer 1, local 2). Stable across repeated runs. |
| **Canary integration — full** (first run) | `npx vitest run --config vitest.canary.config.ts` | **8 files / 17 tests PASS** (incl. relay `canary-forward` byte-identity POSITIVE + DROP tooth). |
| **Relay byte-identity (INV-B)** | `npx vitest run --config vitest.relay-integration.config.ts relay-blind-realsframe multi-hop-byte-identity` | **2 files / 6 tests PASS**. |
| **Whole-repo unit** (non-regression) | `npx vitest run` (repo root) | 173 files / 1494 tests PASS; **1 file / 2 tests FAIL = PRE-EXISTING & UNRELATED** (`scripts/governance/__tests__/revoke-cap-token.test.ts`, mock 10s timeout; `git diff cb414be -- scripts/governance/` = EMPTY = not touched by this lane). |

**Known unrelated flake (NOT in REQ-MLL scope):** `apps/validator-daemon/src/__tests__/integration/canary-slash-e2e.integration.test.ts` (REQ-CFA-006/007/008) boots a Sui localnet and is documented `~1/3 flaky on Windows` in `vitest.canary.config.ts`. It passed in the first full canary run and timed out at suite-boot on a re-run. It is the pre-existing localnet slash E2E, NOT an M2b-live test; all `canary-m2b-live-*` tests passed in every run.

---

## Invariant assertions (vs base `cb414be`)

```
INV-A  git diff --stat cb414be -- verifier.ts proof.ts claim-board.ts   →  EMPTY  (PASS)
INV-B  git diff --stat cb414be -- apps/relay/ packages/inter-relay-client/  →  EMPTY  (PASS — relay code byte-identical, not merely behavior-stable)
Move   git -C dvconf-contracts diff --stat -- sources/                  →  EMPTY  (0 .move source change; only a Move.lock build-artifact churn, no contract code)
console.*  grep in live-consumer.ts / live-consumer-runtime.ts / live-seams.ts  →  0 hits  (PASS)
```

**Full changeset vs `cb414be`** (14 files, all additive M2b-live + the dep-move):
`apps/validator-daemon/package.json` (N1 dep move) · `src/canary/live-consumer.ts` · `live-consumer-runtime.ts` (N2) · `live-seams.ts` (N3, additive) · `test-support/node-canary-producer.ts` (N5) · `evil-relay-forward.ts` (N4) · `m2b-live-validator-proc.ts` · `__tests__/live-seams-capture-flag.test.ts` · 4 × `__tests__/integration/canary-m2b-live-*.integration.test.ts` · `pnpm-lock.yaml`. (The `relay-overlap-m1-bench-2026-06-05.md` working-tree change is a pre-existing unrelated edit — NOT staged.)

---

## tsc (honest)

`tsc --noEmit` run standalone from each app dir is **NOT clean even at base `cb414be`** — it emits a
large, pre-existing set of resolution errors (monorepo tsconfig quirk; everything resolves and runs
fine under tsx/vitest, hence all suites GREEN):

- `apps/validator-daemon`: **132 errors warm**, dominated by **113 × TS2307** "Cannot find module"
  for `@mysten/sui/keypairs/ed25519` / `@dvconf/shared` hitting virtually every canary file
  (`claim-board.ts`, `proof.ts`, `verify-loop.ts`, `verifier.ts`, `index.ts`, the M2b
  capture-core test, etc.), plus a handful of TS6059 `rootDir` / TS2835 / TS7006.
- `apps/relay`: **76 errors warm**, same classes (52 × TS2307 + rootDir/cross-repo).

**0 NEW error CLASSES from M2b-live:** every error that touches a new file
(`canary-m2b-live-consumer`/`-evilrelay`, `m2b-live-validator-proc.ts`) is a `TS2307` instance of
the IDENTICAL pre-existing pattern already exhibited by base canary files importing the same
modules. No M2b-live file has a real type error. Relay tsc references **0** M2b-live files
(relay imports none — INV-B).

---

## Honest caveats on record

1. **Node producer, not a browser.** The media SOURCE is a real Node mediasoup `DirectTransport`
   producer fed by the daemon's canonical `CanaryPublisher.produce()` byte-source — not a real
   `dvconf-client` browser producer (that + cross-repo SFrame byte-equivalence → a later CLIENT lane).
2. **Localhost only, no WAN.** All pipe legs are `127.0.0.1` ephemeral-port; cross-host
   `announcedIp` + STEP-3 SPKI-pinned mTLS carrier → `M2b-live-WAN`.
3. **In-memory board for the gated suite.** The ≥2-distinct quorum accrues over a loopback
   plain-HTTP claims-server into an `InMemoryClaimBoard`; a real on-chain
   `CanaryDivergenceSlashed` slash is the OPTIONAL manual demo (REQ-MLL-11, deferred).
4. **The evil-relay is a purpose-built demo/test-only variant.** Corruption lives ONLY in
   `test-support/evil-relay-forward.ts`, NEVER imported by the production relay path. By design the
   shipped relay daemon never diverges (INV-B) — a permanent boundary, not a deferral.
5. **mediasoup is now a validator-daemon `dependency`** (was devDep): the validator genuinely runs
   an SFU consumer at runtime — this pulls the mediasoup native worker into the validator image (ops
   note, NOT an INV-B concern; the dep is on the validator, not the relay).
6. **REQ-MLL-11 deferred** (demo, not gated) — `scripts/demo-m2b-live-localnet-slash.ts` not written;
   PARTIAL-by-design per plan §1 OPTIONAL.

## Deferrals → next lanes

- **M2b-live-WAN:** cross-host `announcedIp` + `PIPE_PORT_RANGE` orchestration + STEP-3 mTLS carrier + a real on-chain slash across 2 hosts.
- **Client browser-producer lane:** a `dvconf-client` canary producer (client `sframe-transform.ts` + headless browser) and the cross-repo SFrame byte-equivalence.
- **REQ-MLL-11 manual localnet-slash demo** (single-host live chain) — buildable now from the N4/N5 harness + STEP-3 `submitCanarySlash`/`createRoomWithRelay`.
