# Canary Forwarding-Audit Wave (the "validate-node" Wave, D-M2-20) — M1 SHIP GATE

> Independent multi-auditor read-only SHIP gate (M1/M2 precedent). Date: 2026-06-19.
> Verdict: **GATE_PASS (with documented partials)** — 0 blockers / 0 material overclaims.

## What this milestone claims (scope-precise)

A **content-blind E2EE SFU relay is proven (hermetically) to forward media BIT-EXACT — without any
auditor reading content** — and a **tampering relay is isolated-slashed on localnet** via covert
Wallet-B validators that inject indistinguishable canary streams and verify them byte-for-byte at the
receiver (≥2 **distinct `validator_miner_id`** quorum). **Novelty = PARTIAL (0.74)** — defensible ONLY
as the four-way combination on a real-time content-blind E2EE SFU; the sub-primitives (ShortMAC /
mixnet canaries / Livepeer slash / Proof-of-Backhaul quorum) are CONCEDED prior art (LANE-E-PRIOR-ART).
Target = **hermetic mechanism-floor + viva demo (NOT WAN, NOT full Byzantine)** per D-CFA-1.

## HEADs at gate time (verified live, `git log -1`)

| repo | branch | HEAD | scope |
|---|---|---|---|
| dvconf-contracts | main | `970d656` | Move slash entry (Phase 3.1) |
| dvconf-daemons | quangdm_main | `ff0d3b0` | keying/verifier/publisher/proof/cell/E2E/isolation (Phases 0.1–7.1) |
| dvconf-client | master | `e51f255` | CanaryAuditPanel viz (Phase 6.1) |
| root | master | (this commit) | SOT propagation |

## Method

A Workflow of **10 independent READ-ONLY agents** (`wf_f020f176-537`): 7 REQ-slice auditors
(A keying · B verifier+publisher · C proof · D Move entry · E localnet E2E · F cell coverage · G
viz+isolation+content-blind) + 3 adversarial lenses (honesty / scope+invariants / completeness). Each
re-verified its claims against **SHIPPED SOURCE (file:symbol:line)** and the **committed RED/GREEN
evidence logs** — **STATIC ONLY** (no test execution; localnet/mediasoup are port-bound). Per the Wave
discipline ("Main re-runs the suite/bench itself — never trust a subagent's pass count"), **MAIN ran
the hermetic, non-port-bound suites + the Move suite itself** (guard #9, log
`canary-audit-m1-guard9-2026-06-19.log`); the port-bound trio + the localnet E2E are cited from fresh
committed evidence.

**Rollup: 7/7 auditors PASS · 3/3 lenses PASS · totalBlockers = 0 · anyFail = false.**

## REQ-CFA traceability (all MET vs shipped source)

