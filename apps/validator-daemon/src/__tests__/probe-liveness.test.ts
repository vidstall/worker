/**
 * RO-020 — validator standby-liveness gating tests.
 *
 * The validator calls the standby relay's GET /api/probe BEFORE building the
 * standby SessionProof. The FROZEN Phase-1 standby-liveness contract:
 *   - SUCCESSFUL probe (ok:true)  => standby proof carries duration_seconds > 0
 *   - unanswered / ok:false probe => duration_seconds = 0 (liveness gate fails)
 *
 * `duration_seconds` is the IC-2 SIGNED field #6 — it is NOT repurposed; the
 * gate only forces it to 0 when the standby did not answer a live probe.
 *
 * These tests exercise createRelayProbe with the liveness leg injected (no live
 * server) so the duration_seconds gating is deterministic.
 */

import { describe, it, expect } from 'vitest';
import { createRelayProbe, type ProbeLivenessResult } from '../probe.js';

const ROOM_ID = '0xroom1';
const STANDBY_ID = '0xstandby';

/** Endpoint that ONLY has a liveness URL (standby path), no metrics/STUN. */
function standbyEndpoint(livenessUrl: string) {
  return {
    metricsBaseUrl: '',
    livenessUrl,
  };
}

describe('RO-020 validator standby-liveness gating (createRelayProbe)', () => {
  it('SUCCESSFUL probe (ok:true) => durationSeconds > 0', async () => {
    const live: ProbeLivenessResult = {
      ok: true,
      role: 'standby',
      latencyMs: 3n,
      pipeConsumerAlive: true,
      rtcpAlive: true,
    };
    const probe = createRelayProbe(
      ROOM_ID,
      () => standbyEndpoint('http://standby:4001'),
      { fetchLiveness: () => Promise.resolve(live) },
    );

    const sample = await probe(STANDBY_ID);
    expect(sample.durationSeconds).toBeGreaterThan(0n);
  });

  it('FAILED probe (ok:false) => durationSeconds === 0 (liveness gate)', async () => {
    const dead: ProbeLivenessResult = {
      ok: false,
      role: 'standby',
      latencyMs: 1n,
      pipeConsumerAlive: false,
      rtcpAlive: false,
    };
    const probe = createRelayProbe(
      ROOM_ID,
      () => standbyEndpoint('http://standby:4001'),
      { fetchLiveness: () => Promise.resolve(dead) },
    );

    const sample = await probe(STANDBY_ID);
    expect(sample.durationSeconds).toBe(0n);
  });

  it('UNANSWERED probe (null/unreachable) => durationSeconds === 0', async () => {
    const probe = createRelayProbe(
      ROOM_ID,
      () => standbyEndpoint('http://standby:4001'),
      { fetchLiveness: () => Promise.resolve(null) },
    );

    const sample = await probe(STANDBY_ID);
    expect(sample.durationSeconds).toBe(0n);
  });

  it('no livenessUrl (primary path) => liveness gate is NOT applied', async () => {
    // Primary has a metrics URL but no /api/probe gating; durationSeconds must
    // come from the metrics leg, not be forced to 0. We inject a metrics fetch
    // via the test hook to avoid a live server.
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: 'http://primary:4001' }),
      {
        fetchMetrics: () =>
          Promise.resolve({
            bytesForwarded: 1_000n,
            uniquePeers: 3n,
            packetsLost: 0n,
            jitter: 2n,
            duration: 45n,
            activePeers: 3n,
          }),
      },
    );

    const sample = await probe('0xprimary');
    expect(sample.durationSeconds).toBe(45n);
  });

  it('liveness ok but metrics also present => durationSeconds > 0 (not zeroed)', async () => {
    const live: ProbeLivenessResult = {
      ok: true,
      role: 'standby',
      latencyMs: 2n,
      pipeConsumerAlive: true,
      rtcpAlive: true,
    };
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: 'http://standby:4001', livenessUrl: 'http://standby:4001' }),
      {
        fetchLiveness: () => Promise.resolve(live),
        fetchMetrics: () =>
          Promise.resolve({
            bytesForwarded: 500n,
            uniquePeers: 1n,
            packetsLost: 0n,
            jitter: 1n,
            duration: 20n,
            activePeers: 1n,
          }),
      },
    );

    const sample = await probe(STANDBY_ID);
    expect(sample.durationSeconds).toBeGreaterThan(0n);
  });
});
