/**
 * @dvconf/health-monitor — chain DegradationReporter (P17 M2a-P8, REQ-DOH-015).
 *
 * The SINGLE production "degraded" path: the F61 `HealthMonitor`'s injected
 * `DegradationReporter` (D-DOH-M2-HM-4). This module decouples the pure level
 * machine from chain I/O — `makeChainReporter` is the only thing that submits a
 * NodeDegraded-emitting tx, so the F61 producer and the F60/viz-consumed event
 * share exactly one on-chain entry pair.
 *
 * Two FROZEN PTB builders byte-mirror the on-chain entries (verified
 * node_health.move:71 / :110): both take `[net_reg, cap, operator, level]` in
 * that ORDER (ctx auto-injected). They clone the verified `heartbeat.ts` shape
 * and reuse `NetworkConfig` + `executeWithRetry` (DAEMON-07 retry/backoff). Two
 * builders, not one generic call, because the cap types differ
 * (`&MinerCap` vs `&ControlPlaneCap`) and the CP entry hardcodes node_type=3.
 *
 * Per D-DOH-M2-HM-4 the daemon picks the variant matching its cap type at
 * startup (one line); P9 wires the `isPaused` skip + this reporter into the loop.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { randomUUID } from 'node:crypto';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';
import type { DegradationReporter, HealthLevel } from './health-monitor.js';

const MODULE = 'health-monitor/report';

/**
 * Build the generic `node_health::report_node_degradation` call (MinerCap roles:
 * 1=validator, 2=relay, 4=signaling — node_type is DERIVED from the cap on-chain,
 * never an arg). Args mirror node_health.move:71 exactly:
 * `[net_reg, cap: &MinerCap, operator: address, level: u8]`.
 */
export function buildReportNodeDegradationTx(
  tx: Transaction,
  config: NetworkConfig,
  minerCapId: string,
  operator: string,
  level: number,
): void {
  tx.moveCall({
    target: `${config.packageId}::node_health::report_node_degradation`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(minerCapId),
      tx.pure.address(operator),
      tx.pure.u8(level),
    ],
  });
}

/**
 * Build the CP-variant `node_health::report_cp_degradation` call (the
 * ControlPlaneCap TYPE is the CP authority proof => node_type=3 hardcoded
 * on-chain, no role gate). Args mirror node_health.move:110 exactly:
 * `[net_reg, cap: &ControlPlaneCap, operator: address, level: u8]`.
 */
export function buildReportCpDegradationTx(
  tx: Transaction,
  config: NetworkConfig,
  controlPlaneCapId: string,
  operator: string,
  level: number,
): void {
  tx.moveCall({
    target: `${config.packageId}::node_health::report_cp_degradation`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(controlPlaneCapId),
      tx.pure.address(operator),
      tx.pure.u8(level),
    ],
  });
}

/** Which on-chain entry to call — set once by the daemon from its cap type. */
export type CapVariant = 'miner' | 'cp';

export interface ChainReporterArgs {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  /** The daemon's MinerCap (variant 'miner') or ControlPlaneCap (variant 'cp') object id. */
  capId: string;
  /** The operator address (must equal the signer's sender — enforced by the on-chain `E_NOT_OPERATOR` assert). */
  operator: string;
  variant: CapVariant;
  logger: Logger;
}

/**
 * Build the injected `DegradationReporter` over `executeWithRetry`. `report(level)`
 * routes to the cp/miner builder by `variant`, submits with backoff, and maps the
 * result to `boolean`: a confirmed `TxResult` => `true`; `null` (retries
 * exhausted) => `false` (the monitor leaves `reportedLevel` untouched so the next
 * tick re-fires — the P7 self-heal). Never throws — a failed submit is logged and
 * returned as `false`, so a chain hiccup never crashes the poll loop.
 */
export function makeChainReporter(args: ChainReporterArgs): DegradationReporter {
  const { client, signer, config, capId, operator, variant, logger } = args;

  const build =
    variant === 'cp'
      ? (tx: Transaction, level: number) =>
          buildReportCpDegradationTx(tx, config, capId, operator, level)
      : (tx: Transaction, level: number) =>
          buildReportNodeDegradationTx(tx, config, capId, operator, level);

  return {
    async report(level: HealthLevel): Promise<boolean> {
      const traceId = randomUUID();
      const res = await executeWithRetry(
        client,
        signer,
        (tx: Transaction) => build(tx, level),
        `report-${variant}-degradation`,
        logger,
      );
      if (res !== null) {
        logger.info(
          {
            trace_id: traceId,
            module: MODULE,
            action: 'report_degradation',
            context: { variant, level, capId, digest: res.digest },
          },
          'Node degradation reported on-chain',
        );
        return true;
      }
      logger.warn(
        {
          trace_id: traceId,
          module: MODULE,
          action: 'report_degradation',
          context: { variant, level, capId },
        },
        'Node degradation report exhausted retries (executeWithRetry returned null)',
      );
      return false;
    },
  };
}
