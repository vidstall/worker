/**
 * MCU Pipeline — ffmpeg xstack compositing for multi-participant grid output.
 *
 * Decodes individual VP8 streams via mediasoup PlainTransport (RTP),
 * composites them with ffmpeg's xstack filter into a single grid,
 * and outputs the result as a single VP8 Producer on the Router.
 *
 * Requirements: MCU-02, MCU-03, MCU-04
 */

import { spawn, type ChildProcess } from 'child_process';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';

/** Grid layout definition for xstack. */
interface GridLayout {
  cols: number;
  rows: number;
}

/** Per-stream input transport and metadata. */
interface StreamInput {
  transport: msTypes.PlainTransport;
  rtpPort: number;
  rtcpPort: number;
  consumer: msTypes.Consumer;
}

/** Adaptive resolution thresholds. */
const RESOLUTION_720P = { width: 1280, height: 720 };
const RESOLUTION_1080P = { width: 1920, height: 1080 };

/** RTP payload type for VP8. */
const VP8_PAYLOAD_TYPE = 101;
const VP8_CLOCK_RATE = 90000;

/**
 * Determine grid layout based on stream count.
 * 1:    1x1
 * 2:    2x1
 * 3-4:  2x2
 * 5-6:  3x2
 * 7-9:  3x3
 */
