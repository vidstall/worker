import { describe, expect, it } from 'vitest';
import {
  CHAIN_LATENCY_SCHEMA_VERSION,
  parseChainLatencyEvidence,
  renderCanonicalChainLatencySummary,
  summarizeChainLatencyEvidence,
  validateChainLatencyBundle,
  type ChainLatencyBundleTexts,
  type ChainLatencyMetaRow,
  type ChainLatencyMetric,
  type ChainLatencySampleRow,
} from '../chain-latency-evidence.ts';
import { sha256Text } from '../cost-run-safety.ts';

const packageId = '0xabc123';

function meta(overrides: Partial<ChainLatencyMetaRow> = {}): ChainLatencyMetaRow {
  return {
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    record_type: 'meta',
    complete: true,
    run_id: 'p3-unit',
    trace_id: 'trace-unit',
    mode: 'official',
    network: 'localnet',
    observer_path: 'production_event_poller',
    poll_interval_ms: 5_000,
    expected_samples_per_metric: 30,
    package_id: packageId,
    framework_rev: '94ad8ccd0ed6c089a9fe072ff80c918b5ab44943',
    sui_cli_version: 'sui 1.66.2',
    daemon_commit: '846d21145c0ff804f1548c3d8b5617f5f19c56e7',
    contract_commit: '17e1fce0efd7b7668a5cd7d6aa34ebae762670bd',
    started_at: '2026-07-16T00:00:00.000Z',
    completed_at: '2026-07-16T01:00:00.000Z',
    execution_order: 'sequential',
    shared_state_disclosure: 'One persistent localnet; rows are repeated sequential observations.',
    warm_cache_disclosure: 'Later samples may observe warm caches.',
    sui_environment: {
      before_alias: 'devnet',
      before_address: '0xfeed',
    },
    ...overrides,
  };
}

function sample(metric: ChainLatencyMetric, index: number): ChainLatencySampleRow {
  const submit = index * 100;
  const submitToEvent = metric === 'L_chain_create' ? index : index * 2;
  const eventType = metric === 'L_chain_create'
    ? `${packageId}::room_manager::RoomCreated`
    : `${packageId}::economic_layer::RewardsDistributed`;
  const prefix = metric === 'L_chain_create' ? 'create' : 'settle';
  const wallBase = Date.parse('2026-07-16T00:00:00.000Z') + submit;
  return {
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    record_type: 'sample',
    run_id: 'p3-unit',
    trace_id: 'trace-unit',
    metric,
    sample_index: index,
    tx_digest: `${prefix}-digest-${index}`,
    event_type: eventType,
    event_seq: '0',
    room_id: `0x${(1_000 + index).toString(16)}`,
    escrow_id: metric === 'L_chain_create' ? null : `0x${(2_000 + index).toString(16)}`,
    success: true,
    exact_match: true,
    submit_wall_iso: new Date(wallBase).toISOString(),
    submit_mono_ms: submit,
    rpc_return_wall_iso: new Date(wallBase + 10).toISOString(),
    rpc_return_mono_ms: submit + 10,
    observed_wall_iso: new Date(wallBase + submitToEvent).toISOString(),
    observed_mono_ms: submit + submitToEvent,
    rpc_return_ms: 10,
    value_ms: submitToEvent,
  };
}

function rows(metadata = meta()): Array<ChainLatencyMetaRow | ChainLatencySampleRow> {
  const result: Array<ChainLatencyMetaRow | ChainLatencySampleRow> = [metadata];
  for (let index = 1; index <= metadata.expected_samples_per_metric; index += 1) {
    result.push(sample('L_chain_create', index), sample('L_chain_settle', index));
  }
  return result;
}

function raw(values = rows()): string {
  return `${values.map((value) => JSON.stringify(value)).join('\n')}\n`;
}

