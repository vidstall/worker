/**
 * REQ-RMS-015 — the EscrowCreated placement arm excludes a canary-flagged relay
 * from the PROPOSED relay set actually handed to submit_pairing_proposal. We spy
 * the submitProposal seam and assert the flagged minerId is NEVER in the proposed
 * topRelayIds — observing real handleEvent behavior, not a re-derived filter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spy the submitProposal seam BEFORE importing event-handler. vi.mock is HOISTED above
// the module body, so the spy must be created with vi.hoisted() (a bare `const spy` would
// be in the temporal dead zone when the hoisted factory runs).
// submitProposal is exported from room-assignment.js (verified event-handler.ts:56-62);
// keep the rest of that module REAL (votedRooms is used here).
// Variadic signature so mock.calls[i] is unknown[] (the real submitProposal takes 9 positional
// args; the spy ignores them but we read index 5 = topRelayIds, so the tuple must not be length-0).
const { submitProposalSpy } = vi.hoisted(() => ({
  submitProposalSpy: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}));
vi.mock('../room-assignment.js', async (orig) => {
  const actual = await orig<typeof import('../room-assignment.js')>();
  return { ...actual, submitProposal: submitProposalSpy };
});

import { createLogger } from '@dvconf/shared';
import { handleEvent } from '../event-handler.js';
import { type NodeCandidate } from '../scoring.js';
import { votedRooms } from '../room-assignment.js';

const logger = createLogger('test');
const node = (minerId: string): NodeCandidate => ({
  minerId, rtt: 0n, load: 0n, stakeAmount: 1_000_000n, heartbeatAge: 0n, region: '', historyScore: 5_000n,
});

function ev(type: string, parsedJson: Record<string, unknown>): Parameters<typeof handleEvent>[0] {
  return { type: `0xpkg::economic_layer::${type}`, parsedJson } as unknown as Parameters<typeof handleEvent>[0];
}

/** Minimal fake txContext so the arm reaches submitProposal (the spy). */
const fakeTxContext = {
  client: {} as never, signer: {} as never, config: {} as never, cpCapId: 'cap',
} as unknown as Parameters<typeof handleEvent>[5]; // index 5 = txContext (NOT [4]=weights)

/** room_health_validators floor (room_health_alerts.move) needs >= 3 to reach placement logic at all. */
const threeValidators = new Map<string, NodeCandidate>([
  ['val-1', node('val-1')], ['val-2', node('val-2')], ['val-3', node('val-3')],
]);

describe('REQ-RMS-015 — EscrowCreated proposes WITHOUT the canary-flagged relay', () => {
  beforeEach(() => { submitProposalSpy.mockClear(); votedRooms.clear(); });

  it('the flagged relay is NEVER in the topRelayIds passed to submitProposal', async () => {
    // R3 added: after excluding R-byz, the ballot needs >= MIN_RELAY (3) surviving
    // relays (1 primary + 2 pre-warmed standby) or submit_pairing_proposal's on-chain
    // floor can't be satisfied and the arm defers instead of proposing at all.
    const relayState = new Map<string, NodeCandidate>([
      ['R1', node('R1')], ['R-byz', node('R-byz')], ['R2', node('R2')], ['R3', node('R3')],
    ]);
    const pendingRooms = new Map<string, never>();
    const pendingEscrows = new Map<string, never>();

    // 1) stash the room (RoomCreated), 2) trigger placement (EscrowCreated) with a
    // flag that marks R-byz; txContext present => the arm calls submitProposal.
    handleEvent(
      { type: '0xpkg::room_manager::RoomCreated', parsedJson: { room_id: 'room1', creator: 'c', relay_mode: 0 } } as never,
      relayState, pendingRooms as never, logger, undefined, undefined, pendingEscrows as never, threeValidators,
    );
    const isFlagged = (id: string): boolean => id === 'R-byz';
    handleEvent(
      ev('EscrowCreated', { room_id: 'room1', escrow_id: 'esc1', amount: '100' }),
      relayState, pendingRooms as never, logger,
      undefined,               // [4] weights (default)
      fakeTxContext,           // [5] txContext present => the EscrowCreated arm calls submitProposal
      pendingEscrows as never, // [6] pendingEscrows
      threeValidators,         // [7] validatorState
      undefined,               // [8] attestedLoad  (M1 param, unused here)
      undefined,               // [9] currentEpoch (M1 param, unused here)
      isFlagged,               // [10] byzantineFlag (M3) => excludes R-byz from the proposed set
    );

    // submitProposal(client, signer, config, cpCapId, roomId, topRelayIds, ...) —
    // the 6th positional arg (index 5) is the proposed relay-id set. Placement now round-trips
    // through an awaited getRelayReservationLoad devInspect read before submitProposal fires.
    await vi.waitFor(() => expect(submitProposalSpy).toHaveBeenCalledTimes(1));
    const proposedRelayIds = submitProposalSpy.mock.calls[0]![5] as string[];
    expect(proposedRelayIds).not.toContain('R-byz'); // REAL proposed set, observed
    expect(proposedRelayIds.sort()).toEqual(['R1', 'R2', 'R3']);
  });
});
