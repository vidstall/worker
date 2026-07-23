/**
 * mediasoup-client transport wiring — extracted from
 * `scripts/bench/mediasoup-client-harness.ts`'s `VirtualPeer.makeTransport`
 * so any Node-only mediasoup-client consumer shares ONE implementation of the
 * `createTransport`/`connectTransport`/`produce` wire protocol
 * (`apps/relay/src/signaling.ts`).
 */
import type { Device } from 'mediasoup-client';
import type { types as msTypes } from 'mediasoup-client';
import type { RelayClient } from './relay-client.js';

type Transport = msTypes.Transport;

export interface IceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Create + wire a mediasoup-client send or recv transport against the relay's
 * WS protocol: `createTransport` → `transportCreated`, then (send-direction
 * only) `transport.on('produce', ...)` → `produce` → `produced`, and (both
 * directions) `transport.on('connect', ...)` → `connectTransport`.
 */
export async function createWiredTransport(
  device: Device,
  client: RelayClient,
  direction: 'send' | 'recv',
  iceServers: IceServerLike[] = [],
): Promise<Transport> {
  client.send({ type: 'createTransport', direction });
  const params = await client.waitFor((m) => m.type === 'transportCreated');
  const transportParams: msTypes.TransportOptions = {
    id: params['id'] as string,
    iceParameters: params['iceParameters'] as msTypes.IceParameters,
    iceCandidates: params['iceCandidates'] as msTypes.IceCandidate[],
    dtlsParameters: params['dtlsParameters'] as msTypes.DtlsParameters,
    // mediasoup-client honours the iceServers field even though it's
    // optional — only matters when non-empty.
    ...(iceServers.length > 0 ? { iceServers } : {}),
  };
  const transport =
    direction === 'send'
      ? device.createSendTransport(transportParams)
      : device.createRecvTransport(transportParams);
  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    try {
      client.send({
        type: 'connectTransport',
        transportId: transport.id,
        dtlsParameters,
      });
      callback();
    } catch (err) {
      errback(err as Error);
    }
  });
  if (direction === 'send') {
    transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
      (async () => {
        try {
          client.send({
            type: 'produce',
            transportId: transport.id,
            kind,
            rtpParameters,
          });
          const produced = await client.waitFor((m) => m.type === 'produced');
          callback({ id: produced['producerId'] as string });
        } catch (err) {
          errback(err as Error);
        }
      })().catch(errback);
    });
  }
  return transport;
}
