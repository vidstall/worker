/**
 * M2b P8 — validator-side pipe-tap. Given a validator mediasoup Router and the id of a
 * producer that has been re-produced locally from the relay's piped canary stream, stand
 * up an UNPAUSED DirectTransport SINK consumer. ONLY a DirectTransport-fed consumer emits
 * 'rtp' (mediasoup Consumer.js); a PipeTransport consumer ships over UDP and emits nothing,
 * and the relay's warm-pipe consumer is created PAUSED — so the validator must re-produce
 * and tap its OWN DirectTransport sink (base probe B-2). Relay-blind: we only capture
 * forwarded bytes; no decode.
 *
 * mediasoup handles are INJECTED (type-only import) so this module adds no mediasoup runtime
 * dependency to validator-daemon (hermetic capture-core; the cross-process tap is M2b-live).
 */
import type { types as msTypes } from 'mediasoup';
import type { RtpTapConsumer } from './pipe-tap-capture.js';

export interface ValidatorSink {
  consumer: msTypes.Consumer & RtpTapConsumer;
  transport: msTypes.DirectTransport;
  /** Close the sink consumer + its transport (call at scope teardown, after collector.dispose()). */
  close(): void;
}

/**
 * Create an UNPAUSED DirectTransport sink consumer of `pipedProducerId` on `validatorRouter`.
 * The returned `consumer` is the `.on('rtp')` source for a PipeTapCollector.
 */
export async function attachValidatorSink(
  validatorRouter: msTypes.Router,
  pipedProducerId: string,
): Promise<ValidatorSink> {
  const transport = await validatorRouter.createDirectTransport();
  const consumer = await transport.consume({
    producerId: pipedProducerId,
    rtpCapabilities: validatorRouter.rtpCapabilities,
    paused: false, // UNPAUSED — required for 'rtp' to fire
  });
  return {
    consumer: consumer as msTypes.Consumer & RtpTapConsumer,
    transport,
    close(): void {
      try { consumer.close(); transport.close(); } catch { /* best-effort */ }
    },
  };
}
