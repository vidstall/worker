import { describe, it, expect } from 'vitest';
import { parsePeerStandbyParams } from '../cross-host-pipe.ts';

// Track-C genuine 2-host co-sign: the return channel. vm2's attester brings up its standby pipe and
// writes its {ip, port, srtpParameters?} (a PipeConnectParams) as JSON; the driver scps that file back
// to vm1, and the orchestrator parses it to `primary2.connect(...)` cross-host. This parser is the
// TRUST BOUNDARY on that return file — a malformed/half-written return must fail LOUD (never bind a
// bogus endpoint), and the SRTP block must round-trip intact for the WAN hop.

describe('parsePeerStandbyParams (Track-C cross-host return channel)', () => {
  it('parses a plain {ip,port} standby return (PIPE_SRTP off / loopback shape)', () => {
    const p = parsePeerStandbyParams(JSON.stringify({ ip: '10.0.0.5', port: 40001 }));
    expect(p).toEqual({ ip: '10.0.0.5', port: 40001 });
  });

  it('preserves srtpParameters intact for the cross-host WAN hop', () => {
    const srtp = { cryptoSuite: 'AEAD_AES_256_GCM', keyBase64: 'Zm9vYmFyYmF6' };
    const p = parsePeerStandbyParams(JSON.stringify({ ip: '10.0.0.5', port: 40001, srtpParameters: srtp }));
    expect(p.ip).toBe('10.0.0.5');
    expect(p.port).toBe(40001);
    expect(p.srtpParameters).toEqual(srtp);
  });

  it('throws on a missing/empty ip (never connect to a bogus endpoint)', () => {
    expect(() => parsePeerStandbyParams(JSON.stringify({ port: 40001 }))).toThrow();
    expect(() => parsePeerStandbyParams(JSON.stringify({ ip: '', port: 40001 }))).toThrow();
  });

  it('throws on a non-positive/non-integer port', () => {
    expect(() => parsePeerStandbyParams(JSON.stringify({ ip: '10.0.0.5', port: 0 }))).toThrow();
    expect(() => parsePeerStandbyParams(JSON.stringify({ ip: '10.0.0.5', port: -1 }))).toThrow();
    expect(() => parsePeerStandbyParams(JSON.stringify({ ip: '10.0.0.5', port: 1.5 }))).toThrow();
  });

  it('throws on malformed JSON (half-written return file)', () => {
    expect(() => parsePeerStandbyParams('{ "ip": "10.0.0.5", "por')).toThrow();
  });

  it('throws when srtpParameters is present but incomplete', () => {
    expect(() =>
      parsePeerStandbyParams(JSON.stringify({ ip: '10.0.0.5', port: 40001, srtpParameters: { cryptoSuite: 'X' } })),
    ).toThrow();
  });
});
