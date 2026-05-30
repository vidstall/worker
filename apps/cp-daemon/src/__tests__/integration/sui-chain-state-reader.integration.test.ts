/**
 * F47 Phase 4.0 smoke — SuiChainStateReader against a LIVE empty localnet
 * (REQ-RV-013). Boots `sui start`, publishes the package, creates the 6
 * registries, then exercises all 6 reader methods against the fresh
 * (empty-registry) chain.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration`
 * (vitest.integration.config.ts), NEVER `pnpm test`. The orchestrator runs the
 * live boot; this file must TYPE-CHECK under `pnpm typecheck`.
 *
 * Empty-chain expectations:
 *   - getMaxIdleEpochs  → 30n  (DEFAULT_MAX_IDLE_EPOCHS)
 *   - getRevoteCooldownEpochs → 14n (DEFAULT_REVOTE_COOLDOWN_EPOCHS)
 *   - getRoleCounts     → all 0n
 *   - getActiveMiners   → []   (exercises get_active_* devInspect + empty-vector decode)
 *   - getRevoteEligibleSince(0x0…0) → null (dynamic-field not-found path)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLogger, type Logger } from '@dvconf/shared';
import { SuiChainStateReader } from '../../sui-chain-state-reader.js';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';

const ZERO_ID = '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('SuiChainStateReader (live localnet, Phase 4.0 smoke)', () => {
  let handle: LocalnetHandle;
  let reader: SuiChainStateReader;
  const logger: Logger = createLogger('phase40-smoke');

  beforeAll(async () => {
    handle = await bootLocalnet();
    reader = new SuiChainStateReader(handle.client, handle.config, logger);
  }, 300_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('getCurrentEpoch returns a non-negative epoch', async () => {
    expect(await reader.getCurrentEpoch()).toBeGreaterThanOrEqual(0n);
  });

  it('getMaxIdleEpochs returns the default 30', async () => {
    expect(await reader.getMaxIdleEpochs()).toBe(30n);
  });

  it('getRevoteCooldownEpochs returns the default 14', async () => {
    expect(await reader.getRevoteCooldownEpochs()).toBe(14n);
  });

  it('getRoleCounts is all zero on a fresh chain', async () => {
    expect(await reader.getRoleCounts()).toEqual({ relay: 0n, validator: 0n, cp: 0n, signaling: 0n });
  });

  it('getActiveMiners is empty on a fresh chain', async () => {
    expect(await reader.getActiveMiners()).toEqual([]);
  });

  it('getRevoteEligibleSince is null for an unmarked miner', async () => {
    expect(await reader.getRevoteEligibleSince(ZERO_ID)).toBeNull();
  });
});
