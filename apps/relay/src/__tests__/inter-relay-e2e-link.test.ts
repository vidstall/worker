/**
 * G3.2b — inter-relay cross-daemon link END-TO-END.
 *
 *   END-TO-END: a standby openInterRelayLink → primary announce → the frame
 *   crosses a REAL socket → the standby records it (the production loop).
 *
 * Mocked MediasoupManager (real mediasoup workers gated to the relay-integration
 * suite). Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS wiring + auth).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { WebSocketServer } from 'ws';
import type { InterRelayContext } from '../signaling/index.js';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  createWsInterRelaySender,
  handleInboundInterRelayFrame,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import { openInterRelayLink } from '@dvconf/inter-relay-client';
import { startServer, mockLogger, tick } from './inter-relay-auth-wiring.fixtures.js';

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
});

describe('inter-relay cross-daemon link END-TO-END (G3.2b)', () => {
  it('standby openInterRelayLink → primary announce → standby registry records over a real socket', async () => {
    const TOKEN = 'e2e-secret';
    // PRIMARY: holds the accepted standby socket; its sender transmits over it.
    const primaryBox: { socket: InterRelaySocketLike | null } = { socket: null };
    const primarySender = createWsInterRelaySender(() => primaryBox.socket, mockLogger());
    const announceProducer = createInterRelayAnnouncer(primarySender);
    const primaryInterRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: (roomId, producer) => announceProducer(roomId, producer),
      attachPeerSocket: (s) => { primaryBox.socket = s; },
    };
    const { wss, port } = await startServer(primaryInterRelay, TOKEN);
    server = wss;

    // STANDBY: open the real outbound link + route inbound frames to the handler.
    const standbyRegistry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();
    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      onFrame: (raw) => handleInboundInterRelayFrame(raw, { registry: standbyRegistry, onAnnounce }),
      logger: mockLogger(),
    });
    await tick(200); // link open + primary attach

    // PRIMARY produces → announces the REAL producerId across the live socket.
    primaryInterRelay.announceProducer('room-E2E', { id: 'producer-REAL-e2e', kind: 'audio' });
    await tick(200);

    expect(standbyRegistry.resolve('room-E2E')?.producerId).toBe('producer-REAL-e2e');
    // C6: the inbound handler threads the frame's peerRelayId (undefined — this
    // E2E announce carries no cascade peer → the standby defaults to DEFAULT).
    expect(onAnnounce).toHaveBeenCalledWith('room-E2E', undefined);

    link.close();
  });
});
