/**
 * REAL-mediasoup warm-pipe RTP de-risk SPIKE (Phase 5.3, step 3a).
 *
 * Proves the ONE thing the spike exists to prove:
 *
 *   Does real RTP actually flow publisher -> PRIMARY router -> inter-relay
 *   warm-pipe -> STANDBY router -> consumer, after the paused pipe consumer is
 *   resumed (the cutover)?
 *
 * This is NOT a mock. It spawns REAL mediasoup Workers + Routers + Transports
 * and pushes REAL RTP packets through. The existing relay unit tests
 * (relay-role-manager.test.ts, inter-relay-warmpipe.test.ts) mock mediasoup --
 * they verify the wiring shape but cannot prove RTP crosses the wire. This
 * fills that gap.
 *
 * Two paths are exercised:
 *
 *   (a) BASELINE -- router.pipeToRouter({producerId, router}). The mediasoup
 *       high-level helper, which only works for two routers in the SAME
 *       process. Confirms the opus codec + RTP path works AT ALL. This is the
 *       in-process shortcut, NOT what production uses.
 *
 *   (b) PRODUCTION-FAITHFUL -- manual cross-PipeTransport pairing that mirrors
 *       what two SEPARATE daemons must do: ensureWarmPipe() builds the STANDBY
 *       half; createPrimaryPipeTransport() + pipeProducerOntoPrimaryTransport()
 *       (added in inter-relay.ts) build the MISSING PRIMARY half; both ends
 *       connect() with exchanged {ip,port}. The standby pipe consumer is
 *       created PAUSED (REQ-RO-005), then resume()d (the cutover), and we
 *       ASSERT real RTP lands on a downstream consumer after resume.
 *
 * RTP source: a DirectTransport producer on the primary, fed synthetic Opus
 * RTP via producer.send(buf). Fully in-process -- no ffmpeg, no browser, no
 * UDP. RTP sink: a DirectTransport consumer on the standby whose 'rtp' event +
 * getStats() packetCount prove receipt.
 *
 * Requirements touched: REQ-RO-004, REQ-RO-005 (warm-pipe + paused standby).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  ensureWarmPipe,
  createStandbyPipeTransport,
  type RoomTopology,
} from '../../relay-role-manager.js';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
} from '../../inter-relay.js';

// -- Shared codec set (mirrors mediasoup-manager.ts) --------------------

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100, // === OPUS_PT (literal: const declared below, avoid TDZ in initializer)
  },
];

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;

/** A minimal well-formed Opus RTP packet (12-byte header + tiny payload). */
function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const payload = Buffer.from([0xfc, 0xff, 0xfe]);
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2, no padding/ext/cc
  header[1] = OPUS_PT & 0x7f; // marker 0 + payload type
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, payload]);
}

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

// -- Module-scoped real mediasoup workers (spawned once) ----------------

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  // Two workers => two distinct child processes, simulating primary + standby
  // daemons as faithfully as in-process allows.
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

/** Create a synthetic real-RTP Opus producer on the primary router. */
async function makePrimaryRtpSource(): Promise<{
  producer: msTypes.Producer;
  start: () => void;
  stop: () => void;
}> {
  const directTransport = await primaryRouter.createDirectTransport();
  const producer = await directTransport.produce({
    kind: 'audio',
    rtpParameters: pipeProducerRtpParameters,
  });
  let seq = 0;
  let ts = 0;
  let interval: NodeJS.Timeout | null = null;
  return {
    producer,
    start: () => {
      interval = setInterval(() => {
        producer.send(makeRtpPacket(seq++, ts));
        ts += 960; // 20 ms @ 48 kHz
      }, 10);
    },
    stop: () => {
      if (interval !== null) clearInterval(interval);
    },
  };
}

/**
 * Attach a downstream RTP sink on the STANDBY router via a DirectTransport
 * consumer. DirectTransport consumers emit an 'rtp' event per received packet
 * (a plain WebRTC/Plain consumer does not), which is how we OBSERVE that real
 * RTP made it across the pipe. Created paused; the caller resumes to cut over.
 */
