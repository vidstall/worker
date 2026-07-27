/**
 * Validator Daemon -- state types.
 *
 * `ValidatorConfig` (measurement-loop config), `ActiveRoom` (per-room tracked
 * state), and `DaemonState` (the full running-daemon state), extracted verbatim
 * from the former `index.ts` monolith.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { EventPoller } from '@dvconf/shared';
import type { NetworkConfig } from '@dvconf/shared';
import type { CanaryCellLoopHandle } from '../canary/cell.js';
import type { LivenessSweepHandle } from '../liveness-sweep.js';
import type { CanaryVerifyLoopHandle } from '../canary/verify-loop.js';
import type { StartCanaryClaimsResult } from '../canary/claims-server.js';
import type { LiveConsumerRuntime } from '../canary/live-consumer-runtime.js';

/** Configuration for the measurement loop. */
export interface ValidatorConfig {
  /** Interval between measurement cycles in ms (default: 60000). */
  measurementIntervalMs: number;
  /** Validator miner ID (from registration). */
  validatorMinerId: string;
}

/** Tracked state per active room. */
export interface ActiveRoom {
  /** Escrow object ID for this room (discovered via EscrowCreated). */
  escrowId?: string;
  /**
   * Primary relay miner ID (RoomAssigned.relay_ids[0], relay_role==0).
   * Always present once the room is assigned.
   */
  primaryRelayId?: string;
  /**
   * Standby relay miner ID (RoomAssigned.relay_ids[1], relay_role==1).
   * Undefined when the room was assigned with a single relay (length guard).
   * RO-019a: the validator probes + submits a per-relay proof for BOTH slots.
   */
  standbyRelayId?: string;
  /**
   * REQ-CFA-023 (M3 chunk 1, D-CFA-24): the co-auditor validator miner_ids for THIS
   * room, sourced from the in-event `RoomAssigned.validator_ids` (already parsed for the
   * self-membership test, then discarded — ZERO new chain cost). M4a chunk 1 (D-CFA-30):
   * per-relay scopes the canary validator pool (`buildRelayScopedValidatorPool`) so coverage
   * is reported/assigned over ONLY the co-auditors of the room(s) a given relay serves, NOT
   * the cross-room union (closes the over-count W-M3-OVERCOUNT; M3 closed the registry-wide
   * over-count W-M2-3). Written ONLY by the RoomAssigned arm; relay promotion leaves it
   * unchanged (promote_relay touches only assigned_relays — W-M3-STALE). Defaults to [].
   */
  validatorIds?: string[];
}

