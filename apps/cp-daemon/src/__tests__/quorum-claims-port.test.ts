/**
 * Multi-CP quorum Phase 1 — Leg 0(a): startup PORT-COLLISION guard.
 *
 * The future `/quorum/claims` carrier (Leg 7, DEFERRED) will bind a NEW port,
 * default 8092 (ROADMAP §9: free vs the in-use daemon set
 * {8090 TURN_RPC, 8091 CP_HEALTHZ, 8082 SIGNALING_HEALTHZ, 8080 SIGNALING,
 *  8081 BENCH, 4000 relay WS, 4001 relay METRICS, 8101 VALIDATOR_HEALTHZ,
 *  8102 VALIDATOR_CANARY_COVERAGE}).
 *
 * This unit pins the EADDRINUSE-precedent failure mode as a PURE pre-flight
 * assert (no server is started here — that is Leg 7): `assertQuorumPortFree`
 * throws fail-closed if the configured port collides with an in-use port, so a
 * mis-config is caught at startup rather than as a runtime bind crash. The
 * default port is sourced from env `QUORUM_CLAIMS_PORT ?? 8092`.
 *
 * HERMETIC: pure function only, no `server.listen`, no port bound.
 */

import { describe, it, expect } from 'vitest';
import {
  assertQuorumPortFree,
  resolveQuorumClaimsPort,
  DEFAULT_QUORUM_CLAIMS_PORT,
  DAEMON_PORTS_IN_USE,
} from '../quorum-claims-port.js';

describe('Leg 0(a) — assertQuorumPortFree (startup port-collision guard)', () => {
  it('default port 8092 is FREE against the in-use daemon set', () => {
    expect(DEFAULT_QUORUM_CLAIMS_PORT).toBe(8092);
    // The canonical default must not collide — must not throw.
    expect(() => assertQuorumPortFree(8092, DAEMON_PORTS_IN_USE)).not.toThrow();
  });

  it('the in-use set is exactly the documented daemon ports', () => {
    expect([...DAEMON_PORTS_IN_USE].sort((a, b) => a - b)).toEqual(
      [4000, 4001, 8080, 8081, 8082, 8090, 8091, 8101, 8102],
    );
  });

  it.each(DAEMON_PORTS_IN_USE)(
    'fail-closed: a configured port that collides with in-use port %i throws EADDRINUSE-style',
    (port) => {
      expect(() => assertQuorumPortFree(port, DAEMON_PORTS_IN_USE)).toThrow(
        /in use|EADDRINUSE|collision/i,
      );
    },
  );

  it('the thrown error names the offending port (operator-debuggable)', () => {
    expect(() => assertQuorumPortFree(8090, DAEMON_PORTS_IN_USE)).toThrow(/8090/);
  });

  it('a free non-default port (e.g. 8093) is accepted', () => {
    expect(() => assertQuorumPortFree(8093, DAEMON_PORTS_IN_USE)).not.toThrow();
  });
});

describe('Leg 0(a) — resolveQuorumClaimsPort (env QUORUM_CLAIMS_PORT ?? 8092)', () => {
  it('returns 8092 when env is unset', () => {
    expect(resolveQuorumClaimsPort({})).toBe(8092);
  });

  it('parses a numeric env override', () => {
    expect(resolveQuorumClaimsPort({ QUORUM_CLAIMS_PORT: '8093' })).toBe(8093);
  });

  it('fail-closed: a non-numeric / out-of-range env value throws (no silent fallback)', () => {
    expect(() => resolveQuorumClaimsPort({ QUORUM_CLAIMS_PORT: 'not-a-port' })).toThrow();
    expect(() => resolveQuorumClaimsPort({ QUORUM_CLAIMS_PORT: '0' })).toThrow();
    expect(() => resolveQuorumClaimsPort({ QUORUM_CLAIMS_PORT: '99999' })).toThrow();
  });

  it('the resolved default is collision-free against the in-use set (end-to-end guard)', () => {
    const port = resolveQuorumClaimsPort({});
    expect(() => assertQuorumPortFree(port, DAEMON_PORTS_IN_USE)).not.toThrow();
  });
});
