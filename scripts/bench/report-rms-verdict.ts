/**
 * REQ-RMS-014 — pure demo-verdict recompute for the relay-mesh-scaling M3 capstone.
 *
 * Extracted into its OWN module (NOT report-rms-bench.ts) so the hermetic unit
 * suite can import + test it WITHOUT triggering report-rms-bench.ts's top-level
 * reporter side effects (sidecar reads, .md writes, process.exitCode=1 on
 * INCOMPLETE). The default `pnpm test` include globs scripts/**\/__tests__, so a
 * test importing the reporter would run it and break the hermetic suite on any box
 * without a saturation-3mode.json sidecar. report-rms-bench.ts IMPORTS this fn.
 *
 * Pure: no I/O, no @dvconf/shared, no top-level statements.
 */
export interface DemoVerdictInput {
  optimizedMaxLoad: number;
  lowerBound: number;
  cascade: { zeroCrossHopLoss: boolean; e2eeByteIdentity: boolean };
  byzantine: { detectRound: number; slashTriggerSet: boolean };
}
export interface DemoVerdict {
  pass: boolean;
  reasons: string[];
}

/**
 * Independently recompute the REQ-RMS-014 demo verdict from the sidecar numbers
 * (does NOT trust the test's own pass/fail prose).
 */
export function computeDemoVerdict(d: DemoVerdictInput): DemoVerdict {
  const reasons: string[] = [];
  if (d.lowerBound > 0 && d.optimizedMaxLoad > Math.ceil(d.lowerBound * 1.2)) reasons.push('max-load exceeds 1.2x lower bound');
  if (!d.cascade.zeroCrossHopLoss) reasons.push('cascade had cross-hop loss');
  if (!d.cascade.e2eeByteIdentity) reasons.push('E2EE byte-identity failed across a hop');
  if (!d.byzantine.slashTriggerSet) reasons.push('Byzantine slash-trigger not set');
  if (d.byzantine.detectRound < 0 || d.byzantine.detectRound > 7) reasons.push('Byzantine detect-latency unbounded');
  return { pass: reasons.length === 0, reasons };
}
