// apps/validator-daemon/src/canary/live-consumer.ts
/**
 * M2b-live N2 — the validator RUNTIME consumer CORE. Attach an UNPAUSED DirectTransport sink
 * (pipe-tap.ts) to the relay-piped producer, collect forwarded RTP (pipe-tap-capture.ts), and
 * expose a `CanaryForwardCapture` for the UNCHANGED runCanaryVerifyRound. mediasoup is type-only
 * (the Router is injected) so this core adds NO mediasoup runtime dependency.
 */
import type { types as msTypes } from 'mediasoup';
import { attachValidatorSink } from './pipe-tap.js';
import { PipeTapCollector, createPipeTapCapture, type PipeTapCaptureMeta } from './pipe-tap-capture.js';
import type { CanaryForwardCapture } from './verify-loop.js';

export interface LiveConsumer {
  capture: CanaryForwardCapture;
  close(): void;
}

export async function attachLiveConsumer(args: {
  validatorRouter: msTypes.Router;
  pipedProducerId: string;
  receiverMinerId: string;
  meta: PipeTapCaptureMeta;
}): Promise<LiveConsumer> {
  const sink = await attachValidatorSink(args.validatorRouter, args.pipedProducerId);
  const collector = new PipeTapCollector([{ receiverMinerId: args.receiverMinerId, consumer: sink.consumer }]);
  return {
    capture: createPipeTapCapture(collector, args.meta),
    close(): void { collector.dispose(); sink.close(); },
  };
}
