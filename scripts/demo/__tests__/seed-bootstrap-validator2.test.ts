import { describe, it, expect } from 'vitest';
import { buildKeysRecord, type SeededKey } from '../seed-bootstrap.ts';

const k = (s: string): SeededKey => ({ secretKey: s, capId: `0xcap-${s}`, stakeId: `0xstk-${s}` });

describe('buildKeysRecord (seed-bootstrap validator-2 slot)', () => {
  it('emits all 6 role slots INCLUDING a distinct validator-2', () => {
    const rec = buildKeysRecord({
      cp: k('cp'), relay: k('relay'), 'relay-standby': k('rs'),
      validator: k('v1'), 'validator-2': k('v2'), signaling: k('sig'),
    });
    expect(Object.keys(rec).sort()).toEqual(
      ['cp', 'relay', 'relay-standby', 'signaling', 'validator', 'validator-2'],
    );
    // validator-2 MUST be a DISTINCT key from validator (distinct miner_id on-chain).
    expect(rec['validator-2'].secretKey).not.toBe(rec['validator'].secretKey);
  });
});
