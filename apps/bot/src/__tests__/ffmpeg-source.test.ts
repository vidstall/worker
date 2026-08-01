import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { FrameBuffer, computeDueChunks } from '../media/ffmpeg-source.js';

// ── Mocked child_process (monitoring-redesign gap #1 wiring tests) ─────────
// FrameBuffer's own tests above stay 100% real (pure, no process). The
// respawn/stderr/frame-drop COUNTER wiring lives in spawnRespawning +
// startVideoSource/startAudioSource, which spawn a REAL ffmpeg -- mocking
// child_process here tests the wiring without depending on ffmpeg actually
// being installed or on real encode timing.

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let lastSpawned: FakeChildProcess | null = null;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    lastSpawned = new FakeChildProcess();
    return lastSpawned;
  }),
  spawnSync: vi.fn(() => ({ error: null, status: 0 })),
}));

const fakeLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

describe('FrameBuffer', () => {
  it('emits nothing until a full frame worth of bytes has arrived', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(10, onFrame);
    fb.push(Buffer.alloc(4));
    fb.push(Buffer.alloc(5));
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('emits exactly one frame once the frame size is reached, keeping the remainder buffered', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(10, onFrame);
    fb.push(Buffer.alloc(12, 1));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]?.[0]).toHaveLength(10);
  });

  it('emits multiple frames when several frames worth of bytes arrive at once', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(4, onFrame);
    fb.push(Buffer.alloc(17)); // 4 full frames + 1 leftover byte
    expect(onFrame).toHaveBeenCalledTimes(4);
  });

  it('accumulates across pushes that individually are smaller than one frame', () => {
    const onFrame = vi.fn();
    const fb = new FrameBuffer(6, onFrame);
    fb.push(Buffer.alloc(2));
    fb.push(Buffer.alloc(2));
    expect(onFrame).not.toHaveBeenCalled();
    fb.push(Buffer.alloc(2));
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('I420 frame size math: width*height*1.5 for a 640x480 frame', () => {
    const width = 640;
    const height = 480;
    const frameSize = Math.floor(width * height * 1.5);
    const onFrame = vi.fn();
    const fb = new FrameBuffer(frameSize, onFrame);
    fb.push(Buffer.alloc(frameSize));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(frameSize).toBe(460800);
  });

  it('48kHz mono s16le 10ms PCM chunk size is 960 bytes (480 samples * 2 bytes)', () => {
    const sampleRate = 48000;
    const channels = 1;
    const chunkMs = 10;
    const samplesPerChunk = (sampleRate / 1000) * chunkMs;
    const bytesPerChunk = samplesPerChunk * 2 * channels;
    expect(samplesPerChunk).toBe(480);
    expect(bytesPerChunk).toBe(960);
  });
});

describe('computeDueChunks', () => {
  it('one chunk-width elapsed -- due 1, no carry', () => {
    expect(computeDueChunks(10, 10, 0, 1000)).toEqual({ due: 1, carryOut: 0 });
  });

  it('elapsed time beyond a single chunk-width catches up (due > 1)', () => {
    expect(computeDueChunks(35, 10, 0, 1000)).toEqual({ due: 3, carryOut: 0.5 });
  });

  it('carry accumulates across calls until it produces an extra due chunk', () => {
    const first = computeDueChunks(9, 10, 0, 1000); // 0.9 due -- none yet
    expect(first).toEqual({ due: 0, carryOut: 0.9 });
    const second = computeDueChunks(9, 10, first.carryOut, 1000); // 0.9 + 0.9 = 1.8
    expect(second).toEqual({ due: 1, carryOut: expect.closeTo(0.8, 10) });
  });

  it('clamps a very long stall so catch-up never exceeds the queue cap', () => {
    const maxElapsedMs = 1000; // e.g. MAX_QUEUE(100) * chunkMs(10)
    const result = computeDueChunks(60_000, 10, 0, maxElapsedMs); // process suspended 60s
    expect(result.due).toBe(maxElapsedMs / 10);
  });
});

