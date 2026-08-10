/**
 * REQ-RMS-025 — ACTIVE-forward integration (L1.2).
 *
 * The warm-pipe model (REQ-RO-004/005) opens a cross-process PipeTransport from
 * the PRIMARY relay to a STANDBY and consumes a PAUSED keepalive consumer (RTCP
 * liveness only). But that leaves the standby's router with NO producer its OWN
 * local clients can consume — a standby that takes over a busy room can't serve
 * anyone until it MINTS a local producer fed by the piped RTP.
 *
 * This test proves the missing ACTIVE-forward step: after the warm pipe is
 * connected, `produceLocalFromPipe(standbyPipe, announced)` mints a LOCAL producer
 * on the standby router from the SSRC-remapped rtpParameters the primary's announce
 * carried (REQ-RMS-026, threaded by L1.1). It is the production helper for the
 * manual `standbyPipe.produce({...})` step the warm-pipe SPIKE
 * (warmpipe-rtp.integration.test.ts) does by hand.
 *
 * REAL mediasoup (NOT a mock): two Workers => two child processes simulate the
 * primary + standby daemons; a manually-paired cross-PipeTransport carries real
 * Opus RTP. We assert, in priority order:
 *
 *   1. PRIMARY (deterministic): standbyRouter.canConsume({producerId: localProducer.id})
 *      is TRUE — the local producer was minted with valid rtpParameters and the
 *      standby's own clients can consume it. THE must-pass assertion.
 *   2. RTP liveness: a real downstream consumer of localProducer captures >=1 'rtp'
 *      packet within a bounded timeout — media actually forwards end-to-end.
 *   3. Body byte-identity: the forwarded packet's media PAYLOAD BODY is byte-
 *      identical to the sent payload. The 12-byte RTP header DIFFERS by design (a
 *      PipeTransport REMAPS the SSRC — exactly why rtpParameters carries the
 *      remapped ssrc), so we compare only the payload tail, never the full packet.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-active-forward-mint.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  produceLocalFromPipe,
  createPrimaryPipeTransport,
  createStandbyPipeTransport,
  pipeProducerOntoPrimaryTransport,
} from '@dvconf/inter-relay-client';
import {
  mediaCodecs,
  OPUS_SSRC,
  OPUS_PAYLOAD,
  makePrimaryRtpSource as fixtureMakePrimaryRtpSource,
  sleep,
} from './rms-active-forward.fixtures.js';

// ── Module-scoped real mediasoup workers (spawned once) ────────────────────

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

const makePrimaryRtpSource = () => fixtureMakePrimaryRtpSource(primaryRouter);

describe('REQ-RMS-025 — standby ACTIVE-forward: produceLocalFromPipe mints a LOCAL producer from the cross-process pipe', () => {
  it('mints a LOCAL producer the standby router can consume + real RTP forwards through it (body byte-identical, header SSRC remapped by design)', async () => {
    const src = await makePrimaryRtpSource();

    // ── PRIMARY HALF: pipe transport + pipe the room producer onto it ──
    // port:0 => OS-assigned (avoid PIPE_PORT_RANGE collisions across reruns).
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
    // ── STANDBY HALF: the pipe transport ensureWarmPipe would retain on topology. ──
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);

    // CONNECT-PARAM EXCHANGE (in production: over the inter-relay WS link).
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // Primary consumes the room producer onto its pipe => puts RTP on the wire and
    // yields the PIPED consumer whose .id + (remapped) rtpParameters the announce
    // carries to the standby (REQ-RMS-026). This is what the announce registry holds.
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(
      primaryPipe,
      src.producer.id,
    );
    const announced = {
      producerId: primaryPipeConsumer.id,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
    };
    // The piped consumer's SSRC is REMAPPED vs the source (the whole reason the
    // announce carries rtpParameters) — assert it so the byte-identity expectation
    // below (header differs, body identical) is grounded.
    const pipedSsrc = announced.rtpParameters.encodings?.[0]?.ssrc;
    expect(pipedSsrc).toBeDefined();
    expect(pipedSsrc).not.toBe(OPUS_SSRC);

    // ── L1.2 UNDER TEST: mint the LOCAL producer on the standby from the announce. ──
    const localProducer = await produceLocalFromPipe(standbyPipe, announced);

    // ASSERTION 1 (must-pass, deterministic): the standby's own clients can consume it.
    expect(localProducer.id).toBe(announced.producerId);
    expect(
      standbyRouter.canConsume({
        producerId: localProducer.id,
        rtpCapabilities: standbyRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // ── DOWNSTREAM SINK on the standby — observes that RTP actually forwards. ──
    const sinkTransport = await standbyRouter.createDirectTransport();
    const sink = await sinkTransport.consume({
      producerId: localProducer.id,
      rtpCapabilities: standbyRouter.rtpCapabilities,
      paused: false,
    });
    const captured: Buffer[] = [];
    sink.on('rtp', (pkt: Buffer) => {
      captured.push(Buffer.from(pkt));
      if (captured.length > 256) captured.shift();
    });

    // ── DRIVE real RTP through the warm pipe → the local producer → the sink. ──
    src.start();
    // Bounded wait for the first packet(s) to settle across the pipe.
    const deadline = Date.now() + 4000;
    while (captured.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    await sleep(200);
    src.stop();

    // ASSERTION 2: real RTP forwarded end-to-end through the minted local producer.
    expect(captured.length).toBeGreaterThan(0);
    const stats = await sink.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    // ASSERTION 3: media BODY byte-identical (header SSRC remapped by design).
    // The constant Opus payload rides the packet TAIL; the pipe remaps the 12-byte
    // header's SSRC but never the payload. Comparing the trailing payload bytes is
    // robust to any header-length change the pipe introduces.
    const bodyIdentical = captured.filter((pkt) =>
      pkt.subarray(pkt.length - OPUS_PAYLOAD.length).equals(OPUS_PAYLOAD),
    ).length;
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-025 active-forward] captured=${captured.length} ` +
        `inboundPacketCount=${inbound?.packetCount} pipedSsrc=0x${(pipedSsrc ?? 0).toString(16)} ` +
        `sourceSsrc=0x${OPUS_SSRC.toString(16)} bodyIdentical=${bodyIdentical}`,
    );
    expect(bodyIdentical).toBeGreaterThan(0);

    // cleanup
    try {
      sink.close();
      localProducer.close();
      primaryPipeConsumer.close();
      src.producer.close();
      primaryPipe.close();
      standbyPipe.close();
      sinkTransport.close();
    } catch {
      /* best-effort */
    }
  }, 30_000);

  // NOTE: the coordinator wiring around produceLocalFromPipe (forwardLocalProducers
  // dedup, the onLocalProducer callback, the retryable-vs-duplicate error split,
  // clear(), and the legacy no-rtpParameters skip) is unit-tested with mock mediasoup
  // in apps/relay/src/__tests__/standby-warmpipe-active-forward.test.ts (no real
  // Workers needed). This integration test proves the primitive on REAL mediasoup
  // end-to-end.
});
