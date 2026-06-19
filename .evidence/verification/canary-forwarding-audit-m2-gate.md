# Canary Forwarding-Audit Wave (the "validate-node" Wave, D-M2-20) — M2 SHIP GATE

> Independent multi-auditor read-only SHIP gate (M1/M2 precedent). Date: 2026-06-20.
> Verdict: **GATE_PASS (with documented partials)** — 0 blockers / 0 material overclaims.

## What this milestone claims (scope-precise)

M2 makes the M1-shipped audit mechanism **observable and live** and **closes the covertness hole the M2
design review found** — without touching the relay forward path, the on-chain surface, or (beyond an
additive secret salt) the cell-assignment math. Three additive chunks:
1. **Off-chain coverage feed** (closes M1 gate **P1**): a NEW validator-only `GET /canary/coverage`
   (loopback-bound, restricted CORS) serializes the existing cell-loop snapshot; a NEW client
   `useCanaryCoverage` hook feeds the `CanaryAuditPanel` coverage half. Divergence→slash stays
   chain-sourced from the `canary_audit` module.
2. **Live multi-validator discovery** (closes M1 gate **P6**): read-only `devInspect` of the existing
   `validator_registry::get_active_validators`, unioned with the local self-entry, so ≥2-distinct cells
   form live (not only in the localnet E2E).
3. **Salted cell assignment** (closes new **W-M2-10**): a validator-held `assignmentSecret` folded into
   the `assignCells` score so a relay **cannot predict its own coverage** from public inputs.

Coverage feed is an honest daemon **SELF-REPORT** (W-M2-1); the divergence→slash record stays the only
chain-authoritative half. **No Move change** (361/361 by byte-identity). **No new novelty** over the M1
0.74 partial-novelty framing.

## HEADs at gate time (verified live, `git log -1`)

| repo | branch | HEAD | scope |
|---|---|---|---|
| dvconf-daemons | quangdm_main | `7ece10f` | salt + discovery + coverage feed (REQ-CFA-013/014/015/019/020/022) |
| dvconf-client | master | `3274245` | client coverage subscription (REQ-CFA-016/017/018) |
| dvconf-contracts | main | `970d656` | UNCHANGED — M2 adds no Move |
| root | master | (this commit) | SOT propagation |

## Method

A Workflow of **8 independent READ-ONLY auditors** (`wf_b2fe6659-2bc`): 5 REQ-slice auditors (A salt · B
discovery · C coverage-feed daemon · D client · E cross-cutting invariants) + 3 adversarial lenses
(honesty / scope+boundaries / completeness). Each re-verified its claims against the **COMMITTED SHIPPED
SOURCE** (file:symbol:line + commit) — **STATIC ONLY** (no test execution; localnet/mediasoup/ports are
held by a concurrent session). Per the Wave discipline ("Main re-runs the suite itself — never trust a
subagent's pass count"), **MAIN ran the hermetic unit suites + tsc itself** (guard #9, log
`canary-audit-m2-guard9-2026-06-20.log`).

**Rollup: 8/8 auditors PASS or PASS_WITH_PARTIALS · 0 FAIL · totalBlockers = 0 · 0 material overclaims.**

## REQ-CFA traceability (M2 — all MET vs shipped source)