function bundle(values = rows()): ChainLatencyBundleTexts {
  const metadata = values[0] as ChainLatencyMetaRow;
  const chainLatency = raw(values);
  const observedEvents = `${values.slice(1).map((value) => {
    const row = value as ChainLatencySampleRow;
    return JSON.stringify({
      schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
      record_type: 'observed_event',
      run_id: row.run_id,
      trace_id: row.trace_id,
      tx_digest: row.tx_digest,
      event_type: row.event_type,
      event_seq: row.event_seq,
      room_id: row.room_id,
      observed_wall_iso: row.observed_wall_iso,
      observed_mono_ms: row.observed_mono_ms,
    });
  }).join('\n')}\n`;
  const gitStatus = '=== daemons ===\n(clean)\n';
  const runLog = '{"message":"measurement-data-complete"}\n';
  const manifest = {
    schema_version: CHAIN_LATENCY_SCHEMA_VERSION,
    run_id: metadata.run_id,
    trace_id: metadata.trace_id,
    complete: true,
    publishable: metadata.mode === 'official',
    mode: metadata.mode,
    started_at: metadata.started_at,
    ended_at: metadata.completed_at,
    duration_ms: Date.parse(metadata.completed_at) - Date.parse(metadata.started_at),
    samples: {
      L_chain_create: metadata.expected_samples_per_metric,
      L_chain_settle: metadata.expected_samples_per_metric,
    },
    malformed_count: 0,
    excluded_count: 0,
    matcher: {
      targetEventCount: metadata.expected_samples_per_metric * 2,
      ignoredEventCount: 3,
    },
    cleanup: {
      localnet_ports_closed: true,
      restored_sui_environment: 'devnet',
      restored_sui_address: '0xfeed',
    },
    poll_interval_ms: metadata.poll_interval_ms,
    artifact_sha256: {
      'chain-latency.jsonl': sha256Text(chainLatency),
      'observed-events.jsonl': sha256Text(observedEvents),
      'git-status.txt': sha256Text(gitStatus),
      'run.log': sha256Text(runLog),
    },
  };
  return {
    'chain-latency.jsonl': chainLatency,
    'observed-events.jsonl': observedEvents,
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'git-status.txt': gitStatus,
    'run.log': runLog,
  };
}

