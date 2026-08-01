/**
 * Decodes a looping MP4 into raw video (I420) and audio (PCM s16le) frames
 * via ffmpeg/ffprobe, feeding them into @roamhq/wrtc's `RTCVideoSource`/
 * `RTCAudioSource`.
 *
 * Looping is done by ffmpeg itself (`-stream_loop -1` on a `pipe:1` target) —
 * verified by manual smoke test (piping a short synthetic MP4 for several
 * seconds yields more bytes than one play-through would produce) to actually
 * loop indefinitely on a pipe target rather than exiting at EOF. The
 * exit/respawn handler below is therefore a SAFETY NET for an unexpected
 * ffmpeg crash (bad file, OOM, signal), not the primary loop mechanism.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '@dvconf/shared';
import type { WrtcNonstandard } from '@dvconf/shared';

export interface VideoDimensions {
  width: number;
  height: number;
  fps: number;
}

const RESPAWN_BACKOFF_MS = 1000;

function assertOnPath(bin: string): void {
  const result = spawnSync(bin, ['-version']);
  if (result.error || result.status !== 0) {
    throw new Error(
      `${bin} not found on PATH — install ffmpeg (which provides both ffmpeg and ffprobe) before running the bot.`,
    );
  }
}

/** Probe the MP4's video stream once at startup via ffprobe. */
export async function probeVideoDimensions(mp4Path: string): Promise<VideoDimensions> {
  assertOnPath('ffprobe');
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'json',
      mp4Path,
    ]);
    let out = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code} while probing ${mp4Path}`));
        return;
      }
      try {
        const parsed = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }> };
        const stream = parsed.streams?.[0];
        if (!stream || !stream.width || !stream.height || !stream.r_frame_rate) {
          reject(new Error(`ffprobe: could not determine video dimensions/fps for ${mp4Path}`));
          return;
        }
        const [num, den] = stream.r_frame_rate.split('/').map(Number);
        const fps = den ? num! / den : num!;
        resolve({ width: stream.width, height: stream.height, fps: Math.round(fps * 100) / 100 });
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

export type MediaTrack = 'audio' | 'video';

interface RespawningProcessOpts {
  bin: string;
  args: string[];
  logger: Logger;
  label: string;
  track: MediaTrack;
  onData: (chunk: Buffer) => void;
  /** Monitoring-redesign gap #1: count only, never log stderr content. */
  onStderrData?: (track: MediaTrack) => void;
  /** Fires right before scheduling a respawn (unexpected exit). */
  onRespawn?: (track: MediaTrack) => void;
}

/** Spawn a process piping stdout to `onData`; respawn (with backoff) on an
 *  unexpected exit. Returns a stop function. */
function spawnRespawning(opts: RespawningProcessOpts): () => void {
  let stopped = false;
  let current: ChildProcessWithoutNullStreams | null = null;

  const launch = (): void => {
    if (stopped) return;
    const proc = spawn(opts.bin, opts.args);
    current = proc;
    proc.stdout.on('data', opts.onData);
    proc.stderr.on('data', () => {
      /* ffmpeg logs progress to stderr; not surfaced */
      opts.onStderrData?.(opts.track);
    });
    proc.on('error', (err) => {
      opts.logger.warn({ module: 'ffmpeg-source', label: opts.label, err: String(err) }, `${opts.label} process error`);
    });
    proc.on('close', (code, signal) => {
      if (stopped) return;
      opts.logger.warn(
        { module: 'ffmpeg-source', label: opts.label, code, signal },
        `${opts.label} exited unexpectedly (loop=${'-stream_loop -1'} should prevent this under normal operation) — respawning`,
      );
      opts.onRespawn?.(opts.track);
      setTimeout(launch, RESPAWN_BACKOFF_MS);
    });
  };
  launch();

  return () => {
    stopped = true;
    if (current !== null) current.kill('SIGTERM');
  };
}

export interface DueChunksResult {
  due: number;
  carryOut: number;
}

/** How many fixed-size chunks are "due" since the last tick, given elapsed
 *  wall-clock time -- lets a delayed setInterval tick catch up (drain
 *  several due chunks) instead of always draining exactly one, which is
 *  what silently let the backlog grow until MAX_QUEUE dropped the oldest
 *  chunk (the audible break this function exists to fix). `elapsedMs` is
 *  clamped to `maxElapsedMs` (callers pass MAX_QUEUE * chunkMs -- never
 *  claim more is "due" than the queue could ever hold) so a very long stall
 *  (process suspended, laptop sleep) doesn't demand an unbounded catch-up
 *  burst -- it just resumes from "now", same effective behavior as the old
 *  cap-and-drop, but only for truly extreme gaps. */
export function computeDueChunks(
  elapsedMs: number,
  chunkMs: number,
  carryIn: number,
  maxElapsedMs: number,
): DueChunksResult {
  const clamped = Math.min(elapsedMs, maxElapsedMs);
  const total = carryIn + clamped / chunkMs;
  const due = Math.floor(total);
  return { due, carryOut: total - due };
}

/** Pull fixed-size frames out of a byte stream. Pure — testable without a
 *  real child process. */
export class FrameBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly frameSize: number;
  private readonly onFrame: (frame: Buffer) => void;

  constructor(frameSize: number, onFrame: (frame: Buffer) => void) {
    this.frameSize = frameSize;
    this.onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= this.frameSize) {
      const frame = this.buffer.subarray(0, this.frameSize);
      this.onFrame(Buffer.from(frame));
      this.buffer = this.buffer.subarray(this.frameSize);
    }
  }
}

export interface StartVideoSourceOpts {
  mp4Path: string;
  dims: VideoDimensions;
  videoSource: InstanceType<WrtcNonstandard['RTCVideoSource']>;
  logger: Logger;
  /** Monitoring-redesign gap #1: ffmpeg health counters, all optional. */
  onFrameDrop?: (track: MediaTrack) => void;
  onStderrData?: (track: MediaTrack) => void;
  onRespawn?: (track: MediaTrack) => void;
}

/** Spawn the looping video-decode ffmpeg process and feed I420 frames into
 *  `videoSource.onFrame()` at a clock paced independently of ffmpeg's actual
 *  write timing (a queue + `setInterval`), matching the pacing pattern the
 *  bench harness already uses for its silent-audio generator. */
export function startVideoSource(opts: StartVideoSourceOpts): () => void {
  assertOnPath('ffmpeg');
  const { width, height, fps } = opts.dims;
  const frameSize = Math.floor(width * height * 1.5);
  const queue: Buffer[] = [];
  const MAX_QUEUE = Math.max(4, Math.round(fps)); // cap ~1s of buffered frames

  const frameBuffer = new FrameBuffer(frameSize, (frame) => {
    queue.push(frame);
    if (queue.length > MAX_QUEUE) {
      queue.shift(); // drop oldest if consumer falls behind
      opts.onFrameDrop?.('video');
    }
  });

  const stopProcess = spawnRespawning({
    bin: 'ffmpeg',
    args: [
      '-stream_loop', '-1',
      '-re',
      '-i', opts.mp4Path,
      '-an',
      '-f', 'rawvideo',
      '-pix_fmt', 'yuv420p',
      '-vf', `scale=${width}:${height},fps=${fps}`,
      'pipe:1',
    ],
    logger: opts.logger,
    label: 'ffmpeg-video',
    track: 'video',
    onData: (chunk) => frameBuffer.push(chunk),
    onStderrData: opts.onStderrData,
    onRespawn: opts.onRespawn,
  });

  const intervalMs = 1000 / fps;
  let lastTickAt = Date.now();
  let carry = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsedMs = now - lastTickAt;
    lastTickAt = now;
    const { due, carryOut } = computeDueChunks(elapsedMs, intervalMs, carry, MAX_QUEUE * intervalMs);
    carry = carryOut;
    for (let i = 0; i < due; i++) {
      const frame = queue.shift();
      if (frame === undefined) break; // no frame ready yet -- last displayed frame simply holds
      opts.videoSource.onFrame({ width, height, data: new Uint8Array(frame) });
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
    stopProcess();
  };
}

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const AUDIO_CHUNK_MS = 10;
/** 48000 Hz mono s16le, 10 ms chunk = 480 samples = 960 bytes. */
const AUDIO_SAMPLES_PER_CHUNK = (AUDIO_SAMPLE_RATE / 1000) * AUDIO_CHUNK_MS;
const AUDIO_BYTES_PER_CHUNK = AUDIO_SAMPLES_PER_CHUNK * 2 * AUDIO_CHANNELS;

export interface StartAudioSourceOpts {
  mp4Path: string;
  audioSource: InstanceType<WrtcNonstandard['RTCAudioSource']>;
  logger: Logger;
  /** Monitoring-redesign gap #1: ffmpeg health counters, all optional. */
  onFrameDrop?: (track: MediaTrack) => void;
  onStderrData?: (track: MediaTrack) => void;
  onRespawn?: (track: MediaTrack) => void;
  /** Fires when the queue is genuinely empty (ffmpeg itself behind
   *  schedule, not just a delayed consumer tick) and a silence frame was
   *  fed in place of real audio -- see startAudioSource's timer. */
  onUnderrun?: (track: MediaTrack) => void;
}

/** Spawn the looping audio-decode ffmpeg process and feed 10ms PCM chunks
 *  into `audioSource.onData()`, paced the same way as the video source. */
export function startAudioSource(opts: StartAudioSourceOpts): () => void {
  assertOnPath('ffmpeg');
  const queue: Buffer[] = [];
  const MAX_QUEUE = 1000 / AUDIO_CHUNK_MS; // cap ~1s of buffered audio

  const frameBuffer = new FrameBuffer(AUDIO_BYTES_PER_CHUNK, (chunk) => {
    queue.push(chunk);
    if (queue.length > MAX_QUEUE) {
      queue.shift();
      opts.onFrameDrop?.('audio');
    }
  });

  const stopProcess = spawnRespawning({
    bin: 'ffmpeg',
    args: [
      '-stream_loop', '-1',
      '-re',
      '-i', opts.mp4Path,
      '-vn',
      '-f', 's16le',
      '-ar', String(AUDIO_SAMPLE_RATE),
      '-ac', String(AUDIO_CHANNELS),
      'pipe:1',
    ],
    logger: opts.logger,
    label: 'ffmpeg-audio',
    track: 'audio',
    onData: (chunk) => frameBuffer.push(chunk),
    onStderrData: opts.onStderrData,
    onRespawn: opts.onRespawn,
  });

  // chunk.buffer is Node's shared Buffer pool (8192 bytes), not a tightly-
  // sized ArrayBuffer -- @roamhq/wrtc's native binding validates
  // samples.buffer.byteLength against numberOfFrames*channelCount*2 directly
  // (ignoring byteOffset/length), so passing the pooled buffer as-is throws
  // "Expected a .byteLength of 960, not 8192". slice() copies into a
  // freshly-sized ArrayBuffer, decoupled from the pool.
  const emit = (samples: Int16Array): void => {
    opts.audioSource.onData({
      samples,
      sampleRate: AUDIO_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: AUDIO_CHANNELS,
      numberOfFrames: AUDIO_SAMPLES_PER_CHUNK,
    });
  };

  let lastTickAt = Date.now();
  let carry = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const elapsedMs = now - lastTickAt;
    lastTickAt = now;
    const { due, carryOut } = computeDueChunks(elapsedMs, AUDIO_CHUNK_MS, carry, MAX_QUEUE * AUDIO_CHUNK_MS);
    carry = carryOut;
    for (let i = 0; i < due; i++) {
      const chunk = queue.shift();
      if (chunk === undefined) {
        // Genuine underrun (ffmpeg itself behind, not just a delayed
        // timer): feed silence so the track keeps a continuous frame
        // instead of a gap -- turns a discontinuity/pop into a brief,
        // natural silence.
        emit(new Int16Array(AUDIO_SAMPLES_PER_CHUNK));
        opts.onUnderrun?.('audio');
        continue;
      }
      const exact = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length);
      emit(new Int16Array(exact));
    }
  }, AUDIO_CHUNK_MS);

  return () => {
    clearInterval(timer);
    stopProcess();
  };
}
