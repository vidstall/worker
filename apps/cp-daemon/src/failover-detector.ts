/**
 * ADR-0004 relay failover detector — per-room state machine that decides whether
 * a failover PTB (`swap_relay`) or a standby-replacement PTB (`replace_standby`)
 * should be emitted in response to chain events + local heartbeat-miss timers.
 *
 * Scope-B note: this module is the analyzer half of the detector. It does NOT
 * send PTBs; it emits structured `DetectorDecision` objects that the caller
 * (CP daemon main loop or the offline smoke harness) acts on. Keeping the
 * decision logic pure makes the offline smoke + vitest tractable without a
 * live Sui devnet, and keeps the detector portable for the future #30-followup
 * mediasoup `pipeToRouter` wiring.
 *
 * Configuration constants mirror dvconf-contracts/sources/core/constants.move
 * (ADR-0006 + ADR-0004) so a single change there + here keeps Move and TS in
 * sync until shared/constants.ts is introduced.
 */

/** ADR-0006: BFT (n ≥ 3f+1) — n=4 (f=1) minimum non-trivial. */
export const MIN_VALIDATORS_PER_ROOM = 4;

/** ADR-0006: quorum = 2f+1 = 3. */
export const QUORUM_THRESHOLD = 3;

/** ADR-0004: N consecutive heartbeat misses before declaring crash (~30s at 10s cadence). */
export const HEARTBEAT_MISS_THRESHOLD = 3;

/** ADR-0004 `RelayFailoverInitiated.trigger` codes. */
export const TRIGGER_CHAIN_SLASH = 0 as const;
export const TRIGGER_HEARTBEAT_MISS = 1 as const;
export const TRIGGER_DEGRADED = 2 as const;
export type FailoverTrigger =
  | typeof TRIGGER_CHAIN_SLASH
  | typeof TRIGGER_HEARTBEAT_MISS
  | typeof TRIGGER_DEGRADED;

export type DetectorPhase =
  | 'ARMED'
  | 'TRIGGERED'
  | 'TRIGGERED_NO_STANDBY'
  | 'STANDBY_REPLACE_NEEDED';

/** Per-room state carried across event ticks. */
export interface RoomFailoverState {
  room_id: string;
  primary_relay_id: string;
  standby_relay_id: string | null;
  phase: DetectorPhase;
  heartbeat_miss_counter: number;
  last_decision_ts_ms: number | null;
  last_trigger: FailoverTrigger | null;
}

/** Input event envelope — schema-agnostic, callers normalize chain events into this. */
export type DetectorInput =
  | { kind: 'relay-slashed'; ts_ms: number; relay_miner_id: string }
  | { kind: 'relay-heartbeat'; ts_ms: number; relay_miner_id: string }
  | { kind: 'relay-performance-degraded'; ts_ms: number; relay_miner_id: string; rtt: number; load: number }
  | { kind: 'heartbeat-tick'; ts_ms: number }
  | { kind: 'standby-bound'; ts_ms: number; standby_relay_id: string }
  | { kind: 'swap-acked'; ts_ms: number };

/** Output of every input call. `decision === null` = no transition. */
export interface DetectorDecision {
  room_id: string;
  ts_ms: number;
  old_phase: DetectorPhase;
  new_phase: DetectorPhase;
  trigger: FailoverTrigger | null;
  /** Time from the trigger-causing input arriving to this decision (ms). */
  T_trigger_to_decision_ms: number;
  /** Suggested next on-chain action — caller decides whether to emit it. */
  suggested_action:
    | 'emit_swap_relay'
    | 'emit_replace_standby'
    | 'observe_no_action'
    | 'cascading_failure_room_terminated';
  /** Human-readable reason — useful for logs + smoke summary. */
  reason: string;
}

/** Factory: create the per-room state with `ARMED` phase and a known primary. */
export function createRoomState(
  room_id: string,
  primary_relay_id: string,
  standby_relay_id: string | null = null,
): RoomFailoverState {
  return {
    room_id,
    primary_relay_id,
    standby_relay_id,
    phase: 'ARMED',
    heartbeat_miss_counter: 0,
    last_decision_ts_ms: null,
    last_trigger: null,
  };
}

/**
 * Drive the state machine with one input. Returns a decision; the caller should
 * persist `state` mutations (the function mutates in-place).
 */
