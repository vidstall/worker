import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeRelayHealthz } from '../relay-liveness-probe.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('probeRelayHealthz', () => {
  it('rewrites wss:// to https:// and GETs /healthz on the bare host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeRelayHealthz('wss://relay.example.com:4000')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://relay.example.com:4000/healthz', expect.anything());
  });

  it('rewrites ws:// to http://', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await probeRelayHealthz('ws://relay.example.com:4000');
    expect(fetchMock).toHaveBeenCalledWith('http://relay.example.com:4000/healthz', expect.anything());
  });

  it('preserves a path prefix (path-based Caddy routing shares one host across workers)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await probeRelayHealthz('wss://45-79-134-247.sslip.io/akamai-001/relay-1');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://45-79-134-247.sslip.io/akamai-001/relay-1/healthz',
      expect.anything(),
    );
  });

  it('trims a trailing slash on the path so /healthz never doubles up', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await probeRelayHealthz('wss://45-79-134-247.sslip.io/akamai-001/relay-1/');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://45-79-134-247.sslip.io/akamai-001/relay-1/healthz',
      expect.anything(),
    );
  });

  it('resolves false on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    await expect(probeRelayHealthz('wss://relay.example.com:4000')).resolves.toBe(false);
  });

  it('resolves false on a network rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(probeRelayHealthz('wss://relay.example.com:4000')).resolves.toBe(false);
  });

  it('resolves false on a malformed endpoint URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeRelayHealthz('not-a-url')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
