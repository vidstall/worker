import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCanaryPipeParams } from '../write-canary-pipe-params.ts';
import type { CanaryPipeParams } from '../../apps/validator-daemon/src/capture-precedence.ts';

// B-12 (REQ-MLW-B-12): the writer serializes a CanaryPipeParams to CANARY_PIPE_PARAMS_PATH in the
// EXACT shape index.ts consumes. kRoom/cellSecret MUST be number[] on the wire (index.ts bridges via
// Uint8Array.from); a Uint8Array would JSON.stringify to an object and break the consumer.

describe('writeCanaryPipeParams (REQ-MLW-B-12)', () => {
  it('writes number[] kRoom/cellSecret that JSON-parse back into a CanaryPipeParams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwan-'));
    const path = join(dir, 'params.json');
    writeCanaryPipeParams(path, {
      relay: { ip: '10.0.0.1', port: 40000 },
      piped: { id: 'p1', kind: 'video', rtpParameters: {} as any, producerPaused: false },
      receiverMinerId: '0xabc',
      canaryKid: 7,
      expectedCtrs: [0, 1, 2, 3, 4, 5, 6, 7],
      kRoom: new Uint8Array(32).fill(0x5c),
      cellSecret: new Uint8Array(32).fill(0xab),
    });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CanaryPipeParams;
    expect(Array.isArray(parsed.meta.kRoom)).toBe(true);
    expect(parsed.meta.kRoom.length).toBe(32);
    expect(parsed.meta.cellSecret[0]).toBe(0xab);
    expect(parsed.relay).toEqual({ ip: '10.0.0.1', port: 40000 });
    expect(parsed.receiverMinerId).toBe('0xabc');
    expect(Uint8Array.from(parsed.meta.kRoom)[0]).toBe(0x5c);
  });

  // Track-C genuine 2-host co-sign: under PIPE_SRTP=1 the cross-host primary#2 pipe carries SRTP
  // params the peer host (vm2) needs to connect its standby. The writer forwards them into
  // relay.srtpParameters WHEN PRESENT; when omitted, relay stays EXACTLY {ip,port} (byte-identical to
  // the pre-Track-C loopback path — the deployed index.ts consumer ignores a key it never reads anyway).
  it('serializes relay.srtpParameters when provided (PIPE_SRTP cross-host hop)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwan-srtp-'));
    const path = join(dir, 'params.json');
    writeCanaryPipeParams(path, {
      relay: { ip: '10.0.0.4', port: 40000 },
      srtpParameters: { cryptoSuite: 'AEAD_AES_256_GCM', keyBase64: 'Zm9vYmFy' },
      piped: { id: 'p1', kind: 'video', rtpParameters: {} as any, producerPaused: false },
      receiverMinerId: '0xabc',
      canaryKid: 7,
      expectedCtrs: [0, 1, 2, 3, 4, 5, 6, 7],
      kRoom: new Uint8Array(32).fill(0x5c),
      cellSecret: new Uint8Array(32).fill(0xab),
    });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CanaryPipeParams;
    expect(parsed.relay.ip).toBe('10.0.0.4');
    expect(parsed.relay.port).toBe(40000);
    expect(parsed.relay.srtpParameters).toEqual({ cryptoSuite: 'AEAD_AES_256_GCM', keyBase64: 'Zm9vYmFy' });
  });

  it('omits relay.srtpParameters entirely when not provided (byte-identical loopback default)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bwan-nosrtp-'));
    const path = join(dir, 'params.json');
    writeCanaryPipeParams(path, {
      relay: { ip: '127.0.0.1', port: 0 },
      piped: { id: 'p1', kind: 'video', rtpParameters: {} as any, producerPaused: false },
      receiverMinerId: '0xabc',
      canaryKid: 7,
      expectedCtrs: [0],
      kRoom: new Uint8Array(32).fill(0x5c),
      cellSecret: new Uint8Array(32).fill(0xab),
    });
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CanaryPipeParams;
    expect(parsed.relay).toEqual({ ip: '127.0.0.1', port: 0 }); // NO srtpParameters key
    expect('srtpParameters' in parsed.relay).toBe(false);
  });
});
