/**
 * Node mediasoup-client bench harness — S23.2.C1.
 *
 * Spawns 2 virtual peers that join a relay room, produce a silent audio track,
 * consume each other's audio, and poll `Consumer.getStats()` every 1 s to
 * compute and emit `L_g2g_optB` per methodology §3.2:
 *
 *   L_g2g_optB = currentRoundTripTime/2 + jitterBufferDelay
 *              + capture/encode/render constant (50 ms)
 *
 * The harness lets us measure end-to-end latency through the real relay path
 * from a Node process — the `dvconf-client` browser app uses raw
 * `RTCPeerConnection` rather than `mediasoup-client` so it cannot exercise the
 * relay-mediated path the methodology defines.
 *
 * Module layout:
 *
 *   ── Pure helpers (vitest-covered) ──
 *   - `computeG2GoptB(stats)` — methodology §3.2 arithmetic
 *   - `extractRelevantStats(report)` — pluck rtt + jitterBufferDelay from RTCStats
 *   - `startConsumerPoller(consumer, writer, context)` — 1 Hz sampler
 *   - `parseArgs(argv)` — CLI: --relay-url --room-id --duration
 *
 *   ── Relay protocol client (vitest-covered with mocked WS) ──
 *   - `RelayClient` — ws + JSON request/response over the protocol defined in
 *     `apps/relay/src/signaling.ts` (`join` → `routerRtpCapabilities`,
 *     `createTransport` → `transportCreated`, `produce` → `produced`,
 *     `consume` → `consumed`, push `newProducer`)
 *
 *   ── Integration (validated end-to-end in S23.3) ──
 *   - `VirtualPeer` — wires `RelayClient` + `mediasoup-client.Device` +
 *     `@roamhq/wrtc.nonstandard.RTCAudioSource` + `startConsumerPoller`
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.C1
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.2
 */

import { WebSocket } from 'ws';
import { Device, type Transport, type Consumer, type Producer } from 'mediasoup-client';
import type { types as msTypes } from 'mediasoup-client';
// Scripts live outside any workspace package, so `@dvconf/shared` is not
// resolvable from this directory's node_modules. Reach into the source tree
// directly — tsx resolves `.js` extension to `.ts`. Pattern mirrors how
// `scripts/load-test.ts` and `scripts/smoke-test.ts` historically reached
// shared utilities; the imports there are type-only so the gap is hidden.
import {
  LatencyWriter,
  isBenchEnabled,
} from '../../packages/shared/src/index.js';

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * Methodology §3.2 capture/encode/render constant — a fixed 50 ms placeholder
 * accounting for camera-firmware capture + codec encode + decode + paint on
 * commodity hardware. Validated by Option-A cross-check in S-baseline.
 */
export const CAPTURE_ENCODE_RENDER_MS = 50;

export interface RelevantStats {
  /** WebRTC reports `currentRoundTripTime` in seconds. */
  currentRoundTripTime: number;
  /** WebRTC reports `jitterBufferDelay` as total seconds (cumulative). */
  jitterBufferDelay: number;
}

export function computeG2GoptB(stats: RelevantStats): number {
  const rttMs = stats.currentRoundTripTime * 1000;
  const jitterMs = stats.jitterBufferDelay * 1000;
  return rttMs / 2 + jitterMs + CAPTURE_ENCODE_RENDER_MS;
}

interface StatEntry {
  type?: string;
  [k: string]: unknown;
}

interface StatsReportLike {
  values: () => Iterable<StatEntry>;
}

/**
 * Walks a `RTCStatsReport`-shaped object, returning the rtt + jitter pair the
 * methodology needs, or `null` if either is missing (e.g. the candidate pair
 * has not yet finished probing).
 */
export function extractRelevantStats(
  report: StatsReportLike,
): RelevantStats | null {
  let rtt: number | undefined;
  let jitter: number | undefined;
  for (const stat of report.values()) {
    if (
      stat.type === 'candidate-pair' &&
      typeof stat['currentRoundTripTime'] === 'number'
    ) {
      rtt = stat['currentRoundTripTime'] as number;
    } else if (
      stat.type === 'inbound-rtp' &&
      typeof stat['jitterBufferDelay'] === 'number'
    ) {
      jitter = stat['jitterBufferDelay'] as number;
    }
  }
  if (rtt === undefined || jitter === undefined) return null;
  return { currentRoundTripTime: rtt, jitterBufferDelay: jitter };
}

