import { describe, it, expect } from 'vitest';
import { assertRoleAssigned, REGISTRANT_STAKE_MIST } from '../register-lowstake-miner.ts';

describe('register-lowstake-miner', () => {
  it('REGISTRANT_STAKE_MIST is 0.3 SUI (yields role=0/User below the 0.6 SUI CP threshold)', () => {
    expect(REGISTRANT_STAKE_MIST).toBe(300_000_000n);
  });

  it('assertRoleAssigned throws when the live voter never cast (undefined)', () => {
    expect(() => assertRoleAssigned(undefined)).toThrow(/no role assigned/i);
  });

  it('assertRoleAssigned passes through a cast assignment (validator=1)', () => {
    expect(() => assertRoleAssigned(1)).not.toThrow();
  });
});
