import { sha256Text } from '../cost-run-safety.ts';
import {
  CHAIN_LATENCY_METRICS,
  CHAIN_LATENCY_SCHEMA_VERSION,
  expectedEventType,
  type ChainLatencyMetaRow,
  type ParsedChainLatencyEvidence,
  type ValidatedChainLatencySample,
} from './schema.ts';

export const GIT_REVISION = /^[0-9a-f]{7,40}$/i;
export const SUI_OBJECT_ID = /^0x[0-9a-f]{1,64}$/i;
export const EVENT_SEQUENCE = /^\d+$/;
export const SHA256 = /^[0-9a-f]{64}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requireIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be a valid ISO timestamp`);
  }
  return timestamp;
}

export function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

export function requireNonNegativeFinite(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (number < 0) throw new Error(`${label} must be non-negative`);
  return number;
}

export function requireNonNegativeInteger(value: unknown, label: string): number {
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

export function parseJsonLines(raw: string): unknown[] {
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
