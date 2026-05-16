/**
 * Latency benchmark harness — Task #26 (scope B).
 *
 * See `docs/80-research/evaluation/m1-latency-methodology.md` for the
 * conceptual model. This module ships the shared types + JSONL writer
 * + lightweight probe helpers; per-daemon hook-up is colocated with
 * each daemon's source.
 */

export {
  LATENCY_EVENT_SCHEMA_VERSION,
  type LatencyEvent,
  type LatencyMetric,
  type LatencyScenario,
  type LatencySource,
} from './types.js';

export {
  LatencyWriter,
  type LatencyWriterOptions,
  appendLatencyEvent,
  isBenchEnabled,
  resolveTraceId,
  resolveScenario,
} from './writer.js';

export { timeAsync, timeSync, startSampler } from './probe.js';
