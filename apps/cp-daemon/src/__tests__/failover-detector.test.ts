import { describe, it, expect } from 'vitest';
import {
  createRoomState,
  step,
  MIN_VALIDATORS_PER_ROOM,
  QUORUM_THRESHOLD,
  HEARTBEAT_MISS_THRESHOLD,
  TRIGGER_CHAIN_SLASH,
  TRIGGER_HEARTBEAT_MISS,
  TRIGGER_DEGRADED,
} from '../failover-detector.js';

describe('failover-detector ADR-0004 + ADR-0006 constants', () => {
  it('mirrors ADR-0006: n=4, quorum=3', () => {
    expect(MIN_VALIDATORS_PER_ROOM).toBe(4);
    expect(QUORUM_THRESHOLD).toBe(3);
  });

  it('mirrors ADR-0004: heartbeat miss threshold = 3', () => {
    expect(HEARTBEAT_MISS_THRESHOLD).toBe(3);
  });
});

describe('failover-detector state machine', () => {
  const ROOM = '0xROOM1';
  const PRIMARY = '0xPRIMARY';
  const STANDBY = '0xSTANDBY';

  it('F-baseline: ARMED stays ARMED while heartbeats arrive', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    const d1 = step(s, { kind: 'relay-heartbeat', ts_ms: 1_000, relay_miner_id: PRIMARY });
    expect(d1.new_phase).toBe('ARMED');
    expect(d1.trigger).toBeNull();
    expect(d1.suggested_action).toBe('observe_no_action');
    expect(s.heartbeat_miss_counter).toBe(0);
  });

  it('F-chain-slash: primary slash → TRIGGERED with trigger=0', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    const d = step(s, { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: PRIMARY });
    expect(d.new_phase).toBe('TRIGGERED');
    expect(d.trigger).toBe(TRIGGER_CHAIN_SLASH);
    expect(d.suggested_action).toBe('emit_swap_relay');
  });

  it('F-heartbeat-miss: 3 ticks without heartbeat → TRIGGERED with trigger=1', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    const d1 = step(s, { kind: 'heartbeat-tick', ts_ms: 10_000 });
    expect(d1.new_phase).toBe('ARMED');
    expect(s.heartbeat_miss_counter).toBe(1);
    const d2 = step(s, { kind: 'heartbeat-tick', ts_ms: 20_000 });
    expect(d2.new_phase).toBe('ARMED');
    const d3 = step(s, { kind: 'heartbeat-tick', ts_ms: 30_000 });
    expect(d3.new_phase).toBe('TRIGGERED');
    expect(d3.trigger).toBe(TRIGGER_HEARTBEAT_MISS);
    expect(d3.suggested_action).toBe('emit_swap_relay');
  });

  it('a fresh heartbeat resets the miss counter mid-stream', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    step(s, { kind: 'heartbeat-tick', ts_ms: 10_000 });
    step(s, { kind: 'heartbeat-tick', ts_ms: 20_000 });
    const d = step(s, { kind: 'relay-heartbeat', ts_ms: 22_000, relay_miner_id: PRIMARY });
    expect(d.new_phase).toBe('ARMED');
    expect(s.heartbeat_miss_counter).toBe(0);
  });

  it('F-degraded: primary degraded → TRIGGERED with trigger=2', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    const d = step(s, {
      kind: 'relay-performance-degraded',
      ts_ms: 7_500,
      relay_miner_id: PRIMARY,
      rtt: 800,
      load: 95,
    });
    expect(d.new_phase).toBe('TRIGGERED');
    expect(d.trigger).toBe(TRIGGER_DEGRADED);
    expect(d.suggested_action).toBe('emit_swap_relay');
  });

  it('F-standby-replace: standby slashed → STANDBY_REPLACE_NEEDED (not TRIGGERED)', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    const d = step(s, { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: STANDBY });
    expect(d.new_phase).toBe('STANDBY_REPLACE_NEEDED');
    expect(d.trigger).toBeNull();
    expect(d.suggested_action).toBe('emit_replace_standby');
  });

  it('F-cascading: no standby + primary slashed → TRIGGERED_NO_STANDBY', () => {
    const s = createRoomState(ROOM, PRIMARY, null);
    const d = step(s, { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: PRIMARY });
    expect(d.new_phase).toBe('TRIGGERED_NO_STANDBY');
    expect(d.trigger).toBe(TRIGGER_CHAIN_SLASH);
    expect(d.suggested_action).toBe('cascading_failure_room_terminated');
  });

  it('swap-acked re-arms detector with cleared standby', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    step(s, { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: PRIMARY });
    const d = step(s, { kind: 'swap-acked', ts_ms: 6_500 });
    expect(d.new_phase).toBe('ARMED');
    expect(s.standby_relay_id).toBeNull();
  });

  it('slashed-but-unrelated-relay events are ignored', () => {
    const s = createRoomState(ROOM, PRIMARY, STANDBY);
    const d = step(s, { kind: 'relay-slashed', ts_ms: 5_000, relay_miner_id: '0xUNRELATED' });
    expect(d.new_phase).toBe('ARMED');
    expect(d.suggested_action).toBe('observe_no_action');
  });
});