| REQ | Verdict | Backing (file:symbol — commit `7ece10f`/`3274245`) |
|---|---|---|
| REQ-CFA-013 coverage GET server | MET | `coverage-server.ts:startCoverageServer` clones relay/metrics-server.ts but **binds `127.0.0.1`** (`listen(port,'127.0.0.1')`) and **no `ACAO:*`** (`Access-Control-Allow-Origin: corsOrigin`); GET-only 405/404/500; `CoverageStateProvider` injection; healthz.ts untouched; port 8102 |
| REQ-CFA-014 buildCoveragePayload | MET | `coverage-server.ts:buildCoveragePayload` PURE; dedup by minerId (Set); **drops** sessionWallet/publish/consume; `reporterMinerId` = Wallet-A; null/empty → `{round:-1,relays:[]}`; tests assert no-sessionWallet substring + **`reporterMinerId !== sessionAddress`** (value-level) |
| REQ-CFA-015 wiring | MET | `index.ts` main() starts server in the cell-loop crash-safe try (port 8102, provider `()=>state.canaryCellLoop?.latest()??null`, `reporterMinerId=validatorMinerId`); closed in BOTH stopDaemon + the LAST graceful group next to healthz; `.env.example` documents the port |
| REQ-CFA-016 useCanaryCoverage | MET | client `useCanaryCoverage.ts` (clone of useDaemonHealthz: AbortController+timeout+mounted-guard+cleanup) + exported `fetchCanaryCoverage` + `adaptCoveragePayload` (camel/snake; **validatorMinerIds→CoverageRow.validators**); degrades to `{coverage:[],isLive:false}`; reuses MIN_CELL_COVERAGE; adapter fixture asserts non-empty validators[] |
| REQ-CFA-017 derive refactor + panel narrow | MET | `canaryAudit.ts:deriveCanaryAuditView(coverage,divergenceEvents,roomId)` PURE; **drops the never-emitted CanaryCellAssigned pass** (closes P1), keeps CanaryDivergenceSlashed verbatim; `CanaryAuditPanel.tsx` narrows `useChainEvents` to **`['canary_audit']`** (KEEP — divergence lives there; DROP economic_layer) + isLive caption; **regression-guard test** asserts a canary_audit CanaryDivergenceSlashed still renders |
| REQ-CFA-018 config key | MET | `config.ts:VITE_VALIDATOR_CANARY_COVERAGE_URL` (default 8102) distinct from VALIDATOR_HEALTHZ_URL (8101); hook reads it |
| REQ-CFA-019 discovery reader | MET | `validator-discovery.ts` read-only `devInspect` (sender ZERO) of `validator_registry::get_active_validators`; `ValidatorInfoSchema` **verbatim** vs cp-daemon sui-chain-state-reader.ts:56-64 + Move struct validator_registry.move:27-35; miner_id projection only (INV-C); hermetic BCS round-trip test (ID-typed 32-byte) + empty/error→`[]` |
| REQ-CFA-020 getValidators union | MET | `index.ts:getValidators` UNIONs discovered miner_ids (`{minerId,sessionWallet:''}`) with the self-entry via Map; crash-safe (devInspect failure → self-only, warn); refresh on the existing CANARY_CELL_INTERVAL_MS cadence (no new timer) |
| REQ-CFA-021 invariant preservation | MET | INV-B empty `apps/relay/` diff (per-commit `7ece10f~1..7ece10f` = 0); INV-C no Move change + getter returns no session wallet + payload distinct minerId + reporterMinerId Wallet-A + assignmentSecret never on wire; D-CFA-2 salt (predict) + loopback feed (read) + no on-chain coverage event |
| REQ-CFA-022 salted assignment | MET | `cell.ts:score` folds `assignmentSecret` raw bytes after `round\x1f relayId\x1f minerId\x1f` (M1 baseline `977651b` confirmed public-only — genuine change); three guards reject empty secret (deriveAssignmentSecret / assignCells / index env); `cell-salt.test.ts` NON-TRIVIAL (pool 6 > floor 2; secret1≠secret2 covered sets); domain-separated from K_canary; secret never in snapshot/log/wire |

**Invariants:** INV-A (forwarding-integrity) UNCHANGED from M1 (M2 adds no detection logic) · INV-B
(content-blind, relay forward path provably untouched — per-commit empty `apps/relay/` diff) HELD · INV-C
(no mid-session Wallet-A↔B link; assignmentSecret + sessionWallet never on the wire; reporterMinerId =
Wallet-A) HELD · **D-CFA-2 (covertness)** now a real bound: salt blocks **prediction**, loopback feed
blocks **read** · **D-CFA-19** (salted assignment) HELD · **D-CFA-11..18** HELD.

## MAIN guard #9 (live, this session)

- dvconf-daemons canary unit + wiring non-regression: **69 passed / 9 files / 0 failed** (canary 50 =
  M1 baseline 32 [cell 9 / proof 12 / keying 6 / publisher 5] + new cell-salt 5 / validator-discovery 7 /
  coverage-server 6; + index.test 12 + graceful-shutdown-wiring 7 non-regression).
- dvconf-client: **25 passed / 2 files** (CanaryAuditPanel 16 + useCanaryCoverage 9); `tsc --noEmit` exit 0.
- INV-B: `git -C dvconf-daemons diff --name-only 7ece10f~1 7ece10f -- apps/relay/` = **EMPTY**.
- Move: contracts unchanged (`970d656`); no `sources/`/`tests/` edits → **361/361 by byte-identity**
  (carried from the M1 gate; not re-run, env-fragile + no canary-Move change this milestone).
- `console.*` in new prod: NONE (sole grep hits are comments documenting the createLogger rule).
- Detail → `canary-audit-m2-guard9-2026-06-20.log`.

