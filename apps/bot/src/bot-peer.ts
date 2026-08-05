/**
 * BotPeer — a mediasoup-client peer built on the Node-only primitives
 * extracted to `@dvconf/shared`'s `mediasoup-node` module
 * (`ensureNodeWebRtcGlobals`, `RelayClient`, `createWiredTransport`), which
 * were pulled out of `scripts/bench/mediasoup-client-harness.ts`'s
 * `VirtualPeer` so both share ONE implementation of the relay wire protocol
 * (`apps/relay/src/signaling.ts`).
 *
 * Both produces (camera/mic, gated by mediaMode -- see session.ts) AND
 * consumes every other peer currently in the room (unconditionally,
 * regardless of mediaMode) -- modeled directly on `VirtualPeer`'s
 * join→newProducer→consume flow, since the relay's wire protocol for this
 * already exists and needs no changes. Consuming (not just producing) is
 * what lets the bot's stats-reporter (see stats-reporter.ts) report real
 * receiver-side quality fields like jitter, which are structurally
 * unmeasurable on a send-only transport (jitter only exists on
 * inbound-rtp getStats() entries).
 */
import { WebSocket } from 'ws';
import { Device } from 'mediasoup-client';
import type { types as msTypes } from 'mediasoup-client';
import {
  ensureNodeWebRtcGlobals,
  RelayClient,
  createWiredTransport,
  type WsLike,
  type Logger,
} from '@dvconf/shared';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { startStatsReporter } from './stats-reporter.js';

/** Server push when a producer (existing or new) becomes available to
 *  consume -- duplicated (not imported) from the browser client's
 *  `useRelay.ts`'s `NewProducerNotification`, same convention
 *  stats-reporter.ts's header comment documents (no shared client/relay/bot
 *  wire-types package exists in this repo). */
export interface NewProducerNotification {
  type: 'newProducer';
  peerId: string;
  producerId: string;
  kind: 'audio' | 'video';
}

/** Relay's reply to a `consume` request -- duplicated from `useRelay.ts`'s
 *  `ConsumedResponse`. `producerPeerId` is only present for cross-relay-
 *  forwarded producers; omitted for a same-relay consume. */
export interface ConsumedResponse {
  type: 'consumed';
  consumerId: string;
  producerId: string;
  producerPeerId?: string;
  kind: 'audio' | 'video';
  rtpParameters: msTypes.RtpParameters;
}

/** Bounded retry of a flaky consume round-trip -- mirrors
 *  `scripts/bench/mediasoup-client-harness.ts`'s `retryOnTimeout` (not
 *  imported: that script lives outside any workspace package, unreachable
 *  from apps/bot's node_modules). A cross-relay piped/minted producer can
 *  lag its `newProducer` push by a few seconds, occasionally timing out the
 *  first `consume` attempt. */
