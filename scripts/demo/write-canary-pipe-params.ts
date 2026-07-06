// scripts/demo/write-canary-pipe-params.ts  (NEW — B-WAN, REQ-MLW-B-12)
// The CANARY_PIPE_PARAMS_PATH writer the deployed validator index.ts reads. Emits the EXACT
// CanaryPipeParams shape index.ts consumes. kRoom/cellSecret are number[] on the wire
// (re-derivation factors written to a LOCAL OOB per-host file only — INV-C: never on a socket).
import { writeFileSync } from 'node:fs';
import type { CanaryPipeParams, PipeSrtpParameters } from '../../apps/validator-daemon/src/capture-precedence.ts';
import type { PipedProducerDescriptor } from '../../apps/validator-daemon/src/canary/live-consumer-runtime.ts';

export function writeCanaryPipeParams(path: string, args: {
  relay: { ip: string; port: number };
  // Track-C: the cross-host primary#2 pipe's SRTP params (PIPE_SRTP=1). Forwarded into relay so the
  // peer host (vm2) can connect its standby. Omitted => relay stays {ip,port} (byte-identical loopback).
  srtpParameters?: PipeSrtpParameters;
  piped: PipedProducerDescriptor;
  receiverMinerId: string;
  // Track-C: the audited roomId so the standalone peer attester (vm2) re-derives identical expected
  // hashes. Omitted on the deployed index.ts path (it uses its own scope's roomId) — byte-identical.
  roomId?: string;
  canaryKid: number;
  expectedCtrs: number[];
  kRoom: Uint8Array;       // converted to number[] on write
  cellSecret: Uint8Array;  // converted to number[] on write
}): CanaryPipeParams {
  const params: CanaryPipeParams = {
    relay: args.srtpParameters !== undefined
      ? { ...args.relay, srtpParameters: args.srtpParameters }
      : args.relay,
    piped: args.piped,
    receiverMinerId: args.receiverMinerId,
    meta: {
      canaryKid: args.canaryKid,
      expectedCtrs: args.expectedCtrs,
      kRoom: Array.from(args.kRoom),
      cellSecret: Array.from(args.cellSecret),
      ...(args.roomId !== undefined ? { roomId: args.roomId } : {}),
    },
  };
  writeFileSync(path, JSON.stringify(params), 'utf8');
  return params;
}
