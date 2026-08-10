/**
 * E2E load test script for DVConf session lifecycle.
 *
 * Tests the full flow: room creation -> escrow -> CP assignment ->
 * client connections -> data transfer -> room close -> validator proofs ->
 * reward distribution.
 *
 * Usage:
 *   pnpm load-test [--sessions N] [--clients N] [--duration N]
 *
 * Requirements: Phase 14 Task 10
 *
 * NOTE (pure code-movement split): the implementation now lives across sibling modules in
 * `./load-test/` — `chain-ops.ts` (on-chain room/escrow/assignment/close + relay metrics +
 * reward polling), `simulate-client.ts` (the simulated WebSocket client), `session-runner.ts`
 * (session orchestration + the results report). This file is the THIN CLI entry point: it
 * parses argv and wires those pieces together in `main()`. No logic changed.
 */

import pino from 'pino';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  type Logger,
} from '@dvconf/shared';
import { sleep } from './load-test/chain-ops.js';
import { runSession, printReport, type SessionResult } from './load-test/session-runner.js';

// ── CLI argument parsing ──────────────────────────────────────────────

function parseArgs(): { sessions: number; clients: number; duration: number } {
  const args = process.argv.slice(2);
  let sessions = 1;
  let clients = 3;
  let duration = 30;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--sessions' && next) {
      sessions = parseInt(next, 10);
      i++;
    } else if (arg === '--clients' && next) {
      clients = parseInt(next, 10);
      i++;
    } else if (arg === '--duration' && next) {
      duration = parseInt(next, 10);
      i++;
    }
  }

  return { sessions, clients, duration };
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { sessions: sessionCount, clients: clientCount, duration } = parseArgs();

  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, ignore: 'pid,hostname' },
    },
  }) as unknown as Logger;

  logger.info(
    { sessions: sessionCount, clients: clientCount, duration },
    'Starting load test',
  );

  // Load config and create client
  const config = loadNetworkConfig();
  const network = process.env['SUI_NETWORK'] ?? 'localnet';
  const client = createSuiClient(network);
  const signer = loadKeypair('SIGNER_KEY');

  const signerAddress = signer.getPublicKey().toSuiAddress();
  logger.info({ network, signerAddress, packageId: config.packageId }, 'Connected to chain');

  // Run sessions (concurrently if multiple)
  const sessionPromises: Promise<SessionResult>[] = [];
  for (let i = 0; i < sessionCount; i++) {
    sessionPromises.push(
      runSession(i, clientCount, duration, client, signer, config, logger),
    );
    // Stagger session starts by 1s
    if (i < sessionCount - 1) {
      await sleep(1000);
    }
  }

  const results = await Promise.all(sessionPromises);

  // Print report
  printReport(results, logger);

  // Exit code
  const allSuccess = results.every((r) => r.success);
  process.exit(allSuccess ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test crashed:', err);
  process.exit(1);
});
