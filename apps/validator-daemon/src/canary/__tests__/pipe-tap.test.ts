import { describe, it, expect } from 'vitest';
import { attachValidatorSink } from '../pipe-tap.js';

describe('attachValidatorSink (M2b P8)', () => {
  it('creates an UNPAUSED DirectTransport sink consumer on the injected router', async () => {
    let consumeArgs: { producerId: string; paused?: boolean } | undefined;
    const fakeConsumer = { kind: 'video', on() {} };
    const fakeTransport = { consume: async (a: { producerId: string; paused?: boolean }) => { consumeArgs = a; return fakeConsumer; } };
    const fakeRouter = {
      rtpCapabilities: { codecs: [], headerExtensions: [] },
      createDirectTransport: async () => fakeTransport,
    };
    const sink = await attachValidatorSink(fakeRouter as never, 'piped-producer-id');
    expect(consumeArgs?.producerId).toBe('piped-producer-id');
    expect(consumeArgs?.paused).toBe(false); // UNPAUSED — DirectTransport consumers emit 'rtp' only when not paused
    expect(sink.consumer).toBe(fakeConsumer);
  });
});
