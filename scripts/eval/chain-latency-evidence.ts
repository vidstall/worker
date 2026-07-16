import { sha256Text } from './cost-run-safety.ts';

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

const GIT_REVISION = /^[0-9a-f]{7,40}$/i;
const SUI_OBJECT_ID = /^0x[0-9a-f]{1,64}$/i;
const EVENT_SEQUENCE = /^\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return timestamp;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function requireNonNegativeFinite(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const number = requireNonNegativeFinite(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function parseMeta(value: unknown): ChainLatencyMetaRow {
  if (!isRecord(value)) throw new Error('line 1: expected a metadata object');
  if (value['schema_version'] !== CHAIN_LATENCY_SCHEMA_VERSION) {
    throw new Error(`line 1: schema_version must be ${CHAIN_LATENCY_SCHEMA_VERSION}`);
  }
  if (value['record_type'] !== 'meta') throw new Error('line 1: record_type must be meta');
  if (value['complete'] !== true) throw new Error('line 1: complete must be true');

  const mode = value['mode'];
  if (mode !== 'spike' && mode !== 'official') {
    throw new Error('line 1: mode must be spike or official');
  }
  if (value['network'] !== 'localnet') throw new Error('line 1: network must be localnet');
  const observerPath = value['observer_path'];
  if (observerPath !== 'production_event_poller' && observerPath !== 'direct_query_fallback') {
    throw new Error('line 1: observer_path must identify the exercised observer');
  }
  if (value['execution_order'] !== 'sequential') {
    throw new Error('line 1: execution_order must be sequential');
  }

  const expected = value['expected_samples_per_metric'];
  if (!Number.isInteger(expected) || Number(expected) < 1) {
    throw new Error('line 1: expected_samples_per_metric must be a positive integer');
  }
  if (mode === 'spike' && expected !== 1) {
    throw new Error('line 1: spike mode requires exactly one expected sample per metric');
  }
  if (mode === 'official' && Number(expected) < 30) {
    throw new Error('line 1: official mode requires at least 30 expected samples per metric');
  }
  if (value['sample_target'] !== undefined && value['sample_target'] !== expected) {
    throw new Error('line 1: sample_target must equal expected_samples_per_metric when present');
  }

  const pollInterval = requireNonNegativeFinite(value['poll_interval_ms'], 'line 1: poll_interval_ms');
  if (!Number.isInteger(pollInterval)) throw new Error('line 1: poll_interval_ms must be an integer');
  const packageId = requireNonEmptyString(value['package_id'], 'line 1: package_id');
  if (!SUI_OBJECT_ID.test(packageId)) throw new Error('line 1: package_id must be a Sui hex object ID');

  const frameworkRev = requireNonEmptyString(value['framework_rev'], 'line 1: framework_rev');
  const daemonCommit = requireNonEmptyString(value['daemon_commit'], 'line 1: daemon_commit');
  const contractCommit = requireNonEmptyString(value['contract_commit'], 'line 1: contract_commit');
  for (const [label, revision] of [
    ['framework_rev', frameworkRev],
    ['daemon_commit', daemonCommit],
    ['contract_commit', contractCommit],
  ] as const) {
    if (!GIT_REVISION.test(revision)) throw new Error(`line 1: ${label} must be a 7-40 digit hexadecimal Git revision`);
  }

  const startedAt = requireIsoTimestamp(value['started_at'], 'line 1: started_at');
  const completedAt = requireIsoTimestamp(value['completed_at'], 'line 1: completed_at');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('line 1: completed_at must not precede started_at');
  }

  return {
    ...value,
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    record_type: 'meta',
    complete: true,
    run_id: requireNonEmptyString(value['run_id'], 'line 1: run_id'),
    trace_id: requireNonEmptyString(value['trace_id'], 'line 1: trace_id'),
    mode,
    network: 'localnet',
    observer_path: observerPath,
    poll_interval_ms: pollInterval,
    expected_samples_per_metric: Number(expected),
    package_id: packageId,
    framework_rev: frameworkRev,
    sui_cli_version: requireNonEmptyString(value['sui_cli_version'], 'line 1: sui_cli_version'),
    daemon_commit: daemonCommit,
    contract_commit: contractCommit,
    started_at: startedAt,
    completed_at: completedAt,
    execution_order: 'sequential',
    shared_state_disclosure: requireNonEmptyString(
      value['shared_state_disclosure'],
      'line 1: shared_state_disclosure',
    ),
    warm_cache_disclosure: requireNonEmptyString(
      value['warm_cache_disclosure'],
      'line 1: warm_cache_disclosure',
    ),
  };
}

function expectedEventType(meta: ChainLatencyMetaRow, metric: ChainLatencyMetric): string {
  return metric === 'L_chain_create'
    ? `${meta.package_id}::room_manager::RoomCreated`
    : `${meta.package_id}::economic_layer::RewardsDistributed`;
}

function requireMatchingDerivedValue(
  value: unknown,
  expected: number,
  label: string,
): void {
  if (value === undefined) return;
  const actual = requireFiniteNumber(value, label);
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`${label} does not match its monotonic timestamps`);
  }
}

