/**
 * Latency benchmark data model.
 *
 * Schema is **versioned** — bumping `LATENCY_EVENT_SCHEMA_VERSION` is a
 * breaking change and requires a new ADR (see `docs/80-research/evaluation/
 * m1-latency-methodology.md` §5).
 *
 * The shape is consumed by:
 *   - Task #26-followup smoke analyzer
 *   - Task #29 capacity / multi-room stress driver
 *   - Manuscript ch 4 evaluation tables
 */

export const LATENCY_EVENT_SCHEMA_VERSION = '1.0';

/** Stable list of scenarios — keep aligned with methodology §4. */
export type LatencyScenario =
  | 's-baseline'
  | 's-mcu'
  | 's-wan'
  | 's-loaded'
  | 'adhoc';

/** Stable list of metrics — keep aligned with methodology §1. */
export type LatencyMetric =
  | 'L_sig_rtt'
  | 'L_relay_fwd'
  | 'L_chain_create'
  | 'L_chain_settle'
  | 'L_cp_score'
  | 'L_validator_check'
  | 'L_g2g_optA'
  | 'L_g2g_optB';

/** Source daemon that emitted the event. */
export type LatencySource =
  | 'relay'
  | 'signaling'
  | 'cp-daemon'
  | 'validator'
  | 'client';

/** One JSONL line. Required fields are non-nullable. */
export interface LatencyEvent {
  schema_version: typeof LATENCY_EVENT_SCHEMA_VERSION;
  /** Epoch milliseconds when the daemon emitted the event. */
  ts: number;
  /** UUID-v4 grouping all events from one scenario run. */
  trace_id: string;
  scenario: LatencyScenario;
  source: LatencySource;
  /** Daemon's chain ID, hostname, or socket peer-id. */
  instance: string;
  metric: LatencyMetric;
  /** The measurement, in milliseconds. */
  value_ms: number;
  /** Optional free-form context — room/peer/transport ids, peer counts, etc. */
  context?: Record<string, unknown>;
  /** Flag set by the writer when daemon-to-daemon clock skew is suspected. */
  clock_skew_warning?: boolean;
}
