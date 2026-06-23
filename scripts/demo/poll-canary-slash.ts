/**
 * poll-canary-slash.ts — Stage-5 consolidated-demo in-container probe (REQ-CMD-8).
 *
 * The two stack validators (CANARY_LIVE_SEAMS_ENABLED=1) auto-submit a CanaryDivergenceSlashed
 * via their canary verify-loops (verify-loop.ts:431 round-0 immediate + CANARY_VERIFY_INTERVAL_MS).
 * This is a WAIT+POLL+ASSERT probe (no trigger): it reads the shared roomId (ROOM_FILE) and polls
 * the chain for that event, asserting attester_count>=2 AND >=2 distinct attester_ids via the
 * committed assertCanarySlash. @dvconf/shared is imported via the relative source path because
 * scripts/demo is outside the pnpm workspace graph (same pattern as the sibling one-shots).
 */
import { readFileSync } from 'node:fs';
import { createSuiClient, loadNetworkConfig, createLogger } from '../../packages/shared/src/index.ts';
import { assertCanarySlash, type CanarySlashEvent } from './assert-canary-slash.ts';

const ROOM_FILE = process.env['ROOM_FILE'] ?? '/shared/room.json';
const TIMEOUT_S = Number(process.env['CANARY_AUDIT_TIMEOUT_S'] ?? '120');
const POLL_S = Number(process.env['CANARY_AUDIT_POLL_S'] ?? '5');

function readRoomId(): string {
  const m = JSON.parse(readFileSync(ROOM_FILE, 'utf8')) as { roomId?: string };
  if (!m.roomId) throw new Error(`poll-canary-slash: ${ROOM_FILE} has no roomId`);
  return m.roomId;
}

/** Newest CanaryDivergenceSlashed parsedJson matching roomId; {} if none (descending order). */
async function queryLatestSlash(roomId: string): Promise<CanarySlashEvent> {
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const page = await client.queryEvents({
    query: { MoveEventType: `${config.packageId}::canary_audit::CanaryDivergenceSlashed` },
    order: 'descending',
    limit: 50,
  });
  for (const e of page.data) {
    const pj = e.parsedJson as CanarySlashEvent | undefined;
    if (pj && pj.room_id === roomId) return pj;
  }
  return {};
}

async function main(): Promise<void> {
  const log = createLogger('poll-canary-slash');
  const roomId = readRoomId();
  const deadlineMs = Date.now() + TIMEOUT_S * 1000;
  log.info(
    { action: 'poll_start', context: { roomId, timeoutS: TIMEOUT_S } },
    `polling for CanaryDivergenceSlashed room=${roomId}`,
  );
  for (;;) {
    const ev = await queryLatestSlash(roomId);
    const res = assertCanarySlash(ev, roomId);
    if (res.ok) {
      log.info({ action: 'slash_found', context: { roomId, distinct: res.distinct } }, `CanaryDivergenceSlashed distinct=${res.distinct}`);
      process.stdout.write(`CANARY_SLASH_OK room=${roomId} distinct=${res.distinct}\n`);
      return;
    }
    if (Date.now() >= deadlineMs) {
      process.stderr.write(
        `poll-canary-slash: timeout ${TIMEOUT_S}s — no valid CanaryDivergenceSlashed for ${roomId} (last: ${res.reason ?? 'none seen'})\n`,
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_S * 1000));
  }
}

// Run only when invoked directly (assertCanarySlash stays import-safe for any unit test).
if (process.argv[1]?.endsWith('poll-canary-slash.ts')) {
  main().catch((err) => {
    process.stderr.write(`poll-canary-slash: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
