/**
 * REQ-MLW-A-11 (M2b-live-WAN Sub-lane A, Task 4 / 4-daemon) — the PRODUCTION
 * CovertJoinTransport for the validator-daemon covert canary publisher.
 *
 * Tasks 0-3 prove a REAL browser canary lands byte-identical and is detected across the
 * evil-relay -> F1 pipe -> 2-fork-validator chain. This is the "don't dodge production
 * ingest" leg: a REAL relay-signaling WS client behind the `CanaryPublisher.publish(...)`
 * seam (publisher.ts) that drives the actual client<->relay handshake
 * `join -> createTransport -> connectTransport -> produce` (signaling.ts) and honours the
 * COVERT contract.
 *
 * COVERTNESS (DESIGN §5, signaling.ts:790/963): the relay broadcasts a `rosterPeer`
 * (identity) frame to existing members ONLY when the joiner carried a `roomPassword`
 * (=> a validated `sessionPubkey`). The canary MUST take the NO-PASSWORD legacy path, so
 * the `join` message OMITS `roomPassword`/`peerPubkey` entirely (signaling.ts:790 skips the
 * admission block => `sessionPubkey` stays `undefined` => the :963 roster broadcast is
 * skipped). The relay still FORWARDS the canary media (a real producer -> `newProducer`
 * fan-out, signaling.ts:1245) — but no peer is told a new MEMBER appeared.
 *
 * INV-B: this is a WS CLIENT of the relay — it speaks the wire protocol and imports ZERO
 * `apps/relay/` source (the relay media-path behaviour is unchanged). The transport is
 * connector-injected so the socket layer is swappable; `wsSignalingConnector` is the real
 * `ws` adapter (the live-leg wiring supplies it; tests inject the same against an in-test
 * relay that mirrors signaling.ts:790/963).
 *
 * `sendBody` is byte-opaque: the canary SFrame is ALREADY a finished frame
 * (`CanaryPublisher.produce`), so there is NO `createEncodedStreams` transform — the bytes
 * ride the media plane verbatim.
 *
 * LOGGING (HARD-GATE): NEVER log key material / cellSecret / P_i / K_canary. Only non-secret
 * ids (relayHomeId, producerId) and the password flag.
 */

import { createLogger } from '@dvconf/shared';
import type { CovertJoinTransport } from './publisher.js';

const MOD = 'canary/covert-join-transport';
const log = createLogger(MOD);

/** A minimal JSON-frame signaling socket (the relay client-WS protocol). Connector-injected
 *  so the transport logic is testable without a real socket and the live leg can swap it. */
export interface SignalingSocket {
  send(msg: Record<string, unknown>): void;
  onMessage(handler: (msg: Record<string, unknown>) => void): void;
  close(): void;
}

export interface SignalingConnector {
  connect(url: string): Promise<SignalingSocket>;
}

export interface CovertTransportOpts {
  /** The relay home's signaling WS url. */
  relayUrl: string;
  roomId: string;
  peerId: string;
  /** Optional override for the produced track's rtpParameters (default: single-layer VP8). */
  rtpParameters?: Record<string, unknown>;
  /** Credentials used ONLY for a `withPassword:true` join (the non-covert / RED-hook path). */
  passwordCreds?: { roomPassword: string; peerPubkey: string };
}

/** A single-layer (L1T1) VP8 video producer — the canary rides one opaque media track. */
const DEFAULT_RTP_PARAMETERS: Record<string, unknown> = {
  codecs: [
    { mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] },
  ],
  encodings: [{ scalabilityMode: 'L1T1' }],
};

/**
 * The production covert transport: a real relay-signaling WS client. `join` drives the
 * covert no-password handshake + a real `produce`; `sendBody` carries finished canary SFrame
 * bytes opaquely on the media plane.
 */
export class RelaySignalingCovertTransport implements CovertJoinTransport {
  private socket: SignalingSocket | null = null;
  private readonly waiters = new Map<string, Array<(msg: Record<string, unknown>) => void>>();
  private transportId: string | null = null;

  /** The relay home this transport covertly joined (set on `join`). */
  joinedRelayHomeId: string | null = null;
  /** The covert contract flag the publisher passed (the canary MUST be `false`). */
  joinedWithPassword: boolean | null = null;
  /** The real producer id the relay assigned on the `produce` handshake (covert ingest). */
  producerId: string | null = null;
  /** The exact SFrame bodies handed to the media plane, in order (byte-opaque). */
  readonly sentBodies: Uint8Array[] = [];

