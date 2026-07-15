/**
 * Evaluation-only signaling workload for the component-timing campaign.
 *
 * The production signaling probe sends `{type:"bench-ping", send_ts}`. This
 * client keeps a fixed user-message workload in both BENCH_LATENCY arms and,
 * when a ping is present, echoes the narrow `{type:"bench-pong", send_ts}`
 * frame required by `apps/signaling/src/latency-probe.ts`.
 */

import { WebSocket, type RawData } from 'ws';

export interface SignalingFrame {
  type: string;
  peerId?: string;
  send_ts?: number;
  [key: string]: unknown;
}

export interface SignalingProbeWorkloadOptions {
  url: string;
  roomId: string;
  connections: number;
  durationMs: number;
  messageIntervalMs: number;
  messagesPerPeer: number;
  connectTimeoutMs?: number;
}

export interface SignalingProbeWorkloadResult {
  connections: number;
  requestedUserMessages: number;
  sentUserMessages: number;
  deliveredUserMessages: number;
  droppedUserMessages: number;
  benchPongsSent: number;
  elapsedMs: number;
  errors: string[];
}

interface PeerState {
  ws: WebSocket;
  peerId: string | null;
  sent: number;
  delivered: number;
  dropped: number;
  pongs: number;
  errors: string[];
  resolveWelcome: () => void;
  rejectWelcome: (err: Error) => void;
  welcome: Promise<void>;
}

/** Parse one signaling frame without throwing on malformed/non-JSON traffic. */
export function parseSignalingFrame(raw: unknown): SignalingFrame | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
  else if (Array.isArray(raw)) text = Buffer.concat(raw).toString('utf8');
  else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
  else text = String(raw);

  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const frame = parsed as Record<string, unknown>;
    if (typeof frame['type'] !== 'string') return null;
    return frame as SignalingFrame;
  } catch {
    return null;
  }
}

/** Return the exact pong wire frame for a valid bench ping, otherwise null. */
export function buildBenchPong(frame: SignalingFrame): string | null {
  if (
    frame.type !== 'bench-ping' ||
    typeof frame.send_ts !== 'number' ||
    !Number.isFinite(frame.send_ts)
  ) {
    return null;
  }
  return JSON.stringify({ type: 'bench-pong', send_ts: frame.send_ts });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateOptions(opts: SignalingProbeWorkloadOptions): void {
  if (opts.connections < 2 || !Number.isInteger(opts.connections)) {
    throw new Error(`connections must be an integer >= 2, got ${opts.connections}`);
  }
  if (opts.durationMs <= 0 || !Number.isFinite(opts.durationMs)) {
    throw new Error(`durationMs must be > 0, got ${opts.durationMs}`);
  }
  if (opts.messageIntervalMs <= 0 || !Number.isFinite(opts.messageIntervalMs)) {
    throw new Error(`messageIntervalMs must be > 0, got ${opts.messageIntervalMs}`);
  }
  if (opts.messagesPerPeer < 1 || !Number.isInteger(opts.messagesPerPeer)) {
    throw new Error(`messagesPerPeer must be an integer >= 1, got ${opts.messagesPerPeer}`);
  }
}

function newPeer(url: string, connectTimeoutMs: number): PeerState {
  const ws = new WebSocket(url);
  let resolveWelcome: () => void = () => {};
  let rejectWelcome: (err: Error) => void = () => {};
  const welcome = new Promise<void>((resolve, reject) => {
    resolveWelcome = resolve;
    rejectWelcome = reject;
  });
  const state: PeerState = {
    ws,
    peerId: null,
    sent: 0,
    delivered: 0,
    dropped: 0,
    pongs: 0,
    errors: [],
    resolveWelcome,
    rejectWelcome,
    welcome,
  };

  const timer = setTimeout(() => {
    state.rejectWelcome(new Error(`signaling welcome timeout after ${connectTimeoutMs}ms`));
  }, connectTimeoutMs);

  ws.on('message', (raw: RawData) => {
    const frame = parseSignalingFrame(raw);
    if (frame === null) return;

    const pong = buildBenchPong(frame);
    if (pong !== null) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(pong);
        state.pongs++;
      }
      return;
    }

    if (frame.type === 'welcome' && typeof frame.peerId === 'string') {
      if (state.peerId === null) {
        state.peerId = frame.peerId;
        clearTimeout(timer);
        state.resolveWelcome();
      }
      return;
    }

    if (frame.type === 'offer') state.delivered++;
  });

  ws.on('error', (err) => {
    state.errors.push(err.message);
    if (state.peerId === null) {
      clearTimeout(timer);
      state.rejectWelcome(err);
    }
  });
  ws.on('close', (code) => {
    if (state.peerId === null) {
      clearTimeout(timer);
      state.rejectWelcome(new Error(`signaling socket closed before welcome (code=${code})`));
    }
  });

  return state;
}

/**
 * Run a fixed offer-delivery workload while also answering every bench ping.
 * User-message count is target-based rather than timer-duration-based, keeping
 * the OFF/ON observer-effect arms directly comparable.
 */
export async function runSignalingProbeWorkload(
  opts: SignalingProbeWorkloadOptions,
): Promise<SignalingProbeWorkloadResult> {
  validateOptions(opts);
  const startedAt = Date.now();
  const connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
  const peers = Array.from({ length: opts.connections }, () =>
    newPeer(opts.url, connectTimeoutMs),
  );
  const intervals: Array<ReturnType<typeof setInterval>> = [];

  try {
    await Promise.all(peers.map((peer) => peer.welcome));
    for (const peer of peers) {
      peer.ws.send(JSON.stringify({ type: 'join', roomId: opts.roomId }));
    }
    await sleep(250);

    peers.forEach((peer, index) => {
      const target = peers[(index + 1) % peers.length]!.peerId!;
      let sequence = 0;
      const sendOne = (): void => {
        if (sequence >= opts.messagesPerPeer) return;
        sequence++;
        if (peer.ws.readyState !== WebSocket.OPEN) {
          peer.dropped++;
          return;
        }
        try {
          peer.ws.send(
            JSON.stringify({
              type: 'offer',
              targetPeerId: target,
              sdp: { type: 'offer', sdp: `observer-${index}-${sequence}` },
            }),
          );
          peer.sent++;
        } catch (err) {
          peer.dropped++;
          peer.errors.push(err instanceof Error ? err.message : String(err));
        }
      };
      sendOne();
      intervals.push(setInterval(sendOne, opts.messageIntervalMs));
    });

    await sleep(opts.durationMs);
    await sleep(500);
  } finally {
    for (const interval of intervals) clearInterval(interval);
    for (const peer of peers) {
      try {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(JSON.stringify({ type: 'leave' }));
          peer.ws.close();
        } else if (peer.ws.readyState === WebSocket.CONNECTING) {
          peer.ws.terminate();
        }
      } catch {
        // Teardown is best-effort; the returned error list carries live failures.
      }
    }
    await sleep(100);
  }

  return {
    connections: peers.length,
    requestedUserMessages: peers.length * opts.messagesPerPeer,
    sentUserMessages: peers.reduce((sum, peer) => sum + peer.sent, 0),
    deliveredUserMessages: peers.reduce((sum, peer) => sum + peer.delivered, 0),
    droppedUserMessages: peers.reduce((sum, peer) => sum + peer.dropped, 0),
    benchPongsSent: peers.reduce((sum, peer) => sum + peer.pongs, 0),
    elapsedMs: Date.now() - startedAt,
    errors: peers.flatMap((peer) => peer.errors),
  };
}
