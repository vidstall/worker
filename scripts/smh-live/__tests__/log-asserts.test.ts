import { describe, it, expect } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { readPlacementBasis, sawReopenRedelivery, readPromoteSubmit } from '../log-asserts.js';

const line = (o: Record<string, unknown>): string => JSON.stringify(o);

describe('readPlacementBasis (cp event-handler action=placement_basis, basis under context.basis — confirmed event-handler.ts:494)', () => {
  it('returns the basis of the LAST placement_basis line (real pino shape)', () => {
    const lines = [
      '{"level":30,"module":"event-handler","action":"placement_basis","context":{"basis":"defer","feedRows":0,"candidates":3},"msg":"REQ-RMS-022: placement capacity basis"}',
      '{"level":30,"module":"event-handler","action":"placement_basis","context":{"basis":"legacy-self-report","feedRows":0,"candidates":3},"msg":"REQ-RMS-022: placement capacity basis"}',
    ];
    expect(readPlacementBasis(lines)).toBe('legacy-self-report');
  });

  it('reads "defer" (D1a flag-ON path — feed wired but zero attested rows)', () => {
    const lines = ['{"module":"event-handler","action":"placement_basis","context":{"basis":"defer"}}'];
    expect(readPlacementBasis(lines)).toBe('defer');
  });

  it('ignores unrelated lines, non-JSON, and harness noise; returns null when none present', () => {
    expect(readPlacementBasis(['{"action":"something-else"}', 'not-json', '', '[harness] relay=ws://localhost:4000'])).toBeNull();
  });

  it('ignores a placement_basis line whose context.basis is missing/non-string', () => {
    expect(readPlacementBasis(['{"action":"placement_basis","context":{"feedRows":0}}'])).toBeNull();
  });
});

describe('sawReopenRedelivery (REQ-RMS-037 standby re-delivery — confirmed inter-relay.ts:1659)', () => {
  it('detects the re-delivery line (the full emitted string has an "on link reopen" suffix)', () => {
    expect(
      sawReopenRedelivery([
        '{"roomId":"0xroom","count":1,"msg":"REQ-RMS-037: re-delivered stored reverse announces on link reopen"}',
      ]),
    ).toBe(true);
  });

  it('is false when absent (incl. non-JSON lines)', () => {
    expect(sawReopenRedelivery(['{"msg":"nothing"}', 'not-json'])).toBe(false);
  });
});

// T1-1: join the cp watcher's `promote_submit` log to the killed primary by context.oldPrimary and
// anchor the submit instant on the pino `time` field (epoch-ms). This is the `t` for BOTH halves of
// the failover-promotion decomposition (kill->submit and submit->RelayPromoted). Confirmed shape:
// relay-heartbeat-watcher.ts:291-308 — trace_id + action top-level, oldPrimary/newPrimary under context.
describe('readPromoteSubmit (cp action=promote_submit, join by context.oldPrimary, submit t = pino `time`)', () => {
  it('returns {traceId, submitTimeMs=pino time, normalized old/new primary} for the matching oldPrimary', () => {
    const lines = [
      line({ level: 30, time: 1700000000500, trace_id: 't-uuid', module: 'relay-heartbeat-watcher', action: 'promote_submit', context: { roomId: '0xroom', oldPrimary: '0xdead', newPrimary: '0xnew', epoch: '5' }, msg: 'Relay heartbeat watcher: submitting promote_relay PTB' }),
    ];
    const r = readPromoteSubmit(lines, '0xdead');
    expect(r).not.toBeNull();
    expect(r!.traceId).toBe('t-uuid');
    expect(r!.submitTimeMs).toBe(1700000000500);
    expect(r!.oldPrimary).toBe(normalizeSuiAddress('0xdead'));
    expect(r!.newPrimary).toBe(normalizeSuiAddress('0xnew'));
  });

  it('matches oldPrimary by NORMALIZED id and returns the LAST match (most recent submit wins)', () => {
    const lines = [
      line({ time: 1, trace_id: 'a', action: 'promote_submit', context: { oldPrimary: '0xdead', newPrimary: '0x1' } }),
      line({ time: 2, trace_id: 'b', action: 'promote_submit', context: { oldPrimary: '0xdead', newPrimary: '0x2' } }),
    ];
    const r = readPromoteSubmit(lines, normalizeSuiAddress('0xdead'));
    expect(r!.traceId).toBe('b');
    expect(r!.submitTimeMs).toBe(2);
  });

  it('returns null when no promote_submit matches (wrong action, wrong primary, non-JSON)', () => {
    const lines = [
      line({ time: 1, trace_id: 'a', action: 'promote_submitted', context: { oldPrimary: '0xdead' } }),
      line({ time: 2, trace_id: 'b', action: 'promote_submit', context: { oldPrimary: '0xother', newPrimary: '0x2' } }),
      'not-json',
    ];
    expect(readPromoteSubmit(lines, '0xdead')).toBeNull();
  });

  it('returns null when the matching line has no numeric pino `time` (cannot anchor the submit instant)', () => {
    const lines = [
      line({ trace_id: 'a', action: 'promote_submit', context: { oldPrimary: '0xdead', newPrimary: '0x2' } }),
    ];
    expect(readPromoteSubmit(lines, '0xdead')).toBeNull();
  });
});
