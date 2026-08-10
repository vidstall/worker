/**
 * createPipeLivenessObserver (REQ-RO-010 + REQ-RO-011) — honest probe flip.
 *
 * Honest probe flip: pipeConsumerAlive on consumer existence (not closed);
 * rtcpAlive ONLY on a non-zero counter ADVANCE across >=2 getStats() samples
 * (NEVER set-on-create); BOTH cleared false on null/closed. Writes via the
 * injected setLiveness closure (index.ts wires it to the probeLiveness box).
 * Uses fake timers to drive the poll deterministically (no real wall-clock).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPipeLivenessObserver } from '@dvconf/inter-relay-client';

describe('createPipeLivenessObserver — honest probe flip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  /** A mock pipe consumer whose getStats() returns a controllable counter. */
  function makeStatConsumer(initial = 0) {
    let packetCount = initial;
    return {
      consumer: {
        closed: false,
        getStats: vi.fn(async () => [
          { type: 'outbound-rtp', packetCount, byteCount: 0, nackCount: 0, pliCount: 0, firCount: 0 },
        ]),
      },
      advanceBy: (n: number) => {
        packetCount += n;
      },
    };
  }

  /** Drive N poll ticks, awaiting the async getStats() each tick settles. */
  async function pump(ticks: number, intervalMs: number): Promise<void> {
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs);
    }
  }

  it('RED-RO-010: NEVER set-on-create — rtcpAlive false after the first sample (no prior to compare)', async () => {
    const { consumer } = makeStatConsumer(500); // non-zero ABSOLUTE counter
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100); // exactly ONE sample taken
    obs.stop();

    const last = calls.at(-1)!;
    expect(last.pipeConsumerAlive).toBe(true); // consumer exists
    expect(last.rtcpAlive).toBe(false); // no ADVANCE yet — never set-on-create
  });

  it('RED-RO-010: flips rtcpAlive true after a non-zero ADVANCE across >=2 samples', async () => {
    const sc = makeStatConsumer(100);
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => sc.consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100); // sample #1 (baseline)
    expect(calls.at(-1)!.rtcpAlive).toBe(false);
    sc.advanceBy(7); // real RTP/RTCP moved the counter
    await pump(1, 100); // sample #2 — advance detected
    obs.stop();

    expect(calls.at(-1)!.rtcpAlive).toBe(true);
    expect(calls.at(-1)!.pipeConsumerAlive).toBe(true);
  });

  it('RED-RO-011: STATIC counters never flip rtcpAlive (paused-unpaid honesty — no over-claim)', async () => {
    const sc = makeStatConsumer(900); // big but NEVER advances
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => sc.consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(5, 100); // 5 samples, counter frozen
    obs.stop();

    expect(calls.every((c) => c.rtcpAlive === false)).toBe(true);
    expect(calls.at(-1)!.pipeConsumerAlive).toBe(true);
  });

  it('REQ-RMS-025 byte-proof: pipeBytesObserved sums the pipe TRANSPORT bytesReceived+bytesSent (cross-relay RTP that crossed)', async () => {
    const { consumer } = makeStatConsumer(0);
    let received = 0;
    const transport = {
      closed: false,
      getStats: vi.fn(async () => [{ type: 'pipe-transport', bytesReceived: received, bytesSent: 200 }]),
    };
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean; pipeBytesObserved?: number }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => consumer as any,
      getPipeTransport: () => transport as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100);
    expect(calls.at(-1)!.pipeBytesObserved).toBe(200); // 0 received + 200 sent
    received = 9000; // the primary piped real RTP across the inter-relay pipe
    await pump(1, 100);
    obs.stop();
    // The standby's pipe transport RECEIVED 9000 bytes => cross-relay RTP actually crossed.
    expect(calls.at(-1)!.pipeBytesObserved).toBe(9200);
  });

  it('byte-proof: pipeBytesObserved is 0 when no getPipeTransport dep is wired (additive back-compat)', async () => {
    const { consumer } = makeStatConsumer(0);
    const calls: Array<{ pipeBytesObserved?: number }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
    });
    obs.start();
    await pump(1, 100);
    obs.stop();
    expect(calls.at(-1)!.pipeBytesObserved ?? 0).toBe(0);
  });

  it('RED-RO-010: clears BOTH false when getPipeConsumer returns null', async () => {
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => null,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100);
    obs.stop();

    expect(calls.at(-1)!).toEqual({ pipeConsumerAlive: false, rtcpAlive: false, pipeBytesObserved: 0 });
  });

  it('RED-RO-010: clears BOTH false when the consumer is closed', async () => {
    const closedConsumer = {
      closed: true,
      getStats: vi.fn(async () => []),
    };
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => closedConsumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100);
    obs.stop();

    expect(calls.at(-1)!).toEqual({ pipeConsumerAlive: false, rtcpAlive: false, pipeBytesObserved: 0 });
    expect(closedConsumer.getStats).not.toHaveBeenCalled(); // short-circuit on closed
  });

  it('RED-RO-010: a previously-live rtcpAlive RESETS to false if the consumer disappears (no stale true)', async () => {
    const sc = makeStatConsumer(0);
    let present: typeof sc.consumer | null = sc.consumer;
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => present as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(1, 100); // baseline
    sc.advanceBy(10);
    await pump(1, 100); // rtcpAlive -> true
    expect(calls.at(-1)!.rtcpAlive).toBe(true);
    present = null; // pipe consumer gone (worker.died / cutover teardown)
    await pump(1, 100);
    obs.stop();

    expect(calls.at(-1)!).toEqual({ pipeConsumerAlive: false, rtcpAlive: false, pipeBytesObserved: 0 });
  });

  it('RED-RO-010: stop() halts polling (no further setLiveness calls)', async () => {
    const sc = makeStatConsumer(0);
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => sc.consumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(2, 100);
    const countAtStop = calls.length;
    obs.stop();
    sc.advanceBy(50);
    await pump(5, 100);

    expect(calls.length).toBe(countAtStop); // no polls after stop
  });

  it('RED-RO-010: a rejected getStats() leaves liveness flags untouched (does not crash the loop)', async () => {
    const flakyConsumer = {
      closed: false,
      getStats: vi.fn(async () => {
        throw new Error('getStats on a transient transport');
      }),
    };
    const calls: Array<{ pipeConsumerAlive: boolean; rtcpAlive: boolean }> = [];
    const obs = createPipeLivenessObserver({
      getPipeConsumer: () => flakyConsumer as any,
      setLiveness: (f) => calls.push({ ...f }),
      intervalMs: 100,
      requiredSamples: 2,
    });
    obs.start();
    await pump(2, 100); // both ticks: getStats rejects
    obs.stop();

    // consumer EXISTS + not closed -> pipeConsumerAlive true; rtcpAlive stays
    // false (no usable sample); loop survived the rejection.
    expect(calls.at(-1)!.pipeConsumerAlive).toBe(true);
    expect(calls.at(-1)!.rtcpAlive).toBe(false);
  });
});
