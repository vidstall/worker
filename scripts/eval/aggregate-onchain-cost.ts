/**
 * aggregate-onchain-cost.ts — E3-A Step 5 (deterministic aggregation).
 *
 * Reads the committed raw localnet gas capture and emits the §5.3 cost tables:
 *   - per-function gas (computation / storage / rebate / nonRefundable / net) in MIST
 *   - cost-class bundles (one-time deploy, per-user, node-enrolment coverage bundle (synthetic), per-SESSION)
 *   - per-session under three honest measures:
 *       (A) computation-only        — never rebated (protocol-deterministic)
 *       (B) computation + nonRefundable storage fee — MINIMUM irreversible cost
 *       (C) net (= comp + storage - rebate) — includes refundable storage deposits
 *   - SUI (= MIST / 1e9) + USD at a PARAMETERIZED SUI price (default = manuscript
 *     design-assumption $1.50, clearly labelled), + the break-even SUI price at
 *     which a session fits the $0.01/room design target. Session costs are a
 *     single-relay (K=1), first-proof-linearized LOWER-BOUND projection, so the
 *     break-even prices derived from them are OPTIMISTIC UPPER BOUNDS on the
 *     shipped-K=2 allowable SUI price (break-even price = target / cost).
 *
 * Gas provenance (from the raw meta line): protocolVersion 113, referenceGasPrice
 * 1000, framework rev 8fc60f1, CLI 1.66.2, localnet. computationCost is already in
 * MIST (= units x RGP). RGP=1000 matches devnet/testnet reference gas price, so the
 * MIST figures are network-portable at that RGP; mainnet RGP differs (noted).
 *
 * Deterministic: fixed iteration order, integer MIST arithmetic, prints a SHA-256
 * of the canonical output block so raw->table is reproducible (Gate-1).
 *
 * Run:  npx tsx scripts/eval/aggregate-onchain-cost.ts [rawPath] [suiPriceUsd] [pushgatewayUrl]
 *
 * The optional 3rd arg (plus PUSHGATEWAY_TOKEN env var) pushes the headline
 * N=4/ADR-0006 numbers below to the observer host's Pushgateway (see
 * packages/shared/src/metrics-prom.ts's pushToGateway()) for the
 * "Blockchain & Consensus" row of the xaisen-academic-eval Grafana
 * dashboard -- this is a live-dashboard convenience, additive to (never a
 * replacement for) the deterministic Markdown table above, which stays the
 * canonical evidence artifact.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pushToGateway } from '@dvconf/shared';

const RAW = process.argv[2] ??
  'C:/Thesis/dvconf/docs/80-research/evaluation/raw/cost-onchain-localnet-2026-07-13.jsonl';
const SUI_USD = Number(process.argv[3] ?? '1.50'); // manuscript design-assumption; NOT a pinned market quote
const PUSHGATEWAY_URL = process.argv[4];
const TARGET_USD = 0.01;                            // proposal design target per room
const MIST_PER_SUI = 1_000_000_000n;

type Gas = { computationCost: string; storageCost: string; storageRebate: string; nonRefundableStorageFee: string };
type Row = { fn: string; module: string; gasUsed: Gas };

const lines = readFileSync(RAW, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
const meta = JSON.parse(lines[0]);
const rows: Row[] = lines.slice(1).map((l) => JSON.parse(l));
// keep FIRST occurrence per fn (the measured happy-path row); later dup fns are coverage-fillers.
// byFn keys on fn alone for cost-class g() lookups; byFnMod keys on fn|module so the display
// table shows all three same-named `heartbeat` rows (cp/signaling/validator registries).
const byFn = new Map<string, Row>();
const byFnMod = new Map<string, Row>();
for (const r of rows) {
  if (!byFn.has(r.fn)) byFn.set(r.fn, r);
  const k = `${r.fn}|${r.module}`;
  if (!byFnMod.has(k)) byFnMod.set(k, r);
}

const comp = (g: Gas) => BigInt(g.computationCost);
const stor = (g: Gas) => BigInt(g.storageCost);
const reb = (g: Gas) => BigInt(g.storageRebate);
const nonR = (g: Gas) => BigInt(g.nonRefundableStorageFee);
const net = (g: Gas) => comp(g) + stor(g) - reb(g);
const g = (fn: string) => {
  const r = byFn.get(fn);
  if (!r) throw new Error(`missing measured fn: ${fn}`);
  return r.gasUsed;
};

const mistToSui = (m: bigint) => Number(m) / 1e9;
const usd = (m: bigint, price = SUI_USD) => mistToSui(m) * price;
const fmtMist = (m: bigint) => m.toString().padStart(12);

const out: string[] = [];
const p = (s = '') => out.push(s);

p(`# On-chain cost aggregation (E3-A)`);
p(`raw: ${RAW.replace(/\\/g, '/')}`);
p(`provenance: protocolVersion=${meta.protocolVersion} RGP=${meta.referenceGasPrice} rev=${meta.frameworkRev} cli=${meta.cliVersion} net=${meta.network}`);
p(`SUI/USD (design-assumption, NOT a market pin): $${SUI_USD.toFixed(2)}   target: $${TARGET_USD}/room`);
p('');

// ---- per-function table ----
p(`## Per-function gas (MIST)`);
p(`| fn | module | computation | storage | rebate | nonRefundable | net |`);
p(`|---|---|--:|--:|--:|--:|--:|`);
for (const r of byFnMod.values()) {
  const x = r.gasUsed;
  p(`| ${r.fn} | ${r.module} | ${fmtMist(comp(x))} | ${fmtMist(stor(x))} | ${fmtMist(reb(x))} | ${fmtMist(nonR(x))} | ${fmtMist(net(x))} |`);
}
p('');

// ---- cost classes ----
const ONE_TIME_DEPLOY = ['publish'];
const PER_USER = ['register_user'];
// Synthetic coverage bundle spanning BOTH enrolment paths; production role selection is one XOR
// branch (relay | signaling | validator, role-voter.ts), so no single node pays all six.
const ENROL_COVERAGE_BUNDLE = ['register', 'cast_role_vote', 'apply_voted_role', 'register_relay', 'register_validator', 'self_assign_session_wallet'];
// per-SESSION core (per §5.3.1: room creation, pairing assignment, N session proofs, distribution)
const SESSION_FIXED = ['create_room', 'create_escrow', 'submit_pairing_proposal', 'close_room', 'distribute_rewards'];
const SESSION_PER_VALIDATOR = ['submit_session_proof'];

const sumComp = (fns: string[]) => fns.reduce((a, f) => a + comp(g(f)), 0n);
const sumCompNonR = (fns: string[]) => fns.reduce((a, f) => a + comp(g(f)) + nonR(g(f)), 0n);
const sumNet = (fns: string[]) => fns.reduce((a, f) => a + net(g(f)), 0n);

const classLine = (name: string, fns: string[]) => {
  const c = sumComp(fns), cn = sumCompNonR(fns), n = sumNet(fns);
  p(`| ${name} | ${fns.length} tx | ${fmtMist(c)} | ${fmtMist(cn)} | ${fmtMist(n)} | ${usd(cn).toFixed(5)} / ${usd(n).toFixed(5)} |`);
};
p(`## Cost classes (MIST; USD@$${SUI_USD.toFixed(2)} = compNonR / net)`);
p(`| class | txs | computation | comp+nonRefundable | net | USD compNonR/net |`);
p(`|---|---|--:|--:|--:|--:|`);
classLine('one-time DEPLOY (publish)', ONE_TIME_DEPLOY);
classLine('per-USER register (one-time)', PER_USER);
classLine('node-enrolment coverage bundle (synthetic; not a realizable per-node cost — role selection is relay XOR validator)', ENROL_COVERAGE_BUNDLE);
p('');

// ---- per-session under three measures x N validators ----
p(`## Per-SESSION cost x config (N validators) x SUI price — the sensitivity envelope`);
p(`core = ${SESSION_FIXED.join(' + ')} + N x submit_session_proof. N is the dominant CONFIG lever (DEFAULT_MIN_VALIDATORS_PER_ROOM; BFT-safe min = 3 per QUORUM_THRESHOLD).`);
p(`K note: the cost columns below are a single-relay (K=1), first-proof-linearized LOWER-BOUND projection; the break-even columns are correspondingly OPTIMISTIC UPPER BOUNDS on the shipped-K=2 allowable SUI price (break-even price = target ÷ cost, so a lower-bound cost yields an upper-bound price). The shipped path submits one proof per validator per assigned relay (default K=2, DEFAULT_MIN_RELAYS_PER_ROOM), so the total proof count grows with K×N and the exact shipped-K=2 break-even and full-session delta remain unmeasured; the harness logs one submit_session_proof and this aggregator linearizes it ×N with no K/per-relay factor.`);
p(`| N | (B) irreversible MIST | (B) SUI | (B) USD@$${SUI_USD.toFixed(2)} | (C) net USD@$${SUI_USD.toFixed(2)} | break-even SUI for $0.01 (B) | (C) | note |`);
p(`|--:|--:|--:|--:|--:|--:|--:|---|`);
for (const N of [2, 3, 4, 5]) {
  const fns = [...SESSION_FIXED, ...Array(N).fill(SESSION_PER_VALIDATOR[0])];
  const B = sumCompNonR(fns), C = sumNet(fns);
  const beB = TARGET_USD / mistToSui(B), beC = TARGET_USD / mistToSui(C);
  const note = N === 2 ? 'below BFT quorum' : N === 3 ? 'BFT min' : N === 4 ? 'ADR-0006' : 'ratio-cap';
  p(`| ${N} | ${fmtMist(B)} | ${mistToSui(B).toFixed(6)} | $${usd(B).toFixed(5)} | $${usd(C).toFixed(5)} | $${beB.toFixed(4)} | $${beC.toFixed(4)} | ${note} |`);
}
p(`(BLS aggregate signatures — Sui BLS12-381 native, §5.3.6 future work — would collapse N proofs to 1, removing the N-scaling entirely.)`);
p('');

// ---- $0.01 verdict + break-even ----
const N_DECISION = 4; // ADR-0006
const coreN4 = [...SESSION_FIXED, ...Array(N_DECISION).fill('submit_session_proof')];
const B4 = sumCompNonR(coreN4), C4 = sumNet(coreN4);
const breakevenB = TARGET_USD / mistToSui(B4);
const breakevenC = TARGET_USD / mistToSui(C4);
p(`## $0.01 verdict (N=4, ADR-0006 decision)`);
p(`- irreversible (comp+nonRefundable) = ${B4} MIST = ${mistToSui(B4).toFixed(6)} SUI = $${usd(B4).toFixed(5)} @ $${SUI_USD.toFixed(2)}/SUI`);
p(`- net (incl. refundable storage deposits) = ${C4} MIST = ${mistToSui(C4).toFixed(6)} SUI = $${usd(C4).toFixed(5)} @ $${SUI_USD.toFixed(2)}/SUI`);
p(`- fits $0.01 target @ $${SUI_USD.toFixed(2)}/SUI:  irreversible=${usd(B4) <= TARGET_USD ? 'YES' : 'NO'}  net=${usd(C4) <= TARGET_USD ? 'YES' : 'NO'}`);
p(`- BREAK-EVEN SUI price for $0.01/room:  irreversible <= $${breakevenB.toFixed(4)}/SUI ; net <= $${breakevenC.toFixed(4)}/SUI`);
p(`- K/bound direction: the cost figures above are a single-relay (K=1), first-proof-linearized LOWER-BOUND projection; the break-even prices are correspondingly OPTIMISTIC UPPER BOUNDS on the shipped-K=2 allowable SUI price (break-even price = target ÷ cost). The shipped path submits one proof per validator per assigned relay (default K=2), so the exact shipped-K=2 break-even and full-session delta remain unmeasured.`);
p('');

const canonical = out.join('\n');
const sha = createHash('sha256').update(canonical, 'utf8').digest('hex');
console.log(canonical);
console.log(`\nOUTPUT-SHA256: ${sha}`);

if (PUSHGATEWAY_URL) {
  await pushToGateway({
    baseUrl: PUSHGATEWAY_URL,
    job: 'xaisen_onchain_cost',
    instance: sha.slice(0, 16),
    token: process.env['PUSHGATEWAY_TOKEN'],
    metrics: [
      { name: 'dvconf_onchain_cost_irreversible_usd', help: 'N=4 (ADR-0006) irreversible (comp+nonRefundable) session cost in USD', value: usd(B4) },
      { name: 'dvconf_onchain_cost_net_usd', help: 'N=4 (ADR-0006) net session cost in USD', value: usd(C4) },
      { name: 'dvconf_onchain_breakeven_sui_price_irreversible', help: 'Break-even SUI/USD price for the $0.01/room target, irreversible cost basis', value: breakevenB },
      { name: 'dvconf_onchain_breakeven_sui_price_net', help: 'Break-even SUI/USD price for the $0.01/room target, net cost basis', value: breakevenC },
    ],
  });
  console.log(`\npushed headline N=4 cost metrics to ${PUSHGATEWAY_URL}`);
}