export function step(state: RoomFailoverState, input: DetectorInput): DetectorDecision {
  const ts = input.ts_ms;
  const old_phase = state.phase;

  // Once a room has terminated (cascading) or already triggered swap, we are idempotent.
  if (state.phase === 'TRIGGERED') {
    if (input.kind === 'swap-acked') {
      // Reset to ARMED with no standby — the swap consumed the standby.
      state.phase = 'ARMED';
      state.standby_relay_id = null;
      state.last_trigger = null;
      state.heartbeat_miss_counter = 0;
      return {
        room_id: state.room_id,
        ts_ms: ts,
        old_phase,
        new_phase: state.phase,
        trigger: null,
        T_trigger_to_decision_ms: 0,
        suggested_action: 'observe_no_action',
        reason: 'swap acknowledged; detector re-armed without standby',
      };
    }
    return noDecision(state, ts, old_phase, 'already TRIGGERED; awaiting swap-acked');
  }

  if (state.phase === 'TRIGGERED_NO_STANDBY') {
    return noDecision(state, ts, old_phase, 'cascading failure already recorded');
  }

  if (input.kind === 'standby-bound') {
    state.standby_relay_id = input.standby_relay_id;
    if (state.phase === 'STANDBY_REPLACE_NEEDED') state.phase = 'ARMED';
    return noDecision(state, ts, old_phase, `standby bound to ${input.standby_relay_id}`);
  }

  if (input.kind === 'relay-heartbeat' && input.relay_miner_id === state.primary_relay_id) {
    state.heartbeat_miss_counter = 0;
    return noDecision(state, ts, old_phase, 'heartbeat received; miss-counter reset');
  }

  if (input.kind === 'heartbeat-tick') {
    state.heartbeat_miss_counter += 1;
    if (state.heartbeat_miss_counter >= HEARTBEAT_MISS_THRESHOLD) {
      return transitionToTriggered(state, ts, TRIGGER_HEARTBEAT_MISS, 0,
        `heartbeat-miss counter reached ${state.heartbeat_miss_counter}`);
    }
    return noDecision(state, ts, old_phase,
      `heartbeat-tick; miss-counter at ${state.heartbeat_miss_counter}`);
  }

  if (input.kind === 'relay-slashed') {
    if (input.relay_miner_id === state.primary_relay_id) {
      return transitionToTriggered(state, ts, TRIGGER_CHAIN_SLASH, 0,
        `primary ${input.relay_miner_id} slashed on chain`);
    }
    if (input.relay_miner_id === state.standby_relay_id) {
      state.phase = 'STANDBY_REPLACE_NEEDED';
      state.last_decision_ts_ms = ts;
      return {
        room_id: state.room_id,
        ts_ms: ts,
        old_phase,
        new_phase: state.phase,
        trigger: null,
        T_trigger_to_decision_ms: 0,
        suggested_action: 'emit_replace_standby',
        reason: `standby ${input.relay_miner_id} slashed; pick a fresh standby`,
      };
    }
    return noDecision(state, ts, old_phase,
      `slash event for unrelated relay ${input.relay_miner_id}`);
  }

  if (input.kind === 'relay-performance-degraded'
      && input.relay_miner_id === state.primary_relay_id) {
    return transitionToTriggered(state, ts, TRIGGER_DEGRADED, 0,
      `primary ${input.relay_miner_id} performance-degraded rtt=${input.rtt} load=${input.load}`);
  }

  return noDecision(state, ts, old_phase, `input ${input.kind} ignored`);
}

function transitionToTriggered(
  state: RoomFailoverState,
  ts_ms: number,
  trigger: FailoverTrigger,
  T_trigger_to_decision_ms: number,
  reason: string,
): DetectorDecision {
  const old_phase = state.phase;
  if (state.standby_relay_id === null) {
    state.phase = 'TRIGGERED_NO_STANDBY';
    state.last_decision_ts_ms = ts_ms;
    state.last_trigger = trigger;
    return {
      room_id: state.room_id,
      ts_ms,
      old_phase,
      new_phase: state.phase,
      trigger,
      T_trigger_to_decision_ms,
      suggested_action: 'cascading_failure_room_terminated',
      reason: `${reason}; NO standby available (ADR-0004 Risk #3)`,
    };
  }
  state.phase = 'TRIGGERED';
  state.last_decision_ts_ms = ts_ms;
  state.last_trigger = trigger;
  return {
    room_id: state.room_id,
    ts_ms,
    old_phase,
    new_phase: state.phase,
    trigger,
    T_trigger_to_decision_ms,
    suggested_action: 'emit_swap_relay',
    reason,
  };
}

function noDecision(
  state: RoomFailoverState,
  ts_ms: number,
  old_phase: DetectorPhase,
  reason: string,
): DetectorDecision {
  return {
    room_id: state.room_id,
    ts_ms,
    old_phase,
    new_phase: state.phase,
    trigger: null,
    T_trigger_to_decision_ms: 0,
    suggested_action: 'observe_no_action',
    reason,
  };
}
