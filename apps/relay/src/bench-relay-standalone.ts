// bench-relay-standalone.ts — CHAIN-FREE mediasoup SFU + signaling for the E2EE
// glass-to-glass Playwright proof (dvconf-client/e2e/e2ee-g2g.mjs, gap #5).
//
// The full relay daemon (index.ts) hard-requires a localnet chain (loadNetworkConfig +
// loadKeypair + ensureRegistered + heartbeat + self-shutdown watcher). The glass-to-glass
// E2EE MECHANISM proof needs ONLY the media plane: real mediasoup Workers
// (mediasoup-worker.exe) + the WS signaling server that accepts joins and forwards RTP.
// This boots exactly that — NO chain, NO on-chain registration, NO heartbeat.
//
// It REUSES the shipped, un-modified `createMediasoupManager` + `createSignalingServer`
// verbatim (the SAME code path the production daemon runs), so the SFU forwarding under
// test is identical to production. Additive bench fixture only. Lives in apps/relay/src
// so `@dvconf/shared` + the sibling ./modules resolve (scripts/ has no workspace symlink).
//
//   WS_PORT (default 4000) — the ws:// endpoint the bench page's ?relay= points at.
//   NUM_WORKERS (default 1) — one mediasoup Worker is enough for a 1-producer bench.
//   ANNOUNCED_IP (default 127.0.0.1) — ICE candidate IP for same-machine Playwright.
//
// Run:  pnpm --dir dvconf-daemons exec tsx apps/relay/src/bench-relay-standalone.ts

import { createLogger } from '@dvconf/shared';
import { createMediasoupManager } from './mediasoup-manager.js';
import { createSignalingServer } from './signaling/index.js';
import { MetricsTracker } from './metrics.js';

async function main(): Promise<void> {
  // Sensible bench defaults (do not clobber an operator-set value).
  if (!process.env['WS_PORT']) process.env['WS_PORT'] = '4000';
  if (!process.env['NUM_WORKERS']) process.env['NUM_WORKERS'] = '1';
  if (!process.env['ANNOUNCED_IP']) process.env['ANNOUNCED_IP'] = '127.0.0.1';
  // Do NOT cap incoming bitrate for the bench (we want full RTP so framesDecoded ramps fast).
  if (!process.env['RELAY_MAX_INCOMING_BITRATE']) process.env['RELAY_MAX_INCOMING_BITRATE'] = '0';

  const logger = createLogger('bench-relay');
  const manager = await createMediasoupManager(logger);
  const metrics = new MetricsTracker();
  const { wss, getRoomCount } = createSignalingServer(manager, metrics, logger);

  logger.info(
    { port: process.env['WS_PORT'], workers: manager.workers.length, announcedIp: process.env['ANNOUNCED_IP'] },
    'bench relay (chain-free SFU + signaling) UP — accepting WS joins',
  );

  // Loud readiness line the Playwright driver can grep for.
  process.stdout.write(`BENCH_RELAY_READY ws://127.0.0.1:${process.env['WS_PORT']} rooms=${getRoomCount()}\n`);

  const shutdown = (): void => {
    try { wss.close(); } catch { /* ignore */ }
    try { manager.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`bench-relay-standalone fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
