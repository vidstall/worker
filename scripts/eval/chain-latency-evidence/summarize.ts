import {
  CHAIN_LATENCY_SCHEMA_VERSION,
  CHAIN_LATENCY_SUMMARY_SCHEMA_VERSION,
  expectedEventType,
  type ChainLatencyMetric,
  type ChainLatencyMetricSummary,
  type ChainLatencySummary,
  type DistributionSummary,
  type ParsedChainLatencyEvidence,
} from './schema.ts';
import { isRecord } from './parse.ts';

export function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error('nearest-rank requires at least one value');
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error('percentile must be in the interval (0, 1]');
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1]!;
}

function normalizeNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) throw new Error('cannot summarize an empty distribution');
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('distribution values must be finite');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = normalizeNumber(Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(6)));
  return {
    count: sorted.length,
    min: normalizeNumber(sorted[0]!),
    max: normalizeNumber(sorted[sorted.length - 1]!),
    mean,
    p50: normalizeNumber(nearestRank(sorted, 0.5)),
    p95: normalizeNumber(nearestRank(sorted, 0.95)),
    p99: normalizeNumber(nearestRank(sorted, 0.99)),
  };
}

export function summarizeChainLatencyEvidence(parsed: ParsedChainLatencyEvidence): ChainLatencySummary {
  const summarizeMetric = (metric: ChainLatencyMetric): ChainLatencyMetricSummary => {
    const samples = parsed.samples
      .filter((sample) => sample.metric === metric)
      .sort((left, right) => left.sample_index - right.sample_index);
    return {
      count: samples.length,
      event_type: expectedEventType(parsed.meta, metric),
      submit_to_return_ms: summarizeDistribution(samples.map((sample) => sample.submit_to_return_ms)),
      submit_to_event_ms: summarizeDistribution(samples.map((sample) => sample.submit_to_event_ms)),
      return_to_event_ms: summarizeDistribution(samples.map((sample) => sample.return_to_event_ms)),
    };
  };

  return {
    schema_version: CHAIN_LATENCY_SUMMARY_SCHEMA_VERSION,
    source_schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    raw_sha256: parsed.raw_sha256,
    provenance: {
      run_id: parsed.meta.run_id,
      trace_id: parsed.meta.trace_id,
      mode: parsed.meta.mode,
      network: parsed.meta.network,
      observer_path: parsed.meta.observer_path,
      poll_interval_ms: parsed.meta.poll_interval_ms,
      expected_samples_per_metric: parsed.meta.expected_samples_per_metric,
      package_id: parsed.meta.package_id,
      framework_rev: parsed.meta.framework_rev,
      sui_cli_version: parsed.meta.sui_cli_version,
      daemon_commit: parsed.meta.daemon_commit,
      contract_commit: parsed.meta.contract_commit,
      started_at: parsed.meta.started_at,
      completed_at: parsed.meta.completed_at,
      execution_order: parsed.meta.execution_order,
      shared_state_disclosure: parsed.meta.shared_state_disclosure,
      warm_cache_disclosure: parsed.meta.warm_cache_disclosure,
    },
    metrics: {
      L_chain_create: summarizeMetric('L_chain_create'),
      L_chain_settle: summarizeMetric('L_chain_settle'),
    },
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON cannot encode a non-finite number');
    return JSON.stringify(normalizeNumber(value));
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

export function renderCanonicalChainLatencySummary(summary: ChainLatencySummary): string {
  return `${canonicalJson(summary)}\n`;
}
