/**
 * CP Daemon — F61 self-degradation HealthMonitor wiring.
 *
 * Pure extraction from index.ts (P17 M2a-P11, DOH-014/016/017/018).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, NetworkConfig } from '@dvconf/shared';
import { HealthMonitor, makeChainReporter, readCooldownMs, type ThresholdEnv } from '@dvconf/health-monitor';
import { buildHealthSignals, type CpHealthDeps } from './health-signals.js';

/**
 * Assemble + start the cp-daemon's F61 HealthMonitor. Binds the HARD GATE
 * `operator := signer.toSuiAddress()` (the same signer makeChainReporter
 * signs with → operator == ctx.sender(), so report_cp_degradation does not
 * abort, E_NOT_OPERATOR node_health.move:118). variant 'cp' →
 * report_cp_degradation over the ControlPlaneCap (node_type=3 hardcoded
 * on-chain). Exported (not inline) so the wiring is unit-testable.
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  deps: CpHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, cpCapId, deps, logger: log, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: cpCapId,
    operator,
    variant: 'cp',
    logger: log,
  });
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(deps, env),
    reporter,
    logger: log,
    cooldownMs: readCooldownMs(env),
  });
  monitor.start();
  return { monitor, stop: () => monitor.stop() };
}
