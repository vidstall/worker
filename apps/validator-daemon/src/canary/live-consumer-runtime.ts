// apps/validator-daemon/src/canary/live-consumer-runtime.ts
/**
 * M2b-live N2 — the validator RUNTIME bring-up (uses mediasoup AT RUNTIME). Stands up a real
 * worker+router, creates an F1 standby PipeTransport, connects to the relay's primary pipe
 * params + produces the relay-piped producer locally, then attaches a live-consumer. The relay
 * pipe params + the piped-producer descriptor arrive over an out-of-band channel (the cross-process
 * orchestrator in tests; the demo wires them from the run config).
 */
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { createStandbyPipeTransport } from '@dvconf/inter-relay-client';
import { attachLiveConsumer, type LiveConsumer } from './live-consumer.js';
import type { PipeTapCaptureMeta } from './pipe-tap-capture.js';

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];

export interface PipedProducerDescriptor {
  id: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
  producerPaused: boolean;
}

export interface LiveConsumerRuntime extends LiveConsumer {
  /** The standby pipe's bound {ip, port} — published back so the relay primary can connect. */
  standbyParams: { ip: string; port: number };
  /** Connect the standby pipe to the relay's primary {ip, port} (call once the relay params arrive). */
  connectToRelay(relay: { ip: string; port: number }): Promise<void>;
  /** Produce the relay-piped producer locally + attach the live consumer (call after connect). */
  consumePiped(piped: PipedProducerDescriptor): Promise<void>;
  shutdown(): void;
}

export async function bringUpLiveConsumer(args: {
  pipePort: number;            // 0 = ephemeral
  receiverMinerId: string;
  meta: PipeTapCaptureMeta;
}): Promise<LiveConsumerRuntime> {
  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  const router = await worker.createRouter({ mediaCodecs });
  const standbyPipe = await createStandbyPipeTransport(router, args.pipePort);
  let lc: LiveConsumer | null = null;

  return {
    standbyParams: { ip: process.env['ANNOUNCED_IP'] ?? '127.0.0.1', port: standbyPipe.tuple.localPort },
    get capture() { if (!lc) throw new Error('live-consumer not attached yet (call consumePiped first)'); return lc.capture; },
    async connectToRelay(relay): Promise<void> {
      await standbyPipe.connect({ ip: relay.ip, port: relay.port } as Parameters<msTypes.PipeTransport['connect']>[0]);
    },
    async consumePiped(piped): Promise<void> {
      const pipedProducer = await standbyPipe.produce({
        id: piped.id, kind: piped.kind, rtpParameters: piped.rtpParameters, paused: piped.producerPaused,
      } as Parameters<msTypes.PipeTransport['produce']>[0]);
      lc = await attachLiveConsumer({ validatorRouter: router, pipedProducerId: pipedProducer.id, receiverMinerId: args.receiverMinerId, meta: args.meta });
    },
    close(): void { lc?.close(); },
    shutdown(): void { try { lc?.close(); standbyPipe.close(); router.close(); worker.close(); } catch { /* */ } },
  };
}
