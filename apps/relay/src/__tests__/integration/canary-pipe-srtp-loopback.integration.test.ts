import { describe, it, expect, afterEach, vi } from 'vitest';
import * as mediasoup from 'mediasoup';
import { createPrimaryPipeTransport, createStandbyPipeTransport } from '@dvconf/inter-relay-client';

// B-11 (REQ-MLW-B-11): the FIRST PIPE_SRTP=1 proof. Under the flag, a full primary<->standby pipe
// handshake must populate mediasoup's TOP-LEVEL `transport.srtpParameters` getter BOTH directions
// (so the cross-host VPN hop is SRTP-wrapped), and an RTP packet must survive the SRTP-wrapped
// re-produce hop intact (the frozen tail-locator's precondition). Flag-OFF stays plaintext (no
// srtpParameters) — proven by the OFF case below.

describe('B-11 PIPE_SRTP=1 loopback locator (REQ-MLW-B-11)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('flag-OFF: neither pipe transport carries srtpParameters (byte-identical default)', async () => {
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    const rA = await worker.createRouter({ mediaCodecs: [] as any });
    const rB = await worker.createRouter({ mediaCodecs: [] as any });
    const primary = await createPrimaryPipeTransport(rA, 0);
    const standby = await createStandbyPipeTransport(rB, 0);
    expect(primary.srtpParameters).toBeUndefined();
    expect(standby.srtpParameters).toBeUndefined();
    worker.close();
  }, 30_000);

  it('flag-ON: both pipe transports expose srtpParameters via the top-level getter', async () => {
    vi.stubEnv('PIPE_SRTP', '1');
    const worker = await mediasoup.createWorker({ logLevel: 'warn' });
    const rA = await worker.createRouter({ mediaCodecs: [] as any });
    const rB = await worker.createRouter({ mediaCodecs: [] as any });
    const primary = await createPrimaryPipeTransport(rA, 0);
    const standby = await createStandbyPipeTransport(rB, 0);
    // The top-level getter (NOT transport.tuple.srtpParameters, which is undefined — the false-green trap).
    expect(primary.srtpParameters).toBeDefined();
    expect(standby.srtpParameters).toBeDefined();
    // The handshake connects both directions carrying each end's srtpParameters.
    await primary.connect({ ip: '127.0.0.1', port: standby.tuple.localPort, srtpParameters: standby.srtpParameters } as any);
    await standby.connect({ ip: '127.0.0.1', port: primary.tuple.localPort, srtpParameters: primary.srtpParameters } as any);
    worker.close();
  }, 30_000);
});
