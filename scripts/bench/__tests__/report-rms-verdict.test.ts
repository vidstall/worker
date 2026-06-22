/**
 * REQ-RMS-014 — report-rms-bench independently recomputes the demo verdict (does
 * NOT trust the test's own pass/fail prose): max-load reduction, cascade
 * correctness, Byzantine detect-latency, slash-trigger SET.
 *
 * computeDemoVerdict lives in its OWN pure module (report-rms-verdict.ts), NOT in
 * report-rms-bench.ts. The default hermetic `pnpm test` include globs
 * `scripts/**\/__tests__`, and report-rms-bench.ts has TOP-LEVEL side effects
 * (reads sidecars, writes the bench .md, sets process.exitCode on INCOMPLETE) —
 * importing it from a unit test would run the reporter and break / pollute the
 * hermetic suite (e.g. exitCode=1 when no saturation sidecar exists). The reporter
 * IMPORTS this pure fn; the test imports it too — zero side effects either way.
 */
import { describe, it, expect } from 'vitest';
import { computeDemoVerdict } from '../report-rms-verdict.js';

describe('REQ-RMS-014 — computeDemoVerdict', () => {
  it('PASS when max-load within 1.2x lower bound, cascade ok, slash-trigger set, detect bounded', () => {
    const v = computeDemoVerdict({
      optimizedMaxLoad: 1296, lowerBound: 1296,
      cascade: { zeroCrossHopLoss: true, e2eeByteIdentity: true },
      byzantine: { detectRound: 5, slashTriggerSet: true },
    });
    expect(v.pass).toBe(true);
  });
  it('FAIL when the placement scorer was disabled (max-load >> lower bound)', () => {
    const v = computeDemoVerdict({
      optimizedMaxLoad: 6480, lowerBound: 1296,
      cascade: { zeroCrossHopLoss: true, e2eeByteIdentity: true },
      byzantine: { detectRound: 5, slashTriggerSet: true },
    });
    expect(v.pass).toBe(false);
    expect(v.reasons).toContain('max-load exceeds 1.2x lower bound');
  });
  it('FAIL when the Byzantine slash-trigger was not set', () => {
    const v = computeDemoVerdict({
      optimizedMaxLoad: 1296, lowerBound: 1296,
      cascade: { zeroCrossHopLoss: true, e2eeByteIdentity: true },
      byzantine: { detectRound: -1, slashTriggerSet: false },
    });
    expect(v.pass).toBe(false);
  });
});
