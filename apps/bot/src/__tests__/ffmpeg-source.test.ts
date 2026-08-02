import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { FrameBuffer, computeDueCount } from '../media/ffmpeg-source.js';

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

describe('computeDueCount', () => {
  it('one chunk-width elapsed with nothing emitted yet -- due 1', () => {
    expect(computeDueCount(10, 0, 10, 0, 1000)).toBe(1);
  });

  it('elapsed time beyond a single chunk-width catches up (due > 1)', () => {
    expect(computeDueCount(35, 0, 10, 0, 1000)).toBe(3);
  });

  it('already-emitted count is subtracted from the absolute target', () => {
    // 35ms / 10ms chunks -> target 3; 2 already emitted -> only 1 due now.
    expect(computeDueCount(35, 0, 10, 2, 1000)).toBe(1);
  });

  it('never goes negative when alreadyEmitted is ahead of the target (an early tick)', () => {
    expect(computeDueCount(35, 0, 10, 10, 1000)).toBe(0);
  });

  it('clamps a very long stall so catch-up never exceeds the queue cap', () => {
    const maxCatchUpChunks = 100; // e.g. MAX_QUEUE
    const result = computeDueCount(60_000, 0, 10, 0, maxCatchUpChunks); // process suspended 60s
    expect(result).toBe(maxCatchUpChunks);
  });

  it('two tracks sharing one mediaStartedAt converge on the same target regardless of chunk size', () => {
    // audio: 10ms chunks: video: 33.33ms chunks (30fps) -- both measured from
    // the same absolute start, 100ms elapsed.
    const audioDue = computeDueCount(100, 0, 10, 0, 1000);
    const videoDue = computeDueCount(100, 0, 1000 / 30, 0, 1000);
    expect(audioDue).toBe(10);
    expect(videoDue).toBe(3); // floor(100 / 33.33)
  });
});

describe('ffmpeg health counters (monitoring-redesign gap #1)', () => {
  beforeEach(() => {
    lastSpawned = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      mediaStartedAt: Date.now(),
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
      mediaStartedAt: Date.now(),
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
      mediaStartedAt: Date.now(),
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
      mediaStartedAt: Date.now(),
      onRespawn,
    });
    lastSpawned!.emit('close', 1, null);

    expect(onRespawn).toHaveBeenCalledTimes(1);
    expect(onRespawn).toHaveBeenCalledWith('audio');
    stop();
  });

  it('startAudioSource: does not fire onUnderrun before any real chunk has ever arrived', async () => {
    const { startAudioSource } = await import('../media/ffmpeg-source.js');
    const onUnderrun = vi.fn();
    const onData = vi.fn();
    const audioSource = { onData } as never;
    const stop = startAudioSource({
      mp4Path: '/tmp/fake.mp4',
      audioSource,
      logger: fakeLogger,
      mediaStartedAt: Date.now(),
      onUnderrun,
    });

    // No data ever pushed into the queue -- nothing decoded yet, so this
    // must NOT fake progress with silence (that would let audio's clock
    // race ahead of video's during ffmpeg startup, see startAudioSource).
    await vi.advanceTimersByTimeAsync(10);

    expect(onUnderrun).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
    stop();
  });

  it('startAudioSource: feeds silence and fires onUnderrun on a genuine underrun once real audio has started', async () => {
    const { startAudioSource } = await import('../media/ffmpeg-source.js');
    const onUnderrun = vi.fn();
    const onData = vi.fn();
    const audioSource = { onData } as never;
    const stop = startAudioSource({
      mp4Path: '/tmp/fake.mp4',
      audioSource,
      logger: fakeLogger,
      mediaStartedAt: Date.now(),
      onUnderrun,
    });

    // First tick: exactly one real chunk queued -- consumes it, no underrun.
    lastSpawned!.stdout.emit('data', Buffer.alloc(960));
    await vi.advanceTimersByTimeAsync(10);
    expect(onUnderrun).not.toHaveBeenCalled();
    expect(onData).toHaveBeenCalledTimes(1);

    // Second tick: queue now empty, but real audio has already started --
    // must feed silence instead of skipping the call outright.
    await vi.advanceTimersByTimeAsync(10);

    expect(onUnderrun).toHaveBeenCalledWith('audio');
    expect(onData).toHaveBeenCalledTimes(2);
    const samples = onData.mock.calls[1]?.[0]?.samples as Int16Array;
    expect(samples).toHaveLength(480);
    expect(Array.from(samples).every((s) => s === 0)).toBe(true);
    stop();
  });

  it('startVideoSource: repeats the last frame and fires onUnderrun when the queue is empty on tick', async () => {
    const { startVideoSource } = await import('../media/ffmpeg-source.js');
    const onUnderrun = vi.fn();
    const onFrame = vi.fn();
    const videoSource = { onFrame } as never;
    const dims = { width: 2, height: 2, fps: 25 }; // intervalMs = 40, a clean integer
    const frameSize = Math.floor(dims.width * dims.height * 1.5); // 6
    const stop = startVideoSource({
      mp4Path: '/tmp/fake.mp4',
      dims,
      videoSource,
      logger: fakeLogger,
      mediaStartedAt: Date.now(),
      onUnderrun,
    });

    // First tick: exactly one frame is queued -- draws it, no underrun yet.
    lastSpawned!.stdout.emit('data', Buffer.alloc(frameSize, 7));
    await vi.advanceTimersByTimeAsync(40);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onUnderrun).not.toHaveBeenCalled();
    const firstFrameData = onFrame.mock.calls[0]?.[0]?.data;

    // Second tick: queue is now empty -- must repeat the last frame instead
    // of holding silently, and report the underrun.
    await vi.advanceTimersByTimeAsync(40);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onUnderrun).toHaveBeenCalledWith('video');
    expect(onFrame.mock.calls[1]?.[0]?.data).toEqual(firstFrameData);
    stop();
  });

  it('startVideoSource: does not fire onUnderrun before any frame has ever been drawn', async () => {
    const { startVideoSource } = await import('../media/ffmpeg-source.js');
    const onUnderrun = vi.fn();
    const onFrame = vi.fn();
    const videoSource = { onFrame } as never;
    const stop = startVideoSource({
      mp4Path: '/tmp/fake.mp4',
      dims: { width: 2, height: 2, fps: 30 },
      videoSource,
      logger: fakeLogger,
      mediaStartedAt: Date.now(),
      onUnderrun,
    });

    // Queue empty from the very start -- nothing decoded yet, nothing to repeat.
    await vi.advanceTimersByTimeAsync(1000 / 30);

    expect(onFrame).not.toHaveBeenCalled();
    expect(onUnderrun).not.toHaveBeenCalled();
    stop();
  });
});
