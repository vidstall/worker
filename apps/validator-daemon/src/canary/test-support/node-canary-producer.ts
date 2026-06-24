// apps/validator-daemon/src/canary/test-support/node-canary-producer.ts
/**
 * M2b-live — a real mediasoup DirectTransport producer fed by the canonical canary stream
 * (CanaryPublisher.produce(cellSecret)), canary body at the packet TAIL. TEST-support: the
 * media SOURCE for the local real-media slice (a Node producer, not a browser).
 */
import type { types as msTypes } from 'mediasoup';
import { CanaryPublisher } from '../publisher.js';
import { makeVp8RtpWithBody, makeRtcpSenderReport, VP8_PT } from './vp8-rtp.js';

const rtpParameters: msTypes.RtpParameters = {
  codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc: 0x4000_0000, scalabilityMode: 'L1T1' }],
};

export interface NodeCanaryProducer {
  producerId: string;
  start(): void;
  stop(): void;
  close(): void;
}

export async function startNodeCanaryProducer(args: {
  relayRouter: msTypes.Router;
  kRoom: Uint8Array; roomId: string; cellSecret: Uint8Array; canaryKid: number; ctrs: number[];
}): Promise<NodeCanaryProducer> {
  const bodies = await new CanaryPublisher().produce({
    kRoom: args.kRoom, roomId: args.roomId, cellSecret: args.cellSecret, canaryKid: args.canaryKid, ctrs: args.ctrs,
  });
  const transport = await args.relayRouter.createDirectTransport();
  const producer = await transport.produce({ kind: 'video', rtpParameters });

  let timer: ReturnType<typeof setInterval> | null = null;
  let seq = 0, pic = 0, ts = 0, frame = 0, pkt = 0, oct = 0;
  return {
    producerId: producer.id,
    start(): void {
      timer = setInterval(() => {
        const body = bodies[frame % bodies.length]!;
        const packet = makeVp8RtpWithBody({ ssrc: 0x4000_0000, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe: frame % 10 === 0 });
        producer.send(packet); pkt++; oct += packet.length;
        if (frame % 10 === 0) transport.sendRtcp(makeRtcpSenderReport(0x4000_0000, ts, pkt, oct));
        ts += 3000; frame++;
      }, 10);
    },
    stop(): void { if (timer) { clearInterval(timer); timer = null; } },
    close(): void { try { producer.close(); transport.close(); } catch { /* best-effort */ } },
  };
}