function getGridLayout(count: number): GridLayout {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (count <= 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  if (count <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

/**
 * Get adaptive output resolution.
 * 2-4 participants: 720p (1280x720)
 * 5+  participants: 1080p (1920x1080)
 */
function getResolution(count: number): { width: number; height: number } {
  if (count <= 4) return RESOLUTION_720P;
  return RESOLUTION_1080P;
}

/**
 * Build the xstack layout string for ffmpeg.
 * Places tiles in a grid: "0_0|w0_0|0_h0|w0_h0" etc.
 */
function buildXstackLayout(cols: number, rows: number, cellW: number, cellH: number): string {
  const parts: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      parts.push(`${c * cellW}_${r * cellH}`);
    }
  }
  return parts.join('|');
}

export class McuPipeline {
  private ffmpegProcess: ChildProcess | null = null;
  private inputStreams: Map<string, StreamInput> = new Map();
  private outputTransport: msTypes.PlainTransport | null = null;
  private _outputProducer: msTypes.Producer | null = null;
  private router: msTypes.Router;
  private logger: Logger;
  private closing = false;
  private nextRtpPort: number;
  /** Track whether SFU fallback is active due to ffmpeg crash. */
  private _sfuFallback = false;

  constructor(router: msTypes.Router, logger: Logger) {
    this.router = router;
    this.logger = logger;
    // Start assigning RTP ports from a high range to avoid conflicts with mediasoup's range
    this.nextRtpPort = parseInt(process.env['MCU_RTP_BASE_PORT'] ?? '20000', 10);
  }

  /** The composite output Producer that MCU consumers should consume. */
  get outputProducer(): msTypes.Producer | null {
    return this._outputProducer;
  }

  /** Whether this pipeline has fallen back to SFU mode due to error. */
  get sfuFallback(): boolean {
    return this._sfuFallback;
  }

  /** Number of active input streams. */
  get streamCount(): number {
    return this.inputStreams.size;
  }

  /**
   * Add a participant's stream to the MCU pipeline.
   * Creates a PlainTransport to receive RTP from the producer, then recomposes.
   */
  async addStream(peerId: string, producer: msTypes.Producer): Promise<void> {
    if (this.closing) return;

    if (this.inputStreams.has(peerId)) {
      this.logger.warn({ peerId }, 'MCU: stream already exists for peer, skipping');
      return;
    }

    // Create a PlainTransport to pipe RTP from producer to ffmpeg
    const transport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux: false,
      comedia: false,
    });

    const rtpPort = this.allocatePort();
    const rtcpPort = this.allocatePort();

    await transport.connect({
      ip: '127.0.0.1',
      port: rtpPort,
      rtcpPort,
    });

    // Consume the producer on this PlainTransport to get RTP flowing
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities: this.router.rtpCapabilities,
      paused: false,
    });

    this.inputStreams.set(peerId, {
      transport,
      rtpPort,
      rtcpPort,
      consumer,
    });

    this.logger.info(
      { peerId, rtpPort, streamCount: this.inputStreams.size },
      'MCU: added input stream',
    );

    await this.recompose();
  }

  /**
   * Remove a participant's stream from the pipeline.
   */
  async removeStream(peerId: string): Promise<void> {
    const input = this.inputStreams.get(peerId);
    if (!input) return;

    input.consumer.close();
    input.transport.close();
    this.inputStreams.delete(peerId);

    this.logger.info(
      { peerId, remainingStreams: this.inputStreams.size },
      'MCU: removed input stream',
    );

    if (this.inputStreams.size > 0 && !this.closing) {
      await this.recompose();
    } else if (this.inputStreams.size === 0) {
      this.killFfmpeg();
    }
  }

  /**
   * Kill the current ffmpeg process and respawn with updated grid layout.
   * ~200ms interruption is acceptable per design decision D-12.
   */
  async recompose(): Promise<void> {
    if (this.closing) return;

    const count = this.inputStreams.size;
    if (count === 0) {
      this.killFfmpeg();
      return;
    }

    this.killFfmpeg();

    // Ensure output transport exists
    if (!this.outputTransport) {
      await this.createOutputTransport();
    }

    const resolution = getResolution(count);
    const grid = getGridLayout(count);
    const args = this.buildFfmpegArgs(count, resolution, grid);

    this.logger.info(
      { streamCount: count, resolution, grid, args: args.join(' ') },
      'MCU: spawning ffmpeg for recompose',
    );

    const proc = spawn('ffmpeg', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.on('error', (err) => {
      this.logger.error({ err }, 'MCU: ffmpeg spawn error — falling back to SFU');
      this._sfuFallback = true;
    });

    proc.on('exit', (code, signal) => {
      if (!this.closing) {
        this.logger.warn(
          { code, signal },
          'MCU: ffmpeg exited unexpectedly — falling back to SFU for this room',
        );
        this._sfuFallback = true;
        this.ffmpegProcess = null;
      }
    });

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          this.logger.debug({ ffmpeg: line }, 'MCU: ffmpeg stderr');
        }
      });
    }

    this.ffmpegProcess = proc;
    this._sfuFallback = false;
  }

  /**
   * Build ffmpeg command-line arguments for the xstack compositing pipeline.
   */
  private buildFfmpegArgs(
    count: number,
    resolution: { width: number; height: number },
    grid: GridLayout,
  ): string[] {
    const totalSlots = grid.cols * grid.rows;
    const cellW = Math.floor(resolution.width / grid.cols);
    const cellH = Math.floor(resolution.height / grid.rows);

    const args: string[] = [];

    // Input streams from PlainTransports
    const peerIds = [...this.inputStreams.keys()];
    for (const peerId of peerIds) {
      const input = this.inputStreams.get(peerId);
      if (!input) continue;

      args.push(
        '-protocol_whitelist', 'rtp,udp',
        '-f', 'rtp',
        '-i', `rtp://127.0.0.1:${input.rtpPort}`,
      );
    }

    // Build filter_complex for xstack
    const filterParts: string[] = [];

    // Scale each input to cell size
    for (let i = 0; i < count; i++) {
      filterParts.push(`[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2[s${i}]`);
    }

    // Generate black placeholder for empty grid slots
    for (let i = count; i < totalSlots; i++) {
      filterParts.push(`color=c=black:s=${cellW}x${cellH}:r=30[s${i}]`);
    }

    // xstack inputs
    const xstackInputs = Array.from({ length: totalSlots }, (_, i) => `[s${i}]`).join('');
    const layoutStr = buildXstackLayout(grid.cols, grid.rows, cellW, cellH);

    filterParts.push(`${xstackInputs}xstack=inputs=${totalSlots}:layout=${layoutStr}[out]`);

    args.push(
      '-filter_complex', filterParts.join(';'),
      '-map', '[out]',
    );

    // Output encoding: VP8 RTP to output transport
    const outputPort = this.outputTransport
      ? (this.outputTransport.tuple as { localPort: number } | undefined)?.localPort ?? 25000
      : 25000;

    args.push(
      '-c:v', 'libvpx',
      '-b:v', '2M',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-s', `${resolution.width}x${resolution.height}`,
      '-r', '30',
      '-f', 'rtp',
      `rtp://127.0.0.1:${outputPort}?pkt_size=1200`,
    );

    return args;
  }

  /**
   * Create the output PlainTransport and Producer for composite stream.
   */
  private async createOutputTransport(): Promise<void> {
    this.outputTransport = await this.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux: false,
      comedia: true, // ffmpeg will send RTP to this transport
    });

    this._outputProducer = await this.outputTransport.produce({
      kind: 'video',
      rtpParameters: {
        codecs: [
          {
            mimeType: 'video/VP8',
            payloadType: VP8_PAYLOAD_TYPE,
            clockRate: VP8_CLOCK_RATE,
          },
        ],
        encodings: [{ ssrc: 11111111 }],
      },
      paused: false,
    });

    this.logger.info(
      {
        transportId: this.outputTransport.id,
        producerId: this._outputProducer.id,
      },
      'MCU: output transport and producer created',
    );
  }

  /**
   * Gracefully close the entire MCU pipeline.
   * Kills ffmpeg, closes all transports, cleans up resources.
   */
  async close(): Promise<void> {
    this.closing = true;
    this.killFfmpeg();

    // Close all input streams
    for (const [peerId, input] of this.inputStreams) {
      input.consumer.close();
      input.transport.close();
      this.logger.debug({ peerId }, 'MCU: closed input stream');
    }
    this.inputStreams.clear();

    // Close output
    if (this._outputProducer) {
      this._outputProducer.close();
      this._outputProducer = null;
    }
    if (this.outputTransport) {
      this.outputTransport.close();
      this.outputTransport = null;
    }

    this.logger.info('MCU: pipeline closed');
  }

  /** Kill the ffmpeg child process if running. */
  private killFfmpeg(): void {
    if (this.ffmpegProcess) {
      this.ffmpegProcess.removeAllListeners();
      this.ffmpegProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }
  }

  /** Allocate a port pair for RTP input. */
  private allocatePort(): number {
    const port = this.nextRtpPort;
    this.nextRtpPort += 2; // RTP ports must be even, RTCP = RTP + 1
    return port;
  }
}