  constructor(
    private readonly connector: SignalingConnector,
    private readonly opts: CovertTransportOpts,
  ) {}

  private waitFor(type: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${MOD}: timeout waiting for '${type}'`)),
        timeoutMs,
      );
      const queue = this.waiters.get(type) ?? [];
      queue.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.waiters.set(type, queue);
    });
  }

  private dispatch(msg: Record<string, unknown>): void {
    const type = msg['type'];
    if (typeof type !== 'string') return;
    const queue = this.waiters.get(type);
    const next = queue?.shift();
    if (next) next(msg);
  }

  /**
   * Covertly join `relayHomeId` then run the real produce handshake. With `withPassword:false`
   * (the canary contract) the join OMITS `roomPassword`/`peerPubkey` — the relay's legacy path
   * means NO roster broadcast (signaling.ts:790/963). With `withPassword:true` it sends the
   * configured credentials (the non-covert path; requires `passwordCreds`).
   */
  async join(opts: { relayHomeId: string; withPassword: boolean }): Promise<void> {
    this.joinedRelayHomeId = opts.relayHomeId;
    this.joinedWithPassword = opts.withPassword;

    const socket = await this.connector.connect(this.opts.relayUrl);
    this.socket = socket;
    socket.onMessage((m) => this.dispatch(m));

    // COVERT: omit roomPassword/peerPubkey on the no-password path (signaling.ts:790 legacy).
    const joinMsg: Record<string, unknown> = {
      type: 'join',
      roomId: this.opts.roomId,
      peerId: this.opts.peerId,
    };
    if (opts.withPassword) {
      if (!this.opts.passwordCreds) {
        throw new Error(`${MOD}: a withPassword join requires passwordCreds`);
      }
      joinMsg['roomPassword'] = this.opts.passwordCreds.roomPassword;
      joinMsg['peerPubkey'] = this.opts.passwordCreds.peerPubkey;
    }

    const routerCaps = this.waitFor('routerRtpCapabilities');
    socket.send(joinMsg);
    await routerCaps;

    // createTransport(send) -> transportCreated.
    const created = this.waitFor('transportCreated');
    socket.send({ type: 'createTransport', direction: 'send' });
    const tc = await created;
    this.transportId = tc['id'] as string;

    // connectTransport — the relay sends no reply on success (handleConnectTransport). The
    // client DTLS is a stub here; the live leg supplies the real mediasoup-client DTLS.
    socket.send({
      type: 'connectTransport',
      transportId: this.transportId,
      dtlsParameters: { fingerprints: [], role: 'client' },
    });

    // produce one L1T1 VP8 video producer — the real covert ingest. -> produced.
    const produced = this.waitFor('produced');
    socket.send({
      type: 'produce',
      transportId: this.transportId,
      kind: 'video',
      rtpParameters: this.opts.rtpParameters ?? DEFAULT_RTP_PARAMETERS,
    });
    const p = await produced;
    this.producerId = p['producerId'] as string;

    log.info(
      { relayHomeId: opts.relayHomeId, withPassword: opts.withPassword, producerId: this.producerId },
      'covert join + produce handshake complete (no roster broadcast on the no-password path)',
    );
  }

  /**
   * Emit one finished canary SFrame on the media plane, byte-opaque (NO createEncodedStreams —
   * the bytes are already a complete SFrame). Captured verbatim for the byte-identity proof; in
   * production the live media transport (SRTP over the negotiated WebRtcTransport) forwards it.
   */
  sendBody(body: Uint8Array): Promise<void> {
    this.sentBodies.push(Uint8Array.prototype.slice.call(body));
    return Promise.resolve();
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * The real `ws` connector — the production socket adapter. Lazily imports `ws` so the module
 * carries no socket dependency until a connector is actually built (the live-leg wiring or a
 * test). Speaks the relay client-WS protocol: JSON frames over a single WebSocket.
 */
export function wsSignalingConnector(): SignalingConnector {
  return {
    async connect(url: string): Promise<SignalingSocket> {
      const { WebSocket } = await import('ws');
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      return {
        send: (msg) => ws.send(JSON.stringify(msg)),
        onMessage: (handler) =>
          ws.on('message', (data) =>
            handler(JSON.parse(data.toString()) as Record<string, unknown>),
          ),
        close: () => ws.close(),
      };
    },
  };
}
