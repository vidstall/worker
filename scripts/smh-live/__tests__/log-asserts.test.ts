import { describe, it, expect } from 'vitest';
import { readPlacementBasis, sawReopenRedelivery } from '../log-asserts.js';

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
