import { describe, it, expect } from 'vitest';
import { buildKeysRecord, type SeededKey } from '../seed-bootstrap.ts';

const k = (s: string): SeededKey => ({
  secretKey: s,
  capId: `0xcap-${s}`,
  stakeId: `0xstk-${s}`,
  minerId: `0xmin-${s}`,
});

describe('buildKeysRecord (seed-bootstrap validator-2 slot)', () => {
  it('emits all 5 role slots INCLUDING a distinct validator-2', () => {
    const rec = buildKeysRecord({
      cp: k('cp'), relay: k('relay'), 'relay-standby': k('rs'),
      validator: k('v1'), 'validator-2': k('v2'),
    });
    expect(Object.keys(rec).sort()).toEqual(
      ['cp', 'relay', 'relay-standby', 'validator', 'validator-2'],
    );
    // validator-2 MUST be a DISTINCT key from validator (distinct miner_id on-chain).
    expect(rec['validator-2'].secretKey).not.toBe(rec['validator'].secretKey);
  });

  // gap #3 (Stage-5 live slash): the relay slot MUST carry minerId — canary live-seams
  // loadRelayBondKeys throws without relay.minerId (W-E9 self-slash needs the bond owner's
  // miner_id). The keys file is the SOLE source the validators read for it.
  it('preserves a minerId on every slot (relay.minerId is load-bearing for live-seams)', () => {
    const rec = buildKeysRecord({
      cp: k('cp'), relay: k('relay'), 'relay-standby': k('rs'),
      validator: k('v1'), 'validator-2': k('v2'),
    });
    expect(rec['relay'].minerId).toBe('0xmin-relay');
    for (const slot of Object.values(rec)) {
      expect(typeof slot.minerId).toBe('string');
      expect(slot.minerId.length).toBeGreaterThan(0);
    }
  });
});
