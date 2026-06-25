// scripts/demo/write-canary-pipe-params.ts  (NEW — B-WAN, REQ-MLW-B-12)
// The CANARY_PIPE_PARAMS_PATH writer the deployed validator index.ts reads. Emits the EXACT
// CanaryPipeParams shape index.ts consumes. kRoom/cellSecret are number[] on the wire
// (re-derivation factors written to a LOCAL OOB per-host file only — INV-C: never on a socket).
import { writeFileSync } from 'node:fs';
import type { CanaryPipeParams } from '../../apps/validator-daemon/src/capture-precedence.ts';
import type { PipedProducerDescriptor } from '../../apps/validator-daemon/src/canary/live-consumer-runtime.ts';

export function writeCanaryPipeParams(path: string, args: {
  relay: { ip: string; port: number };
  piped: PipedProducerDescriptor;
  receiverMinerId: string;
  canaryKid: number;
  expectedCtrs: number[];
  kRoom: Uint8Array;       // converted to number[] on write
  cellSecret: Uint8Array;  // converted to number[] on write
}): CanaryPipeParams {
  const params: CanaryPipeParams = {
    relay: args.relay,
    piped: args.piped,
    receiverMinerId: args.receiverMinerId,
    meta: {
      canaryKid: args.canaryKid,
      expectedCtrs: args.expectedCtrs,
      kRoom: Array.from(args.kRoom),
      cellSecret: Array.from(args.cellSecret),
    },
  };
  writeFileSync(path, JSON.stringify(params), 'utf8');
  return params;
}
