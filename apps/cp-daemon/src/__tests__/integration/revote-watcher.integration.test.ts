/**
 * F47 Phase 4.1 — RevoteWatcher driven against a LIVE localnet (REQ-RV-013).
 *
 * Closes the loop the Phase 4.0 smoke deferred: instead of only reading an empty
 * chain, this test stands up a real role population (1 CP + 2 relays via the full
 * on-chain lifecycle), advances epochs past the idle threshold, then drives the
 * real `RevoteWatcher` over the real `SuiChainStateReader`:
 *
 *   1. scanIdleMiners() returns a superset containing both relay ids.
 *   2. submitMarkTx(relayId, Idle) → 'submitted' (real mark_revote_eligible_idle TX).
 *   3. getRevoteEligibleSince(relayId) is now a non-null bigint > 0 — exercising
 *      the NON-EMPTY content-shape of the dynamic-field read (4.0 only hit the
 *      not-found → null path). [follow-up (b)]
 *   4. A second submitMarkTx immediately after → 'skipped-cooldown' (epoch <
 *      since + cooldown(14)), exercising the cooldown path against real chain data.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), NEVER `pnpm test` (excluded there). Must still
 * TYPE-CHECK under `pnpm typecheck`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLogger, type Logger } from '@dvconf/shared';
import { SuiChainStateReader } from '../../sui-chain-state-reader.js';
import { RevoteWatcher, makeMarkSubmitter, MarkReason } from '../../revote-watcher.js';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';
import {
  bootstrapCp,
  voteAndApplyRelay,
  waitForEpochAtLeast,
  type RelayResult,
} from './revote-localnet-helpers.js';

/**
 * Short epoch duration so we can advance past max_idle (30) quickly. Main tunes
 * this on the live run: start at 2000ms; raise toward ~10000ms only if Windows
 * shows epoch-reconfig instability. Single source of truth for the test.
 */
const EPOCH_DURATION_MS = 2000;

/** max_idle_epochs default = 30; an idle gap must STRICTLY exceed it → advance ≥ 31. */
const IDLE_GAP = 31n;

describe('RevoteWatcher integration (RV-013, Phase 4.1)', () => {
  let handle: LocalnetHandle;
  let relays: RelayResult[];
  let baseEpoch: bigint;
  const logger: Logger = createLogger('phase41-revote-watcher');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    // 1 CP, then 2 relays via the full on-chain lifecycle (register → vote → apply
    // → register_relay). Sequential: each shares the same MinerStore / registries.
    const cp = await bootstrapCp(handle.client, handle.config, logger);
    relays = [
      await voteAndApplyRelay(handle.client, cp, handle.config, logger),
      await voteAndApplyRelay(handle.client, cp, handle.config, logger),
    ];

    // Idle baseline AFTER the last register_relay set last_heartbeat = epoch.
    baseEpoch = BigInt((await handle.client.getLatestSuiSystemState()).epoch);
    await waitForEpochAtLeast(handle.client, baseEpoch + IDLE_GAP, { timeoutMs: 240_000 }, logger);
  }, 300_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('drives idle scan → mark → revote_eligible_since → cooldown against live chain', async () => {
    const reader = new SuiChainStateReader(handle.client, handle.config, logger);
    const submitter = makeMarkSubmitter(handle.client, handle.signer, handle.config, logger);
    const watcher = new RevoteWatcher(reader, submitter, logger);

    const relayIds = relays.map((r) => r.minerId);

    // (1) Both relays are idle. The bootstrap CP is also idle by now → superset,
    // so assert each relay is present (not exact length). Explicit per-id contains
    // affirms BOTH relays were detected, never just one.
    const idle = await watcher.scanIdleMiners();
    for (const relayId of relayIds) {
      expect(idle).toContain(relayId);
    }

    // (2) A real mark_revote_eligible_idle TX lands for each relay.
    for (const relayId of relayIds) {
      expect(await watcher.submitMarkTx(relayId, MarkReason.Idle)).toBe('submitted');
    }

    // (3) revote_eligible_since is now a non-null bigint in a sensible epoch range —
    // exercises the NON-EMPTY content-shape of the dynamic-field read (closes
    // follow-up (b)). The mark landed at/after the idle baseline, so since >= baseEpoch
    // (rules out a parse that returns an arbitrary small positive).
    for (const relayId of relayIds) {
      const since = await reader.getRevoteEligibleSince(relayId);
      expect(since).not.toBeNull();
      expect(typeof since).toBe('bigint');
      expect(since! >= baseEpoch).toBe(true);
    }

    // (4) An immediate re-mark is inside the cooldown window → skipped, for EVERY relay.
    for (const relayId of relayIds) {
      expect(await watcher.submitMarkTx(relayId, MarkReason.Idle)).toBe('skipped-cooldown');
    }
  });
});
