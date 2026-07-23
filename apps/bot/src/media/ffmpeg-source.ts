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

interface RespawningProcessOpts {
  bin: string;
  args: string[];
  logger: Logger;
  label: string;
  onData: (chunk: Buffer) => void;
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
    proc.stderr.on('data', () => { /* ffmpeg logs progress to stderr; not surfaced */ });
    proc.on('error', (err) => {
      opts.logger.warn({ module: 'ffmpeg-source', label: opts.label, err: String(err) }, `${opts.label} process error`);
    });
    proc.on('close', (code, signal) => {
      if (stopped) return;
      opts.logger.warn(
        { module: 'ffmpeg-source', label: opts.label, code, signal },
        `${opts.label} exited unexpectedly (loop=${'-stream_loop -1'} should prevent this under normal operation) — respawning`,
      );
      setTimeout(launch, RESPAWN_BACKOFF_MS);
    });
  };
  launch();

  return () => {
    stopped = true;
    if (current !== null) current.kill('SIGTERM');
  };
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
    if (queue.length > MAX_QUEUE) queue.shift(); // drop oldest if consumer falls behind
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
    onData: (chunk) => frameBuffer.push(chunk),
  });

  const intervalMs = 1000 / fps;
  const timer = setInterval(() => {
    const frame = queue.shift();
    if (frame === undefined) return; // no frame ready yet; skip this tick
    opts.videoSource.onFrame({ width, height, data: new Uint8Array(frame) });
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
}

/** Spawn the looping audio-decode ffmpeg process and feed 10ms PCM chunks
 *  into `audioSource.onData()`, paced the same way as the video source. */
export function startAudioSource(opts: StartAudioSourceOpts): () => void {
  assertOnPath('ffmpeg');
  const queue: Buffer[] = [];
  const MAX_QUEUE = 1000 / AUDIO_CHUNK_MS; // cap ~1s of buffered audio

  const frameBuffer = new FrameBuffer(AUDIO_BYTES_PER_CHUNK, (chunk) => {
    queue.push(chunk);
    if (queue.length > MAX_QUEUE) queue.shift();
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
    onData: (chunk) => frameBuffer.push(chunk),
  });

  const timer = setInterval(() => {
    const chunk = queue.shift();
    if (chunk === undefined) return;
    opts.audioSource.onData({
      samples: new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2),
      sampleRate: AUDIO_SAMPLE_RATE,
      bitsPerSample: 16,
      channelCount: AUDIO_CHANNELS,
      numberOfFrames: AUDIO_SAMPLES_PER_CHUNK,
    });
  }, AUDIO_CHUNK_MS);

  return () => {
    clearInterval(timer);
    stopProcess();
  };
}
