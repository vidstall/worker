/**
 * VirtualPeer — wires `RelayClient` + `mediasoup-client.Device` +
 * `@roamhq/wrtc.nonstandard.RTCAudioSource` + `startConsumerPoller` into a
 * single relay-connected peer. Split out of `mediasoup-client-harness.ts` —
 * see that file's header for the harness-wide module layout notes.
 *
 * `RelayClient`/`RelayMessage`/`WsLike` live in
 * `packages/shared/src/mediasoup-node/relay-client.ts` so both this harness
 * and `apps/bot` share ONE implementation of the relay's WS JSON
 * request/response protocol.
 */

import { WebSocket } from 'ws';
import { Device, type Transport, type Consumer, type Producer } from 'mediasoup-client';
import type { types as msTypes } from 'mediasoup-client';
import {
  ensureNodeWebRtcGlobals,
  RelayClient,
  createWiredTransport,
  type RelayMessage,
  type WsLike,
} from '../../../packages/shared/src/index.js';
import { startConsumerPoller, type ConsumerLike, type TransportLike, type WriterLike } from './consumer-poller.ts';
import { extractBytesReceived } from './stats.ts';

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

export interface VirtualPeerOptions {
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
    return createWiredTransport(this.device, this.client, direction, this.opts.iceServers ?? []);
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
