/**
 * P3 evaluation-only localnet chain-latency harness.
 *
 * Measures two distinct client-observed quantities with the production EventPoller
 * left byte-for-byte unchanged:
 *   - L_chain_create: create_room submission -> first exact RoomCreated observation
 *   - L_chain_settle: distribute_rewards submission -> first exact
 *     RewardsDistributed observation
 *
 * The harness deliberately owns timestamps and exact matching. It reuses the proven
 * localnet/roster/proof builders, but does not change product semantics or production
 * symbols. Official mode is exactly 30 sequential rooms on one persistent localnet;
 * --samples 1 is a non-publishable spike.
 *
 * This file is a thin CLI entry point: the implementation lives in
 * ./chain-latency/*. It is kept at this path/name so the CLI invocation and
 * every previously exported symbol (used by tests importing this module)
 * keep working unchanged.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseChainLatencyOptions } from './chain-latency/cli.ts';
import { ExactEventMatcher } from './chain-latency/event-matcher.ts';
import { runMeasurement } from './chain-latency/run-measurement.ts';
import type { ChainLatencyOptions } from './chain-latency/types.ts';
import { asError } from './chain-latency/util.ts';

const MODULE = 'measure-chain-latency';

const __filename = fileURLToPath(import.meta.url);

export type { ChainLatencyOptions };
export { ExactEventMatcher, parseChainLatencyOptions };

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseChainLatencyOptions(argv);
  await runMeasurement(options);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    process.stderr.write(`${MODULE}: ${asError(error).stack ?? asError(error).message}\n`);
    process.exitCode = 1;
  });
}