export interface ConsumerLike {
  getStats: () => Promise<StatsReportLike>;
}

export interface WriterLike {
  write: (
    metric: string,
    value_ms: number,
    context?: Record<string, unknown>,
  ) => void;
}

/**
 * Poll a Consumer's getStats() at `intervalMs`, write one `L_g2g_optB` event
 * per successful poll. Returns a cancel function — call it from peer cleanup.
 * Transient `getStats()` failures are swallowed (one bad tick must not stop
 * the whole sampler).
 */
export function startConsumerPoller(
  consumer: ConsumerLike,
  writer: WriterLike,
  context: Record<string, unknown>,
  intervalMs = 1000,
): () => void {
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const report = await consumer.getStats();
      const stats = extractRelevantStats(report);
      if (stats !== null) {
        writer.write('L_g2g_optB', computeG2GoptB(stats), context);
      }
    } catch {
      // skip this tick
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  // Fire an immediate sample so short durations capture at least one event.
  void tick();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

// ── CLI parsing ──────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = 'ws://localhost:4000';
const DEFAULT_DURATION_S = 60;
const DEFAULT_PEERS = 2;
const MAX_PEERS = 26; // letter-based peer IDs (A..Z)

export interface CliArgs {
  relayUrl: string;
  roomId: string;
  durationMs: number;
  peers: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let relayUrl = DEFAULT_RELAY_URL;
  let roomId = `bench-${Date.now()}`;
  let durationMs = DEFAULT_DURATION_S * 1000;
  let peers = DEFAULT_PEERS;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--relay-url') {
      relayUrl = args[++i] ?? relayUrl;
    } else if (a === '--room-id') {
      roomId = args[++i] ?? roomId;
    } else if (a === '--duration') {
      const d = args[++i];
      if (d !== undefined) durationMs = Math.round(parseFloat(d) * 1000);
    } else if (a === '--peers') {
      const n = args[++i];
      if (n !== undefined) {
        const parsed = parseInt(n, 10);
        if (Number.isFinite(parsed) && parsed >= 2 && parsed <= MAX_PEERS) {
          peers = parsed;
        } else {
          throw new Error(
            `--peers must be an integer in [2, ${MAX_PEERS}], got ${n}`,
          );
        }
      }
    }
  }
  return { relayUrl, roomId, durationMs, peers };
}

/** Map peer index (0-based) to a stable label: A..Z. */
export function peerLabel(index: number): string {
  if (index < 0 || index >= MAX_PEERS) {
    throw new Error(`peerLabel: index ${index} out of range [0, ${MAX_PEERS})`);
  }
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

// ── Relay protocol client ────────────────────────────────────────────

export interface RelayMessage {
  type: string;
  [k: string]: unknown;
}

export interface WsLike {
  send: (data: string) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  close: () => void;
}

interface PendingRequest {
  predicate: (msg: RelayMessage) => boolean;
  resolve: (msg: RelayMessage) => void;
  reject: (err: Error) => void;
}

/**
 * Tiny request/response client over the relay's WS signaling. Push messages
 * (`newProducer`) are routed to an optional callback; everything else is
 * matched by predicate against the pending request queue (first match wins).
 */
export class RelayClient {
  private readonly ws: WsLike;
  private readonly pending: PendingRequest[] = [];
  private readonly onProducer: ((msg: RelayMessage) => void) | null;
  readonly ready: Promise<void>;

  constructor(
    ws: WsLike,
    onProducer: ((msg: RelayMessage) => void) | null = null,
  ) {
    this.ws = ws;
    this.onProducer = onProducer;
    this.ready = new Promise<void>((resolve) => {
      this.ws.on('open', () => resolve());
    });
    this.ws.on('message', (...args: unknown[]) => {
      const data = args[0];
      const raw =
        typeof data === 'string'
          ? data
          : data instanceof Buffer
            ? data.toString('utf8')
            : String(data);
      let msg: RelayMessage;
      try {
        msg = JSON.parse(raw) as RelayMessage;
      } catch {
        return;
      }
      this.routeIncoming(msg);
    });
  }

  /** Test seam — feed an incoming message into the routing logic. */
  routeIncoming(msg: RelayMessage): void {
    if (msg.type === 'newProducer' && this.onProducer !== null) {
      this.onProducer(msg);
      return;
    }
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i]!.predicate(msg)) {
        const [matched] = this.pending.splice(i, 1);
        matched!.resolve(msg);
        return;
      }
    }
  }

  send(msg: RelayMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(
    predicate: (msg: RelayMessage) => boolean,
    timeoutMs = 10_000,
  ): Promise<RelayMessage> {
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error('Relay response timeout'));
      }, timeoutMs);
      this.pending.push(entry);
    });
  }

  close(): void {
    this.ws.close();
  }
}

