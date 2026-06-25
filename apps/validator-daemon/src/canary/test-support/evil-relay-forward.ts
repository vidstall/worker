// apps/validator-daemon/src/canary/test-support/evil-relay-forward.ts
/**
 * M2b-live — DEMO/TEST-ONLY byzantine-relay variant. Consumes a source producer on a
 * DirectTransport, optionally corrupts the canary ciphertext (one tail byte per packet,
 * just before the 14-byte SFrame trailer = present-but-different = TAMPER p=1, mirroring
 * the M2b harness offset), re-produces the (possibly corrupted) RTP on a second
 * DirectTransport, and pipes THAT producer so the validator receives genuinely-diverged
 * bytes over a REAL forward. INV-B: NEVER imported by the production relay path.
 *
 * mediasoup handles are type-only (callers inject routers/transports); the @dvconf/inter-relay-client
 * pipe helper is a runtime import (test-support only).
 *
 * The returned `EvilRelayForward` also surfaces the piped consumer's descriptor
 * (`pipedProducerId` + `kind` + `rtpParameters` + `producerPaused`) so the standby side can
 * `pipeTransport.produce(...)` directly from a single source of truth — no throwaway
 * probe-consume in the caller (plan Task-1 Step-4 option, applied consistently for Tasks 3/5).
 */
import type { types as msTypes } from 'mediasoup';
import { pipeProducerOntoPrimaryTransport } from '@dvconf/inter-relay-client';

const SFRAME_TRAILER_LEN = 14; // byte-frozen (config:1+kid:4+ctr:8+codecOffset:1)

export interface EvilRelayForward {
  /** The piped producer id the validator standby side re-produces + consumes. */
  pipedProducerId: string;
  /** The piped consumer's media kind (for the standby `pipeTransport.produce`). */
  kind: msTypes.MediaKind;
  /** The piped consumer's rtpParameters (for the standby `pipeTransport.produce`). */
  rtpParameters: msTypes.RtpParameters;
  /** The piped consumer's producerPaused (for the standby `pipeTransport.produce`). */
  producerPaused: boolean;
  close(): void;
}

export async function startEvilRelayForward(args: {
  relayRouter: msTypes.Router;
  sourceProducerId: string;
  byzantine: boolean;
  pipeTransport: msTypes.PipeTransport; // a primary pipe already created on relayRouter
  /**
   * REQ-MLW-B-18 (B6 DROP/withholding): deterministically WITHHOLD every Nth forwarded canary packet
   * so ground-truth withholding exists (drop-rate ~= 1/dropEveryN). Undefined / 0 / 1 => NO drop
   * (byte-identical to the pre-B6 always-forward path). Deterministic (counter-based, reproducible).
   */
  dropEveryN?: number;
}): Promise<EvilRelayForward> {
  const { relayRouter, sourceProducerId, byzantine, pipeTransport, dropEveryN } = args;

  const inTransport = await relayRouter.createDirectTransport();
  const inConsumer = await inTransport.consume({
    producerId: sourceProducerId,
    rtpCapabilities: relayRouter.rtpCapabilities,
    paused: false,
  });
  const outTransport = await relayRouter.createDirectTransport();
  const outProducer = await outTransport.produce({ kind: inConsumer.kind, rtpParameters: inConsumer.rtpParameters });

  let pktCount = 0;
  const dropN = dropEveryN && dropEveryN > 1 ? Math.floor(dropEveryN) : 0;
  inConsumer.on('rtp', (pkt: Buffer) => {
    pktCount += 1;
    // REQ-MLW-B-18 DROP tooth: withhold every Nth packet (deterministic). dropN===0 => never drops
    // => byte-identical to the pre-B6 always-forward path.
    if (dropN !== 0 && pktCount % dropN === 0) {
      return; // withhold
    }
    const copy = Buffer.from(pkt);
    if (byzantine) {
      const ti = copy.length - SFRAME_TRAILER_LEN - 1; // a ciphertext byte just before the trailer
      if (ti >= 0) copy[ti] = (copy[ti]! ^ 0xff) & 0xff;
    }
    outProducer.send(copy);
  });

  const pipedConsumer = await pipeProducerOntoPrimaryTransport(pipeTransport, outProducer.id);
  return {
    pipedProducerId: pipedConsumer.id,
    kind: pipedConsumer.kind,
    rtpParameters: pipedConsumer.rtpParameters,
    producerPaused: pipedConsumer.producerPaused,
    close(): void {
      try { inConsumer.close(); inTransport.close(); outProducer.close(); outTransport.close(); } catch { /* best-effort */ }
    },
  };
}
