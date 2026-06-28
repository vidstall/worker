/**
 * RMS-live cross-relay DEADLOCK — regression test (real mediasoup).
 *
 * The native E2E run (room 0x2a9446…) proved Assertion A (on-chain ≥3 relays) and
 * Assertion B (real RTP both ways) LIVE — but the media was served by a SINGLE
 * primary relay. The standby ACTIVE-forward path DEADLOCKED, so cross-relay media
 * never flowed. Root cause (LIVE-CROSSRELAY-DEADLOCK-PLAN §2):
 *
 *   1. `StandbyWarmPipeCoordinator.ensure` runs on first-peer-join, BEFORE the
 *      primary has announced any producer → realId undefined → `ensureWarmPipe`
 *      falls back to the `pipe-producer-pending-<roomId>` sentinel → real mediasoup
 *      `transport.consume({producerId: sentinel})` THROWS "Producer … not found".
 *   2. `onAnnounce` then runs ensureWarmPipe (consume) BEFORE forwardLocalProducers
 *      (produce) — the local producer is not on the standby router yet, so the
 *      consume throws again; and the 4-arg call CLOSES+REBUILDS the already-connected
 *      pipe transport, destroying the minted producer.
 *
 * The hermetic 22/22 suite HID this because every passing test hand-feeds the REAL
 * announced producerId and produces-then-consumes; NONE drives the
 * ensure-before-announce sentinel/ordering branch on real mediasoup. This test is
 * the missing reproduction: it drives the REAL coordinator in the LIVE order.
 *
 * REAL mediasoup (NOT a mock): two Workers ⇒ two child processes simulate the
 * primary + standby daemons; a manually-paired cross-PipeTransport (in production:
 * over the inter-relay WS) carries the handshake.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-live-crossrelay-deadlock.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  StandbyWarmPipeCoordinator,
  InterRelayProducerRegistry,
  buildPipeProducerAnnounce,
  createPrimaryPipeTransport,
  createStandbyPipeTransport,
  pipeProducerOntoPrimaryTransport,
  type RoomTopology,
} from '@dvconf/inter-relay-client';
import type { Logger } from '@dvconf/shared';

// ── Shared codec set (mirrors mediasoup-manager.ts / rms-active-forward) ────

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
  },
];

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;

const pipeProducerRtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: OPUS_PT,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: OPUS_SSRC }],
};

function mockLogger(): Logger {
  const fn = (): void => {};
  return {
    info: fn, warn: fn, error: fn, debug: fn,
    fatal: fn, trace: fn, child() { return this; }, level: 'info',
  } as unknown as Logger;
}

// ── Module-scoped real mediasoup workers ────────────────────────────────────

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

/** A real Opus producer on the PRIMARY router (DirectTransport src). */
async function makePrimaryProducer(): Promise<msTypes.Producer> {
  const directTransport = await primaryRouter.createDirectTransport();
  return directTransport.produce({
    kind: 'audio',
    rtpParameters: pipeProducerRtpParameters,
  });
}

describe('RMS-live cross-relay DEADLOCK — StandbyWarmPipeCoordinator ensure-before-announce (REAL mediasoup)', () => {
  it('ensure() before any announce must NOT throw the pipe-producer-pending sentinel, and a later announce mints a LOCAL producer the standby can consume (REQ-RMS-025)', async () => {
    const roomId = 'rms-deadlock-room';
    const registry = new InterRelayProducerRegistry();
    const minted: msTypes.Producer[] = [];
    const coordinator = new StandbyWarmPipeCoordinator(
      registry,
      mockLogger(),
      (_rid, producer) => { minted.push(producer); }, // onLocalProducer
      true, // activeForward (RMS_ACTIVE_FORWARD=1 — the live mesh config)
    );

    const topology: RoomTopology = {
      roomId,
      role: 'standby',
      primaryEndpoint: 'ws://127.0.0.1:0',
      standbyEndpoint: 'ws://127.0.0.1:0',
      pipePort: 0,
      pipeConsumer: null,
      pipeTransport: null,
    };

    // ── PHASE 1 (the deadlock): ensure BEFORE any announce. Registry empty → pending.
    //    TODAY: ensureWarmPipe falls back to `pipe-producer-pending-<roomId>` and
    //    consumes it on real mediasoup → THROWS "Producer … not found" (the exact
    //    relay-1 level-50 error). EXPECTED after the fix: ensure binds+retains the
    //    pipe transport (so the UP {ip,port} announce can read tuple.localPort) and
    //    RESOLVES null (deferred) — no consume of a non-existent producer.
    await expect(
      coordinator.ensure(topology, standbyRouter, 0),
    ).resolves.toBeNull();
    expect(topology.pipeTransport).not.toBeNull(); // bound: the standby can announce UP
    expect(topology.pipeConsumer).toBeNull();       // deferred: no consumer minted yet

    // ── PHASE 2: the connect handshake (in production: over the inter-relay WS link).
    //    Pair the primary half to the standby's ALREADY-BOUND pipe transport. ──
    const src = await makePrimaryProducer();
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: topology.pipeTransport!.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await topology.pipeTransport!.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // ── PHASE 3: primary pipes its producer + announces (records into the standby
    //    registry — exactly what signaling.ts does on inbound pipe-producer frame). ──
    const pipedConsumer = await pipeProducerOntoPrimaryTransport(primaryPipe, src.id);
    // The piped consumer's SSRC is REMAPPED vs the source — that is why the announce
    // carries rtpParameters (the standby produce needs the remapped encoding).
    expect(pipedConsumer.rtpParameters.encodings?.[0]?.ssrc).not.toBe(OPUS_SSRC);
    registry.record(
      buildPipeProducerAnnounce(
        roomId,
        { id: pipedConsumer.id, kind: pipedConsumer.kind },
        'publisher-1',
        undefined, // DEFAULT peer (legacy single-standby leg)
        pipedConsumer.rtpParameters,
      ),
    );

    // ── PHASE 4 (the cutover): onAnnounce must drive produce-then-consume on the
    //    SAME connected transport. TODAY: consume-before-produce → "Producer … not
    //    found", and the 4-arg ensureWarmPipe closes+rebuilds the connected transport.
    //    EXPECTED after the fix: forwardLocalProducers mints the LOCAL producer FIRST,
    //    then ensureWarmPipe consumes it onto the SAME transport (paused keepalive). ──
    const reran = await coordinator.onAnnounce(roomId, topology, standbyRouter, 0);
    expect(reran).toBe(true);

    // The standby minted a LOCAL producer its OWN clients can consume = cross-relay
    // forward is live (the standby has no producers of its own; this one rode the pipe).
    expect(minted.length).toBeGreaterThan(0);
    expect(
      standbyRouter.canConsume({
        producerId: pipedConsumer.id,
        rtpCapabilities: standbyRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // REQ-RO-005 PRESERVED: the keepalive pipe consumer exists + stays PAUSED (the
    // failover/MTTR mechanism must survive the active-forward reorder).
    expect(topology.pipeConsumer).not.toBeNull();
    expect(topology.pipeConsumer!.paused).toBe(true);

    // cleanup
    try {
      topology.pipeConsumer?.close();
      topology.pipeTransport?.close();
      pipedConsumer.close();
      primaryPipe.close();
      src.close();
      minted.forEach((p) => p.close());
    } catch {
      /* best-effort */
    }
  }, 30_000);
});
