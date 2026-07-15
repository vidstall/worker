import { describe, expect, it } from 'vitest';
import { parseArgs, selectSourceIp, validateTraceId } from '../signaling-stress';

describe('signaling stress source-IP CLI', () => {
  it('keeps the existing OS-selected source address by default', () => {
    expect(parseArgs(['--scenario', 's1', '--peers', '10']).sourceIps).toEqual([]);
  });

  it('parses a unique IPv4 loopback pool and preserves S3 geometry', () => {
    const args = parseArgs([
      '--scenario', 's3',
      '--rooms', '4',
      '--peers-per-room', '4',
      '--duration', '30',
      '--source-ips', '127.0.0.1,127.0.0.2,127.0.0.3,127.0.0.4',
    ]);

    expect(args.peers).toBe(16);
    expect(args.sourceIps).toEqual([
      '127.0.0.1',
      '127.0.0.2',
      '127.0.0.3',
      '127.0.0.4',
    ]);
  });

  it('assigns source addresses round-robin and leaves an empty pool undefined', () => {
    const pool = ['127.0.0.1', '127.0.0.2'];
    expect([0, 1, 2, 3].map((i) => selectSourceIp(pool, i))).toEqual([
      '127.0.0.1',
      '127.0.0.2',
      '127.0.0.1',
      '127.0.0.2',
    ]);
    expect(selectSourceIp([], 0)).toBeUndefined();
  });

  it.each([
    ['non-loopback', '192.0.2.1', 'only accepts IPv4 loopback'],
    ['IPv6 loopback', '::1', 'only accepts IPv4 loopback'],
    ['duplicate', '127.0.0.2,127.0.0.2', 'must not contain duplicates'],
  ])('rejects an unsafe %s source pool', (_name, sourceIps, message) => {
    expect(() => parseArgs(['--source-ips', sourceIps])).toThrow(message);
  });

  it('rejects invalid numeric and unknown CLI values', () => {
    expect(() => parseArgs(['--peers', '0'])).toThrow('positive integer');
    expect(() => parseArgs(['--scenario', 's2'])).toThrow('unknown scenario');
    expect(() => parseArgs(['--mystery', '1'])).toThrow('unknown argument');
  });

  it('accepts only bounded filename-safe trace IDs', () => {
    expect(validateTraceId('20260715T1915Z-k2_n4.run-01')).toBe('20260715T1915Z-k2_n4.run-01');
    expect(() => validateTraceId('../escape')).toThrow('filename-safe');
    expect(() => validateTraceId('contains space')).toThrow('filename-safe');
    expect(() => validateTraceId('x'.repeat(129))).toThrow('filename-safe');
  });
});
