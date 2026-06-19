/**
 * REQ-CFA-013/014 (M2 chunk 1) — off-chain coverage feed, hermetic tests.
 *
 * buildCoveragePayload(snapshot, reporterMinerId) is the PURE mapper that serializes the
 * EXISTING canary cell-loop snapshot (CellRoundSnapshot) into the LOCKED camelCase wire
 * shape consumed by the client coverage hook. It is the only part of the feed that touches
 * wire bytes, so the INV-C hygiene assertions live here (no HTTP, no ports).
 *
 * THIS TEST PINS (DESIGN section 5 / D-CFA-13):
 *   - distinctValidatorCount = dedup of validators[].minerId (Wallet-B duplicates collapse).
 *   - the serialized payload contains NO `sessionWallet` substring (and drops publish/consume).
 *   - reporterMinerId is the value passed in (Wallet-A) and is NOT the sessionAddress —
 *     a value-level check (a key-substring check alone would miss a wrong Wallet-B VALUE).
 *   - empty/null snapshot -> { round:-1, relays:[] } (honest pre-first-tick state).
 *
 * HERMETIC: pure function only — startCoverageServer (which binds a port) is NOT started
 * here (per the concurrent-session port-collision rule); its loopback-bind + restricted-CORS
 * behaviour is verified by static review against the DESIGN, not by booting a server.
 */

import { describe, it, expect } from 'vitest';
import { buildCoveragePayload } from '../coverage-server.js';
import type { CellRoundSnapshot } from '../cell.js';

const WALLET_A = '0x' + 'a'.padStart(64, 'a'); // the reporting validator's Wallet-A miner_id
const SESSION_ADDR = '0x' + 'b'.padStart(64, 'b'); // a Wallet-B session address (MUST NOT leak)

/** A snapshot with one relay covered by two DISTINCT miners, one of which has a Wallet-B dup. */
const snapshot: CellRoundSnapshot = {
  round: 7,
  cells: [
    {
      relayId: '0xrelay1',
      covered: true,
      validators: [
        { minerId: '0xminerX', sessionWallet: SESSION_ADDR, publish: true, consume: true },
        // SAME miner, a rotated Wallet-B session — must collapse in distinct count.
        { minerId: '0xminerX', sessionWallet: '0xotherSession', publish: true, consume: true },
        { minerId: '0xminerY', sessionWallet: '0xsessY', publish: true, consume: true },
      ],
    },
    {
      relayId: '0xrelay2',
      covered: false,
      validators: [{ minerId: '0xminerX', sessionWallet: SESSION_ADDR, publish: true, consume: true }],
    },
  ],
};

describe('REQ-CFA-014 buildCoveragePayload — pure cell-snapshot -> wire mapper', () => {
  it('(a) maps cells to the LOCKED camelCase wire shape', () => {
    const p = buildCoveragePayload(snapshot, WALLET_A);
    expect(p.service).toBe('validator-daemon');
    expect(p.reporterMinerId).toBe(WALLET_A);
    expect(p.round).toBe(7);
    expect(p.minDistinct).toBe(2);
    expect(typeof p.ts).toBe('number');
    expect(p.relays).toHaveLength(2);

    const r1 = p.relays.find((r) => r.relayMinerId === '0xrelay1')!;
    expect(r1.covered).toBe(true);
    expect(r1.relayMinerId).toBe('0xrelay1');
  });

  it('(b) distinctValidatorCount + validatorMinerIds DEDUP by minerId (Wallet-B collapses)', () => {
    const p = buildCoveragePayload(snapshot, WALLET_A);
    const r1 = p.relays.find((r) => r.relayMinerId === '0xrelay1')!;
    // 3 raw validators, but only 2 DISTINCT miner_ids (minerX twice + minerY).
    expect(r1.distinctValidatorCount).toBe(2);
    expect([...r1.validatorMinerIds].sort()).toEqual(['0xminerX', '0xminerY']);
    // single source of truth: the count equals the deduped list length.
    expect(r1.distinctValidatorCount).toBe(r1.validatorMinerIds.length);
  });

  it('(c) the serialized payload contains NO sessionWallet substring (and no publish/consume)', () => {
    const serialized = JSON.stringify(buildCoveragePayload(snapshot, WALLET_A));
    // The session address VALUE must not appear anywhere on the wire.
    expect(serialized).not.toContain(SESSION_ADDR);
    expect(serialized).not.toContain('0xotherSession');
    expect(serialized).not.toContain('0xsessY');
    // Nor the dropped field keys.
    expect(serialized).not.toContain('sessionWallet');
    expect(serialized).not.toContain('publish');
    expect(serialized).not.toContain('consume');
  });

  it('(d) reporterMinerId is Wallet-A and is NOT the sessionAddress (value-level, D-CFA-13)', () => {
    const p = buildCoveragePayload(snapshot, WALLET_A);
    expect(p.reporterMinerId).toBe(WALLET_A);
    // The load-bearing value check: a Wallet-B value would slip past a key-substring check.
    expect(p.reporterMinerId).not.toBe(SESSION_ADDR);
    expect(JSON.stringify(p)).not.toContain(SESSION_ADDR);
  });

  it('(e) an EMPTY snapshot (no cells) -> honest { round, relays:[] }', () => {
    const p = buildCoveragePayload({ round: 3, cells: [] }, WALLET_A);
    expect(p.relays).toEqual([]);
    expect(p.round).toBe(3);
    expect(p.reporterMinerId).toBe(WALLET_A);
  });

  it('(e) a NULL snapshot (pre-first-tick) -> { round:-1, relays:[] } (honest empty state)', () => {
    const p = buildCoveragePayload(null, WALLET_A);
    expect(p.round).toBe(-1);
    expect(p.relays).toEqual([]);
    expect(p.reporterMinerId).toBe(WALLET_A);
  });
});
