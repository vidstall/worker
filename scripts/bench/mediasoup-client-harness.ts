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

// ── Node WebRTC handler bootstrap (S25.C.6 — CI-16) ───────────────────

/**
 * mediasoup-client `Device` was designed for browsers — its built-in handlers
 * (`Chrome111`, `Firefox120`, …) read `RTCPeerConnection`, `MediaStream`, etc.
 * from `globalThis`. In Node the globals are absent and `Device.load()` throws
 * `UnsupportedError: device not supported` (the failure surfaced at S25.C.6).
 *
 * Fix: lazy-import `@roamhq/wrtc` (already a workspace devDep — used by
 * `startAudioProducer`) and stitch its named exports onto `globalThis` once
 * per process before the first `Device` is created. We pick `Chrome111` as
 * the handler because @roamhq/wrtc's surface matches a recent Chromium build.
 *
 * Kept lazy so unit tests (which mock the WS and never construct a Device)
 * don't pay the native-binding cost or fail in environments without wrtc.
 */
let wrtcGlobalsInstalled = false;
async function ensureNodeWebRtcGlobals(): Promise<void> {
  if (wrtcGlobalsInstalled) return;
  const wrtcModule = (await import('@roamhq/wrtc')) as {
    default?: Record<string, unknown>;
    [k: string]: unknown;
  };
  const w = (wrtcModule.default ?? wrtcModule) as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  const names = [
    'RTCPeerConnection',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'RTCRtpReceiver',
    'RTCRtpSender',
    'MediaStream',
    'MediaStreamTrack',
  ] as const;
  for (const n of names) {
    if (g[n] === undefined && w[n] !== undefined) g[n] = w[n];
  }
  wrtcGlobalsInstalled = true;
}

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * SMH-LIVE (D2 media-hardening) — bounded retry of a flaky async op.
 *
 * The bench cross-relay consume/produce handshake occasionally rejects with
 * `Relay response timeout` (the piped/minted producer lags the `newProducer`
 * push). Re-runs `op` up to `attempts` times, sleeping `delayMs` between tries,
 * and rethrows the LAST error once attempts are exhausted. Pure (no relay / no
 * timers beyond a plain sleep) so it is unit-testable in isolation.
 */
export async function retryOnTimeout<T>(
  op: () => Promise<T>,
  opts: { attempts: number; delayMs: number },
): Promise<T> {
  const attempts = Math.max(1, opts.attempts);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
    }
  }
  throw lastErr;
}

/** SMH-LIVE consume-retry budget: 4 attempts over ~12 s covers the observed
 *  cross-relay piped-producer lag without blocking the fleet warm-up window. */
