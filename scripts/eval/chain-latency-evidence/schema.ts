export const CHAIN_LATENCY_SCHEMA_VERSION = 'dvconf-chain-latency/1.0' as const;
export const CHAIN_LATENCY_SUMMARY_SCHEMA_VERSION = 'dvconf-chain-latency-summary/1.0' as const;
export const CHAIN_LATENCY_METRICS = ['L_chain_create', 'L_chain_settle'] as const;

export type ChainLatencyMetric = (typeof CHAIN_LATENCY_METRICS)[number];
export type ChainLatencyObserverPath = 'production_event_poller' | 'direct_query_fallback';
export type ChainLatencyRunMode = 'spike' | 'official';

export interface ChainLatencyMetaRow extends Record<string, unknown> {
  schema_version: typeof CHAIN_LATENCY_SCHEMA_VERSION;
  record_type: 'meta';
  complete: true;
  run_id: string;
  trace_id: string;
  mode: ChainLatencyRunMode;
  network: 'localnet';
  observer_path: ChainLatencyObserverPath;
  poll_interval_ms: number;
  expected_samples_per_metric: number;
  package_id: string;
  framework_rev: string;
  sui_cli_version: string;
  daemon_commit: string;
  contract_commit: string;
  started_at: string;
  completed_at: string;
  execution_order: 'sequential';
  shared_state_disclosure: string;
  warm_cache_disclosure: string;
}

export interface ChainLatencySampleRow extends Record<string, unknown> {
  schema_version: typeof CHAIN_LATENCY_SCHEMA_VERSION;
  record_type: 'sample';
  run_id: string;
  trace_id: string;
  metric: ChainLatencyMetric;
  sample_index: number;
  tx_digest: string;
  event_type: string;
  event_seq: string;
  room_id: string;
  escrow_id: string | null;
  success: true;
  exact_match: true;
  submit_wall_iso: string;
  submit_mono_ms: number;
  rpc_return_wall_iso: string;
  rpc_return_mono_ms: number;
  observed_wall_iso: string;
  observed_mono_ms: number;
}

export interface ValidatedChainLatencySample extends ChainLatencySampleRow {
  submit_to_return_ms: number;
  submit_to_event_ms: number;
  return_to_event_ms: number;
}

export interface ParsedChainLatencyEvidence {
  meta: ChainLatencyMetaRow;
  samples: ValidatedChainLatencySample[];
  raw_sha256: string;
}

export const CHAIN_LATENCY_BUNDLE_FILES = [
  'chain-latency.jsonl',
  'observed-events.jsonl',
  'manifest.json',
  'git-status.txt',
  'run.log',
] as const;

export type ChainLatencyBundleFile = (typeof CHAIN_LATENCY_BUNDLE_FILES)[number];
export type ChainLatencyBundleTexts = Record<ChainLatencyBundleFile, string>;

export interface ChainLatencyObservedEventRow extends Record<string, unknown> {
  schema_version: typeof CHAIN_LATENCY_SCHEMA_VERSION;
  record_type: 'observed_event';
  run_id: string;
  trace_id: string;
  tx_digest: string;
  event_type: string;
  event_seq: string;
  room_id: string;
  observed_wall_iso: string;
  observed_mono_ms: number;
}

export interface ChainLatencyManifest extends Record<string, unknown> {
  schema_version: typeof CHAIN_LATENCY_SCHEMA_VERSION;
  run_id: string;
  trace_id: string;
  complete: true;
  publishable: boolean;
  mode: ChainLatencyRunMode;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  samples: Record<ChainLatencyMetric, number>;
  malformed_count: 0;
  excluded_count: 0;
  matcher: {
    targetEventCount: number;
    ignoredEventCount: number;
  };
  cleanup: {
    localnet_ports_closed: true;
    restored_sui_environment: string;
    restored_sui_address: string | null;
  };
  poll_interval_ms: number;
  artifact_sha256: Record<Exclude<ChainLatencyBundleFile, 'manifest.json'>, string>;
}

export interface ValidatedChainLatencyBundle {
  evidence: ParsedChainLatencyEvidence;
  observed_events: ChainLatencyObservedEventRow[];
  manifest: ChainLatencyManifest;
}

export interface DistributionSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface ChainLatencyMetricSummary {
  count: number;
  event_type: string;
  submit_to_return_ms: DistributionSummary;
  submit_to_event_ms: DistributionSummary;
  return_to_event_ms: DistributionSummary;
}

export interface ChainLatencySummary {
  schema_version: typeof CHAIN_LATENCY_SUMMARY_SCHEMA_VERSION;
  source_schema_version: typeof CHAIN_LATENCY_SCHEMA_VERSION;
  raw_sha256: string;
  provenance: {
    run_id: string;
    trace_id: string;
    mode: ChainLatencyRunMode;
    network: 'localnet';
    observer_path: ChainLatencyObserverPath;
    poll_interval_ms: number;
    expected_samples_per_metric: number;
    package_id: string;
    framework_rev: string;
    sui_cli_version: string;
    daemon_commit: string;
    contract_commit: string;
    started_at: string;
    completed_at: string;
    execution_order: 'sequential';
    shared_state_disclosure: string;
    warm_cache_disclosure: string;
  };
  metrics: Record<ChainLatencyMetric, ChainLatencyMetricSummary>;
}

export function expectedEventType(meta: ChainLatencyMetaRow, metric: ChainLatencyMetric): string {
  return metric === 'L_chain_create'
    ? `${meta.package_id}::room_manager::RoomCreated`
    : `${meta.package_id}::economic_layer::RewardsDistributed`;
}
