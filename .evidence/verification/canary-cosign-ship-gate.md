# Canary Forwarding-Audit Wave — W-M4-COSIGN slice SHIP gate

> **GATE_PASS_WITH_PARTIALS** — independent 9-agent read-only SHIP gate `wf_e3341215-4bf`
> (4 REQ-slice auditors + 4 adversarial lenses [honesty / INV-A byte-frozen / anti-fabrication soundness /
> scope-tsc] + a gate synthesizer). **0 blockers · 0 confirmed overclaims.** Every claim re-verified against
> COMMITTED source (file:symbol:line), not prose. Guard #9 reproduced LIVE by the gate. 2026-06-20.

## Verdict

All 4 auditors **MET** (0 issues / 0 overclaims); all 4 lenses **PASS**. **REQ-CFA-047..053 ALL MET (7/7).**
Guard #9 reproduced by the gate (hermetic, no ports): **validator-daemon unit 189/189 + tsc 5 pre-existing /
0 NEW.** The RED log is genuine (`deps.syntheticPeerKeypairs is not a function` pre-swap → GREEN 189).

## HEADs gated

| repo | branch | HEAD | scope |
|---|---|---|---|
| dvconf-daemons | quangdm_main | `c779b3e` (code) + (this commit: gate doc) | proof.ts helpers + claim-board.ts + verify-loop seam swap + index wiring |
| root | master | `473baa4` (design + REQ) + (EXECUTION-STATUS commit) | DESIGN-COSIGN.md + REQUIREMENTS REQ-CFA-047..053 |
| dvconf-contracts | main | `970d656` (UNCHANGED) | zero Move — `canary_audit.move` byte-frozen by construction |

## What the slice proves (the W-M4-COSIGN designable-now root, hermetic)

The off-chain **≥2-distinct-Wallet-B attestation-COLLECTION** protocol (Approach D+ pull-corroboration
claim-board, the TRUE root of W-M3-SIM), built with NO ports:

- **REQ-CFA-047/048** — `cellKey` (claim-board.ts:42-44) keys ONLY on `(roomId, relayMinerId, canaryId,
  frameSeq)`; `signSelfAttestation` (proof.ts:297-306) signs ONE Wallet-B leg over the UNCHANGED 145-byte
  `canonicalProofMessage`, calls NEITHER `buildDivergenceProof` NOR `MIN_ATTESTERS` NOR `dualKeySign`.
- **REQ-CFA-049/050** — `assembleProofFromAttestations` (proof.ts:316-352) accrues PRE-SIGNED REMOTE
  attestations, re-asserts ≥2 DISTINCT pubkeys (throws below 2, dedups output); `attestIfIndependentlyObserved`
  (claim-board.ts:140-156) signs ONLY on a local byte-match of `(frameSeq, expectedHash, observedHash)` — a
  peer **cannot be coerced** (disagree→null, absent→null, unit-proven).
- **REQ-CFA-051/052** — `InMemoryClaimBoard` dedup-by-pubkey + fail-closed `W_corr` GC + submit gating; the
  verify-loop seam swap drops `syntheticPeerKeypairs`, adds `claimBoard` + `selfSessionKeypair`, and the
  promote block is **publish-own → poll-corroborate → assemble+submit ONLY at ≥2 distinct** (a self-only loop
  FAILS CLOSED — unit-proven: `submitted=0`, cell open with 1 distinct).
- **REQ-CFA-053** — INV-C: the board + attestation carry ONLY the accused relay's PUBLIC id + Wallet-B
  pubkey/sig (unit-asserted: no `minerId`/Wallet-A/`assignmentSecret`/`cellSecret` on the wire).

## Security crux (anti-fabrication) — VERIFIED SOUND

- A **single** validator cannot slash alone: the self-only loop fails closed (1 distinct < `MIN_ATTESTERS`).
- A validator **cannot rotate Wallet-B to forge a 2nd attester**: the AUTHORITATIVE on-chain
  `slash_for_canary_divergence` (canary_audit.move:226-237) resolves each pubkey → `blake2b256(0x00‖pk)` →
  `lookup_session_wallet` → ONE miner_id → `VecSet<ID>` dedup → ABORT `E_INSUFFICIENT_DISTINCT_ATTESTERS`. The
  off-chain `distinctAttesterCount` pre-check is documented **ADVISORY** (proof.ts:272); on-chain is authoritative.
- The independence gate's incentive-not-cryptographic limit (2 COLLUDING validators can co-sign, **W-E4**) is
  DISCLOSED, not hidden.

## Cross-cutting invariants (git-verified by the gate)

INV-A: `proof.ts` lines 1-261 byte-IDENTICAL parent↔HEAD (sole hunk `@@ -259,3 +259,94 @@` = additive);
`MIN_ATTESTERS=2` / `canonicalProofMessage` / `buildDivergenceProof` unchanged; `canary_audit.move` byte-frozen
(contracts HEAD == `970d656`); 145-byte golden vectors GREEN. INV-B: `git diff c779b3e~1 c779b3e -- apps/relay`
= EMPTY (the live carrier is a cp-daemon edit, M4b). INV-C: held as above. **Novelty FROZEN 0.74** (a
composition of Tendermint evidence-submission + Sarmenta spot-check + PBFT canonical-witness; no increment).

## Documented partials (none blocking)

- **W-M3-SIM narrowed-not-closed** — the independence gate + ≥2-distinct quorum are exercised only over
  SYNTHETIC capture in-process; real cross-validator media capture is M4b.
- **Live transport / cross-validator capture / live ≥2 quorum presence DEFERRED to M4b** — the `ClaimBoard` is
  an injected in-memory fake; the two-validator quorum is modelled by TWO in-process loops over a shared board.
  The live OFF-MEDIA-PATH cp-daemon `/canary/claims` carrier + the protocol-bond submitter are M4b.
- **W-E4** (independence is INCENTIVE-based, not cryptographic) — reaffirmed, irreducible. **W-E9** (bond-owner-
  signs live-slash) — unchanged, M4b.
- **3 new W5-residual deltas disclosed** — W-M4-COSIGN-SEAM (net-new additive sibling), W-M4-COSIGN-CARRIER-TRUST
  (D-CFA-47 carrier host-independence = W5 precondition), W-M4-COSIGN-IP-CORRELATION (shared-host A↔B side-channel).
- **5 pre-existing tsc errors** (baseline-identical, all cross-repo / OUTSIDE the cosign slice: 2× dvconf-client
  `../log` import-extension, wan-harness-shape.test.ts rootDir, keying.ts, verifier.ts). **0 NEW from this slice.**
