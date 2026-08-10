/**
 * W5 M1 — SINGLE-WORKER forwarding-CEILING bench (advisor-gate-2 follow-up).
 *
 * The P9 hard-gate (bandwidth-scale-bench.integration.test.ts) proved the
 * BANDWIDTH math: layer-select + off-page-pause forwards >=3x fewer bytes. It
 * did NOT answer "how big a room can ONE relay node actually hold?" — i.e. the
 * single mediasoup Worker CPU ceiling. That is the only scale question a SINGLE
 * developer machine can answer honestly (100 real browser clients on one box
 * would saturate the CLIENTS' encoders, not the relay — a meaningless number).
 *
 * ── Model: FAN-OUT, not N-producers-x-1-consumer ─────────────────────────────
 * In an SFU the expensive work is FORWARDING (copy each incoming packet to every
 * subscribed consumer), and that is what a single Worker's core spends CPU on.
 * So we model a realistic page: P=9 visible producers (1 active speaker + 8
 * thumbnails) fanned out to M VIEWERS. Each viewer = 1 DirectTransport carrying
 * 9 consumers (one per visible producer), exactly the M1 per-viewer downlink.
 *
 *   Worker forwarding copies ~= P * M  (e.g. M=100 -> ~900 forward paths — the
 *   same O(N x page_size) load a 100-person room imposes on the relay).
 *
 * Injection stays CONSTANT in M (only 9 producers to feed), so the JS injector
 * never becomes the M-dependent bottleneck — the Worker's C++ forwarding does.
 * mediasoup Workers are separate C++ subprocesses, so worker.getResourceUsage()
 * reads the FORWARDING CPU cleanly, not polluted by the Node injector thread.
 *
 * ── Two policies at each M ────────────────────────────────────────────────────
 *   BASELINE  (no select): all 9 consumers/viewer at spatialLayer:2 (high).
 *   OPTIMIZED (M1 page-9): consumer 0 at :2, consumers 1..8 at :0 (low).
 * Same forward-PATH count (P*M); OPTIMIZED moves most copies to the tiny low
 * layer, so it should sustain a far larger M before the core saturates.
 *
 * ── Signals (ramp M, find the knee) ──────────────────────────────────────────
 *   1. cpuCores = (d.ru_utime + d.ru_stime) ms / windowMs  — worker CPU in cores
 *      (mediasoup reports ru_utime/ru_stime in MILLISECONDS of CPU time).
 *   2. deliveryHealth = mean per-consumer forwarded throughput at M, relative to
 *      the smallest-M reference. ~1.0 = worker keeps up; a drop = it is dropping
 *      packets = SATURATED. (Sampled over the first few viewers to keep getStats
 *      overhead M-independent.)
 * The knee = the largest M where cpuCores stays below ~1 core AND deliveryHealth
 * stays >= ~0.9.
 *
 * ── Honesty bounds (mechanism-floor discipline, mirrors P9 + relay-overlap) ───
 *  - DirectTransport SKIPS SRTP encrypt/decrypt — real WebRTC pays that per
 *    packet, so the measured CPU is OPTIMISTIC. The real-SRTP ceiling is LOWER
 *    than the UNKNOWN DirectTransport boundary (this harness's boundary was
 *    never located — it broke before reaching it); the real-SRTP ceiling's
 *    relation to any measured point (e.g. the 540-path delivery-healthy
 *    sample) is UNMEASURED.
 *  - Single box, synthetic RTP source, no WAN, no jitter/congestion control.
 *  - One Worker == one core. Multi-worker / multi-node cascade (which spreads a
 *    big room across cores/hosts) is NOT built (DA-5) — extrapolating past one
 *    worker is a documented assumption, not a measurement.
 * This bench finds the ONE-WORKER forwarding ceiling; it is NOT a production
 * capacity number. It is exploratory (logs a curve), NOT a hard pass/fail gate.
 *
 * EXPLORATORY + SLOW + non-reproducible -> SKIPPED unless SAT_BENCH=1, so the
 * default relay-integration suite never runs (and never hangs on) it.
 *
 * See single-worker-saturation-bench.fixtures.ts for the shared harness
 * (rampPass, knee, worker beforeAll/afterAll, RTP/RTCP builders).
 *
 * Run: SAT_BENCH=1 [SAT_RAMP=10,20,30] pnpm exec vitest run \
 *        --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/single-worker-saturation-bench.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import * as mediasoup from 'mediasoup';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  RUN_SATURATION,
  RAMP,
  PAGE_SIZE,
  WINDOW_MS,
  SETTLE_MS,
  rampPass,
  knee,
} from './single-worker-saturation-bench.fixtures.js';

describe('W5 M1 — single-worker forwarding-ceiling bench (REAL mediasoup, advisor-gate-2)', () => {
  // Skipped unless SAT_BENCH=1 — slow, exploratory, non-reproducible on a dev box.
  (RUN_SATURATION ? it : it.skip)(
    'ramps viewers per page-9 grid and locates the one-worker CPU/delivery knee',
    async () => {
      // REQ-RMS-001 — three named capacity-calibration modes. The video-only
      // OPTIMIZED curve is the PRIMARY (C_worker is read from its knee); the two
      // audio modes measure the audio-cost tax (baked-in vs separate).
      const os = await import('node:os');
      const cores = os.cpus().length;

      const videoCurve = await rampPass({ optimized: true, audio: 'video-only' });
      const audioCurve = await rampPass({ optimized: false, audio: 'audio-only-N' });
      const mixedCurve = await rampPass({ optimized: true, audio: 'mixed-30-70' });

      const videoKnee = knee(videoCurve);
      const audioKnee = knee(audioCurve);
      const mixedKnee = knee(mixedCurve);
      const lastRamp = RAMP[RAMP.length - 1];
      // eslint-disable-next-line no-console
      console.log(
        `\n[knee] video-only: ${videoKnee ? `M=${videoKnee.m} [${videoKnee.bound}] ${videoKnee.reason}` : `NOT saturated up to M=${videoCurve[videoCurve.length - 1]?.m ?? lastRamp}`}` +
          `\n[knee] audio-only-N: ${audioKnee ? `M=${audioKnee.m} [${audioKnee.bound}] ${audioKnee.reason}` : `NOT saturated up to M=${audioCurve[audioCurve.length - 1]?.m ?? lastRamp}`}` +
          `\n[knee] mixed-30-70: ${mixedKnee ? `M=${mixedKnee.m} [${mixedKnee.bound}] ${mixedKnee.reason}` : `NOT saturated up to M=${mixedCurve[mixedCurve.length - 1]?.m ?? lastRamp}`}`,
      );

      // C_worker = forward-paths at the video-only knee (the per-room ceiling).
      // null when the worker never saturated within this (modest) ramp -> the
      // reporter flags that as INCOMPLETE rather than inventing a number.
      const cWorkerPaths = videoKnee
        ? (videoCurve.find((s) => s.m === videoKnee.m)?.forwardPaths ?? null)
        : null;
      // C_relay = cores * C_worker — an EXTRAPOLATION (one Worker benched), not a measurement.
      const cRelayPaths = cWorkerPaths === null ? null : cWorkerPaths * cores;
      // audioBakedIn: true when the mixed-mode knee lands materially BELOW the
      // video-only knee, i.e. audio fan-out meaningfully eats into C_worker.
      const audioBakedIn =
        mixedKnee !== null && videoKnee !== null && mixedKnee.m < videoKnee.m;

      const sidecar = {
        bench: 'single-worker-forwarding-ceiling',
        mode: '3-mode',
        phase: 'relay-mesh-scaling M1 (REQ-RMS-001)',
        mediasoupVersion: mediasoup.version,
        numWorkers: 1,
        cores,
        pageSize: PAGE_SIZE,
        windowMs: WINDOW_MS,
        settleMs: SETTLE_MS,
        ramp: RAMP,
        videoCurve,
        audioCurve,
        mixedCurve,
        videoKnee,
        audioKnee,
        mixedKnee,
        cWorkerPaths,
        cRelayPaths,
        audioBakedIn,
        honest_note:
          'ONE mediasoup Worker (==one core) forwarding ceiling. DirectTransport SKIPS SRTP -> measured CPU is OPTIMISTIC; the real-SRTP ceiling is LOWER than the UNKNOWN DirectTransport boundary, and its relation to any measured point (e.g. the 540-path delivery-healthy sample) is UNMEASURED. Single box, synthetic RTP, no WAN/jitter. Multi-worker/multi-node cascade (DA-5) NOT built; extrapolating past one worker is a documented assumption, not a measurement. Exploratory curve, not a pass/fail gate.',
        audio_note:
          'audio-only fan-out is O(N^2); C_relay = cores*C_worker is an EXTRAPOLATION not a measurement; SRTP skipped -> CPU optimistic, +-2-3x variance. Synthetic Opus carries the ssrc-audio-level RTP header extension (mediasoup level meter does not decode payload); no server-side audio last-N (REQ-RMS-012 deferred), so audio paths are counted CONSERVATIVELY.',
      };
      const sidecarPath = resolve(process.cwd(), '.logs/bench/rms/saturation-3mode.json');
      mkdirSync(dirname(sidecarPath), { recursive: true });
      writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf8');
      // eslint-disable-next-line no-console
      console.log(`[saturation] sidecar -> ${sidecarPath}`);

      // ── Sanity guards only (EXPLORATORY bench, NOT a hard pass/fail gate) ─────
      // Real media flowed and the injector was healthy at the smallest M (no
      // dead-pipe false read, reference point trustworthy).
      expect(videoCurve[0]!.perViewerThroughput).toBeGreaterThan(0);
      expect(videoCurve[0]!.deliveryHealth).toBe(1);
      // The worker did real forwarding work somewhere on the ramp (load registered
      // on the clean subprocess CPU read — not a no-op measurement).
      const peakCpu = Math.max(
        ...videoCurve.map((s) => s.cpuCores),
        ...audioCurve.map((s) => s.cpuCores),
        ...mixedCurve.map((s) => s.cpuCores),
      );
      expect(peakCpu).toBeGreaterThan(0.1);
      // The audio mode actually fanned out (no silent zero-audio false read).
      expect(audioCurve[0]!.audioPaths).toBeGreaterThan(0);
      // NOTE: we deliberately do NOT assert OPTIMIZED CPU < BASELINE CPU — the
      // smoke run showed they are ~EQUAL, because forwarding CPU tracks PACKET
      // count (both layers share the packet rate), not payload bytes. Layer-select
      // saves downlink BANDWIDTH; PAGINATION+PAUSE (fewer paths) is what saves
      // relay CPU. That finding is the point of this bench, not a failure.
    },
    600_000,
  );
});
