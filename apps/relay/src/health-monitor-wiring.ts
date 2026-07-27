/**
 * P17 M2a-P11 — relay HealthMonitor (F61) assembly, extracted out of index.ts
 * so the wiring is unit-testable without booting the daemon.
 *
 * Requirements: DOH-014/016/017/018.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import {
  HealthMonitor,
  makeChainReporter,
  readCooldownMs,
  type ThresholdEnv,
} from '@dvconf/health-monitor';
import { buildHealthSignals, type RelayHealthDeps } from './health-signals.js';

/**
 * P17 M2a-P11 — assemble + start the relay's F61 HealthMonitor (DOH-014/016/017/018).
 *
 * Single seam that binds the HARD GATE: `operator := signer.toSuiAddress()` — the
 * SAME `signer` makeChainReporter signs the tx with — so `operator == ctx.sender()`
 * holds and `report_node_degradation` does not abort (E_NOT_OPERATOR,
 * node_health.move:81). variant 'miner' (relay holds a MinerCap; node_type=2 is
 * derived on-chain from the cap role). Returns a `stop` for the shutdown teardown.
 * Exported (not inline) so the wiring is unit-testable (health-monitor-wiring.test.ts).
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  minerCapId: string;
  deps: RelayHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, minerCapId, deps, logger, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: minerCapId,
    operator,
    variant: 'miner',
    logger,
  });
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(deps, env),
    reporter,
    logger,
    cooldownMs: readCooldownMs(env),
  });
  monitor.start();
  return { monitor, stop: () => monitor.stop() };
}
