/**
 * Single-CP gate for the G3 infra-peer pubkey recovery wiring (consolidated-demo root cause C,
 * 2026-06-24).
 *
 * BUG: index.ts wired `new InfraPeerPubkeyCache()` UNCONDITIONALLY, so even a single-CP issuer
 * (CAP_TOKEN_QUORUM_THRESHOLD=1) routed every infra peer through G3 recovery. On the FIRST room
 * the cache is empty (it is only seeded by OBSERVING prior CapabilityIssued events) →
 * `submitIssue` fail-closed-SKIPs the mint → NO CapabilityIssued is ever emitted (chicken-and-egg)
 * → the demo's Stage 2c (on-chain accept proof) can never pass, and the F62-proven single-CP
 * legacy mint (`resolvePeerPubkey` 32-byte miner-id placeholder) is silently disabled.
 *
 * The issuer ALREADY documents the intended contract: `onCapabilityIssued` is a no-op "when no
 * recovery cache is configured (single-CP / legacy)" (cap-token-issuer.ts:880-881) and
 * `infraPeerCache?` is optional. G3 recovery is a MULTI-CP mechanism (threshold>=2). This pure
 * policy makes the wiring honour that intent so single-CP falls back to the legacy mint.
 */
import { describe, it, expect } from 'vitest';
import { shouldWireInfraPeerRecovery } from '../cap-token/index.js';

describe('shouldWireInfraPeerRecovery — single-CP must NOT wire G3 recovery', () => {
  it('is FALSE for single-CP (threshold 1) → legacy resolvePeerPubkey mint, no fail-closed skip', () => {
    expect(shouldWireInfraPeerRecovery(1)).toBe(false);
  });

  it('is FALSE for a degenerate threshold (0) — never enable recovery below quorum', () => {
    expect(shouldWireInfraPeerRecovery(0)).toBe(false);
  });

  it('is TRUE for multi-CP (threshold 2) → G3 recovery active (preserve existing behaviour)', () => {
    expect(shouldWireInfraPeerRecovery(2)).toBe(true);
  });

  it('is TRUE for any higher quorum (threshold 3)', () => {
    expect(shouldWireInfraPeerRecovery(3)).toBe(true);
  });
});