describe('ffmpeg health counters (monitoring-redesign gap #1)', () => {
  beforeEach(() => {
    lastSpawned = null;
    vi.useFakeTimers();
  });

  it('startVideoSource: onFrameDrop fires once the consumer queue exceeds its cap', async () => {
    const { startVideoSource } = await import('../media/ffmpeg-source.js');
    const onFrameDrop = vi.fn();
    const videoSource = { onFrame: vi.fn() } as never;
    const stop = startVideoSource({
      mp4Path: '/tmp/fake.mp4',
      dims: { width: 2, height: 2, fps: 30 },
      videoSource,
      logger: fakeLogger,
      onFrameDrop,
    });
    const frameSize = Math.floor(2 * 2 * 1.5); // 6
    const maxQueue = Math.max(4, Math.round(30)); // 30
    // Push far more full frames than the queue can hold -- consumer (the
    // setInterval) never runs (fake timers, not advanced), so every push
    // past MAX_QUEUE must drop the oldest queued frame.
    const framesToPush = maxQueue + 5;
    lastSpawned!.stdout.emit('data', Buffer.alloc(frameSize * framesToPush));

    expect(onFrameDrop).toHaveBeenCalledTimes(5);
    expect(onFrameDrop).toHaveBeenCalledWith('video');
    stop();
  });

  it('startAudioSource: onFrameDrop fires once the consumer queue exceeds its cap', async () => {
    const { startAudioSource } = await import('../media/ffmpeg-source.js');
    const onFrameDrop = vi.fn();
    const audioSource = { onData: vi.fn() } as never;
    const stop = startAudioSource({
      mp4Path: '/tmp/fake.mp4',
      audioSource,
      logger: fakeLogger,
      onFrameDrop,
    });
    const bytesPerChunk = 960;
    const maxQueue = 1000 / 10; // 100
    const chunksToPush = maxQueue + 3;
    lastSpawned!.stdout.emit('data', Buffer.alloc(bytesPerChunk * chunksToPush));

    expect(onFrameDrop).toHaveBeenCalledTimes(3);
    expect(onFrameDrop).toHaveBeenCalledWith('audio');
    stop();
  });

  it('onStderrData fires once per stderr data event (count only)', async () => {
    const { startAudioSource } = await import('../media/ffmpeg-source.js');
    const onStderrData = vi.fn();
    const audioSource = { onData: vi.fn() } as never;
    const stop = startAudioSource({
      mp4Path: '/tmp/fake.mp4',
      audioSource,
      logger: fakeLogger,
      onStderrData,
    });
    lastSpawned!.stderr.emit('data', Buffer.from('frame=  1 fps=0.0\n'));
    lastSpawned!.stderr.emit('data', Buffer.from('frame=  2 fps=30.0\n'));

    expect(onStderrData).toHaveBeenCalledTimes(2);
    expect(onStderrData).toHaveBeenCalledWith('audio');
    stop();
  });

  it('onRespawn fires when the ffmpeg process exits unexpectedly', async () => {
    const { startAudioSource } = await import('../media/ffmpeg-source.js');
    const onRespawn = vi.fn();
    const audioSource = { onData: vi.fn() } as never;
    const stop = startAudioSource({
      mp4Path: '/tmp/fake.mp4',
      audioSource,
      logger: fakeLogger,
      onRespawn,
    });
    lastSpawned!.emit('close', 1, null);

    expect(onRespawn).toHaveBeenCalledTimes(1);
    expect(onRespawn).toHaveBeenCalledWith('audio');
    stop();
  });

  it('startAudioSource: feeds silence and fires onUnderrun when the queue is genuinely empty on tick', async () => {
    const { startAudioSource } = await import('../media/ffmpeg-source.js');
    const onUnderrun = vi.fn();
    const onData = vi.fn();
    const audioSource = { onData } as never;
    const stop = startAudioSource({
      mp4Path: '/tmp/fake.mp4',
      audioSource,
      logger: fakeLogger,
      onUnderrun,
    });

    // No data ever pushed into the queue -- the very next tick must find it
    // empty and feed silence instead of skipping the call outright.
    await vi.advanceTimersByTimeAsync(10);

    expect(onUnderrun).toHaveBeenCalledWith('audio');
    expect(onData).toHaveBeenCalledTimes(1);
    const samples = onData.mock.calls[0]?.[0]?.samples as Int16Array;
    expect(samples).toHaveLength(480);
    expect(Array.from(samples).every((s) => s === 0)).toBe(true);
    stop();
  });
});
