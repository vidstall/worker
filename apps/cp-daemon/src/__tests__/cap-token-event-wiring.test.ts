/**
 * F62 M2 daemon-wiring W-P2 (REQ-ADW-001, D-W8/D-W9) — event-handler → CapTokenIssuer wiring.
 *
 * Proves the four cap-token arms in `handleEvent`/`createEventHandler` dispatch to the
 * issuer with the right handler + a snake_case→camelCase-mapped payload + a traceId,
 * guarded by `if (txContext?.capTokenIssuer)` (absent issuer = no dispatch, no crash):
 *   - room_manager::RoomAssigned          → onRoomAssigned
 *   - role_voting::RoleAssigned           → onRoleAssigned
 *   - economic_layer::RelaySlashed        → onRelaySlashed (ADDITIVE to turnIssuer.markSlashed)
 *   - miner::registration::RoleChanged    → onRoleChanged   (NEW case arm, D-W8)
 *
 * TDD RED-first: these fail until the arms thread `capTokenIssuer` into the txContext.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import { createEventHandler } from '../event-handler.js';
import type { CapTokenIssuer } from '../cap-token-issuer.js';
import type { TurnIssuer } from '../turn-issuer.js';

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

/** A fake CapTokenIssuer exposing only the four handler spies the arms call. */
function fakeCapTokenIssuer() {
  return {
    onRoomAssigned: vi.fn().mockResolvedValue(undefined),
    onRoleAssigned: vi.fn().mockResolvedValue(undefined),
    onRoleChanged: vi.fn().mockResolvedValue(undefined),
    onRelaySlashed: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeTurnIssuer() {
  return {
    markSlashed: vi.fn(),
    emergencyEvictSecret: vi.fn().mockReturnValue(true),
  } as unknown as TurnIssuer;
}

const PKG = '0xpkg';
function ev(module: string, name: string, parsedJson: Record<string, unknown>): SuiEvent {
  return { type: `${PKG}::${module}::${name}`, parsedJson } as unknown as SuiEvent;
}

function ctx(capTokenIssuer: ReturnType<typeof fakeCapTokenIssuer> | undefined, turnIssuer?: TurnIssuer) {
  return {
    client: {} as any,
    signer: {} as any,
    config: {} as any,
    cpCapId: '0xcap',
    ...(turnIssuer && { turnIssuer }),
    ...(capTokenIssuer && { capTokenIssuer: capTokenIssuer as unknown as CapTokenIssuer }),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('event-handler → CapTokenIssuer wiring (W-P2, D-W8/D-W9)', () => {
  let issuer: ReturnType<typeof fakeCapTokenIssuer>;
  beforeEach(() => {
    issuer = fakeCapTokenIssuer();
  });

  it('RoomAssigned arm dispatches onRoomAssigned with snake→camel-mapped payload + traceId', async () => {
    const { handler } = createEventHandler(mockLogger(), undefined, ctx(issuer));
    await handler(
      ev('room_manager', 'RoomAssigned', {
        room_id: '0xroom1',
        relay_ids: ['0xrelay1', '0xrelay2'],
        signaling_id: '0xsig1',
        relay_mode: 1,
        verified_score: '950',
        consensus_reached: true,
        winning_cp: '0xcp1',
        validator_ids: ['0xval1', '0xval2'],
      }),
    );
    expect(issuer.onRoomAssigned).toHaveBeenCalledTimes(1);
    const [payload, traceId] = issuer.onRoomAssigned.mock.calls[0];
    expect(payload).toEqual({
      roomId: '0xroom1',
      relayIds: ['0xrelay1', '0xrelay2'],
      signalingId: '0xsig1',
      relayMode: 1,
      verifiedScore: '950',
      consensusReached: true,
      winningCp: '0xcp1',
      validatorIds: ['0xval1', '0xval2'],
    });
    expect(traceId).toMatch(UUID_RE);
  });

  it('RoleAssigned arm dispatches onRoleAssigned with mapped payload', async () => {
    const { handler } = createEventHandler(mockLogger(), undefined, ctx(issuer));
    await handler(
      ev('role_voting', 'RoleAssigned', {
        miner_id: '0xminer1', role: 4, vote_count: '3', threshold: '2',
      }),
    );
    expect(issuer.onRoleAssigned).toHaveBeenCalledTimes(1);
    const [payload, traceId] = issuer.onRoleAssigned.mock.calls[0];
    expect(payload).toEqual({ minerId: '0xminer1', role: 4, voteCount: '3', threshold: '2' });
    expect(traceId).toMatch(UUID_RE);
  });

  it('NEW RoleChanged case arm dispatches onRoleChanged with mapped payload (D-W8)', async () => {
    const { handler } = createEventHandler(mockLogger(), undefined, ctx(issuer));
    await handler(
      ev('registration', 'RoleChanged', {
        miner_id: '0xminer1', old_role: 2, new_role: 4, new_stake: '1000000000',
      }),
    );
    expect(issuer.onRoleChanged).toHaveBeenCalledTimes(1);
    const [payload, traceId] = issuer.onRoleChanged.mock.calls[0];
    expect(payload).toEqual({ minerId: '0xminer1', oldRole: 2, newRole: 4, newStake: '1000000000' });
    expect(traceId).toMatch(UUID_RE);
  });

  it('RelaySlashed arm dispatches onRelaySlashed ADDITIVELY alongside turnIssuer.markSlashed', async () => {
    const turn = fakeTurnIssuer();
    const { handler } = createEventHandler(mockLogger(), undefined, ctx(issuer, turn));
    await handler(
      ev('economic_layer', 'RelaySlashed', {
        room_id: '0xroom1', relay_miner_id: '0xrelay-bad', slash_amount: '500000000',
      }),
    );
    // Existing TURN kill-switch still fires
    expect(turn.markSlashed).toHaveBeenCalledWith('0xrelay-bad');
    // ADDITIVE cap-token dispatch
    expect(issuer.onRelaySlashed).toHaveBeenCalledTimes(1);
    const [payload, traceId] = issuer.onRelaySlashed.mock.calls[0];
    expect(payload).toEqual({ roomId: '0xroom1', relayMinerId: '0xrelay-bad', slashAmount: '500000000' });
    expect(traceId).toMatch(UUID_RE);
  });

  it('guard: with no capTokenIssuer in txContext, no issuer method is called (no crash)', async () => {
    const { handler } = createEventHandler(mockLogger(), undefined, ctx(undefined, fakeTurnIssuer()));
    await handler(ev('room_manager', 'RoomAssigned', {
      room_id: '0xroom1', relay_ids: [], signaling_id: '0xsig1', relay_mode: 0,
      verified_score: '0', consensus_reached: true, winning_cp: '0xcp1', validator_ids: [],
    }));
    await handler(ev('registration', 'RoleChanged', {
      miner_id: '0xminer1', old_role: 2, new_role: 4, new_stake: '1',
    }));
    // No throw; the arms simply skip the issuer dispatch.
    expect(issuer.onRoomAssigned).not.toHaveBeenCalled();
    expect(issuer.onRoleChanged).not.toHaveBeenCalled();
  });
});
