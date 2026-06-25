/**
 * REQ-MLW-A-11 (Task 4, 4-daemon) — the PRODUCTION CovertJoinTransport.
 *
 * The other Task-4 readings (Tasks 0-3) prove a REAL browser canary lands byte-identical
 * and is detected across the evil-relay -> F1 -> 2-fork-validator chain. This file proves
 * the "don't dodge production ingest" half: a REAL relay-signaling WS client behind the
 * `CanaryPublisher.publish(...)` seam that drives the actual `join -> createTransport ->
 * connectTransport -> produce` handshake and honours the COVERT contract.
 *
 * COVERTNESS (DESIGN §5, signaling.ts:790/963): the relay broadcasts a `rosterPeer`
 * (identity) frame to existing members ONLY when the joiner carried a `roomPassword` (=>
 * a `sessionPubkey`). The canary MUST take the NO-PASSWORD legacy path so it is invisible
 * to the roster — the relay still FORWARDS its media (a real producer -> `newProducer`
 * fan-out) but no peer is told a new MEMBER appeared. We assert that exact split against a
 * faithful in-test relay that mirrors signaling.ts:790/963. The REAL relay's matching
 * behaviour is independently locked in BOTH directions by apps/relay/.../room-password-roster.test.ts:
 * the POSITIVE (a password join DOES announce a rosterPeer) and the NEGATIVE covert-by-omission
 * case ('COVERT (negative): a NO-password legacy joiner ... triggers ZERO rosterPeer', added with
 * this task) — so the canary's no-password => no-roster claim is pinned on the real signaling code.
 *
 * The transport is a REAL `ws` client (production `wsSignalingConnector`) over a REAL
 * socket; only the relay is an in-test model. `sendBody` carries the SFrame bytes opaquely
 * (NO `createEncodedStreams` — the bytes are already a finished canary SFrame).
 *
 * Non-vacuity RED-hook: a WITH-password join through the SAME client DOES produce a
 * `rosterPeer` broadcast — so the 0-broadcast covert result is the no-password path's doing,
 * not a dead assertion.
 *
 * LOGGING/SECRETS (HARD-GATE): never log cellSecret / P_i / K_canary.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import {
  verifyForwardedCanary,
  recomputeCanaryFrame,
  deriveCanarySeed,
  type VerifyInput,
} from '../verifier.js';
import { CanaryPublisher, type CanaryProduceInput } from '../publisher.js';
import {
  RelaySignalingCovertTransport,
  wsSignalingConnector,
} from '../covert-join-transport.js';

// ── Fixed per-cell canary inputs (the same shape as publisher.test.ts) ──────────
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const K_ROOM = new Uint8Array(32).fill(0x5c);
const ROOM_ID = 'cfa-covert-publish-room';
const RELAY_HOME_ID = 'relay-home-7';
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4, 5];

const produceInput = (ctrs: number[]): CanaryProduceInput => ({
  kRoom: K_ROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  ctrs,
});

const verifyInput = (expectedCtrs: number[]): VerifyInput => ({
  kRoom: K_ROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  expectedCtrs,
});

/** Valid base64 of a 32-byte ed25519 session pubkey (mirrors room-password-roster). */
function pubkey32(seed: number): string {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (seed * 31 + i) & 0xff;
  return Buffer.from(b).toString('base64');
}

/** signaling.ts:391 validateSessionPubkey, mirrored faithfully. */
function validSessionPubkey(pubkeyB64: string | undefined): boolean {
  if (typeof pubkeyB64 !== 'string' || pubkeyB64.length === 0) return false;
  return Buffer.from(pubkeyB64, 'base64').length === 32;
}

interface RelayFrame {
  type: string;
  [k: string]: unknown;
}

/**
 * A faithful in-test relay implementing JUST the protocol slice the covert transport drives
 * + the signaling.ts:790/963 roster rule: `rosterPeer` is broadcast to existing room members
 * ONLY when the joiner carried a roomPassword AND a valid session pubkey; `newProducer` is
 * fanned out on every produce (media is always forwarded — that is the point of the canary).
 */
