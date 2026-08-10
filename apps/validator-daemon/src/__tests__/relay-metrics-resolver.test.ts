import { describe, it, expect } from 'vitest';
import { metricsUrlFromEndpoint } from '../relay-metrics-resolver.js';

describe('metricsUrlFromEndpoint — derive metrics base URL from a relay ws endpoint', () => {
  it('rewrites wss:// to https://, preserving host and port', () => {
    expect(metricsUrlFromEndpoint('wss://relay.example:9000')).toBe('https://relay.example:9000');
  });

  it('rewrites ws:// to http://, preserving host and port', () => {
    expect(metricsUrlFromEndpoint('ws://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
  });

  it('preserves a path prefix (path-based Caddy routing shares one host across workers)', () => {
    expect(metricsUrlFromEndpoint('wss://45-79-134-247.sslip.io/akamai-001/relay-1')).toBe(
      'https://45-79-134-247.sslip.io/akamai-001/relay-1',
    );
  });

  it('trims a trailing slash on the path so /metrics/<roomId> never doubles up', () => {
    expect(metricsUrlFromEndpoint('wss://45-79-134-247.sslip.io/akamai-001/relay-1/')).toBe(
      'https://45-79-134-247.sslip.io/akamai-001/relay-1',
    );
  });

  it('returns null for an unparseable endpoint', () => {
    expect(metricsUrlFromEndpoint('')).toBeNull();
  });
});
