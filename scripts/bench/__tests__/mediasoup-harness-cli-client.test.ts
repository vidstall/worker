/**
 * RED test for the Node mediasoup-client harness — S23.2.C1.
 *
 * Covers the unit-testable CLI/networking surfaces of
 * `mediasoup-client-harness.ts`:
 *
 *   - `parseArgs` — CLI parsing
 *   - `buildIceServers` — S28.B.1 ICE server config
 *   - `peerLabel` — A..Z peer index labelling
 *   - `RelayClient` — request/response routing with mocked WS
 *
 * The `VirtualPeer.run()` integration (live mediasoup-client + relay WS
 * handshake) is validated end-to-end in S23.3 against a running relay.
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.C1
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from 'vitest';
import { EventEmitter } from 'node:events';
import {
  parseArgs,
  peerLabel,
  buildIceServers,
  DEFAULT_STUN_URL,
} from '../mediasoup-client-harness.js';
// `RelayClient`/`RelayMessage`/`WsLike` were extracted to
// `packages/shared/src/mediasoup-node/` (shared between this harness and
// `apps/bot`) — imported directly from there now.
import {
  RelayClient,
  type WsLike,
} from '../../../packages/shared/src/index.js';

// ── parseArgs ────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('honours --relay-url --room-id --duration', () => {
    const args = parseArgs([
      'node',
      'harness.ts',
      '--relay-url',
      'ws://relay:4000',
      '--room-id',
      'room-x',
      '--duration',
      '10',
    ]);
    expect(args).toEqual({
      relayUrl: 'ws://relay:4000',
      roomId: 'room-x',
      durationMs: 10_000,
      peers: 2,
      iceMode: 'none',
    });
  });

  it('defaults relay-url, duration, peers when flags are absent', () => {
    const args = parseArgs(['node', 'harness.ts']);
    expect(args.relayUrl).toBe('ws://localhost:4000');
    expect(args.durationMs).toBe(60_000);
    expect(args.peers).toBe(2);
    expect(args.roomId).toMatch(/^bench-\d+$/);
  });

  it('rounds fractional --duration to ms', () => {
    const args = parseArgs(['node', 'harness.ts', '--duration', '0.5']);
    expect(args.durationMs).toBe(500);
  });

  it('honours --peers N (S25.C.4 — N-peer extension)', () => {
    const args = parseArgs(['node', 'harness.ts', '--peers', '4']);
    expect(args.peers).toBe(4);
  });

  it('rejects --peers below 2', () => {
    expect(() => parseArgs(['node', 'harness.ts', '--peers', '1'])).toThrow(
      /peers/,
    );
  });

  it('rejects --peers above 26', () => {
    expect(() => parseArgs(['node', 'harness.ts', '--peers', '27'])).toThrow(
      /peers/,
    );
  });

  it('rejects non-numeric --peers', () => {
    expect(() => parseArgs(['node', 'harness.ts', '--peers', 'four'])).toThrow(
      /peers/,
    );
  });

  // S28.B.1 — --ice-mode flag (Phase I prep for internet-benchmark-plan)
  it('defaults --ice-mode to "none"', () => {
    const args = parseArgs(['node', 'harness.ts']);
    expect(args.iceMode).toBe('none');
  });

  it('honours --ice-mode stun', () => {
    const args = parseArgs(['node', 'harness.ts', '--ice-mode', 'stun']);
    expect(args.iceMode).toBe('stun');
  });

  it('honours --ice-mode turn', () => {
    const args = parseArgs(['node', 'harness.ts', '--ice-mode', 'turn']);
    expect(args.iceMode).toBe('turn');
  });

  it('rejects unknown --ice-mode values', () => {
    expect(() =>
      parseArgs(['node', 'harness.ts', '--ice-mode', 'mesh']),
    ).toThrow(/ice-mode/);
  });
});

// ── buildIceServers (S28.B.1 — Phase I prep) ─────────────────────────

describe('buildIceServers', () => {
  it('returns empty array for ice-mode "none"', () => {
    expect(buildIceServers('none')).toEqual([]);
  });

  it('returns public Google STUN for ice-mode "stun"', () => {
    const servers = buildIceServers('stun');
    expect(servers).toEqual([{ urls: [DEFAULT_STUN_URL] }]);
  });

  it('exposes the default STUN URL as the canonical public-internet probe', () => {
    expect(DEFAULT_STUN_URL).toBe('stun:stun.l.google.com:19302');
  });

  it('returns STUN + TURN for ice-mode "turn" with env-supplied config', () => {
    const servers = buildIceServers('turn', {
      turnUrl: 'turn:relay.example.com:3478?transport=udp',
      turnUsername: '1737000000:alice',
      turnCredential: 'base64hmac==',
    });
    expect(servers).toEqual([
      { urls: [DEFAULT_STUN_URL] },
      {
        urls: ['turn:relay.example.com:3478?transport=udp'],
        username: '1737000000:alice',
        credential: 'base64hmac==',
      },
    ]);
  });

  it('throws on ice-mode "turn" when TURN env config is missing', () => {
    expect(() => buildIceServers('turn')).toThrow(/BENCH_TURN_URL/);
  });

  it('throws on ice-mode "turn" when only URL is supplied (no creds)', () => {
    expect(() =>
      buildIceServers('turn', {
        turnUrl: 'turn:relay.example.com:3478',
      }),
    ).toThrow(/BENCH_TURN_USERNAME|BENCH_TURN_CREDENTIAL/);
  });
});

// ── peerLabel ────────────────────────────────────────────────────────

describe('peerLabel', () => {
  it('maps 0..3 to A..D', () => {
    expect(peerLabel(0)).toBe('A');
    expect(peerLabel(1)).toBe('B');
    expect(peerLabel(2)).toBe('C');
    expect(peerLabel(3)).toBe('D');
  });

  it('maps 25 to Z', () => {
    expect(peerLabel(25)).toBe('Z');
  });

  it('throws on out-of-range indices', () => {
    expect(() => peerLabel(-1)).toThrow(/range/);
    expect(() => peerLabel(26)).toThrow(/range/);
  });
});

// ── RelayClient ──────────────────────────────────────────────────────

class MockWs extends EventEmitter implements WsLike {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }
}

describe('RelayClient', () => {
  let ws: MockWs;
  let client: RelayClient;

  beforeEach(() => {
    ws = new MockWs();
    client = new RelayClient(ws);
  });

  it('resolves ready when the underlying ws fires open', async () => {
    let resolved = false;
    void client.ready.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    ws.emit('open');
    await client.ready;
    expect(resolved).toBe(true);
  });

  it('serialises send payloads as JSON', () => {
    client.send({ type: 'join', roomId: 'r', peerId: 'p' });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'join',
      roomId: 'r',
      peerId: 'p',
    });
  });

  it('waitFor resolves with the first matching message', async () => {
    const promise = client.waitFor((m) => m.type === 'routerRtpCapabilities');
    // Push an unrelated message first — must NOT resolve the predicate.
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', message: 'noise' })),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'routerRtpCapabilities',
          rtpCapabilities: { codecs: [] },
        }),
      ),
    );
    const msg = await promise;
    expect(msg.type).toBe('routerRtpCapabilities');
    expect(msg['rtpCapabilities']).toEqual({ codecs: [] });
  });

  it('routes newProducer push messages to the onProducer callback', () => {
    const onProducer = vi.fn();
    const c = new RelayClient(new MockWs(), onProducer);
    c.routeIncoming({
      type: 'newProducer',
      peerId: 'pA',
      producerId: 'prod1',
      kind: 'audio',
    });
    expect(onProducer).toHaveBeenCalledOnce();
    expect(onProducer).toHaveBeenCalledWith({
      type: 'newProducer',
      peerId: 'pA',
      producerId: 'prod1',
      kind: 'audio',
    });
  });

  it('waitFor rejects on timeout when no matching message arrives', async () => {
    vi.useFakeTimers();
    try {
      const promise = client.waitFor((m) => m.type === 'never', 1000);
      const caught = promise.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await caught).toContain('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores malformed JSON instead of throwing', () => {
    expect(() => ws.emit('message', Buffer.from('not-json'))).not.toThrow();
  });
});