describe('P3 chain latency evidence', () => {
  it('validates both complete distributions and uses nearest-rank percentiles', () => {
    const parsed = parseChainLatencyEvidence(raw());
    const summary = summarizeChainLatencyEvidence(parsed);

    expect(parsed.samples).toHaveLength(60);
    expect(summary.metrics.L_chain_create.submit_to_event_ms).toMatchObject({
      count: 30,
      min: 1,
      max: 30,
      mean: 15.5,
      p50: 15,
      p95: 29,
      p99: 30,
    });
    expect(summary.metrics.L_chain_settle.submit_to_event_ms).toMatchObject({
      p50: 30,
      p95: 58,
      p99: 60,
    });
    expect(summary.metrics.L_chain_create.submit_to_return_ms.p99).toBe(10);
    expect(summary.metrics.L_chain_create.return_to_event_ms).toMatchObject({
      min: -9,
      max: 20,
      p50: 5,
      p95: 19,
      p99: 20,
    });
  });

  it('renders byte-stable canonical JSON with sorted keys', () => {
    const summary = summarizeChainLatencyEvidence(parseChainLatencyEvidence(raw()));
    const first = renderCanonicalChainLatencySummary(summary);
    const second = renderCanonicalChainLatencySummary(summary);

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(first.indexOf('"metrics"')).toBeLessThan(first.indexOf('"provenance"'));
    expect(JSON.parse(first)).toEqual(summary);
  });

  it('rejects incomplete, duplicated, or non-contiguous samples', () => {
    const incomplete = rows();
    incomplete.pop();
    expect(() => parseChainLatencyEvidence(raw(incomplete))).toThrow(/exactly 60 sample rows/);

    const duplicated = rows();
    const last = duplicated[duplicated.length - 1] as ChainLatencySampleRow;
    last.sample_index = 29;
    expect(() => parseChainLatencyEvidence(raw(duplicated))).toThrow(/duplicate metric\/sample_index/);
  });

  it('rejects duplicate transaction digests across metrics', () => {
    const values = rows();
    const create = values[1] as ChainLatencySampleRow;
    const settle = values[2] as ChainLatencySampleRow;
    settle.tx_digest = create.tx_digest;
    expect(() => parseChainLatencyEvidence(raw(values))).toThrow(/duplicate tx_digest/);
  });

  it('requires paired create/settle room identity', () => {
    const values = rows();
    (values[2] as ChainLatencySampleRow).room_id = '0xbeef';
    expect(() => parseChainLatencyEvidence(raw(values))).toThrow(/room_id mismatch for sample_index 1/);
  });

  it('enforces event sequence and metric-specific escrow identity', () => {
    const missingSequence = rows();
    delete (missingSequence[1] as unknown as Record<string, unknown>)['event_seq'];
    expect(() => parseChainLatencyEvidence(raw(missingSequence))).toThrow(/event_seq must be a non-empty string/);

    const createEscrow = rows();
    (createEscrow[1] as ChainLatencySampleRow).escrow_id = '0xaaa';
    expect(() => parseChainLatencyEvidence(raw(createEscrow))).toThrow(/create escrow_id must be null/);

    const missingSettlementEscrow = rows();
    (missingSettlementEscrow[2] as ChainLatencySampleRow).escrow_id = null;
    expect(() => parseChainLatencyEvidence(raw(missingSettlementEscrow))).toThrow(/escrow_id must be a non-empty string/);

    const duplicateSettlementEscrow = rows();
    (duplicateSettlementEscrow[4] as ChainLatencySampleRow).escrow_id =
      (duplicateSettlementEscrow[2] as ChainLatencySampleRow).escrow_id;
    expect(() => parseChainLatencyEvidence(raw(duplicateSettlementEscrow))).toThrow(
      /duplicate settlement escrow_id/,
    );
  });

  it.each([
    ['success', false, /success must be true/],
    ['exact_match', false, /exact_match must be true/],
    ['observed_mono_ms', -1, /must be non-negative/],
    ['rpc_return_mono_ms', 99, /must not precede submit/],
    ['value_ms', 999, /does not match its monotonic timestamps/],
    ['return_to_event_ms', 999, /does not match its monotonic timestamps/],
  ] as const)('rejects invalid fail-closed sample field %s', (field, value, message) => {
    const values = rows();
    const target = values[1] as unknown as Record<string, unknown>;
    target[field] = value;
    expect(() => parseChainLatencyEvidence(raw(values))).toThrow(message);
  });

  it('rejects a same-module event that is not the exact full event type', () => {
    const values = rows();
    const target = values[1] as ChainLatencySampleRow;
    target.event_type = `${packageId}::room_manager::SomeOtherEvent`;
    expect(() => parseChainLatencyEvidence(raw(values))).toThrow(/event_type must exactly match/);
  });

  it('allows a one-sample spike but prevents undersized official evidence', () => {
    const spikeMeta = meta({ mode: 'spike', expected_samples_per_metric: 1 });
    expect(parseChainLatencyEvidence(raw(rows(spikeMeta))).samples).toHaveLength(2);

    const undersizedOfficial = meta({ expected_samples_per_metric: 1 });
    expect(() => parseChainLatencyEvidence(raw(rows(undersizedOfficial)))).toThrow(/at least 30/);
  });

  it('validates the complete five-artifact bundle', () => {
    const validated = validateChainLatencyBundle(bundle());
    expect(validated.evidence.samples).toHaveLength(60);
    expect(validated.observed_events).toHaveLength(60);
    expect(validated.manifest.publishable).toBe(true);
  });

  it('rejects observed-event identity mismatches', () => {
    const files = bundle();
    const observed = files['observed-events.jsonl']
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    observed[0]!['event_seq'] = '7';
    files['observed-events.jsonl'] = `${observed.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const manifest = JSON.parse(files['manifest.json']) as Record<string, unknown>;
    const hashes = manifest['artifact_sha256'] as Record<string, unknown>;
    hashes['observed-events.jsonl'] = sha256Text(files['observed-events.jsonl']);
    files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
    expect(() => validateChainLatencyBundle(files)).toThrow(/event_seq mismatch/);
  });

  it('rejects observed-event timestamp mismatches', () => {
    const files = bundle();
    const observed = files['observed-events.jsonl']
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    observed[0]!['observed_mono_ms'] = Number(observed[0]!['observed_mono_ms']) + 1;
    files['observed-events.jsonl'] = `${observed.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const manifest = JSON.parse(files['manifest.json']) as Record<string, unknown>;
    const hashes = manifest['artifact_sha256'] as Record<string, unknown>;
    hashes['observed-events.jsonl'] = sha256Text(files['observed-events.jsonl']);
    files['manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
    expect(() => validateChainLatencyBundle(files)).toThrow(/observed_mono_ms mismatch/);
  });

  it('rejects manifest artifact hash tampering', () => {
    const files = bundle();
    files['run.log'] += '{"message":"tampered"}\n';
    expect(() => validateChainLatencyBundle(files)).toThrow(
      /artifact_sha256.run\.log does not match exact file text/,
    );
  });

  it('rejects manifest identity and mode/publishability mismatches', () => {
    const wrongIdentity = bundle();
    const identityManifest = JSON.parse(wrongIdentity['manifest.json']) as Record<string, unknown>;
    identityManifest['run_id'] = 'another-run';
    wrongIdentity['manifest.json'] = `${JSON.stringify(identityManifest, null, 2)}\n`;
    expect(() => validateChainLatencyBundle(wrongIdentity)).toThrow(/run_id does not match/);

    const spikeMeta = meta({ mode: 'spike', expected_samples_per_metric: 1 });
    const wrongPublishability = bundle(rows(spikeMeta));
    const publishabilityManifest = JSON.parse(
      wrongPublishability['manifest.json'],
    ) as Record<string, unknown>;
    publishabilityManifest['publishable'] = true;
    wrongPublishability['manifest.json'] = `${JSON.stringify(publishabilityManifest, null, 2)}\n`;
    expect(() => validateChainLatencyBundle(wrongPublishability)).toThrow(
      /spike mode requires publishable=false/,
    );
  });
});
