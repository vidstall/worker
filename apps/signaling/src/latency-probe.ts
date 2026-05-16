/**
 * Signaling-side latency probe — Task #26 (scope B).
 *
 * Measures client ↔ signaling WebSocket RTT via a timestamped bench-ping
 * exchange. Emits `L_sig_rtt`. Off-by-default.
 *
 * Wire-in (`signaling/src/index.ts`): on each `ws` connection, call
 * `probe.attach(ws, peerId)`. The probe sends a `bench-ping` every 5 s with
 * `send_ts`; the client must echo back `{ type: 'bench-pong', send_ts }`.
 * If the client does not implement the pong, the probe simply records nothing.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 */

import type { WebSocket } from 'ws';
import { LatencyWriter, isBenchEnabled, type Logger } from '@dvconf/shared';

export interface SignalingLatencyProbe {
  /** Attach the probe to one WebSocket. Returns a detach fn. */
  attach(ws: WebSocket, peerId: string): () => void;
  close(): void;
}

interface BenchPongMessage {
  type: 'bench-pong';
  send_ts: number;
}

export function createSignalingLatencyProbe(
  instance: string,
  logger: Logger,
): SignalingLatencyProbe | null {
  if (!isBenchEnabled()) {
    return null;
  }
  const writer = new LatencyWriter({ source: 'signaling', instance });
  logger.info(
    { traceId: writer.traceId, scenario: writer.scenario, file: writer.getFilePath() },
    'Latency benchmark probe ENABLED',
  );

  const intervalMs = parseInt(process.env['BENCH_SAMPLE_INTERVAL_MS'] ?? '5000', 10);

  return {
    attach(ws, peerId) {
      const pingHandle = setInterval(() => {
        if (ws.readyState !== ws.OPEN) return;
        const send_ts = Date.now();
        try {
          ws.send(JSON.stringify({ type: 'bench-ping', send_ts }));
        } catch {
          /* socket race condition — skip */
        }
      }, intervalMs);

      const onMessage = (raw: unknown): void => {
        let msg: BenchPongMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type !== 'bench-pong' || typeof msg.send_ts !== 'number') {
          return;
        }
        const rtt = Date.now() - msg.send_ts;
        writer.write('L_sig_rtt', rtt, { peer_id: peerId });
      };

      // `ws.on('message', ...)` is called for every message; we filter inline
      // so we don't intercept signaling traffic.
      ws.on('message', onMessage);

      return () => {
        clearInterval(pingHandle);
        ws.off('message', onMessage);
      };
    },
    close() {
      writer.close();
    },
  };
}
