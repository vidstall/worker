# Canary forwarding-audit — ON-CHAIN SLASH leg E2E (Phase 4.1 capstone)

REQ-CFA-006 / REQ-CFA-007 / REQ-CFA-008 · INV-A · INV-C
Date: 2026-06-19 · Branch: `quangdm_main` · Localnet (`sui 1.66.2`, `--epoch-duration-ms 2000`)

## What this proves

A REAL `proof.ts` proof — built from a REAL `verifier.ts` divergence over REAL canary
bytes — wired into the DEPLOYED Move entry `canary_audit::slash_for_canary_divergence`
(contracts main `970d656`) produces a real, isolated, bond-decreasing slash on a live
localnet. The mediasoup forward leg is Phase 1.1's separate file; this E2E exercises the
on-chain slash leg only (DESIGN §6.1 file 2).

## The divergence is real (INV-A)

`CanaryPublisher.produce()` → canonical canary SFrame stream (cellSecret-derived) →
wrapped in 12-byte RTP headers → ONE frame's ciphertext byte flipped (trailer ctr intact
⇒ TAMPER, not drop) → `verifyForwardedCanary()` recomputes each expected C_i LOCALLY and
byte-compares ⇒ a real `CanaryDivergence { frameSeq:2, expectedHash, observedHash }` (a
present-but-different, not a drop) → `buildDivergenceProof()` (2 Wallet-B session sigs).

## The bond reality — approach (b) / W-E9 (ON RECORD)

`staking::share_for_testing` + `create_for_testing` are `#[test_only]` (staking.move:140-161)
and STRIPPED from the deployed localnet package. `StakePosition has key` (no store);
registration mints it OWNED by the miner wallet; an owned `&mut` PTB arg can only be passed
by its OWNER. So the slash tx is **signed by the relay (the bond owner) itself**. This
proves the entry mechanism end-to-end (the ≥2-distinct Wallet-B quorum cannot be forged by
the relay; divergence/room/wrong-bond asserts all execute; the bond is debited; the event
fires). The "bond owner signs its own slash" gap IS W-E9: production needs a
protocol-controlled bond so a validator tx can slash without the owner's cooperation.

## Assertions proven (exact on-chain values)

### REQ-CFA-006 — HAPPY: slash entry fires + bond decreases
- `CanaryDivergenceSlashed` event fired: `relay_miner_id == R_k`, `frame_seq == 2`,
  `attester_count == 2`, `attester_ids == {v1, v2}` (distinct, resolved from Wallet-B
  session pubkeys via `lookup_session_wallet` — INV-C, no Wallet-A on-chain).
- Bond delta (MIST): **before `300_000_000` → after `270_000_000`**, `slash_amount =
  30_000_000` (= 10% SLASH_BPS), and `before - after == slash_amount` exactly.

### REQ-CFA-008 — NO-FALSE-POSITIVE: honest run aborts, bond unchanged
- An HONEST run (`expected == observed`, observed present) with otherwise-valid 2 Wallet-B
  sigs ⇒ entry aborts **`E_NO_DIVERGENCE` (686)** ⇒ NO event, NO slash, bond UNCHANGED.

### REQ-CFA-007 — NxM attribution: only the named relay is slashed
- R2's proof slashes ONLY R2: R2 before `300_000_000` → after `270_000_000`; R1 untouched
  (`270_000_000` → `270_000_000`).
- Wrong-bond teeth: submitting R2's proof against R1's bond aborts **`E_WRONG_STAKE` (687)**
  (the entry binds `proof.relay_miner_id` to the passed StakePosition's `miner_id`, check #2,
  BEFORE the room check).

## Files
- prod: `apps/validator-daemon/src/canary/slash-submitter.ts` (proof → PTB → entry; owner-signed)
- test: `apps/validator-daemon/src/__tests__/integration/canary-slash-e2e.integration.test.ts`
- helpers: `apps/validator-daemon/src/__tests__/integration/canary-localnet-helpers.ts`
- fixture: `apps/validator-daemon/src/__tests__/integration/localnet-fixture.ts` (copy of the
  cp-daemon fixture + deployer/AdminCap exposure for AdminCap-gated room assignment)
- config: `vitest.integration.config.ts` (precise `canary-*` glob — does NOT pull the
  sibling `dual-probe-bw-delta` bench)

## Run
```
pnpm test:integration   # vitest.integration.config.ts (cp-daemon + the canary glob)
# or scoped:
npx vitest run --config vitest.integration.config.ts \
  apps/validator-daemon/src/__tests__/integration/canary-slash-e2e.integration.test.ts
```
RED: `.evidence/tdd/REQ-CFA-006-007-008-e2e-red.log` (fails: slash-submitter not wired).
GREEN: `.evidence/tdd/REQ-CFA-006-007-008-e2e-green.log` (3/3 passed; clean taskkill-tree
teardown — no stray `sui.exe`, port 9000 free).