| REQ | Verdict | Backing (file:symbol — commit) |
|---|---|---|
| REQ-CFA-001 canary keying + nonce-restart | MET | `canary/keying.ts` deriveCanaryKey/DurableKidStore (PathC salt-mix delegation; real `writeFileSync`/`load` restart-durable kid) — `a4804ea`; RED/GREEN logs |
| REQ-CFA-002 covert publisher | MET | `canary/publisher.ts` CanaryPublisher.produce/publish (no-password join, reuses verifier recompute) — `7575bbf` |
| REQ-CFA-003 receiver-equality (local ctr + AAD) | MET | `canary/verifier.ts` verifyForwardedCanary (local expected-ctr drive, reproduces clearPrefix‖14B-trailer AAD; tamper + drop teeth) — `743c23f`; tamper/drop logs |
| REQ-CFA-004 cell coverage / rotation | MET | `canary/cell.ts` assignCells/dedupByMinerId (≥2 distinct miner_id floor; deterministic SHA-256 score; Wallet-B Sybil → covered=false) + `index.ts` +56 additive — `977651b` |
| REQ-CFA-005 Wallet-B-only proof | MET | `canary/proof.ts` buildDivergenceProof (≥2 session sigs only, NO Wallet-A; frozen 145-byte canonical msg round-trip) — `05c1bc9` |
| REQ-CFA-006 Move slash entry | MET | `sources/audit/canary_audit.move` slash_for_canary_divergence (&NetworkRegistry+!is_paused; NEW ≥2 Wallet-B verifier; VecSet distinct miner_id via package-gated lookup_session_wallet; staking::slash sets own amount; CanaryDivergenceSlashed; errors 680–688) — `970d656` |
| REQ-CFA-007 single-relay attribution | MET | `canary-slash-e2e.integration.test.ts` N×M (tamper R₂ ⇒ only R₂ slashed; R₁ untouched; wrong-bond aborts E_WRONG_STAKE 687) — `121d4bd` |
| REQ-CFA-008 no false-positive | MET | honest run (expected==observed) ⇒ entry aborts E_NO_DIVERGENCE 686, bond unchanged — `121d4bd` |
| REQ-CFA-009 hermetic harness (TWO files) | MET | (1) `canary-forward.integration.test.ts` real mediasoup + P10_FORCE_TAMPER RED hook; (2) SEPARATE `canary-slash-e2e.integration.test.ts` localnet slash — `743c23f` / `121d4bd` |
| REQ-CFA-010 non-regression + isolation | MET | `vitest.canary.config.ts` (forks/singleFork/no-parallelism) + canary-* exclude on `vitest.relay-integration.config.ts` + `canary-isolation.config.test.ts` (13 hermetic asserts) — `ff0d3b0` |
| REQ-CFA-011 CanaryAuditPanel viz | MET | client `canaryAudit.ts` deriveCanaryAuditView (pure; coverage by distinct miner_id) + `CanaryAuditPanel.tsx` (PanelShell; hook untouched) + RoomPage additive room-gated mount — `e51f255` |
| REQ-CFA-012 content-blind preserved (INV-B) | MET | full-Wave `apps/relay/` non-test range diff = EMPTY across all 7 daemons commits; `room-handler.ts:createConsumer` untouched (last by `32ad32b`) — verified per-commit |

**Invariants:** INV-A (forwarding-integrity, tamper+drop teeth) HELD · INV-B (content-blind, relay
production forward path provably untouched) HELD · INV-C (no mid-session Wallet-A↔B link; Wallet-B-only
proof + package-gated miner_id resolution) HELD. **D-CFA-8** (protocol-controlled bond — hermetic
stand-in) HELD as approach (b), see partial P2 · **D-CFA-9** (≥2 distinct miner_id, anti-Sybil) HELD ·
**D-CFA-10** (cellSecret PathC salt-mix) HELD.

## MAIN guard #9 (live, this session)

- `sui move test` full suite **361/361** (REQ-CFA-006 + negatives + non-regression). NOTE: a transient
  env condition (a dangling ephemeral active-env from this Wave's own Phase-4.1 localnet fixture + a
  concurrent session's live localnet whose chain id mismatches `Move.toml`'s declared `local`) blocked
  the first attempt; the clean 361/361 was obtained with an isolated throwaway `SUI_CONFIG_DIR` (no
  active env → env resolution skipped). Source is byte-identical to the committed green (no commits to
  `sources/`/`tests/`/`Move.toml` since `970d656`) → infrastructure, not a code regression.
- validator-daemon canary unit (keying/publisher/proof/cell) **32/32** · relay isolation guard
  **13/13** · client CanaryAuditPanel **13/13**.
- Cited fresh from Phase 7.1 (`ff0d3b0`, port-bound — not re-run to avoid colliding with the concurrent
  live localnet): M1 bandwidth ratio **5.81×** (≥3.0) · M2 relay-blind byteIdentical **59 == 59**
  mediaPackets, 0 tampered · MTTR N=30 P95 **65.0** / P99 **67.0** (≤100/≤200) · canary-forward 2/2.
  canary-slash-e2e localnet committed green (Phase 4.1 `121d4bd`): bond 300M→270M, attribution R₂-only,
  honest-run no slash. Detail → `canary-audit-m1-guard9-2026-06-19.log`.