function parseSample(
  value: unknown,
  lineNumber: number,
  meta: ChainLatencyMetaRow,
): ValidatedChainLatencySample {
  const line = `line ${lineNumber}`;
  if (!isRecord(value)) throw new Error(`${line}: expected a sample object`);
  if (value['schema_version'] !== CHAIN_LATENCY_SCHEMA_VERSION) {
    throw new Error(`${line}: schema_version must be ${CHAIN_LATENCY_SCHEMA_VERSION}`);
  }
  if (value['record_type'] !== 'sample') throw new Error(`${line}: record_type must be sample`);
  if (value['run_id'] !== meta.run_id) throw new Error(`${line}: run_id does not match metadata`);
  if (value['trace_id'] !== meta.trace_id) throw new Error(`${line}: trace_id does not match metadata`);

  const metric = value['metric'];
  if (metric !== 'L_chain_create' && metric !== 'L_chain_settle') {
    throw new Error(`${line}: unknown chain latency metric`);
  }
  const sampleIndex = value['sample_index'];
  if (!Number.isInteger(sampleIndex) || Number(sampleIndex) < 1) {
    throw new Error(`${line}: sample_index must be a positive integer`);
  }
  if (value['success'] !== true) throw new Error(`${line}: success must be true`);
  if (value['exact_match'] !== true) throw new Error(`${line}: exact_match must be true`);

  const eventType = requireNonEmptyString(value['event_type'], `${line}: event_type`);
  const requiredEventType = expectedEventType(meta, metric);
  if (eventType !== requiredEventType) {
    throw new Error(`${line}: event_type must exactly match ${requiredEventType}`);
  }
  const roomId = requireNonEmptyString(value['room_id'], `${line}: room_id`);
  if (!SUI_OBJECT_ID.test(roomId)) throw new Error(`${line}: room_id must be a Sui hex object ID`);
  const eventSeq = requireNonEmptyString(value['event_seq'], `${line}: event_seq`);
  if (!EVENT_SEQUENCE.test(eventSeq)) {
    throw new Error(`${line}: event_seq must be a non-negative decimal integer string`);
  }
  let escrowId: string | null;
  if (metric === 'L_chain_create') {
    if (value['escrow_id'] !== null) {
      throw new Error(`${line}: L_chain_create escrow_id must be null`);
    }
    escrowId = null;
  } else {
    escrowId = requireNonEmptyString(value['escrow_id'], `${line}: escrow_id`);
    if (!SUI_OBJECT_ID.test(escrowId)) {
      throw new Error(`${line}: L_chain_settle escrow_id must be a Sui hex object ID`);
    }
  }

  const submitMono = requireNonNegativeFinite(value['submit_mono_ms'], `${line}: submit_mono_ms`);
  const returnMono = requireNonNegativeFinite(value['rpc_return_mono_ms'], `${line}: rpc_return_mono_ms`);
  const observedMono = requireNonNegativeFinite(value['observed_mono_ms'], `${line}: observed_mono_ms`);
  if (returnMono < submitMono) {
    throw new Error(`${line}: rpc_return_mono_ms must not precede submit_mono_ms`);
  }
  if (observedMono < submitMono) {
    throw new Error(`${line}: observed_mono_ms must not precede submit_mono_ms`);
  }

  const submitWall = requireIsoTimestamp(value['submit_wall_iso'], `${line}: submit_wall_iso`);
  const returnWall = requireIsoTimestamp(value['rpc_return_wall_iso'], `${line}: rpc_return_wall_iso`);
  const observedWall = requireIsoTimestamp(value['observed_wall_iso'], `${line}: observed_wall_iso`);
  if (Date.parse(returnWall) < Date.parse(submitWall)) {
    throw new Error(`${line}: rpc_return_wall_iso must not precede submit_wall_iso`);
  }
  if (Date.parse(observedWall) < Date.parse(submitWall)) {
    throw new Error(`${line}: observed_wall_iso must not precede submit_wall_iso`);
  }

  const submitToReturn = returnMono - submitMono;
  const submitToEvent = observedMono - submitMono;
  const returnToEvent = observedMono - returnMono;
  requireMatchingDerivedValue(value['rpc_return_ms'], submitToReturn, `${line}: rpc_return_ms`);
  requireMatchingDerivedValue(value['value_ms'], submitToEvent, `${line}: value_ms`);
  requireMatchingDerivedValue(
    value['return_to_event_ms'],
    returnToEvent,
    `${line}: return_to_event_ms`,
  );

  return {
    ...value,
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    record_type: 'sample',
    run_id: meta.run_id,
    trace_id: meta.trace_id,
    metric,
    sample_index: Number(sampleIndex),
    tx_digest: requireNonEmptyString(value['tx_digest'], `${line}: tx_digest`),
    event_type: eventType,
    event_seq: eventSeq,
    room_id: roomId,
    escrow_id: escrowId,
    success: true,
    exact_match: true,
    submit_wall_iso: submitWall,
    submit_mono_ms: submitMono,
    rpc_return_wall_iso: returnWall,
    rpc_return_mono_ms: returnMono,
    observed_wall_iso: observedWall,
    observed_mono_ms: observedMono,
    submit_to_return_ms: submitToReturn,
    submit_to_event_ms: submitToEvent,
    return_to_event_ms: returnToEvent,
  };
}

