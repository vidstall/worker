/**
 * Load-test simulated WebSocket client (joins the relay signaling protocol and pushes
 * fake RTP-like data). Split out of `../load-test.ts` (pure code movement — nothing here
 * changes behavior).
 */

import WebSocket from 'ws';
import type { Logger } from '@dvconf/shared';

export interface ClientResult {
  peerId: string;
  connected: boolean;
  connectTimeMs: number;
  messagesSent: number;
  bytesSent: bigint;
  error: string | null;
}

export async function simulateClient(
  relayWsUrl: string,
  roomId: string,
  peerId: string,
  durationSec: number,
  logger: Logger,
): Promise<ClientResult> {
  const result: ClientResult = {
    peerId,
    connected: false,
    connectTimeMs: 0,
    messagesSent: 0,
    bytesSent: 0n,
    error: null,
  };

  const connectStart = Date.now();

  return new Promise<ClientResult>((resolve) => {
    let ws: WebSocket;
    let sendInterval: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (sendInterval) clearInterval(sendInterval);
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'leave' }));
          ws.close();
        }
      } catch { /* ignore cleanup errors */ }
      resolve(result);
    };

    try {
      ws = new WebSocket(relayWsUrl);

      ws.on('open', () => {
        result.connectTimeMs = Date.now() - connectStart;
        result.connected = true;

        // Send join message matching relay signaling protocol
        ws.send(JSON.stringify({
          type: 'join',
          roomId,
          peerId,
        }));

        logger.debug({ peerId, connectTimeMs: result.connectTimeMs }, 'Client connected');

        // After join, start sending fake RTP-like data every 100ms
        sendInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            if (sendInterval) clearInterval(sendInterval);
            return;
          }

          // Fake RTP-like payload (random bytes, ~1KB per packet)
          const payload = Buffer.alloc(1024);
          for (let i = 0; i < payload.length; i++) {
            payload[i] = Math.floor(Math.random() * 256);
          }

          ws.send(payload);
          result.messagesSent++;
          result.bytesSent += BigInt(payload.length);
        }, 100);

        // Stop after duration
        setTimeout(finish, durationSec * 1000);
      });

      ws.on('error', (err: Error) => {
        result.error = err.message;
        logger.warn({ peerId, err: err.message }, 'Client WebSocket error');
        finish();
      });

      ws.on('close', () => {
        if (!resolved) {
          logger.debug({ peerId }, 'Client WebSocket closed early');
          finish();
        }
      });

      // Safety timeout — always resolve
      setTimeout(() => {
        if (!resolved) {
          result.error = 'Timeout exceeded';
          finish();
        }
      }, (durationSec + 10) * 1000);
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      finish();
    }
  });
}