## Documented partials (on record — DA-3; none blocking)

- **P1 — REQ-CFA-011 coverage-viz has no shipped on-chain event source.** `canaryAudit.ts` derives
  per-relay coverage from a `CanaryCellAssigned` event, but `canary_audit.move` emits **only**
  `CanaryDivergenceSlashed`. The **divergence→slash half is fully sourced**; the **coverage half is
  demo/mock-fed** in any real deployment (the panel honestly renders the empty state and discloses
  "registered not live" — NOT an overclaim). Future: emit a cell-assigned event (cell assignment is
  off-chain in `cell.ts:assignCells`).
- **P2 — D-CFA-8 as-built = approach (b) owned-bond, not shared-stake.** `share_for_testing`/
  `create_for_testing` are `#[test_only]` (stripped from the deployed package), so the localnet E2E
  registers R_k, which OWNS its bond and signs its OWN slash tx (the only way to pass an owned `&mut`).
  This proves the **entry mechanism** (≥2 distinct Wallet-B quorum unforgeable; slash/event/attribution
  execute), **NOT** a production protocol-bond = **W-E9**. Disclosed in 4 daemons-side artifacts; the
  contracts commit `970d656` prose retains the original "SHARED StakePosition" framing (reconciled by a
  DESIGN D-CFA-8 addendum this gate). `staking.move` was NOT modified by `970d656`.
- **P3 — TDD REDs are module-absent / compile-level** (test authored first, impl absent), not
  assertion-level REDs. The genuine assertion teeth are in the GREEN runs + the tamper/drop logs +
  golden-vector. Honest test-first; noted for form.
- **P4 — Move negative `#[expected_failure]` coverage = 4 of 9 error codes** (680/684/685/686 dedicated;
  681/682/683/687/688 positively exercised by happy-path + golden vector). The 681/682/683 gap is
  disclosed in the commit message. Optional Phase-8 hardening.
- **P5 — pre-existing docstring drift:** `vitest.relay-integration.config.ts` references a
  `pnpm test:integration:relay` script that does not exist — predates this Wave. Cosmetic.
- **P6 — REQ-CFA-004 live multi-validator discovery deferred (Task 5.2+).** `index.ts:getValidators`
  seeds the pool with only this daemon's own miner_id, so a single live daemon never reaches the
  ≥2-distinct floor on its own; the ≥2 co-homing is exercised in the localnet E2E (two real validators)
  + unit-tested (32 tests). Consistent with the mechanism-floor scope (D-CFA-1 / OQ-CFA-1). Disclosed inline.

## Weaknesses on record (W-E1..W-E9 — carried from DESIGN §7)

W-E1 novelty partial 0.74 (combination-only) · W-E2 hermetic-not-WAN + benign-loss drop=seq-gap
false-positive surface · W-E3 observedHash not on-chain-verifiable (quorum-trust, not crypto proof) ·
W-E4 quorum collusion / no full Byzantine bound · W-E5 attribution scoped to a relay's local fan-out ·
W-E6 metadata fingerprint + covert-join leaks · W-E7 no VRF probe-selection · W-E8 validators not
slashed (only relays) · **W-E9 production needs a protocol-controlled bond** (the hermetic E2E slashes
an owned bond via approach (b); = partial P2). All honestly disclosed; none misrepresented as solved.

## Verdict

**GATE_PASS (with documented partials).** All 12 REQ-CFA + INV-A/B/C + D-CFA-8/9/10 verified MET vs
shipped source by 7 independent auditors; honesty/scope/completeness lenses all PASS with 0 blockers and
0 material overclaims; MAIN guard-#9 re-runs all green (Move 361/361 + hermetic 32+13+13; port-bound
trio cited fresh). The 6 partials are scoped/disclosed limits with named futures, consistent with the
hermetic mechanism-floor target and the 0.74 partial-novelty framing. **M1 SHIPPED.**