function parseJsonLines(raw: string): unknown[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error('raw evidence is empty');
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`line ${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function parseChainLatencyEvidence(raw: string): ParsedChainLatencyEvidence {
  const rows = parseJsonLines(raw);
  const meta = parseMeta(rows[0]);
  const samples = rows.slice(1).map((value, index) => parseSample(value, index + 2, meta));
  const expectedTotal = meta.expected_samples_per_metric * CHAIN_LATENCY_METRICS.length;
  if (samples.length !== expectedTotal) {
    throw new Error(`expected exactly ${expectedTotal} sample rows, got ${samples.length}`);
  }

  const seenSamples = new Set<string>();
  const seenDigests = new Set<string>();
  const seenSettlementEscrows = new Set<string>();
  for (const sample of samples) {
    const sampleKey = `${sample.metric}|${sample.sample_index}`;
    if (seenSamples.has(sampleKey)) throw new Error(`duplicate metric/sample_index: ${sampleKey}`);
    if (seenDigests.has(sample.tx_digest)) throw new Error(`duplicate tx_digest: ${sample.tx_digest}`);
    seenSamples.add(sampleKey);
    seenDigests.add(sample.tx_digest);
    if (sample.metric === 'L_chain_settle') {
      const escrowId = sample.escrow_id;
      if (escrowId === null) {
        throw new Error(`L_chain_settle escrow_id missing after validation: ${sampleKey}`);
      }
      if (seenSettlementEscrows.has(escrowId)) {
        throw new Error(`duplicate settlement escrow_id: ${escrowId}`);
      }
      seenSettlementEscrows.add(escrowId);
    }
  }

  for (const metric of CHAIN_LATENCY_METRICS) {
    const metricSamples = samples.filter((sample) => sample.metric === metric);
    if (metricSamples.length !== meta.expected_samples_per_metric) {
      throw new Error(
        `expected exactly ${meta.expected_samples_per_metric} ${metric} samples, got ${metricSamples.length}`,
      );
    }
    for (let index = 1; index <= meta.expected_samples_per_metric; index += 1) {
      if (!seenSamples.has(`${metric}|${index}`)) {
        throw new Error(`missing ${metric} sample_index ${index}`);
      }
    }
  }

  for (let index = 1; index <= meta.expected_samples_per_metric; index += 1) {
    const create = samples.find(
      (sample) => sample.metric === 'L_chain_create' && sample.sample_index === index,
    );
    const settle = samples.find(
      (sample) => sample.metric === 'L_chain_settle' && sample.sample_index === index,
    );
    if (create === undefined || settle === undefined) {
      throw new Error(`missing create/settle pair for sample_index ${index}`);
    }
    if (create.room_id !== settle.room_id) {
      throw new Error(
        `room_id mismatch for sample_index ${index}: ${create.room_id} != ${settle.room_id}`,
      );
    }
  }

  return { meta, samples, raw_sha256: sha256Text(raw) };
}

function parseObservedEvent(
  value: unknown,
  lineNumber: number,
  meta: ChainLatencyMetaRow,
): ChainLatencyObservedEventRow {
  const line = `observed-events.jsonl line ${lineNumber}`;
  if (!isRecord(value)) throw new Error(`${line}: expected an observed event object`);
  if (value['schema_version'] !== CHAIN_LATENCY_SCHEMA_VERSION) {
    throw new Error(`${line}: schema_version must be ${CHAIN_LATENCY_SCHEMA_VERSION}`);
  }
  if (value['record_type'] !== 'observed_event') {
    throw new Error(`${line}: record_type must be observed_event`);
  }
  if (value['run_id'] !== meta.run_id) throw new Error(`${line}: run_id does not match raw metadata`);
  if (value['trace_id'] !== meta.trace_id) {
    throw new Error(`${line}: trace_id does not match raw metadata`);
  }

  const eventSeq = requireNonEmptyString(value['event_seq'], `${line}: event_seq`);
  if (!EVENT_SEQUENCE.test(eventSeq)) {
    throw new Error(`${line}: event_seq must be a non-negative decimal integer string`);
  }
  const roomId = requireNonEmptyString(value['room_id'], `${line}: room_id`);
  if (!SUI_OBJECT_ID.test(roomId)) throw new Error(`${line}: room_id must be a Sui hex object ID`);

  return {
    ...value,
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    record_type: 'observed_event',
    run_id: meta.run_id,
    trace_id: meta.trace_id,
    tx_digest: requireNonEmptyString(value['tx_digest'], `${line}: tx_digest`),
    event_type: requireNonEmptyString(value['event_type'], `${line}: event_type`),
    event_seq: eventSeq,
    room_id: roomId,
    observed_wall_iso: requireIsoTimestamp(
      value['observed_wall_iso'],
      `${line}: observed_wall_iso`,
    ),
    observed_mono_ms: requireNonNegativeFinite(
      value['observed_mono_ms'],
      `${line}: observed_mono_ms`,
    ),
  };
}

function parseManifest(
  raw: string,
  evidence: ParsedChainLatencyEvidence,
  observedCount: number,
  files: ChainLatencyBundleTexts,
): ChainLatencyManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `manifest.json: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw new Error('manifest.json: expected an object');
  if (value['schema_version'] !== CHAIN_LATENCY_SCHEMA_VERSION) {
    throw new Error(`manifest.json: schema_version must be ${CHAIN_LATENCY_SCHEMA_VERSION}`);
  }
  if (value['complete'] !== true) throw new Error('manifest.json: complete must be true');
  if (value['run_id'] !== evidence.meta.run_id) {
    throw new Error('manifest.json: run_id does not match raw metadata');
  }
  if (value['trace_id'] !== evidence.meta.trace_id) {
    throw new Error('manifest.json: trace_id does not match raw metadata');
  }
  if (value['mode'] !== evidence.meta.mode) {
    throw new Error('manifest.json: mode does not match raw metadata');
  }
  const expectedPublishable = evidence.meta.mode === 'official';
  if (value['publishable'] !== expectedPublishable) {
    throw new Error(
      `manifest.json: ${evidence.meta.mode} mode requires publishable=${String(expectedPublishable)}`,
    );
  }

  const startedAt = requireIsoTimestamp(value['started_at'], 'manifest.json: started_at');
  const endedAt = requireIsoTimestamp(value['ended_at'], 'manifest.json: ended_at');
  if (startedAt !== evidence.meta.started_at || endedAt !== evidence.meta.completed_at) {
    throw new Error('manifest.json: start/end timestamps do not match raw metadata');
  }
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new Error('manifest.json: ended_at must not precede started_at');
  }
  const durationMs = requireNonNegativeFinite(value['duration_ms'], 'manifest.json: duration_ms');

  const sampleCounts = value['samples'];
  if (!isRecord(sampleCounts)) throw new Error('manifest.json: samples must be an object');
  const expected = evidence.meta.expected_samples_per_metric;
  for (const metric of CHAIN_LATENCY_METRICS) {
    if (sampleCounts[metric] !== expected) {
      throw new Error(`manifest.json: samples.${metric} must equal ${expected}`);
    }
  }
  if (value['malformed_count'] !== 0) {
    throw new Error('manifest.json: malformed_count must be zero');
  }
  if (value['excluded_count'] !== 0) {
    throw new Error('manifest.json: excluded_count must be zero');
  }

  const pollInterval = requireNonNegativeInteger(
    value['poll_interval_ms'],
    'manifest.json: poll_interval_ms',
  );
  if (pollInterval !== evidence.meta.poll_interval_ms) {
    throw new Error('manifest.json: poll_interval_ms does not match raw metadata');
  }

  const matcher = value['matcher'];
  if (!isRecord(matcher)) throw new Error('manifest.json: matcher must be an object');
  const targetEventCount = requireNonNegativeInteger(
    matcher['targetEventCount'],
    'manifest.json: matcher.targetEventCount',
  );
  const ignoredEventCount = requireNonNegativeInteger(
    matcher['ignoredEventCount'],
    'manifest.json: matcher.ignoredEventCount',
  );
  const expectedTargetEvents = expected * CHAIN_LATENCY_METRICS.length;
  if (targetEventCount !== expectedTargetEvents || targetEventCount !== observedCount) {
    throw new Error(
      `manifest.json: matcher.targetEventCount must equal the ${expectedTargetEvents} raw/observed target rows`,
    );
  }

  const cleanup = value['cleanup'];
  if (!isRecord(cleanup)) throw new Error('manifest.json: cleanup must be an object');
  if (cleanup['localnet_ports_closed'] !== true) {
    throw new Error('manifest.json: cleanup.localnet_ports_closed must be true');
  }
  const restoredEnvironment = requireNonEmptyString(
    cleanup['restored_sui_environment'],
    'manifest.json: cleanup.restored_sui_environment',
  );
  const restoredAddressValue = cleanup['restored_sui_address'];
  let restoredAddress: string | null;
  if (restoredAddressValue === null) {
    restoredAddress = null;
  } else {
    restoredAddress = requireNonEmptyString(
      restoredAddressValue,
      'manifest.json: cleanup.restored_sui_address',
    );
    if (!SUI_OBJECT_ID.test(restoredAddress)) {
      throw new Error('manifest.json: cleanup.restored_sui_address must be a Sui hex object ID or null');
    }
  }

  const suiEnvironment = evidence.meta['sui_environment'];
  if (!isRecord(suiEnvironment)) {
    throw new Error('raw metadata: sui_environment is required to cross-check cleanup restoration');
  }
  const beforeAlias = requireNonEmptyString(
    suiEnvironment['before_alias'],
    'raw metadata: sui_environment.before_alias',
  );
  const beforeAddressValue = suiEnvironment['before_address'];
  let beforeAddress: string | null;
  if (beforeAddressValue === null) {
    beforeAddress = null;
  } else {
    beforeAddress = requireNonEmptyString(
      beforeAddressValue,
      'raw metadata: sui_environment.before_address',
    );
    if (!SUI_OBJECT_ID.test(beforeAddress)) {
      throw new Error('raw metadata: sui_environment.before_address must be a Sui hex object ID or null');
    }
  }
  if (restoredEnvironment !== beforeAlias || restoredAddress !== beforeAddress) {
    throw new Error('manifest.json: cleanup restoration does not match the pre-run Sui environment');
  }

  const artifactSha256 = value['artifact_sha256'];
  if (!isRecord(artifactSha256)) {
    throw new Error('manifest.json: artifact_sha256 must be an object');
  }
  const verifiedHashes = {} as Record<
    Exclude<ChainLatencyBundleFile, 'manifest.json'>,
    string
  >;
  for (const artifact of [
    'chain-latency.jsonl',
    'observed-events.jsonl',
    'git-status.txt',
    'run.log',
  ] as const) {
    const actual = requireNonEmptyString(
      artifactSha256[artifact],
      `manifest.json: artifact_sha256.${artifact}`,
    );
    if (!SHA256.test(actual)) {
      throw new Error(`manifest.json: artifact_sha256.${artifact} must be lowercase SHA-256 hex`);
    }
    const expectedHash = sha256Text(files[artifact]);
    if (actual !== expectedHash) {
      throw new Error(`manifest.json: artifact_sha256.${artifact} does not match exact file text`);
    }
    verifiedHashes[artifact] = actual;
  }

  return {
    ...value,
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    run_id: evidence.meta.run_id,
    trace_id: evidence.meta.trace_id,
    complete: true,
    publishable: expectedPublishable,
    mode: evidence.meta.mode,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    samples: {
      L_chain_create: expected,
      L_chain_settle: expected,
    },
    malformed_count: 0,
    excluded_count: 0,
    matcher: { targetEventCount, ignoredEventCount },
    cleanup: {
      localnet_ports_closed: true,
      restored_sui_environment: restoredEnvironment,
      restored_sui_address: restoredAddress,
    },
    poll_interval_ms: pollInterval,
    artifact_sha256: verifiedHashes,
  };
}