## Documented partials (on record — DA-3; none blocking)

- **P-M2-1 — index.ts wiring has no dedicated unit test.** The new wiring (coverage-server start,
  `getValidators` UNION, `reporterMinerId`, discovery refresh, shutdown close, fail-safe) is exercised
  indirectly; the new *logic* is unit-tested at the module level (coverage-server / validator-discovery /
  cell-salt). The commit's "wiring index 12 + graceful-shutdown 7" are **pre-existing, canary-agnostic
  non-regression suites** that assert no M2 wiring symbol — accurate as a non-regression count, NOT M2
  wiring coverage. A live wiring proof needs a localnet boot = the deferred live demo.
- **P-M2-2 — W-M2-1 coverage = daemon SELF-REPORT.** The feed proves the auditor's *claimed* coverage,
  not a chain-verified fact (a validator could over-report). Honestly labeled in source (panel caption +
  `coverage-server.ts` header) and on record. The punishing half (divergence→slash) stays chain-authoritative.
- **P-M2-3 — W-M2-10 residual.** Post-salt covertness now trusts `assignmentSecret` staying within the
  validator quorum; a colluding/leaking validator re-enables prediction = the pre-existing **W-E4**.
- **P-M2-4 — assignmentSecret transport.** DESIGN D-CFA-19 prose says "covert Wallet-B channel"; the
  **as-built** transport is a shared `CANARY_CELL_SECRET` env seed, **domain-separated** from K_canary via
  `deriveAssignmentSecret` (SHA-256 with a distinct domain label). Disclosed in the commit + `.env.example`
  + reconciled by a DESIGN D-CFA-19 as-built addendum this gate. Same trust model; the production OOB
  network channel is future work (publisher/verifier secret distribution = Task 5.2+).
- **P-M2-5 — W-M2-3 / D-CFA-16 registry-wide, not room-scoped.** Discovery returns the registry-wide
  active set; `useCanaryCoverage(roomId)` accepts `roomId` as a documented no-op. Room-scoping → M3 (W-E2).
- **P-M2-6 — fail-safe-off.** If `CANARY_CELL_SECRET` is unset/empty the cell loop AND the coverage server
  do NOT start (throws caught by the crash-safe try) — refusing an unsalted, relay-recomputable assignment
  over a silent weak fallback. By design; the FE renders the honest empty/Polling state; a live coverage
  demo REQUIRES setting the secret (`.env.example` ships it blank by design).
- **P-M2-7 — TDD REDs are module-absent / compile-level** (REQ-CFA-013/019 RED = "Cannot find module …");
  the genuine behavioral RED is REQ-CFA-022 (salt) + the FE panel RED. Per-REQ logs for 014/015/020 are
  bundled in the fullsuite green; client 017/018 RED/GREEN are byte-copies of 016 (one joint run, disclosed).
  Carries the M1 partial-P3 form.
- **P-M2-8 — pre-existing daemons tsc debt** (4 errors in keying.ts/verifier.ts cross-repo rootDir import
  from M1 `a4804ea`) — NOT M2 (no M2 file errors); vitest/esbuild is the M1-shipped validation path. Track in GAPS.
- **P-M2-9 — D-CFA-18 loopback + restricted CORS verified by static source only** (no booted server);
  `CANARY_COVERAGE_CORS_ORIGIN` is operator-overridable but never defaults to `*`.

## Carried M1 weaknesses (W-E1..W-E9)

All carried unchanged from the M1 gate (novelty 0.74 combination-only; observedHash not on-chain-verifiable;
quorum collusion; local-fan-out attribution; metadata/covert-join leaks; no VRF; validators not slashed;
production protocol-bond). M2 neither closes nor worsens them; **W-E2** (WAN/real-camera + benign-loss
tolerance) is explicitly DEFERRED to M3 (D-CFA-17).

## Verdict

**GATE_PASS (with documented partials).** All 10 M2 REQ-CFA (013..022) + INV-A/B/C + D-CFA-11..19 verified
MET vs committed shipped source by 5 independent slice auditors; honesty/scope/completeness lenses all PASS
with 0 blockers and 0 material overclaims; MAIN guard-#9 re-runs all green (daemons 69/69 + client 25/25 +
tsc 0; INV-B empty relay diff; Move byte-identity). The 9 partials are scoped/disclosed limits consistent
with the hermetic mechanism-floor target and the 0.74 partial-novelty framing. **M2 SHIPPED.**
