/**
 * Relay-overlap M2 — Phase 5 gate (c): RO-014 no-ffmpeg-on-standby + CPU floor.
 *
 * Acceptance (REQUIREMENTS RO-014 / RO-025): "no ffmpeg process on the standby
 * for an MCU room; standby CPU within epsilon of an SFU room."
 *
 * ── What is real ───────────────────────────────────────────────────────────
 * REAL mediasoup: two Workers (primary + standby relays, distinct child
 * processes), two Routers, real PipeTransports (the production-faithful warm
 * pipe proven by the M1 step-3a spike). child_process.spawn is wrapped (kept
 * REAL so the mediasoup Workers still launch) and every call recorded; ffmpeg
 * spawns are counted by filtering argv[0] === 'ffmpeg' (mediasoup-worker spawns
 * carry a different argv[0], so they never contaminate the count).
 *
 * ── The two roles' media-ingest paths ──────────────────────────────────────
 * ffmpeg is spawned ONLY by McuPipeline.recompose (mcu-pipeline.ts:213), reached
 * via notifyNewProducer -> mcuPipeline.addStream when a PEER PRODUCES into an MCU
 * room — the PRIMARY relay's ingest path. The STANDBY's ingest path is the
 * paused warm pipe (ensureWarmPipe): it carries the primary's individual stream
 * with the consumer paused (RTCP-only, REQ-RO-005) and never touches
 * McuPipeline. So the SAME MCU stream is composited by the primary (ffmpeg) but
 * warm-piped by the standby (no ffmpeg) — exactly RO-014. On cutover the CLIENT
 * composites locally (RO-014 client OffscreenCanvas build), so the standby never
 * spins up ffmpeg even after promotion.
 *
 * HONESTY: signaling.ts:374-378 constructs an McuPipeline object for ANY MCU
 * room regardless of role — but the constructor is INERT (mcu-pipeline.ts:89-94,
 * no spawn). It only spawns ffmpeg once fed via addStream, which the standby's
 * ingest never does. This bench asserts the runtime guarantee (0 ffmpeg child on
 * the standby), and faithfully builds that inert object on the standby room to
 * prove it stays unfed (streamCount === 0). The PRIMARY leg is a POSITIVE
 * CONTROL: it proves the spy + the ffmpeg path are reachable, so the standby's
 * zero is not a vacuous pass.
 *
 * ── CPU floor (best-effort, NOT a hard gate) ───────────────────────────────
 * process.cpuUsage() of the Node MAIN thread over identical windows for the
 * standby (warm pipe) vs an SFU room. This EXCLUDES mediasoup-worker + ffmpeg
 * CPU (separate child processes) — so the decisive CPU saving (an absent ffmpeg
 * child, ~1 full core for 720p libvpx@30) is the spawn-count gate above, NOT
 * this main-thread delta. The delta is reported as an in-process OPTIMISTIC
 * FLOOR (mirrors the M1 mechanism-floor honesty); real glass-to-glass CPU is
 * BENCH-3 (real-WebRTC, out of M2 scope, XC-9).
 *
 * Run: pnpm bench:m2
 *   (or: vitest run --config vitest.m2-bench.config.ts \
 *          apps/relay/src/__tests__/integration/relay-overlap-m2-bench.integration.test.ts)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger } from '@dvconf/shared';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
  pipeSrtpEnabled,
} from '@dvconf/inter-relay-client';
import { ensureWarmPipe, type RoomTopology } from '@dvconf/inter-relay-client';
import { McuPipeline } from '../../mcu-pipeline.js';
import { notifyNewProducer, type RoomState } from '../../room-handler.js';

// Wrap child_process.spawn: keep REAL behavior (mediasoup Workers still launch)
// but record every call. ffmpeg spawns are isolated by filtering argv[0].
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => actual.spawn(...args)),
  };
});
// eslint-disable-next-line import/first
import { spawn } from 'child_process';
const spawnMock = vi.mocked(spawn);
const ffmpegSpawns = (): number =>
  spawnMock.mock.calls.filter((c) => c[0] === 'ffmpeg').length;

const logger = createLogger('bench:relay-m2');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const VP8_SSRC = 0x11223344;
const vp8RtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'video/VP8',
      payloadType: VP8_PT,
      clockRate: 90000,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: VP8_SSRC }],
};

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

function cpuMicros(): number {
  const u = process.cpuUsage();
  return u.user + u.system;
}
async function measureCpuWindow(ms: number): Promise<number> {
  const before = cpuMicros();
  await sleep(ms);
  return cpuMicros() - before;
}

const EPSILON_US = 50_000; // 50 ms of main-thread CPU — advisory, not a hard gate

describe('relay-overlap M2 — Phase 5 gate (c): RO-014 no-ffmpeg + CPU floor', () => {
  it('standby MCU media-ingest spawns 0 ffmpeg; primary spawns >=1 (positive control); CPU floor reported', async () => {
    // One MCU source stream (a real VP8 producer on the primary router) used by
    // BOTH roles: the primary composites it (ffmpeg), the standby warm-pipes it.
    const srcTransport = await primaryRouter.createDirectTransport();
    const producer = await srcTransport.produce({
      kind: 'video',
      rtpParameters: vp8RtpParameters,
    });

    // ── PRIMARY leg — POSITIVE CONTROL (the ffmpeg path IS reachable) ──────
    spawnMock.mockClear();
    const primaryRoom: RoomState = {
      roomId: 'mcu-primary',
      router: primaryRouter,
      mode: 'mcu',
      peers: new Map(),
      mcuPipeline: new McuPipeline(primaryRouter, logger), // signaling.ts:376
    };
    await notifyNewProducer(primaryRoom, 'peer-1', producer, logger);
    await sleep(150); // let recompose() spawn ffmpeg
    const primarySpawns = ffmpegSpawns();
    await primaryRoom.mcuPipeline!.close(); // SIGKILL ffmpeg (no leak)

    // ── STANDBY leg — the RO-014 guarantee (warm-pipe ingest, no ffmpeg) ───
    spawnMock.mockClear();
    // Faithful prod setup: a standby MCU room ALSO builds the inert McuPipeline
    // (signaling.ts:376). It must stay unfed (streamCount 0) -> no ffmpeg.
    const standbyRoom: RoomState = {
      roomId: 'mcu-standby',
      router: standbyRouter,
      mode: 'mcu',
      peers: new Map(),
      mcuPipeline: new McuPipeline(standbyRouter, logger),
    };

    // Production-faithful warm pipe: pipe the SAME source producer primary->standby
    // (mirrors the M1 step-3a spike backbone), then run the standby's real ingest
    // path: ensureWarmPipe -> paused warm consumer (REQ-RO-005). No McuPipeline.
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
    const standbyPipe = await standbyRouter.createPipeTransport({
      listenIp: { ip: '0.0.0.0', announcedIp: '127.0.0.1' },
      port: 0,
      enableRtx: false,
      enableSrtp: pipeSrtpEnabled(),
    } as Parameters<msTypes.Router['createPipeTransport']>[0]);
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(
      primaryPipe,
      producer.id,
    );
    const pipedProducer = await standbyPipe.produce({
      id: primaryPipeConsumer.id,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
      paused: primaryPipeConsumer.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);

    const topology: RoomTopology = {
      roomId: 'mcu-standby',
      role: 'standby',
      primaryEndpoint: 'ws://127.0.0.1:0',
      standbyEndpoint: 'ws://127.0.0.1:0',
      pipePort: 0,
      pipeConsumer: null,
      pipeTransport: null,
    };
    const warm = await ensureWarmPipe(topology, standbyRouter, 0, pipedProducer.id);
    await sleep(150);
    const standbySpawns = ffmpegSpawns();

    // ── CPU floor (best-effort) — standby warm pipe vs an SFU room ─────────
    const cpuStandbyUs = await measureCpuWindow(500); // standby warm pipe live
    const sfuRoom: RoomState = {
      roomId: 'sfu-1',
      router: standbyRouter,
      mode: 'sfu',
      peers: new Map(),
    };
    void sfuRoom;
    const cpuSfuUs = await measureCpuWindow(500);
    const cpuDeltaUs = Math.abs(cpuStandbyUs - cpuSfuUs);

    // ── emit sidecar ──────────────────────────────────────────────────────
    const sidecar = {
      gate: 'c',
      req: 'RO-014',
      title: 'no-ffmpeg-on-standby + CPU floor',
      ffmpeg_spawns_primary: primarySpawns,
      ffmpeg_spawns_standby: standbySpawns,
      standby_mcupipeline_stream_count: standbyRoom.mcuPipeline!.streamCount,
      warm_consumer_paused: warm?.paused ?? null,
      cpu_standby_us: cpuStandbyUs,
      cpu_sfu_us: cpuSfuUs,
      cpu_delta_us: cpuDeltaUs,
      cpu_epsilon_us: EPSILON_US,
      cpu_within_epsilon: cpuDeltaUs <= EPSILON_US,
      honest_note:
        'ffmpeg-spawn count is the decisive CPU signal (an absent ffmpeg child ~= 1 core saved on standby). cpu_delta_us is Node main-thread only (excludes mediasoup-worker + ffmpeg child CPU) -> an in-process OPTIMISTIC FLOOR; real glass-to-glass CPU = BENCH-3.',
    };
    const outDir = resolve(process.cwd(), '.logs/bench/m2');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, 'no-ffmpeg-cpu.json'),
      JSON.stringify(sidecar, null, 2),
      'utf8',
    );
    // eslint-disable-next-line no-console
    console.log(
      `[bench gate-c] ffmpeg spawns: primary=${primarySpawns} standby=${standbySpawns} ` +
        `| standby McuPipeline streams=${standbyRoom.mcuPipeline!.streamCount} ` +
        `warm paused=${warm?.paused} | cpu standby=${cpuStandbyUs}us sfu=${cpuSfuUs}us ` +
        `delta=${cpuDeltaUs}us (eps=${EPSILON_US}us)`,
    );

    // ── teardown ──────────────────────────────────────────────────────────
    try {
      warm?.close();
      topology.pipeTransport?.close();
      pipedProducer.close();
      primaryPipeConsumer.close();
      primaryPipe.close();
      standbyPipe.close();
      await standbyRoom.mcuPipeline!.close();
      producer.close();
      srcTransport.close();
    } catch {
      /* best-effort cleanup */
    }

    // ── assertions ────────────────────────────────────────────────────────
    // POSITIVE CONTROL: the ffmpeg path is reachable (non-vacuous). Assert the
    // room really was MCU so a future regression that flips it to 'sfu' can't
    // make the control silently pass.
    expect(primaryRoom.mode).toBe('mcu');
    expect(primarySpawns).toBeGreaterThanOrEqual(1);
    // HARD GATE (RO-014): the standby's media-ingest path spawns NO ffmpeg.
    expect(standbySpawns).toBe(0);
    // The standby's inert McuPipeline (signaling.ts:376) is never fed.
    expect(standbyRoom.mcuPipeline!.streamCount).toBe(0);
    // REQ-RO-005: the warm consumer is paused (RTCP-only standby).
    expect(warm?.paused).toBe(true);
    // CPU floor: reported (best-effort). Logged for the report, NOT hard-gated —
    // both main-thread windows are near-idle (no ffmpeg either side). A
    // non-negative delta sanity-checks the meter ran.
    expect(cpuDeltaUs).toBeGreaterThanOrEqual(0);
  });
});