/** Internal state for the running daemon. */
export interface DaemonState {
  client: SuiClient;
  mainKeypair: Ed25519Keypair;
  sessionKeypair: Ed25519Keypair;
  sessionAddress: string;
  config: NetworkConfig;
  validatorCapId: string;
  measurementTimer: ReturnType<typeof setInterval> | null;
  eventPoller: EventPoller | null;
  escrowPoller: EventPoller | null;
  roomPoller: EventPoller | null;
  livenessSweep: LivenessSweepHandle | null;
  escrowMap: Map<string, string>;
  activeRooms: Map<string, ActiveRoom>;
  /** Stop function returned by startHeartbeat (F40). */
  heartbeatStop: (() => void) | null;
  /**
   * F61 health signals (DOH-014). `rttSamplesMs` = a bounded rolling window of the
   * latest reachable-cycle RTTs (probe avgLatencyMs); `consecutiveUnreachable` =
   * count of back-to-back unreachable measureRelay results (reset on any reachable).
   * Both prime to 0 / [] (= healthy) until the first measurement cycle.
   */
  rttSamplesMs: number[];
  consecutiveUnreachable: number;
  /**
   * REQ-CFA-029 (M3 chunk 2, D-CFA-26): the latest validator-probed STUN packet-loss
   * (basis points) per relayMinerId. Written in `measureRelay` (next to the rttSamplesMs
   * push) from `measurement.packetLossRate` — a value the per-relay session-proof BCS
   * folds in (~:821) then otherwise DISCARDS. This is the per-relay SEAM the loss classifier
   * IS read by via the wired canary verify loop (getStunLossBps below, W-M3-SIM): it folds into
   * the classifier's BUDGET (D-CFA-25, stunPacketLossBps + delta): STUN-UDP != canary-RTP and the
   * probe is a single global host, so it is a COARSE prior, NOT a binding signal (not
   * per-relay-attributed until G3).
   */
  relayStunLossBps: Map<string, bigint>;
  /**
   * G3 (partial): per-relayMinerId metrics base URL, resolved from each relay's ON-CHAIN ws
   * endpoint (relay_registry::get_active_relays, metrics = ws+1). Refreshed once per measurement
   * cycle so measureRelay probes the relay it ATTESTS (the cp's dynamically-chosen primary), not
   * one static RELAY_METRICS_URL. Empty -> resolveProbeEndpoint falls back to RELAY_METRICS_URL.
   */
  relayMetricsUrls: Map<string, string>;
  /** Stop function for the F61 HealthMonitor (DOH-018). */
  healthMonitorStop: (() => void) | null;
  /**
   * REQ-CFA-004 (Task 5.1): the additive deterministic canary cell-rotation loop handle
   * (per-relay >=2-distinct-miner_id coverage). Null if the loop failed to start — its
   * start is guarded so a fault cannot crash the daemon. `latest()` feeds the downstream
   * covert-publish / verify loops (Task 5.2+).
   */
  canaryCellLoop: CanaryCellLoopHandle | null;
  /**
   * REQ-CFA-042/043 (M4a chunk 3, D-CFA-33): the additive crash-safe canary VERIFY loop handle
   * (verifyForwardedCanary -> classifyDivergences -> buildDivergenceProof -> submit, behind an
   * injectable capture+submit seam). Null if the loop failed to start (guarded) — its start is
   * wrapped so a fault can NEVER abort the daemon. It is the FIRST real reader of
   * `relayStunLossBps` (closes W-M3-STUN-PATH). The production capture seam yields NO live
   * frames yet (the live producer/SFU-forward/consumer media plane is M4b, port-locked); the
   * loop is WIRED and reads STUN, but promotes nothing until M4b supplies live captures
   * (W-M3-SIM narrowed; this loop AMPLIFIES the off-chain gate W-M3-OFFCHAIN — on record).
   */
  canaryVerifyLoop: CanaryVerifyLoopHandle | null;
  /**
   * Stage 4.5 (multi-cp-quorum, C1 cross-host): the local `/canary/claims` mTLS SERVER, started ONLY
   * when the live seams are active (master flag CANARY_LIVE_SEAMS_ENABLED). It shares the verify-loop's
   * `localBoard` instance so a PEER's POSTed self-attestation accrues onto the SAME board this daemon
   * assembles from -> the >=2-distinct quorum can form cross-host (PLAN-m4b-hermetic §3.2). Null in
   * vanilla mode (flag off) -> no server, byte-identical to the pre-Stage-4 daemon.
   */
  canaryClaimsServer: StartCanaryClaimsResult | null;
  /**
   * M2b-live-WAN B2 (REQ-MLW-B-01/02): the REAL pipe-tap consumer runtime (a mediasoup worker +
   * standby F1 pipe + live consumer), brought up ONLY when CANARY_LIVE_CAPTURE=pipe. Its `.capture`
   * is swapped into the verify-loop seam (via chooseCapture) so the loop verifies REAL forwarded
   * frames. Null in the default/byte-identical-OFF path (flag unset / any other value) — then the
   * verify-loop keeps its EXACT empty no-op capture. Shut down in BOTH teardown sites.
   */
  liveConsumer: LiveConsumerRuntime | null;
  /**
   * M2 chunk 2 (REQ-CFA-019/020): the latest live-discovered active-validator miner_ids
   * (Wallet-A ids from validator_registry::get_active_validators), refreshed each canary
   * round and UNIONed with the self-entry inside the cell loop's getValidators. Undefined
   * until the first discovery refresh resolves (crash-safe: a failed refresh leaves the
   * last good cache, and the union always re-adds the self-entry → never below self-only).
   */
  discoveredValidatorMinerIds?: string[];
  /**
   * M2 chunk 1 (REQ-CFA-013/015): the off-chain coverage feed HTTP server handle (loopback,
   * port VALIDATOR_CANARY_COVERAGE_PORT). Null if it failed to start (guarded). Closed in
   * the LAST shutdown group next to the healthz close.
   */
  coverageServer: import('node:http').Server | null;
  running: boolean;
  /**
   * P17 M2b-P9 (DOH-022): the currently-running measurement cycle promise (or null
   * when idle). The graceful-shutdown drain awaits it so an in-flight per-relay
   * proof submit completes before teardown (no cancel) — bounded by the 30s drain.
   */
  inFlightMeasurement: Promise<void> | null;
}