// ── Integration: virtual peer (validated in S23.3 against running relay) ──

interface VirtualPeerOptions {
  relayUrl: string;
  roomId: string;
  peerId: string;
  writer: WriterLike;
}

class VirtualPeer {
  private readonly opts: VirtualPeerOptions;
  private device: Device | null = null;
  private client: RelayClient | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producer: Producer | null = null;
  private readonly consumers: Consumer[] = [];
  private readonly pollerStops: Array<() => void> = [];
  private audioSource: { onData: (data: unknown) => void } | null = null;
  private audioInterval: NodeJS.Timeout | null = null;

  constructor(opts: VirtualPeerOptions) {
    this.opts = opts;
  }

  async run(): Promise<void> {
    const ws = new WebSocket(this.opts.relayUrl) as unknown as WsLike;
    this.client = new RelayClient(ws, (msg) => {
      void this.onNewProducer(msg);
    });
    await this.client.ready;

    // 1. join → routerRtpCapabilities
    this.client.send({
      type: 'join',
      roomId: this.opts.roomId,
      peerId: this.opts.peerId,
    });
    const caps = await this.client.waitFor(
      (m) => m.type === 'routerRtpCapabilities',
    );

    // 2. Load device
    this.device = new Device();
    await this.device.load({
      routerRtpCapabilities: caps['rtpCapabilities'] as msTypes.RtpCapabilities,
    });

    // 3. Send transport
    this.sendTransport = await this.makeTransport('send');

    // 4. Produce silent audio
    await this.startAudioProducer();

    // 5. Recv transport (ready for newProducer handler)
    this.recvTransport = await this.makeTransport('recv');
  }