async function retryOnTimeout<T>(op: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

const CONSUME_RETRY_ATTEMPTS = 4;
const CONSUME_RETRY_DELAY_MS = 3000;

export interface BotPeerOptions {
  relayUrl: string;
  roomId: string;
  peerId: string;
  roomPassword: string;
  /** Threaded into RelayClient so a mid-session relay-WS close is observable
   *  (bot has no standby/dual-relay path, so this is log-only — no hint sent). */
  logger?: Logger;
}

/** Base64-encode a 32-byte ed25519 public key for the `join` message's
 *  `peerPubkey` field. The relay only validates the byte length
 *  (`validateSessionPubkey`, `apps/relay/src/signaling.ts`) — `signature`/
 *  `nonce` ride the wire unverified (M2), so a fresh throwaway session
 *  keypair is sufficient; it is never used for anything else. */
export function generatePeerPubkeyB64(): string {
  const keypair = new Ed25519Keypair();
  return Buffer.from(keypair.getPublicKey().toRawBytes()).toString('base64');
}

/** Pure builder for the `join` WS message — split out from `connect()` so
 *  the message shape is unit-testable without a real WS/Device. */
export function buildJoinMessage(opts: BotPeerOptions): {
  type: 'join';
  roomId: string;
  peerId: string;
  roomPassword: string;
  peerPubkey: string;
  signature: string;
  nonce: number;
} {
  return {
    type: 'join',
    roomId: opts.roomId,
    peerId: opts.peerId,
    roomPassword: opts.roomPassword,
    peerPubkey: generatePeerPubkeyB64(),
    // Unverified server-side (M2, apps/relay/src/signaling.ts:73-74) — the
    // admission gate is the password, not this signature.
    signature: 'unverified',
    nonce: 1,
  };
}

/** Pure decision function for whether a `newProducer` notification should
 *  be consumed: never our own producer, never a producerId we've already
 *  claimed. Split out from `BotPeer` so the guard logic is unit-testable
 *  without a real WS/Device/transport -- same rationale as
 *  `buildJoinMessage`. */
export function shouldConsume(
  msg: NewProducerNotification,
  selfPeerId: string,
  alreadyConsumed: ReadonlySet<string>,
): boolean {
  return msg.peerId !== selfPeerId && !alreadyConsumed.has(msg.producerId);
}

export class BotPeer {
  private readonly opts: BotPeerOptions;
  private device: Device | null = null;
  private client: RelayClient | null = null;
  private sendTransport: msTypes.Transport | null = null;
  private recvTransport: msTypes.Transport | null = null;
  private videoProducer: msTypes.Producer | null = null;
  private audioProducer: msTypes.Producer | null = null;
  private readonly consumers: msTypes.Consumer[] = [];
  private readonly consumedProducerIds = new Set<string>();
  /** `newProducer` pushes that arrive before `recvTransport`/`device` are
   *  ready -- the relay sends the existing-producer roster as a burst of
   *  `newProducer` frames immediately after `routerRtpCapabilities`, well
   *  before device.load()/recv-transport creation finish. Drained once
   *  setup completes (see connect()). */
  private readonly pendingProducers: NewProducerNotification[] = [];
  private stopStatsReporter: (() => void) | null = null;

  constructor(opts: BotPeerOptions) {
    this.opts = opts;
  }

  /** Join the room, set up both transports, and start consuming every
   *  other peer currently in the room (plus any that join later). Does not
   *  produce yet -- that's still explicit via produceVideo/produceAudio. */
  async connect(): Promise<void> {
    const ws = new WebSocket(this.opts.relayUrl) as unknown as WsLike;
    this.client = new RelayClient(
      ws,
      (msg) => this.onNewProducer(msg as unknown as NewProducerNotification),
      { roomId: this.opts.roomId, peerId: this.opts.peerId, relayUrl: this.opts.relayUrl },
      this.opts.logger,
    );
    await this.client.ready;

    this.client.send(buildJoinMessage(this.opts));
    const joined = await this.client.waitFor(
      (m) => m.type === 'routerRtpCapabilities' || m.type === 'error',
    );
    if (joined.type === 'error') {
      throw new Error(`BotPeer join failed: ${String(joined['message'])}`);
    }

    await ensureNodeWebRtcGlobals();
    this.device = new Device({ handlerName: 'Chrome111' });
    await this.device.load({
      routerRtpCapabilities: joined['rtpCapabilities'] as msTypes.RtpCapabilities,
    });

    this.sendTransport = await createWiredTransport(this.device, this.client, 'send');
    this.recvTransport = await createWiredTransport(this.device, this.client, 'recv');

    // Drain any newProducer pushes (the existing-producer roster, or a live
    // arrival) that landed while device/recvTransport were still loading.
    const queued = this.pendingProducers.splice(0);
    for (const msg of queued) {
      this.onNewProducer(msg);
    }

    // Self-report client-side connection-quality stats to the relay's
    // /stats/report side channel, same as a real browser client does
    // (RoomPage.tsx) -- otherwise the relay only ever sees the bot's
    // SERVER-observed dvconf_rtc_* metrics, never the client-reported
    // dvconf_relay_peer_* ones cli/observer/metrics_user.py::
    // collect_user_sample() reads, and user/<peerId>.json is never written
    // for a bot session. Reports from BOTH transports now (merged --
    // see stats-reporter.ts's mergeRawExtract), so receiver-side fields
    // like jitter reflect what this bot's consumers are actually seeing,
    // not a structural zero.
    this.stopStatsReporter = startStatsReporter(
      { send: this.sendTransport, recv: this.recvTransport },
      {
        relayUrl: this.opts.relayUrl,
        roomId: this.opts.roomId,
        peerId: this.opts.peerId,
        logger: this.opts.logger,
      },
    );
  }

  /** Handles both the drained roster and live `newProducer` pushes.
   *  Queues instead of consuming when recvTransport isn't ready yet
   *  (connect() drains the queue once it is). Fire-and-forget -- errors are
   *  logged, never thrown into the RelayClient push-callback context. */
  private onNewProducer(msg: NewProducerNotification): void {
    if (this.device === null || this.recvTransport === null || this.client === null) {
      this.pendingProducers.push(msg);
      return;
    }
    if (!shouldConsume(msg, this.opts.peerId, this.consumedProducerIds)) {
      return;
    }
    // Claimed up-front (before the async round-trip below) so a second
    // push for the same producerId racing this one is skipped rather than
    // double-consumed -- a second consume of the same producer throws
    // "Consumer already exists" on the relay.
    this.consumedProducerIds.add(msg.producerId);
    void this.consumeProducer(msg).catch((err) => {
      this.consumedProducerIds.delete(msg.producerId);
      this.opts.logger?.warn(
        { module: 'bot-peer', producerId: msg.producerId, err },
        'BotPeer: consume failed after retries',
      );
    });
  }

  private async consumeProducer(msg: NewProducerNotification): Promise<void> {
    const client = this.client;
    const device = this.device;
    const recvTransport = this.recvTransport;
    if (client === null || device === null || recvTransport === null) return;

    const response = await retryOnTimeout(
      async () => {
        client.send({
          type: 'consume',
          producerId: msg.producerId,
          rtpCapabilities: device.rtpCapabilities,
        });
        const reply = await client.waitFor(
          (m) => m.type === 'consumed' && m['producerId'] === msg.producerId,
        );
        return reply as unknown as ConsumedResponse;
      },
      CONSUME_RETRY_ATTEMPTS,
      CONSUME_RETRY_DELAY_MS,
    );

    const consumer = await recvTransport.consume({
      id: response.consumerId,
      producerId: response.producerId,
      kind: response.kind,
      rtpParameters: response.rtpParameters,
    });
    this.consumers.push(consumer);
  }

  async produceVideo(track: MediaStreamTrack): Promise<msTypes.Producer> {
    if (this.sendTransport === null) {
      throw new Error('BotPeer.produceVideo: call connect() first');
    }
    this.videoProducer = await this.sendTransport.produce({ track: track as unknown as never });
    return this.videoProducer;
  }

  async produceAudio(track: MediaStreamTrack): Promise<msTypes.Producer> {
    if (this.sendTransport === null) {
      throw new Error('BotPeer.produceAudio: call connect() first');
    }
    this.audioProducer = await this.sendTransport.produce({ track: track as unknown as never });
    return this.audioProducer;
  }

  /** Number of other peers' producers currently being consumed --
   *  read-only accessor, mainly for tests. */
  consumerCount(): number {
    return this.consumers.length;
  }

  close(): void {
    if (this.stopStatsReporter !== null) this.stopStatsReporter();
    for (const consumer of this.consumers) consumer.close();
    if (this.videoProducer !== null) this.videoProducer.close();
    if (this.audioProducer !== null) this.audioProducer.close();
    if (this.sendTransport !== null) this.sendTransport.close();
    if (this.recvTransport !== null) this.recvTransport.close();
    if (this.client !== null) this.client.close();
  }
}