const CONSUME_RETRY_ATTEMPTS = 4;
const CONSUME_RETRY_DELAY_MS = 3000;

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
let statsDumpCount = 0;
const STATS_DUMP_MAX = 2;
export function extractRelevantStats(
  report: StatsReportLike,
): RelevantStats | null {
  let rtt: number | undefined;
  let jitter: number | undefined;
  const collected: StatEntry[] = [];
  for (const stat of report.values()) {
    collected.push(stat);
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
  // DEBUG S25.C-followup.A — dump first 2 reports to identify field mapping.
  // Removed after triage (S25.C-followup.C).
  if (statsDumpCount < STATS_DUMP_MAX && process.env['BENCH_DEBUG_STATS'] === '1') {
    statsDumpCount++;
    const summary = collected.map((s) => ({
      type: s.type,
      keys: Object.keys(s).filter((k) => k !== 'type').slice(0, 12),
    }));
    console.log(
      `[debug-stats #${statsDumpCount}] entries=${collected.length} rtt=${rtt} jitter=${jitter}`,
    );
    console.log(`[debug-stats #${statsDumpCount}] shape=${JSON.stringify(summary)}`);
  }
  if (rtt === undefined || jitter === undefined) return null;
  return { currentRoundTripTime: rtt, jitterBufferDelay: jitter };
}

/**
 * Narrowed-metric fallback (S25.C-followup): pluck ICE `currentRoundTripTime`
 * alone from candidate-pair stats when full Option-B data is unavailable
 * (jitterBufferDelay is per-RTP-receiver and @roamhq/wrtc may not emit it).
 * Used to drive `L_g2g_RTT_proxy = RTT/2 + 50 ms`.
 *
 * Accepts RTT = 0 (valid on localhost loopback — sub-microsecond probe
 * RTT rounds to 0). Returns null only when the candidate-pair stat is
 * absent or the value is non-numeric.
 */
export function extractRttOnly(report: StatsReportLike): number | null {
  for (const stat of report.values()) {
    if (
      stat.type === 'candidate-pair' &&
      typeof stat['currentRoundTripTime'] === 'number'
    ) {
      return stat['currentRoundTripTime'] as number;
    }
  }
  return null;
}

/**
 * SMH-LIVE (D2 real-continuity): sum `bytesReceived` across every `inbound-rtp` entry in a
 * stats report. On a recv transport (RTCPeerConnection-level) this is the TOTAL inbound media
 * bytes across all of a peer's consumers; on a single Consumer it is that consumer's bytes.
 * `> 0` proves REAL media flowed through the relay mesh (not just an RPC/on-chain claim).
 */
export function extractBytesReceived(report: StatsReportLike): number {
  let total = 0;
  for (const stat of report.values()) {
    if (stat.type === 'inbound-rtp' && typeof stat['bytesReceived'] === 'number') {
      total += stat['bytesReceived'] as number;
    }
  }
  return total;
}

export interface ConsumerLike {
  getStats: () => Promise<StatsReportLike>;
}

export interface TransportLike {
  getStats: () => Promise<StatsReportLike>;
}

export interface WriterLike {
  write: (
    metric: string,
    value_ms: number,
    context?: Record<string, unknown>,
  ) => void;
}

export interface ConsumerPollerOpts {
  /** Optional transport. Tried FIRST — RTCPeerConnection.getStats() may
   *  be implemented even when RTCRtpReceiver.getStats() is not (CI-20:
   *  @roamhq/wrtc on Node throws "Not yet implemented; file a feature
   *  request against node-webrtc" on receiver.getStats but the underlying
   *  PeerConnection.getStats may return candidate-pair RTT). */
  transport?: TransportLike;
}

/**
 * Poll a Consumer's getStats() at `intervalMs`, write one `L_g2g_optB` event
 * per successful poll. Returns a cancel function — call it from peer cleanup.
 * Transient `getStats()` failures are swallowed (one bad tick must not stop
 * the whole sampler).
 *
 * CI-20 (S25.C-followup): when an optional `transport` is supplied, the
 * poller tries `transport.getStats()` first — this proxies to
 * RTCPeerConnection.getStats() which @roamhq/wrtc may implement even when
 * Consumer-level (RTCRtpReceiver.getStats) is not. If only RTT is available
 * (no jitterBufferDelay), the poller emits `L_g2g_RTT_proxy` (RTT/2 + 50 ms)
 * instead of `L_g2g_optB` — a narrowed metric disclosed in ch5 §5.2.7.
 */
export function startConsumerPoller(
  consumer: ConsumerLike,
  writer: WriterLike,
  context: Record<string, unknown>,
  intervalMs = 1000,
  pollerOpts: ConsumerPollerOpts = {},
): () => void {
  let stopped = false;
  let tickCount = 0;
  let writeCount = 0;
  let nullCount = 0;
  let errCount = 0;

  const debug = process.env['BENCH_DEBUG_STATS'] === '1';
  const transport = pollerOpts.transport;

  // Try transport first if provided; on failure fall back to consumer.
  // Returns null if both sources fail or yield no usable stats.
  const fetchReport = async (): Promise<StatsReportLike | null> => {
    if (transport !== undefined) {
      try {
        return await transport.getStats();
      } catch {
        // fall through to consumer
      }
    }
    try {
      return await consumer.getStats();
    } catch {
      return null;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    tickCount++;
    const report = await fetchReport();
    if (report === null) {
      errCount++;
      if (debug && errCount <= 2) {
        console.log(
          `[debug-poll consumer=${String(context['consumer_id'])}] tick=${tickCount} both transport+consumer getStats failed`,
        );
      }
      return;
    }
    // S25.C-followup.C decision: on Node + @roamhq/wrtc the W3C-spec'd
    // `jitterBufferDelay` unit (seconds) is mis-reported as milliseconds —
    // makes `L_g2g_optB = RTT/2 + jitter*1000 + 50` produce values in the
    // tens of millions of ms after a few seconds of streaming. The full
    // Option-B sum is therefore unreliable on this binding.
    //
    // Primary emitted metric is the **narrowed Option B**:
    //   `L_g2g_RTT_proxy = currentRoundTripTime/2 + 50 ms`
    // (capture/encode/render constant only; drops jitter contribution).
    // Bound: under-counts true L_g2g by the per-frame jitter buffer delay,
    // typically 20–60 ms per W3C reference samples. Methodology §1.3
    // already labelled the Option-B error term as ±30–80 ms; the narrowed
    // variant lands on the under-estimate side. Disclosure: ch5 §5.2.7.
    const rttOnly = extractRttOnly(report);
    if (rttOnly !== null) {
      writer.write(
        'L_g2g_RTT_proxy',
        (rttOnly * 1000) / 2 + CAPTURE_ENCODE_RENDER_MS,
        context,
      );
      writeCount++;
    } else {
      nullCount++;
    }
    // `extractRelevantStats` retained as importable helper for future
    // browser-side harness or post-binding-fix re-enable — read but not
    // emitted from Node today.
    void extractRelevantStats;
    void computeG2GoptB;
    if (debug && tickCount <= 3) {
      console.log(
        `[debug-poll consumer=${String(context['consumer_id'])}] tick=${tickCount} stats=${stats === null ? 'null' : 'ok'} writes=${writeCount} nulls=${nullCount}`,
      );
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

/**
 * Public Google STUN endpoint — the canonical free probe used by browsers
 * + reference clients to learn server-reflexive candidates. Selected over
 * Mozilla/Cloudflare because Google's anycast has the lowest RTT from APAC
 * and is the de-facto example in WebRTC docs ([[ch2-01-webrtc-primer]] § ICE).
 */
export const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';

export type IceMode = 'none' | 'stun' | 'turn';
const VALID_ICE_MODES: readonly IceMode[] = ['none', 'stun', 'turn'];

export interface CliArgs {
  relayUrl: string;
  roomId: string;
  durationMs: number;
  peers: number;
  iceMode: IceMode;
}

/**
 * Build a mediasoup-compatible `iceServers` array for the chosen network
 * mode. Phase I of [[internet-benchmark-plan]] threads STUN-only through
 * the harness so the pipeline survives real NAT without TURN deployment;
 * Phase II adds TURN once ADR-0005 credential issuance is wired.
 *
 * - `none` (default) → `[]`, the pre-S28 localhost behaviour. ICE uses
 *   host candidates only; works on loopback + LAN.
 * - `stun` → `[{ urls: [DEFAULT_STUN_URL] }]`. Adds srflx candidates so
 *   peers behind cone NATs can connect directly.
 * - `turn` → `[stun, turn]`. Last-resort relay path for symmetric NAT or
 *   UDP-blocked firewalls. TURN config is env-driven, not flag-driven,
 *   because credentials are short-lived secrets (ADR-0005 § TTL = 20 min).
 *
 * Note: this helper validates env presence but does NOT verify the
 * HMAC-SHA1 signature against coturn's `static-auth-secret`. That contract
 * is exercised end-to-end in S30 Phase II once `cp-daemon/turn-issuer.ts`
 * is wired.
 */
export interface BuildIceServersOpts {
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
}

export function buildIceServers(
  mode: IceMode,
  opts: BuildIceServersOpts = {},
): Array<{ urls: string[]; username?: string; credential?: string }> {
  if (mode === 'none') return [];
  const stun = { urls: [DEFAULT_STUN_URL] };
  if (mode === 'stun') return [stun];
  // mode === 'turn'
  const { turnUrl, turnUsername, turnCredential } = opts;
  if (turnUrl === undefined || turnUrl === '') {
    throw new Error(
      '--ice-mode turn requires BENCH_TURN_URL env (e.g. turn:relay.example.com:3478?transport=udp)',
    );
  }
  if (turnUsername === undefined || turnUsername === '') {
    throw new Error(
      '--ice-mode turn requires BENCH_TURN_USERNAME env (HMAC-SHA1 username, typically "<unix-ts>:<userId>")',
    );
  }
  if (turnCredential === undefined || turnCredential === '') {
    throw new Error(
      '--ice-mode turn requires BENCH_TURN_CREDENTIAL env (base64-encoded HMAC-SHA1 of username with static-auth-secret)',
    );
  }
  return [
    stun,
    { urls: [turnUrl], username: turnUsername, credential: turnCredential },
  ];
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let relayUrl = DEFAULT_RELAY_URL;
  let roomId = `bench-${Date.now()}`;
  let durationMs = DEFAULT_DURATION_S * 1000;
  let peers = DEFAULT_PEERS;
  let iceMode: IceMode = 'none';
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
    } else if (a === '--ice-mode') {
      const m = args[++i];
      if (m !== undefined) {
        if ((VALID_ICE_MODES as readonly string[]).includes(m)) {
          iceMode = m as IceMode;
        } else {
          throw new Error(
            `--ice-mode must be one of ${VALID_ICE_MODES.join('|')}, got ${m}`,
          );
        }
      }
    }
  }
  return { relayUrl, roomId, durationMs, peers, iceMode };
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
  /** Optional iceServers list. When non-empty, both send + recv transports
   *  use it for ICE gathering — Phase I (`stun`) adds srflx candidates so
   *  peers behind cone NATs reach each other directly, Phase II (`turn`)
   *  adds a relay-fallback path for symmetric NAT. Empty array (the
   *  default) restores the pre-S28 localhost-only behaviour. */
  iceServers?: Array<{ urls: string[]; username?: string; credential?: string }>;
}

export class VirtualPeer {
  private readonly opts: VirtualPeerOptions;
  private device: Device | null = null;
  private client: RelayClient | null = null;
  private sendTransport: Transport | null = null;
  private recvTransport: Transport | null = null;
  private producer: Producer | null = null;
  private readonly consumers: Consumer[] = [];
  private readonly pollerStops: Array<() => void> = [];
  /** SMH-LIVE (D2 media-hardening): producerIds we have already begun consuming.
   *  Guards against a double-consume when the SAME producer is delivered twice —
   *  the join-time `newProducer` loop AND a live push, or a retry racing the
   *  original — which would otherwise throw `Consumer already exists` on the relay. */
  private readonly consumedProducerIds = new Set<string>();
  private audioSource: { onData: (data: unknown) => void } | null = null;
  private audioInterval: NodeJS.Timeout | null = null;
  /** Producers we were told about before recvTransport was ready
   *  (CI-18 secondary race: relay forwards `newProducer` push as soon as
   *  any peer produces, even if local peer is still in step 3-4). */
  private readonly pendingProducers: RelayMessage[] = [];

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

    // 2. Load device — CI-16: wrtc globals + explicit handlerName required in Node
    await ensureNodeWebRtcGlobals();
    this.device = new Device({ handlerName: 'Chrome111' });
    await this.device.load({
      routerRtpCapabilities: caps['rtpCapabilities'] as msTypes.RtpCapabilities,
    });

    // 3. Send transport
    this.sendTransport = await this.makeTransport('send');

    // 4. Recv transport FIRST (so onNewProducer handler is ready when peer-A
    //    produces in step 5 below; otherwise relay's `newProducer` push lands
    //    while recvTransport=null and the message is dropped — observed at
    //    S25.C.6 debug-stats run as "onNewProducer ABORTED — recvT=null").
    this.recvTransport = await this.makeTransport('recv');

    // 5. Produce silent audio (after recvTransport is in place)
    await this.startAudioProducer();

    // Drain any newProducer pushes that landed while we were setting up.
    const queued = this.pendingProducers.splice(0);
    for (const msg of queued) {
      void this.onNewProducer(msg);
    }
  }

  private async makeTransport(direction: 'send' | 'recv'): Promise<Transport> {
    if (this.device === null || this.client === null) {
      throw new Error('Device or client not ready');
    }
    this.client.send({ type: 'createTransport', direction });
    const params = await this.client.waitFor((m) => m.type === 'transportCreated');
    const iceServers = this.opts.iceServers ?? [];
    const transportParams: msTypes.TransportOptions = {
      id: params['id'] as string,
      iceParameters: params['iceParameters'] as msTypes.IceParameters,
      iceCandidates: params['iceCandidates'] as msTypes.IceCandidate[],
      dtlsParameters: params['dtlsParameters'] as msTypes.DtlsParameters,
      // mediasoup-client honours the iceServers field even though it's
      // optional — only matters when non-empty (Phase I/II of internet
      // benchmark). Empty array preserves the pre-S28 localhost path.
      ...(iceServers.length > 0 ? { iceServers } : {}),
    };
    const transport =
      direction === 'send'
        ? this.device.createSendTransport(transportParams)
        : this.device.createRecvTransport(transportParams);
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
    const debug = process.env['BENCH_DEBUG_STATS'] === '1';
    if (debug) {
      console.log(
        `[debug-peer ${this.opts.peerId}] onNewProducer producerId=${String(msg['producerId'])} remotePeer=${String(msg['peerId'])}`,
      );
    }
    if (
      this.device === null ||
      this.recvTransport === null ||
      this.client === null
    ) {
      // recvTransport not ready yet — queue, run() will drain after setup.
      this.pendingProducers.push(msg);
      if (debug) {
        console.log(
          `[debug-peer ${this.opts.peerId}] onNewProducer QUEUED — device=${this.device === null ? 'null' : 'ok'} recvT=${this.recvTransport === null ? 'null' : 'ok'} client=${this.client === null ? 'null' : 'ok'}`,
        );
      }
      return;
    }
    const producerId = msg['producerId'] as string;
    const remotePeerId = msg['peerId'] as string;

    // SMH-LIVE (D2 media-hardening): idempotency — never consume the same producer
    // twice. The join-time `newProducer` loop and the live push can deliver the same
    // producerId, and the retry below can race the original in-flight consume; a
    // second consume of the same producer throws `Consumer already exists` on the
    // relay and would tear the whole handshake down. Claim the id up-front.
    if (this.consumedProducerIds.has(producerId)) {
      if (debug) {
        console.log(
          `[debug-peer ${this.opts.peerId}] onNewProducer SKIP — already consuming producerId=${producerId}`,
        );
      }
      return;
    }
    this.consumedProducerIds.add(producerId);

    // SMH-LIVE (D2 media-hardening): the cross-relay consume handshake sometimes
    // times out ('Relay response timeout') — the piped/minted producer can lag the
    // `newProducer` push by a few seconds. Retry the consume-request round-trip a
    // bounded number of times so a single flaky handshake does not leave this peer
    // with no consumer (= no forwarded bytes on that relay). Each attempt re-sends
    // the consume request and waits for the matching `consumed` reply.
    let consumed: RelayMessage;
    try {
      consumed = await retryOnTimeout(
        async () => {
          this.client!.send({
            type: 'consume',
            producerId,
            rtpCapabilities: this.device!.rtpCapabilities,
          });
          return this.client!.waitFor(
            (m) => m.type === 'consumed' && m['producerId'] === producerId,
          );
        },
        { attempts: CONSUME_RETRY_ATTEMPTS, delayMs: CONSUME_RETRY_DELAY_MS },
      );
    } catch (err) {
      // Exhausted retries — release the claim so a LATER push for this producer can
      // try again, then rethrow (the caller's process-level handler swallows it).
      this.consumedProducerIds.delete(producerId);
      if (debug) {
        console.log(
          `[debug-peer ${this.opts.peerId}] onNewProducer consume FAILED after retries producerId=${producerId}: ${String(err)}`,
        );
      }
      throw err;
    }
    if (debug) {
      console.log(
        `[debug-peer ${this.opts.peerId}] consumed reply id=${String(consumed['consumerId'])} kind=${String(consumed['kind'])}`,
      );
    }
    const consumer = await this.recvTransport.consume({
      id: consumed['consumerId'] as string,
      producerId,
      kind: consumed['kind'] as 'audio' | 'video',
      rtpParameters: consumed['rtpParameters'] as msTypes.RtpParameters,
    });
    if (debug) {
      console.log(
        `[debug-peer ${this.opts.peerId}] consumer created id=${consumer.id} — starting poller`,
      );
    }
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
      1000,
      { transport: this.recvTransport as unknown as TransportLike },
    );
    this.pollerStops.push(stop);
  }

  /**
   * SMH-LIVE (D2): current total inbound media bytes for this peer. Prefers the recv
   * transport's RTCPeerConnection-level stats (total across all consumers); falls back to
   * summing per-consumer stats. Returns 0 if no stats are available yet. Additive read-only
   * accessor — does not change the join/produce/consume lifecycle.
   */
  /**
   * SMH-LIVE (D2): number of consumers this peer has established (>0 means the peer
   * is actively receiving at least one remote track — the client-side counterpart to
   * the relay's server-side bytesForwarded). Additive read-only accessor.
   */
  consumerCount(): number {
    return this.consumers.length;
  }

  async currentBytesReceived(): Promise<number> {
    if (this.recvTransport !== null) {
      try {
        const report = await (this.recvTransport as unknown as TransportLike).getStats();
        const b = extractBytesReceived(report);
        if (b > 0) return b;
      } catch {
        // fall through to per-consumer stats
      }
    }
    let total = 0;
    for (const c of this.consumers) {
      try {
        const report = await (c as unknown as ConsumerLike).getStats();
        total += extractBytesReceived(report);
      } catch {
        // skip a consumer whose getStats is unavailable
      }
    }
    return total;
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
  const iceServers = buildIceServers(args.iceMode, {
    turnUrl: process.env['BENCH_TURN_URL'],
    turnUsername: process.env['BENCH_TURN_USERNAME'],
    turnCredential: process.env['BENCH_TURN_CREDENTIAL'],
  });
  console.log(
    `[harness] relay=${args.relayUrl} room=${args.roomId} peers=${args.peers} duration=${args.durationMs}ms ice-mode=${args.iceMode} (${iceServers.length} ice-server${iceServers.length === 1 ? '' : 's'})`,
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
        iceServers,
      }),
    );
  }
  // Sequential join — relay's per-room async lock (added at S25.C-followup.D
  // in apps/relay/src/signaling.ts) removes the CI-18 parallel-join race.
  // We keep sequential setup here to make per-peer log lines deterministic
  // and easier to triage if something regresses; no inter-peer delay needed.
  for (let i = 0; i < peers.length; i++) {
    await peers[i]!.run();
  }
  console.log(`[harness] ${peers.length} peers joined, sampling…`);

  await new Promise((r) => setTimeout(r, args.durationMs));

  // Flush JSONL before the wrtc cleanup chain — LatencyWriter.close() does
  // a final writeSync + fsync, must complete before we exit.
  writer.close();
  console.log('[harness] done');

  // CI-19 mitigation: @roamhq/wrtc's native binding teardown crashes Node
  // on Windows with STATUS_STACK_BUFFER_OVERRUN (0xC0000409) when
  // Producer/Consumer/Transport close() chains fire during the same exit
  // (G-016). Data layer is already flushed above. Skip the JS-level close
  // chain and SIGKILL ourselves so the native cleanup doesn't run.
  // Disclosure: this trades exit-code cleanliness for stable data emission;
  // ch5 §5.2.7 documents the trade-off. Real fix (upstream binding swap)
  // tracked separately.
  process.kill(process.pid, 'SIGKILL');
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