  private async makeTransport(direction: 'send' | 'recv'): Promise<Transport> {
    if (this.device === null || this.client === null) {
      throw new Error('Device or client not ready');
    }
    this.client.send({ type: 'createTransport', direction });
    const params = await this.client.waitFor((m) => m.type === 'transportCreated');
    const transport =
      direction === 'send'
        ? this.device.createSendTransport({
            id: params['id'] as string,
            iceParameters: params['iceParameters'] as msTypes.IceParameters,
            iceCandidates: params['iceCandidates'] as msTypes.IceCandidate[],
            dtlsParameters: params['dtlsParameters'] as msTypes.DtlsParameters,
          })
        : this.device.createRecvTransport({
            id: params['id'] as string,
            iceParameters: params['iceParameters'] as msTypes.IceParameters,
            iceCandidates: params['iceCandidates'] as msTypes.IceCandidate[],
            dtlsParameters: params['dtlsParameters'] as msTypes.DtlsParameters,
          });
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      try {
        this.client!.send({
          type: 'connectTransport',
          transportId: transport.id,
          dtlsParameters,
        });
        callback();
      } catch (err) {
        errback(err as Error);
      }
    });
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        (async () => {
          try {
            this.client!.send({
              type: 'produce',
              transportId: transport.id,
              kind,
              rtpParameters,
            });
            const produced = await this.client!.waitFor(
              (m) => m.type === 'produced',
            );
            callback({ id: produced['producerId'] as string });
          } catch (err) {
            errback(err as Error);
          }
        })().catch(errback);
      });
    }
    return transport;
  }

  private async startAudioProducer(): Promise<void> {
    if (this.sendTransport === null) return;
    // Late-load @roamhq/wrtc so unit tests that import this module don't pay
    // the native binding cost.
    const wrtcModule = (await import('@roamhq/wrtc')) as {
      default?: { nonstandard: { RTCAudioSource: new () => unknown } };
      nonstandard?: { RTCAudioSource: new () => unknown };
    };
    const nonstandard =
      wrtcModule.nonstandard ?? wrtcModule.default?.nonstandard;
    if (nonstandard === undefined) {
      throw new Error('@roamhq/wrtc nonstandard surface not found');
    }
    const audioSource = new nonstandard.RTCAudioSource() as {
      createTrack: () => MediaStreamTrack;
      onData: (data: unknown) => void;
    };
    const track = audioSource.createTrack();
    this.audioSource = { onData: (d) => audioSource.onData(d) };

    // Silence: 16-bit PCM, 8 kHz, mono, 80 samples / 10 ms
    const silenceBuf = new Int16Array(80);
    this.audioInterval = setInterval(() => {
      this.audioSource?.onData({
        samples: silenceBuf,
        sampleRate: 8000,
        bitsPerSample: 16,
        channelCount: 1,
        numberOfFrames: 80,
      });
    }, 10);

    this.producer = await this.sendTransport.produce({ track });
  }

  private async onNewProducer(msg: RelayMessage): Promise<void> {
    if (
      this.device === null ||
      this.recvTransport === null ||
      this.client === null
    ) {
      return;
    }
    const producerId = msg['producerId'] as string;
    const remotePeerId = msg['peerId'] as string;
    this.client.send({
      type: 'consume',
      producerId,
      rtpCapabilities: this.device.rtpCapabilities,
    });
    const consumed = await this.client.waitFor(
      (m) => m.type === 'consumed' && m['producerId'] === producerId,
    );
    const consumer = await this.recvTransport.consume({
      id: consumed['consumerId'] as string,
      producerId,
      kind: consumed['kind'] as 'audio' | 'video',
      rtpParameters: consumed['rtpParameters'] as msTypes.RtpParameters,
    });
    this.consumers.push(consumer);
    const stop = startConsumerPoller(
      consumer as unknown as ConsumerLike,
      this.opts.writer,
      {
        room_id: this.opts.roomId,
        peer_a: remotePeerId,
        peer_b: this.opts.peerId,
        consumer_id: consumer.id,
      },
    );
    this.pollerStops.push(stop);
  }

  async close(): Promise<void> {
    for (const stop of this.pollerStops) stop();
    if (this.audioInterval !== null) clearInterval(this.audioInterval);
    for (const c of this.consumers) c.close();
    if (this.producer !== null) this.producer.close();
    if (this.sendTransport !== null) this.sendTransport.close();
    if (this.recvTransport !== null) this.recvTransport.close();
    if (this.client !== null) this.client.close();
  }
}

// ── CLI entry ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!isBenchEnabled()) {
    console.error('BENCH_LATENCY=1 required to write JSONL events.');
    process.exit(1);
  }
  const args = parseArgs(process.argv);
  console.log(
    `[harness] relay=${args.relayUrl} room=${args.roomId} peers=${args.peers} duration=${args.durationMs}ms`,
  );

  const writer = new LatencyWriter({
    source: 'client',
    instance: 'harness',
  });
  console.log(`[harness] writing to ${writer.getFilePath()}`);

  const peers: VirtualPeer[] = [];
  for (let i = 0; i < args.peers; i++) {
    peers.push(
      new VirtualPeer({
        relayUrl: args.relayUrl,
        roomId: args.roomId,
        peerId: `harness-peer-${peerLabel(i)}`,
        writer,
      }),
    );
  }
  await Promise.all(peers.map((p) => p.run()));
  console.log(`[harness] ${peers.length} peers joined, sampling…`);

  await new Promise((r) => setTimeout(r, args.durationMs));

  await Promise.all(peers.map((p) => p.close()));
  writer.close();
  console.log('[harness] done');
}

const isMain =
  process.argv[1]?.endsWith('mediasoup-client-harness.ts') === true ||
  process.argv[1]?.endsWith('mediasoup-client-harness.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
