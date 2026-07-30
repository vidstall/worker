/**
 * REQ-RMS-009 — submitSpillAuthorization builds the authorize_spill_relay PTB.
 * Hermetic: stub the SuiClient/executeWithRetry seam, assert the moveCall target +
 * arg shape (mirrors submitProposal). No live chain.
 */
import { describe, it, expect, vi } from 'vitest';

const captured: { target?: string; argCount?: number } = {};
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return {
    ...actual,
    executeWithRetry: vi.fn(async (_client, _signer, build: (tx: any) => void) => {
      const fakeTx = {
        moveCall: (c: { target: string; arguments: unknown[] }) => {
          captured.target = c.target;
          captured.argCount = c.arguments.length;
        },
        object: (id: string) => ({ kind: 'object', id }),
        pure: { id: (id: string) => ({ kind: 'id', id }) },
      };
      build(fakeTx);
    }),
  };
});

import { submitSpillAuthorization } from '../room-assignment.js';

describe('submitSpillAuthorization (REQ-RMS-009)', () => {
  it('targets room_manager_reassignment::authorize_spill_relay with 7 args (5 objects + 2 ids)', async () => {
    const config = {
      packageId: '0xpkg', networkRegistryId: '0xnet', roomManagerId: '0xroom',
      cpRegistryId: '0xcp', relayRegistryId: '0xrelay',
    } as any;
    await submitSpillAuthorization(
      {} as any, {} as any, config, '0xcap', 'room-1', 'relay-spill', { info: () => {}, debug: () => {}, error: () => {} } as any,
    );
    expect(captured.target).toBe('0xpkg::room_manager_reassignment::authorize_spill_relay');
    // net_reg, manager, cp_reg, relay_reg, cap (5 objects) + room_id, spill_relay (2 ids) = 7
    expect(captured.argCount).toBe(7);
  });
});
