/**
 * W5 M2 P7 (REQ-MCS-015) — STRUCTURAL MCU-refusal for E2EE rooms (relay half).
 *
 * LOCKED SEMANTICS (ROADMAP P7 / CONTEXT D-M2-6, D-M2-8):
 *   The relay MUST STRUCTURALLY refuse to server-side MCU-mix an E2EE room, so
 *   MCU can NEVER silently engage behind the user's back. P6's `deriveRoomMode`
 *   already forces `e2ee:false` under MCU at the wire (the client never shows a
 *   false "encrypted" badge); THIS is the defense-in-depth enforcement: if a room
 *   whose `roomConfigs.get(roomId)?.e2ee === true` is EVER fed into the MCU mixer
 *   (`McuPipeline.addStream` — the ffmpeg compositing ingest), the relay THROWS
 *   `E_MCU_REFUSED_E2EE` and never mixes. It is the relay-side guarantee backing
 *   the client's never-auto-degrade consent gate (the trilemma boundary).
 *
 * HONESTY (D-M2-8): an MCU relay DECODES → re-encodes media, which structurally
 * breaks SFrame content-E2EE. The refusal keeps the system from EVER content-
 * mixing a room the user believes is E2EE. This is NOT a cryptographic
 * "relay/validator cannot decrypt" claim (M2 has no crypto validator-exclusion;
 * Path C → M3) — it is a STRUCTURAL refusal to engage the mixer.
 *
 * The refusal fires BEFORE any `router.createPlainTransport` / `transport.consume`
 * (i.e. before any mediasoup native call), so this is a pure unit test on the
 * guard — no mediasoup Workers needed (Windows-CI-friendly, mirrors the inert-
 * constructor note in relay-overlap-m2-bench.integration.test.ts:28-33).
 */

import { describe, it, expect, vi } from 'vitest';
import { McuPipeline, E_MCU_REFUSED_E2EE } from '../mcu-pipeline.js';
import type { types as msTypes } from 'mediasoup';

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as never;
}

/**
 * A router whose `createPlainTransport` is a SPY: the E2EE refusal MUST throw
 * BEFORE this is ever called (structural — no transport/consumer ever created
 * for an E2EE room's mix). A non-E2EE room reaches it and mixes normally.
 */
function mockRouter() {
  const plainTransport = {
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockResolvedValue({ close: vi.fn() }),
    produce: vi.fn().mockResolvedValue({ id: 'composite-out', close: vi.fn() }),
    close: vi.fn(),
    tuple: { localPort: 25000 },
  };
  const createPlainTransport = vi.fn().mockResolvedValue(plainTransport);
  const router = {
    createPlainTransport,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
  } as unknown as msTypes.Router;
  return { router, createPlainTransport };
}

function mockProducer(id: string): msTypes.Producer {
  return { id, kind: 'video', close: vi.fn() } as unknown as msTypes.Producer;
}

describe('W5 M2 P7 (REQ-MCS-015) — relay STRUCTURALLY refuses to MCU-mix an E2EE room', () => {
  it('REFUSES addStream for an E2EE room (throws E_MCU_REFUSED_E2EE, never reaches the mixer)', async () => {
    const { router, createPlainTransport } = mockRouter();
    // e2ee:true — the room the user believes is end-to-end encrypted.
    const pipeline = new McuPipeline(router, mockLogger(), true);

    await expect(
      pipeline.addStream('peer-1', mockProducer('prod-1')),
    ).rejects.toThrow(E_MCU_REFUSED_E2EE);

    // STRUCTURAL: the refusal fired before any mediasoup ingest — no transport,
    // no consumer, no stream tracked. The mixer was never engaged.
    expect(createPlainTransport).not.toHaveBeenCalled();
    expect(pipeline.streamCount).toBe(0);
  });

  it('the thrown error is named (.name === "E_MCU_REFUSED_E2EE") and leaks NO key material', async () => {
    const { router } = mockRouter();
    const pipeline = new McuPipeline(router, mockLogger(), true);

    let caught: unknown;
    try {
      await pipeline.addStream('peer-1', mockProducer('prod-1'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe(E_MCU_REFUSED_E2EE);
    // The message names the room/peer for ops, never a key/password/bundle.
    const msg = (caught as Error).message;
    expect(msg).not.toMatch(/key|password|secret|bundle|sealed/i);
  });

  it('a structured warn is emitted on refusal (no key material in the log context)', async () => {
    const { router } = mockRouter();
    const logger = mockLogger() as unknown as { warn: ReturnType<typeof vi.fn> };
    const pipeline = new McuPipeline(router, logger as never, true);

    await expect(
      pipeline.addStream('peer-9', mockProducer('prod-9')),
    ).rejects.toThrow(E_MCU_REFUSED_E2EE);

    expect(logger.warn).toHaveBeenCalled();
    // Assert the structured context carries the peerId but NO key/secret field.
    const [ctx] = logger.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ peerId: 'peer-9' });
    expect(JSON.stringify(ctx)).not.toMatch(/key|password|secret|bundle|sealed/i);
  });

  it('a NON-E2EE room still mixes — addStream reaches the mediasoup ingest (no refusal)', async () => {
    const { router, createPlainTransport } = mockRouter();
    // e2ee:false — a plain MCU room is content-agnostic by design; mixing is OK.
    const pipeline = new McuPipeline(router, mockLogger(), false);

    await pipeline.addStream('peer-1', mockProducer('prod-1'));

    // The non-E2EE path reaches the mixer ingest and tracks the stream.
    expect(createPlainTransport).toHaveBeenCalled();
    expect(pipeline.streamCount).toBe(1);
  });

  it('default (no e2ee arg) is a non-E2EE pipeline — backward-compatible, still mixes', async () => {
    const { router, createPlainTransport } = mockRouter();
    // Construction WITHOUT the e2ee arg (legacy/M1 call sites) ⇒ defaults to a
    // mixable, non-E2EE pipeline (the flag is opt-in, mirrors RoomConfig.e2ee).
    const pipeline = new McuPipeline(router, mockLogger());

    await pipeline.addStream('peer-1', mockProducer('prod-1'));

    expect(createPlainTransport).toHaveBeenCalled();
    expect(pipeline.streamCount).toBe(1);
  });
});
