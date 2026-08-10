/**
 * Validator Daemon -- F61 self-degradation HealthMonitor wiring.
 *
 * Extracted from the former `index.ts` monolith (via `daemon/bootstrap.ts`).
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { HealthMonitor, makeChainReporter, readCooldownMs, type ThresholdEnv } from '@dvconf/health-monitor';
import type { ValidatorHealthDeps } from '../health-signals.js';
import { buildHealthSignals } from '../health-signals.js';

/**
 * P17 M2a-P11 — assemble + start the validator daemon's F61 HealthMonitor
 * (DOH-014/016/017/018). Binds the HARD GATE `operator := signer.toSuiAddress()`
 * using the MAIN wallet (`signer` here MUST be `mainKeypair` — the operator that
 * owns the MinerCap; the session key signs proofs, not operator-gated calls). The
 * same signer makeChainReporter signs with → operator == ctx.sender(), so
 * report_node_degradation does not abort (E_NOT_OPERATOR, node_health.move:81).
 * variant 'miner' (node_type=1 validator, derived on-chain). Exported so the wiring
 * is unit-testable.
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  validatorCapId: string;
  deps: ValidatorHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, validatorCapId, deps, logger: log, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: validatorCapId,
    operator,
    variant: 'miner',
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