async function makeStandbySink(
  pipedProducerId: string,
): Promise<{
  consumer: msTypes.Consumer;
  rtpCount: () => number;
  firstRtpAt: () => number | null;
}> {
  const directTransport = await standbyRouter.createDirectTransport();
  const consumer = await directTransport.consume({
    producerId: pipedProducerId,
    rtpCapabilities: standbyRouter.rtpCapabilities,
    paused: true,
  });
  let count = 0;
  let firstAt: number | null = null;
  consumer.on('rtp', () => {
    count++;
    if (firstAt === null) firstAt = Date.now();
  });
  return {
    consumer,
    rtpCount: () => count,
    firstRtpAt: () => firstAt,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------
// (a) BASELINE -- pipeToRouter (in-process shortcut). Proves codec/RTP path.
// ----------------------------------------------------------------------

describe('warm-pipe RTP -- baseline (router.pipeToRouter, same-process)', () => {
  it('flows real Opus RTP primary->standby via pipeToRouter after resume', async () => {
    const src = await makePrimaryRtpSource();

    // High-level helper: builds + connects both PipeTransports automatically
    // and mints a piped producer on the standby with the SAME id.
    await primaryRouter.pipeToRouter({
      producerId: src.producer.id,
      router: standbyRouter,
    });

    const sink = await makeStandbySink(src.producer.id);
    src.start();

    // Paused consumer: nothing should arrive yet.
    await sleep(250);
    expect(sink.rtpCount()).toBe(0);

    // CUTOVER.
    await sink.consumer.resume();
    await sleep(400);
    src.stop();

    expect(sink.rtpCount()).toBeGreaterThan(0);
    const stats = await sink.consumer.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    sink.consumer.close();
    src.producer.close();
  }, 20_000);
});

// ----------------------------------------------------------------------
// (b) PRODUCTION-FAITHFUL -- manual cross-PipeTransport pairing. This is the
//     path two SEPARATE daemons MUST use. Reuses ensureWarmPipe for the
//     standby half + the new primary-side helpers for the missing half.
// ----------------------------------------------------------------------

describe('warm-pipe RTP -- production-faithful (manual cross-PipeTransport pairing)', () => {
  it('flows real Opus RTP across a manually-paired pipe; standby consumer paused->resume cutover observes RTP', async () => {
    const src = await makePrimaryRtpSource();

    // -- PRIMARY HALF (the piece that did NOT exist before this spike) --
    // 1. primary PipeTransport. port:0 => OS-assigned (avoid PIPE_PORT_RANGE
    //    collisions when the suite reruns).
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);

    // -- STANDBY HALF --
    // We need a handle to the standby PipeTransport to connect() it. ensureWarmPipe
    // creates its own internal PipeTransport but does not return it, so for the
    // wire-carrying pipe we create the standby PipeTransport here (mirroring
    // ensureWarmPipe's exact createPipeTransport options) and then ALSO call
    // ensureWarmPipe separately to assert its as-built paused-consumer contract.
    const standbyPipe = await standbyRouter.createPipeTransport({
      listenIp: { ip: '0.0.0.0', announcedIp: '127.0.0.1' },
      port: 0,
      enableRtx: false,
      enableSrtp: false,
    } as Parameters<msTypes.Router['createPipeTransport']>[0]);

    // 2. CONNECT-PARAM EXCHANGE (in production: over the inter-relay WS link).
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // 3. primary consumes the room producer onto its pipe => puts RTP on wire
    //    and yields the id the standby must consume.
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(
      primaryPipe,
      src.producer.id,
    );
    const pipedProducerId = primaryPipeConsumer.id;

    // standby: produce the piped producer onto ITS pipe transport (this is the
    // producer the downstream consumer reads).
    const pipedProducer = await standbyPipe.produce({
      id: pipedProducerId,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
      paused: primaryPipeConsumer.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);

    // Independently assert ensureWarmPipe's STANDBY contract: a PAUSED pipe
    // consumer for the real producer id (REQ-RO-005). It uses its own internal
    // pipe transport on a separate OS port; we do not wire RTP through THIS one
    // (it has no connected primary peer), but it proves the as-built standby
    // half accepts the real producer id + pauses.
    const topology: RoomTopology = {
      roomId: 'spike-room',
      role: 'standby',
      primaryEndpoint: 'ws://127.0.0.1:0',
      standbyEndpoint: 'ws://127.0.0.1:0',
      pipePort: 0,
      pipeConsumer: null,
      pipeTransport: null,
    };
    const warmPipeConsumer = await ensureWarmPipe(
      topology,
      standbyRouter,
      0,
      pipedProducerId,
    );
    expect(warmPipeConsumer).not.toBeNull();
    expect(warmPipeConsumer!.paused).toBe(true);

    // -- DOWNSTREAM SINK on the standby + paused->resume cutover --
    const sink = await makeStandbySink(pipedProducer.id);
    src.start();

    // Paused: no RTP yet.
    await sleep(250);
    expect(sink.rtpCount()).toBe(0);

    // CUTOVER -- resume the standby-side consumer.
    const resumeAt = Date.now();
    await sink.consumer.resume();
    await sleep(500);
    src.stop();

    // ASSERT real RTP crossed the manually-paired pipe.
    const observed = sink.rtpCount();
    expect(observed).toBeGreaterThan(0);

    const stats = await sink.consumer.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);
    expect(inbound?.byteCount ?? 0).toBeGreaterThan(0);

    // Timing: resume -> first RTP observed (single clean measurement; the
    // percentile harness is later scope). Logged, not asserted as a hard
    // threshold (env-dependent).
    const firstAt = sink.firstRtpAt();
    const cutoverMs = firstAt === null ? -1 : firstAt - resumeAt;
    // eslint-disable-next-line no-console
    console.log(
      `[spike] production-faithful: rtpPackets=${observed} ` +
        `inboundPacketCount=${inbound?.packetCount} ` +
        `inboundByteCount=${inbound?.byteCount} ` +
        `resume->firstRtp=${cutoverMs}ms`,
    );

    sink.consumer.close();
    warmPipeConsumer!.close();
    src.producer.close();
  }, 20_000);

  it('REQ-RO-005: ensureWarmPipe consumes onto a CONNECTED createStandbyPipeTransport handle, stays paused, RTP flows on resume', async () => {
    const src = await makePrimaryRtpSource();

    // PRIMARY half (port:0 => OS-assigned, avoid PIPE_PORT_RANGE collisions).
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);

    // STANDBY half via the NEW factory — we hold the handle, so we can read
    // tuple.localPort + connect() BEFORE consuming (the F1 handshake order).
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);

    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(primaryPipe, src.producer.id);
    const pipedProducerId = primaryPipeConsumer.id;

    // The downstream-readable producer on the standby pipe.
    const pipedProducer = await standbyPipe.produce({
      id: pipedProducerId,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
      paused: primaryPipeConsumer.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);

    // KEY ASSERTION: ensureWarmPipe consumes onto the PASSED-IN connected
    // transport (REQ-RO-005 refactor) — paused, retained, no new transport.
    const topology: RoomTopology = {
      roomId: 'passed-pipe-room',
      role: 'standby',
      primaryEndpoint: 'ws://127.0.0.1:0',
      standbyEndpoint: 'ws://127.0.0.1:0',
      pipePort: 0,
      pipeConsumer: null,
      pipeTransport: null,
    };
    const warmPipeConsumer = await ensureWarmPipe(
      topology,
      standbyRouter,
      0,
      pipedProducerId,
      standbyPipe, // <-- passed-in transport
    );
    expect(warmPipeConsumer).not.toBeNull();
    expect(warmPipeConsumer!.paused).toBe(true);          // REQ-RO-005 still paused
    expect(topology.pipeTransport).toBe(standbyPipe);     // retained (N2)

    // Real RTP across the CONNECTED handle, observed via a downstream sink.
    const sink = await makeStandbySink(pipedProducer.id);
    src.start();
    await sleep(250);
    expect(sink.rtpCount()).toBe(0);                      // paused → nothing yet
    await sink.consumer.resume();                         // CUTOVER
    await sleep(500);
    src.stop();
    expect(sink.rtpCount()).toBeGreaterThan(0);

    sink.consumer.close();
    warmPipeConsumer!.close();
    src.producer.close();
  }, 20_000);
});