class FakeRelay {
  readonly wss: WebSocketServer;
  readonly port: number;
  /** roomId -> set of member sockets. */
  private readonly rooms = new Map<string, Set<WebSocket>>();
  /** socket -> { roomId, peerId, sessionPubkey? }. */
  private readonly state = new Map<
    WebSocket,
    { roomId: string; peerId: string; sessionPubkey?: string }
  >();
  private producerSeq = 0;

  private constructor(wss: WebSocketServer, port: number) {
    this.wss = wss;
    this.port = port;
    wss.on('connection', (ws) => {
      ws.on('message', (data) => this.onMessage(ws, JSON.parse(data.toString()) as RelayFrame));
      ws.on('close', () => {
        const st = this.state.get(ws);
        if (st) this.rooms.get(st.roomId)?.delete(ws);
        this.state.delete(ws);
      });
    });
  }

  static start(): Promise<FakeRelay> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: 0 });
      wss.on('listening', () => {
        const addr = wss.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(new FakeRelay(wss, port));
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  private send(ws: WebSocket, msg: RelayFrame): void {
    ws.send(JSON.stringify(msg));
  }

  private onMessage(ws: WebSocket, msg: RelayFrame): void {
    switch (msg.type) {
      case 'join': {
        const roomId = msg['roomId'] as string;
        const peerId = msg['peerId'] as string;
        // signaling.ts:790/963 — sessionPubkey is set ONLY on the password path.
        const sessionPubkey =
          typeof msg['roomPassword'] === 'string' && validSessionPubkey(msg['peerPubkey'] as string)
            ? (msg['peerPubkey'] as string)
            : undefined;
        const members = this.rooms.get(roomId) ?? new Set<WebSocket>();
        // Roster identity broadcast to existing members — ONLY for a password join.
        if (sessionPubkey !== undefined) {
          for (const existing of members) {
            this.send(existing, { type: 'rosterPeer', peerId, sessionPubkey });
          }
        }
        members.add(ws);
        this.rooms.set(roomId, members);
        this.state.set(ws, { roomId, peerId, sessionPubkey });
        this.send(ws, { type: 'routerRtpCapabilities', rtpCapabilities: {}, mode: 'sfu' });
        break;
      }
      case 'createTransport': {
        this.send(ws, {
          type: 'transportCreated',
          id: 'send-transport-1',
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: { fingerprints: [], role: 'auto' },
        });
        break;
      }
      case 'connectTransport': {
        // No reply in the real protocol (handleConnectTransport) on success.
        break;
      }
      case 'produce': {
        const st = this.state.get(ws);
        const producerId = `producer-${++this.producerSeq}`;
        this.send(ws, { type: 'produced', producerId });
        // notifyNewProducer (signaling.ts:1245): fan the new producer out to OTHER members.
        if (st) {
          for (const other of this.rooms.get(st.roomId) ?? []) {
            if (other === ws) continue;
            this.send(other, {
              type: 'newProducer',
              peerId: st.peerId,
              producerId,
              kind: msg['kind'],
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  close(): void {
    for (const ws of this.state.keys()) ws.close();
    this.wss.close();
  }
}

/** An observer member that joins WITH a password (so it is a roster-broadcast target). */
async function joinObserver(
  relay: FakeRelay,
  peerId: string,
): Promise<{ ws: WebSocket; frames: RelayFrame[]; close: () => void }> {
  const frames: RelayFrame[] = [];
  const ws = new WebSocket(relay.url);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.on('message', (d) => frames.push(JSON.parse(d.toString()) as RelayFrame));
  ws.send(
    JSON.stringify({
      type: 'join',
      roomId: ROOM_ID,
      peerId,
      roomPassword: 'observer-pw',
      peerPubkey: pubkey32(1),
    }),
  );
  await new Promise((r) => setTimeout(r, 50));
  return { ws, frames, close: () => ws.close() };
}

const tick = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));

let relay: FakeRelay | undefined;
afterEach(() => {
  relay?.close();
  relay = undefined;
});

describe('REQ-MLW-A-11 — production CovertJoinTransport: covert no-password join + real produce', () => {
  it('publish() over a real WS transport forwards media (newProducer) WITHOUT a roster leak (rosterPeer===0)', async () => {
    relay = await FakeRelay.start();
    const observer = await joinObserver(relay, 'observer');

    const transport = new RelaySignalingCovertTransport(wsSignalingConnector(), {
      relayUrl: relay.url,
      roomId: ROOM_ID,
      peerId: 'canary',
    });
    const frames = await new CanaryPublisher().publish(
      { relayHomeId: RELAY_HOME_ID, ...produceInput(CTRS) },
      transport,
    );
    await tick(100);

    // Covert contract: the join took the NO-PASSWORD path.
    expect(transport.joinedRelayHomeId).toBe(RELAY_HOME_ID);
    expect(transport.joinedWithPassword).toBe(false);

    // Real ingest: a producer was created via the real produce handshake (not dodged).
    expect(transport.producerId).toBeTruthy();

    // The relay FORWARDS the canary media to the observer (newProducer fan-out)...
    const newProducer = observer.frames.filter((f) => f.type === 'newProducer');
    expect(newProducer.length).toBeGreaterThan(0);
    expect(newProducer[0]!['peerId']).toBe('canary');

    // ...but NO identity roster frame about the canary ever reaches the observer.
    const rosterAboutCanary = observer.frames.filter(
      (f) => f.type === 'rosterPeer' && f['peerId'] === 'canary',
    );
    expect(rosterAboutCanary.length).toBe(0);

    // sendBody carried every produced SFrame opaquely, in order, byte-identical to produce().
    expect(transport.sentBodies.length).toBe(CTRS.length);
    frames.forEach((f, i) => {
      expect(Buffer.from(transport.sentBodies[i]!).equals(Buffer.from(f))).toBe(true);
    });

    transport.close();
    observer.close();
  });

  it('the SFrame bytes carried on the wire verify clean against the FROZEN verifier (publish ≡ produce)', async () => {
    relay = await FakeRelay.start();
    const transport = new RelaySignalingCovertTransport(wsSignalingConnector(), {
      relayUrl: relay.url,
      roomId: ROOM_ID,
      peerId: 'canary',
    });
    await new CanaryPublisher().publish(
      { relayHomeId: RELAY_HOME_ID, ...produceInput(CTRS) },
      transport,
    );

    // Wrap each opaque body as a VP8-ish RTP packet (body as the LAST bytes) and verify.
    const captured = transport.sentBodies.map((body) =>
      Buffer.concat([Buffer.alloc(16), Buffer.from(body)]),
    );
    const result = await verifyForwardedCanary(captured, verifyInput(CTRS));
    expect(result.mediaPackets).toBe(CTRS.length);
    expect(result.byteIdentical).toBe(result.mediaPackets);
    expect(result.divergences.length).toBe(0);

    // DRY: the bytes equal the verifier's own recompute (no parallel chain).
    const seed = deriveCanarySeed(CELL_SECRET);
    for (let i = 0; i < CTRS.length; i++) {
      const expected = await recomputeCanaryFrame(
        { kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID },
        seed,
        CTRS[i]!,
      );
      expect(Buffer.from(transport.sentBodies[i]!).equals(Buffer.from(expected))).toBe(true);
    }
    transport.close();
  });

  it('NON-VACUITY: a WITH-password join through the SAME client DOES leak a rosterPeer to the observer', async () => {
    relay = await FakeRelay.start();
    const observer = await joinObserver(relay, 'observer');

    // Same production transport, but joining the loud (password) way — the relay MUST roster it.
    const loud = new RelaySignalingCovertTransport(wsSignalingConnector(), {
      relayUrl: relay.url,
      roomId: ROOM_ID,
      peerId: 'loud',
      passwordCreds: { roomPassword: 'loud-pw', peerPubkey: pubkey32(2) },
    });
    await loud.join({ relayHomeId: RELAY_HOME_ID, withPassword: true });
    await tick(100);

    expect(loud.joinedWithPassword).toBe(true);
    const rosterAboutLoud = observer.frames.filter(
      (f) => f.type === 'rosterPeer' && f['peerId'] === 'loud',
    );
    expect(rosterAboutLoud.length).toBeGreaterThan(0);

    loud.close();
    observer.close();
  });
});
