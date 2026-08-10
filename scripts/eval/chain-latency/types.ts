/**
 * Shared type definitions for the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import type { SuiTransactionBlockResponse } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import type { CpHandle } from '../../demo/seed-bootstrap.ts';

import { CHAIN_LATENCY_SCHEMA_VERSION } from '../chain-latency-evidence.ts';

const SCHEMA_VERSION = CHAIN_LATENCY_SCHEMA_VERSION;

export type Metric = 'L_chain_create' | 'L_chain_settle';
export type RunMode = 'spike' | 'official';

export interface ChainLatencyOptions {
  contractsDir: string;
  contractRef: string;
  runId: string;
  traceId: string;
  samples: 1 | 30;
  mode: RunMode;
  outputRoot: string;
  runDir: string;
}

export interface MonotonicWallTime {
  wallIso: string;
  wallEpochMs: number;
  monoMs: number;
}

export interface ObservedTargetEvent extends MonotonicWallTime {
  txDigest: string;
  eventType: string;
  eventSeq: string;
  roomId: string;
  timestampMs: string | null;
}

export interface PendingObservation {
  eventType: string;
  roomId: string;
  resolve: (event: ObservedTargetEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReadyValidator {
  mainKp: Ed25519Keypair;
  sessionKp: Ed25519Keypair;
  minerId: string;
}

export interface Roster {
  cp: CpHandle;
  relayIds: [string, string];
  validators: [ReadyValidator, ReadyValidator, ReadyValidator, ReadyValidator];
  userKp: Ed25519Keypair;
}

export interface SampleRecord {
  schema_version: typeof SCHEMA_VERSION;
  record_type: 'sample';
  run_id: string;
  trace_id: string;
  metric: Metric;
  sample_index: number;
  tx_digest: string;
  event_type: string;
  event_seq: string;
  room_id: string;
  escrow_id: string | null;
  submit_wall_iso: string;
  submit_mono_ms: number;
  rpc_return_wall_iso: string;
  rpc_return_mono_ms: number;
  finality_return_wall_iso: string;
  finality_return_mono_ms: number;
  observed_wall_iso: string;
  observed_mono_ms: number;
  value_ms: number;
  rpc_return_ms: number;
  return_to_event_ms: number;
  finality_return_ms: number;
  success: true;
  exact_match: true;
}

export interface TimedExecution {
  result: SuiTransactionBlockResponse;
  digest: string;
  submit: MonotonicWallTime;
  rpcReturn: MonotonicWallTime;
}

export interface FinalityReturn {
  result: SuiTransactionBlockResponse;
  time: MonotonicWallTime;
}

export interface SnapshotVerification {
  commit: string;
  trackedFileCount: number;
  treeSha256: string;
}
