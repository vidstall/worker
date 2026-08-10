import { sha256Text } from '../cost-run-safety.ts';
import {
  CHAIN_LATENCY_BUNDLE_FILES,
  CHAIN_LATENCY_METRICS,
  CHAIN_LATENCY_SCHEMA_VERSION,
  type ChainLatencyBundleFile,
  type ChainLatencyBundleTexts,
  type ChainLatencyManifest,
  type ChainLatencyMetaRow,
  type ChainLatencyObservedEventRow,
  type ParsedChainLatencyEvidence,
  type ValidatedChainLatencyBundle,
} from './schema.ts';
import {
  isRecord,
  parseChainLatencyEvidence,
  parseJsonLines,
  requireIsoTimestamp,
  requireNonEmptyString,
  requireNonNegativeFinite,
  requireNonNegativeInteger,
  SUI_OBJECT_ID,
  EVENT_SEQUENCE,
  SHA256,
} from './parse.ts';

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
