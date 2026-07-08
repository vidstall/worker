/**
 * SMH-LIVE pino-JSONL assertions.
 *
 * The native daemons log raw JSON pino to stdout (redirected to `.logs/<role>-<ts>.log`).
 * These helpers parse those lines. Log format is JSON as long as `LOG_PRETTY` is not true
 * (Task 8 forces `LOG_PRETTY=false` on the boot env; `packages/shared/src/logger.ts:38-63`).
 *
 * Shapes GROUNDED in AUDIT Step 3/4 + RECONCILIATION v2:
 *   - placement_basis: `{ module:'event-handler', action:'placement_basis',
 *       context:{ basis, feedRows, candidates }, msg:'REQ-RMS-022: placement capacity basis' }`
 *       (apps/cp-daemon/src/event-handler.ts:494) — basis is under `context.basis`.
 *   - reopen re-delivery: `msg` === 'REQ-RMS-037: re-delivered stored reverse announces on
 *       link reopen' (packages/inter-relay-client/src/inter-relay.ts:1659). The design's grep
 *       target 'REQ-RMS-037: re-delivered stored reverse announces' is a substring, so an
 *       `.includes` match holds. (D3 is proven HERMETICALLY per RECONCILIATION v2; this helper
 *       stays for completeness / the hermetic evidence note.)
 */

function parse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Return the `basis` of the LAST `action === 'placement_basis'` line (the most recent
 * placement wins), or null if no well-formed placement_basis line is present. Reads
 * `context.basis` (a string) — D1a expects `'defer'`, D1b expects `'legacy-self-report'`.
 */
export function readPlacementBasis(lines: string[]): string | null {
  let last: string | null = null;
  for (const line of lines) {
    const o = parse(line);
    if (o && o['action'] === 'placement_basis') {
      const ctx = o['context'] as { basis?: unknown } | undefined;
      if (typeof ctx?.basis === 'string') last = ctx.basis;
    }
  }
  return last;
}

const REDELIVERY = 'REQ-RMS-037: re-delivered stored reverse announces';

/** True iff any line carries the REQ-RMS-037 standby reverse-announce re-delivery marker. */
export function sawReopenRedelivery(lines: string[]): boolean {
  return lines.some((l) => l.includes(REDELIVERY));
}