export function validateChainLatencyBundle(
  files: ChainLatencyBundleTexts,
): ValidatedChainLatencyBundle {
  for (const file of CHAIN_LATENCY_BUNDLE_FILES) {
    if (typeof files[file] !== 'string') throw new Error(`bundle is missing required text: ${file}`);
  }

  const evidence = parseChainLatencyEvidence(files['chain-latency.jsonl']);
  const observedRows = parseJsonLines(files['observed-events.jsonl']).map((value, index) =>
    parseObservedEvent(value, index + 1, evidence.meta),
  );
  const expectedTotal = evidence.meta.expected_samples_per_metric * CHAIN_LATENCY_METRICS.length;
  if (observedRows.length !== expectedTotal) {
    throw new Error(
      `observed-events.jsonl: expected exactly ${expectedTotal} target rows, got ${observedRows.length}`,
    );
  }

  const observedByDigest = new Map<string, ChainLatencyObservedEventRow>();
  for (const event of observedRows) {
    if (observedByDigest.has(event.tx_digest)) {
      throw new Error(`observed-events.jsonl: duplicate tx_digest ${event.tx_digest}`);
    }
    observedByDigest.set(event.tx_digest, event);
  }
  for (const sample of evidence.samples) {
    const observed = observedByDigest.get(sample.tx_digest);
    if (observed === undefined) {
      throw new Error(`observed-events.jsonl: missing raw sample digest ${sample.tx_digest}`);
    }
    for (const field of [
      'event_type',
      'event_seq',
      'room_id',
      'run_id',
      'trace_id',
      'observed_wall_iso',
      'observed_mono_ms',
    ] as const) {
      if (observed[field] !== sample[field]) {
        throw new Error(
          `observed-events.jsonl: ${field} mismatch for digest ${sample.tx_digest}`,
        );
      }
    }
  }

  const manifest = parseManifest(files['manifest.json'], evidence, observedRows.length, files);
  return { evidence, observed_events: observedRows, manifest };
}

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
