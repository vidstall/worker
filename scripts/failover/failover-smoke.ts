/**
 * Offline failover-detector smoke — feeds 5 synthetic scenarios into the
 * detector state machine and emits a JSON summary on stdout. No chain, no
 * mediasoup, no devnet dependency — purely validates the analyzer half of
 * the failover surface added by Task #30 (scope-B).
 *
 * Run: `pnpm failover:smoke`
 */

import {
  createRoomState,
  step,
  TRIGGER_CHAIN_SLASH,
  TRIGGER_HEARTBEAT_MISS,
  TRIGGER_DEGRADED,
  type DetectorDecision,
  type DetectorInput,
} from '../../apps/cp-daemon/src/failover-detector.js';

interface ScenarioResult {
  decisions: number;
  triggered: boolean;
  trigger: number | null;
  replace_standby_needed: boolean;
  cascading: boolean;
  final_phase: string;
  T_trigger_to_decision_ms: number | null;
}

function runScenario(
  name: string,
  primary: string,
  standby: string | null,
  inputs: DetectorInput[],
): ScenarioResult {
  const state = createRoomState('0xROOM1', primary, standby);
  const decisions: DetectorDecision[] = [];
  let triggered_trigger: number | null = null;
  let replace_standby_needed = false;
  let cascading = false;
  let T_trigger_to_decision_ms: number | null = null;

  for (const input of inputs) {
    const d = step(state, input);
    if (d.old_phase !== d.new_phase || d.suggested_action !== 'observe_no_action') {
      decisions.push(d);
    }
    if (d.new_phase === 'TRIGGERED' && d.trigger !== null) {
      triggered_trigger = d.trigger;
      T_trigger_to_decision_ms = d.ts_ms;
    }
    if (d.new_phase === 'STANDBY_REPLACE_NEEDED') replace_standby_needed = true;
    if (d.new_phase === 'TRIGGERED_NO_STANDBY') {
      cascading = true;
      triggered_trigger = d.trigger;
    }
  }

  return {
    decisions: decisions.length,
    triggered: state.phase === 'TRIGGERED' || state.phase === 'TRIGGERED_NO_STANDBY',
    trigger: triggered_trigger,
    replace_standby_needed,
    cascading,
    final_phase: state.phase,
    T_trigger_to_decision_ms,
  };
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`[FAIL] ${label}\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
    process.exitCode = 1;
  }
}

const PRIMARY = '0xRELAY-PRIMARY';
const STANDBY = '0xRELAY-STANDBY';

// ── F-baseline ─────────────────────────────────────────────────────
const baseline = runScenario('F-baseline', PRIMARY, STANDBY, [
  { kind: 'relay-heartbeat', ts_ms: 1_000, relay_miner_id: PRIMARY },
  { kind: 'relay-heartbeat', ts_ms: 11_000, relay_miner_id: PRIMARY },
  { kind: 'relay-heartbeat', ts_ms: 21_000, relay_miner_id: PRIMARY },
]);
assertEqual('F-baseline decisions', baseline.decisions, 0);
assertEqual('F-baseline triggered', baseline.triggered, false);

// ── F-chain-slash ──────────────────────────────────────────────────
const chainSlash = runScenario('F-chain-slash', PRIMARY, STANDBY, [
  { kind: 'relay-heartbeat', ts_ms: 1_000, relay_miner_id: PRIMARY },
  { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: PRIMARY },
]);
assertEqual('F-chain-slash triggered', chainSlash.triggered, true);
assertEqual('F-chain-slash trigger code', chainSlash.trigger, TRIGGER_CHAIN_SLASH);

// ── F-heartbeat-miss ───────────────────────────────────────────────
const heartbeat = runScenario('F-heartbeat-miss', PRIMARY, STANDBY, [
  { kind: 'heartbeat-tick', ts_ms: 10_000 },
  { kind: 'heartbeat-tick', ts_ms: 20_000 },
  { kind: 'heartbeat-tick', ts_ms: 30_000 },
]);
assertEqual('F-heartbeat-miss triggered', heartbeat.triggered, true);
assertEqual('F-heartbeat-miss trigger code', heartbeat.trigger, TRIGGER_HEARTBEAT_MISS);

// ── F-degraded ─────────────────────────────────────────────────────
const degraded = runScenario('F-degraded', PRIMARY, STANDBY, [
  { kind: 'relay-heartbeat', ts_ms: 1_000, relay_miner_id: PRIMARY },
  { kind: 'relay-performance-degraded', ts_ms: 7_500, relay_miner_id: PRIMARY, rtt: 800, load: 95 },
]);
assertEqual('F-degraded triggered', degraded.triggered, true);
assertEqual('F-degraded trigger code', degraded.trigger, TRIGGER_DEGRADED);

// ── F-standby-replace ──────────────────────────────────────────────
const standbyReplace = runScenario('F-standby-replace', PRIMARY, STANDBY, [
  { kind: 'relay-slashed', ts_ms: 4_000, relay_miner_id: STANDBY },
]);
assertEqual('F-standby-replace replace-needed', standbyReplace.replace_standby_needed, true);
assertEqual('F-standby-replace not-triggered', standbyReplace.triggered, false);

// ── F-cascading (no standby) ───────────────────────────────────────
const cascading = runScenario('F-cascading', PRIMARY, null, [
  { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: PRIMARY },
]);
assertEqual('F-cascading cascading-flag', cascading.cascading, true);

// ── Emit JSON summary ──────────────────────────────────────────────
const summary = {
  schema: 'forensic-cli/1.0',
  harness: 'failover-smoke',
  scenarios: 6,
  scenarios_breakdown: {
    'F-baseline': baseline,
    'F-chain-slash': chainSlash,
    'F-heartbeat-miss': heartbeat,
    'F-degraded': degraded,
    'F-standby-replace': standbyReplace,
    'F-cascading': cascading,
  },
  smoke: process.exitCode === 1 ? 'fail' : 'ok',
};
console.log(JSON.stringify(summary, null, 2));
