import { describe, it, expect } from 'vitest';
import { metricsUrlFromEndpoint } from '../relay-metrics-resolver.js';

describe('metricsUrlFromEndpoint — derive metrics base URL from a relay ws endpoint (metrics = ws+1)', () => {
  it('maps ws://host:PORT -> http://host:(PORT+1) for each loopback relay', () => {
    expect(metricsUrlFromEndpoint('ws://127.0.0.1:4000')).toBe('http://127.0.0.1:4001');
    expect(metricsUrlFromEndpoint('ws://127.0.0.1:4002')).toBe('http://127.0.0.1:4003');
    expect(metricsUrlFromEndpoint('ws://127.0.0.1:4004')).toBe('http://127.0.0.1:4005');
  });

  it('accepts wss and a hostname', () => {
    expect(metricsUrlFromEndpoint('wss://relay.example:9000')).toBe('http://relay.example:9001');
  });

  it('returns null for an unparseable / portless endpoint', () => {
    expect(metricsUrlFromEndpoint('relay://test:8080')).toBeNull();
    expect(metricsUrlFromEndpoint('ws://127.0.0.1')).toBeNull();
    expect(metricsUrlFromEndpoint('')).toBeNull();
  });
});
