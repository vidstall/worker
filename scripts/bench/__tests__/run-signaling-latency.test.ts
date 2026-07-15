import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  P1_SIGNALING_LATENCY_SETTINGS,
  parseSignalingLatencyArgs,
  runSignalingLatencyMeasurement,
  validateSignalingLatencyJsonl,
  type SignalingLatencySettings,
} from '../run-signaling-latency.js';

const tempRoots: string[] = [];

afterEach(() => {
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function settings(overrides: Partial<SignalingLatencySettings> = {}): SignalingLatencySettings {
  return {
    connections: 2,
    durationMs: 180,
    sampleIntervalMs: 20,
    messageIntervalMs: 20,
    messagesPerPeer: 2,
    minTotalSamples: 6,
    minSamplesPerPeer: 3,
    ...overrides,
  };
}

function rawEvent(runId: string, instance: string, peerId: string, valueMs = 1): string {
  return JSON.stringify({
    schema_version: '1.0',
    ts: 1_700_000_000_000,
    trace_id: runId,
    scenario: 'adhoc',
    source: 'signaling',
    instance,
    metric: 'L_sig_rtt',
    value_ms: valueMs,
    context: { peer_id: peerId },
  });
}

describe('P1 signaling latency runner', () => {
  it('requires separate filename-safe run and UUID-v4 trace identities', () => {
    const runId = 'p1-lsig-local-test-r01';
    const traceId = randomUUID();
    expect(
      parseSignalingLatencyArgs([
        'node',
        'run-signaling-latency.ts',
        '--run-id',
        runId,
        '--trace-id',
        traceId,
        '--output-root',
        'new-runs',
      ]),
    ).toEqual({ runId, traceId, outputRoot: 'new-runs' });
    expect(() =>
      parseSignalingLatencyArgs(['node', 'run-signaling-latency.ts', '--run-id', 'repeat']),
    ).toThrow(/usage|UUID/);
    expect(() =>
      parseSignalingLatencyArgs([
        'node',
        'run-signaling-latency.ts',
        '--run-id',
        runId,
        '--trace-id',
        traceId,
        '--output-root',
        'x',
        '--duration-ms',
        '1',
      ]),
    ).toThrow(/unknown argument/);
    expect(() =>
      parseSignalingLatencyArgs([
        'node',
        'run-signaling-latency.ts',
        '--run-id',
        runId,
        '--run-id',
        runId,
        '--trace-id',
        traceId,
        '--output-root',
        'x',
      ]),
    ).toThrow(/duplicate --run-id/);
    expect(P1_SIGNALING_LATENCY_SETTINGS.minTotalSamples).toBeGreaterThanOrEqual(
      P1_SIGNALING_LATENCY_SETTINGS.connections *
        P1_SIGNALING_LATENCY_SETTINGS.minSamplesPerPeer,
    );
  });

  it('validates every raw line and enforces aggregate plus per-peer coverage', () => {
    const runId = randomUUID();
    const instance = `p1-local-${runId}`;
    const valid = [
      ...Array.from({ length: 3 }, (_, index) => rawEvent(runId, instance, 'peer-a', index)),
      ...Array.from({ length: 3 }, (_, index) => rawEvent(runId, instance, 'peer-b', index + 1)),
    ].join('\n') + '\n';
    expect(validateSignalingLatencyJsonl(valid, runId, instance, settings())).toMatchObject({
      perPeerSamples: { 'peer-a': 3, 'peer-b': 3 },
    });
    expect(() =>
      validateSignalingLatencyJsonl(valid.replace(runId, randomUUID()), runId, instance, settings()),
    ).toThrow(/wrong trace_id/);
    expect(() =>
      validateSignalingLatencyJsonl(valid.split('\n').slice(0, 5).join('\n'), runId, instance, settings()),
    ).toThrow(/final newline/);
    expect(() =>
      validateSignalingLatencyJsonl(
        valid.split('\n').slice(0, 5).join('\n') + '\n',
        runId,
        instance,
        settings(),
      ),
    ).toThrow(/only 5 samples/);
    expect(() =>
      validateSignalingLatencyJsonl(`${valid}{bad}\n`, runId, instance, settings()),
    ).toThrow(/malformed JSON/);
  });

  it('runs the production server/probe/workload and retains a replayable gated bundle', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'dvconf-p1-lsig-'));
    tempRoots.push(tempRoot);
    const runId = 'p1-lsig-local-test-r01';
    const traceId = randomUUID();
    const runDir = join(tempRoot, runId);
    const result = await runSignalingLatencyMeasurement({
      runId,
      traceId,
      outputRoot: tempRoot,
      settings: settings(),
      requireCleanHarness: false,
    });

    expect(result.workload).toMatchObject({
      connections: 2,
      requestedUserMessages: 4,
      sentUserMessages: 4,
      deliveredUserMessages: 4,
      droppedUserMessages: 0,
      errors: [],
    });
    expect(result.events.length).toBeGreaterThanOrEqual(6);
    expect(readFileSync(result.replayPath, 'utf8')).toMatch(/L_sig_rtt,signaling/);
    const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as {
      status: string;
      validation: { gate: string; peers: number };
    };
    expect(manifest).toMatchObject({
      status: 'PASS',
      validation: { gate: 'PASS', peers: 2 },
    });
    await expect(
      runSignalingLatencyMeasurement({
        runId,
        traceId,
        outputRoot: tempRoot,
        settings: settings(),
        requireCleanHarness: false,
      }),
    ).rejects.toThrow(/run directory must be new/);
  });
});
