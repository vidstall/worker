/**
 * BotPeer — a SEND-ONLY mediasoup-client peer built on the Node-only
 * primitives extracted to `@dvconf/shared`'s `mediasoup-node` module
 * (`ensureNodeWebRtcGlobals`, `RelayClient`, `createWiredTransport`), which
 * were pulled out of `scripts/bench/mediasoup-client-harness.ts`'s
 * `VirtualPeer` so both share ONE implementation of the relay wire protocol
 * (`apps/relay/src/signaling.ts`).
 *
 * Unlike `VirtualPeer`, this never creates a recv transport / consumes other
 * peers' media — the bot has no reason to receive anything, it only
 * publishes the looping MP4's video + audio.
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

export class BotPeer {
  private readonly opts: BotPeerOptions;
  private device: Device | null = null;
  private client: RelayClient | null = null;
  private sendTransport: msTypes.Transport | null = null;
  private videoProducer: msTypes.Producer | null = null;
  private audioProducer: msTypes.Producer | null = null;

  constructor(opts: BotPeerOptions) {
    this.opts = opts;
  }

  /** Join the room and set up the send transport. Does not produce yet. */
  async connect(): Promise<void> {
    const ws = new WebSocket(this.opts.relayUrl) as unknown as WsLike;
    this.client = new RelayClient(
      ws,
      null,
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

  close(): void {
    if (this.videoProducer !== null) this.videoProducer.close();
    if (this.audioProducer !== null) this.audioProducer.close();
    if (this.sendTransport !== null) this.sendTransport.close();
    if (this.client !== null) this.client.close();
  }
}
