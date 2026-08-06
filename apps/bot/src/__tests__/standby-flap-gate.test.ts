import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStandbyFlapGate, wsToProbeUrl } from '../standby-flap-gate.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('wsToProbeUrl', () => {
  it('rewrites wss:// to https:// and swaps the port to the metrics port (4001)', () => {
    expect(wsToProbeUrl('wss://relay.example.com:4000')).toBe('https://relay.example.com:4001');
  });

  it('rewrites ws:// to http:// and swaps the port to the metrics port (4001)', () => {
    expect(wsToProbeUrl('ws://relay.example.com:4000')).toBe('http://relay.example.com:4001');
  });
});

describe('createStandbyFlapGate (fail-open policy)', () => {
  it('resolves true (cut over) on a reachable body.ok === true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    const gate = createStandbyFlapGate({ probeUrl: 'https://standby.example:4001/api/probe' });
    await expect(gate.check()).resolves.toBe(true);
  });

  it('resolves false (suppress the cut) ONLY on a reachable body.ok === false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false }) }));
    const gate = createStandbyFlapGate({ probeUrl: 'https://standby.example:4001/api/probe' });
    await expect(gate.check()).resolves.toBe(false);
  });

  it('fails open (true) on a non-ok HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ ok: false }) }));
    const gate = createStandbyFlapGate({ probeUrl: 'https://standby.example:4001/api/probe' });
    await expect(gate.check()).resolves.toBe(true);
  });

  it('fails open (true) on a network rejection', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const gate = createStandbyFlapGate({ probeUrl: 'https://standby.example:4001/api/probe' });
    await expect(gate.check()).resolves.toBe(true);
  });

  it('fails open (true) on a timeout (fetch never resolves within the deadline)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    const gate = createStandbyFlapGate({ probeUrl: 'https://standby.example:4001/api/probe', timeoutMs: 10 });
    await expect(gate.check()).resolves.toBe(true);
  });
});
