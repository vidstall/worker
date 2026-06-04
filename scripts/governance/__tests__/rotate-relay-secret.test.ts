import { describe, it, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';

// Manual mock (NO importOriginal): the root/scripts package does not declare
// @dvconf/shared, so vitest's resolver cannot load the real module from this
// context (matches the request-revote / revoke-cap-token sibling tests). The
// builder + guards under test never call these at module load; main() never runs
// here. The named exports exist so rotate-relay-secret.ts's import binding resolves.
vi.mock('@dvconf/shared', () => ({
  executeWithRetry: vi.fn(),
  createSuiClient: vi.fn(),
  createLogger: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadKeypair: vi.fn(),
}));

import {
  buildRotateRelaySecretTx,
  assertValidRotation,
  type RotateRelaySecretArgs,
} from '../rotate-relay-secret.js';

// NOTE: object/id args must be VALID hex — the SDK validates them as Sui addresses
// (`tx.pure.id` eagerly; `tx.object` at the `getData()` snapshot). The plan's fixture
// literals (`0xMINER`/`0xADMIN`/`0xNET`) contain non-hex chars and throw "Invalid Sui
// address", so adminCapId/cpMinerId/networkRegistryId are swapped for valid 0x hex.
// packageId feeds the moveCall target, whose package portion the SDK also normalizes
// as an address at snapshot time — so it must be valid hex too.
const PKG = '0x0000000000000000000000000000000000000000000000000000000000000fee';
const NET = '0x0000000000000000000000000000000000000000000000000000000000000bee';
const ADMIN = '0x000000000000000000000000000000000000000000000000000000000000ad11';
const MINER = '0x0000000000000000000000000000000000000000000000000000000000000abc';

const config = {
  packageId: PKG,
  networkRegistryId: NET,
} as const;

const baseArgs: RotateRelaySecretArgs = {
  adminCapId: ADMIN,
  cpMinerId: MINER,
  oldSecretId: 1n,
  newSecretId: 2n,
  reason: 0,
};

describe('assertValidRotation', () => {
  it('rejects reason > 2 (mirrors Move E_INVALID_ROTATION_REASON=803)', () => {
    expect(() => assertValidRotation({ ...baseArgs, reason: 3 })).toThrow(/reason/i);
  });
  it('rejects equal old/new secret ids (mirrors Move E_SAME_SECRET_ID=804)', () => {
    expect(() => assertValidRotation({ ...baseArgs, oldSecretId: 5n, newSecretId: 5n })).toThrow(/same/i);
  });
  it('accepts a valid rotation', () => {
    expect(() => assertValidRotation(baseArgs)).not.toThrow();
  });
});

describe('buildRotateRelaySecretTx', () => {
  it('adds exactly one moveCall to emergency_rotate_relay_secret with the right target', () => {
    const tx = new Transaction();
    buildRotateRelaySecretTx(tx, config, baseArgs);
    const data = tx.getData();
    const moveCalls = data.commands.filter((c) => c.$kind === 'MoveCall');
    expect(moveCalls).toHaveLength(1);
    const mc = (moveCalls[0] as { MoveCall: { package: string; module: string; function: string } }).MoveCall;
    expect(mc.module).toBe('turn_credential');
    expect(mc.function).toBe('emergency_rotate_relay_secret');
  });
});
