import { describe, it, expect, vi } from 'vitest';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, RoomCreated } from '@dvconf/shared';
import { handleEvent, DEFAULT_WEIGHTS } from '../event-handler.js';
import type { NodeCandidate } from '../scoring.js';
import * as roomAssignment from '../room-assignment.js';
import { PVR_DEFAULT_HISTORY } from '../scoring.js';
import type { AttestedLoad } from '../coverage-load-reader.js';

/** Create a mock Pino logger. */
function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

/** Create a fake SuiEvent. */
function makeSuiEvent(eventName: string, parsedJson: Record<string, unknown>): SuiEvent {
  return {
    id: { txDigest: 'test-digest', eventSeq: '0' },
    packageId: '0xabc',
    transactionModule: 'test_module',
    sender: '0x123',
    type: `0xabc::relay_registry::${eventName}`,
    parsedJson,
    bcs: '',
    timestampMs: '1000',
  } as SuiEvent;
}

/**
 * A 3-validator pool — the recorded room_health_validators ballot must be exactly 3
 * (room-assignment.ts's healthValidatorMinerIds floor, room_health_alerts.move), so any
 * EscrowCreated test that expects to reach the capacity/ballot logic (not defer early) needs
 * at least 3 validators, regardless of what it's actually testing about relays.
 */
function threeValidators(): Map<string, NodeCandidate> {
  return new Map<string, NodeCandidate>([
    ['val-1', { minerId: 'val-1', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
    ['val-2', { minerId: 'val-2', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
    ['val-3', { minerId: 'val-3', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
  ]);
}

describe('REQ-RMS-002 capacity-aware placement replaces the hardcoded top-2 slice', () => {
  it('selects i* = argmin (l_i + L_r)/C_worker, not just the top PVR score', () => {
    // CONCRETE failing-test-first for REQ-RMS-002's load-bearing selection. This is RED BEFORE
    // 8.4: today the EscrowCreated arm slices the top-2 by PVR score, so the high-stake 'hot'
    // relay (best PVR score) wins even though it is over capacity — the assertion below fails.
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    // 'hot' has high stake (best PVR score) but is near-saturated on attested load; 'cool' is light.
    relayState.set('hot',  { minerId: 'hot',  rtt: 0n, load: 0n, stakeAmount: 5_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('cool', { minerId: 'cool', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    // 3rd relay to clear the on-chain MIN_RELAY=3 ballot floor (1 primary + 2 standby) —
    // over-capacity like 'hot' so it never contends for the i* pick, only pads the ballot.
    relayState.set('padding', { minerId: 'padding', rtt: 0n, load: 0n, stakeAmount: 1_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot',  { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }], // 295 + L_r(12) = 307 > C_worker 300 -> rejected
      ['cool', { attestedLoadPaths: 10,  heartbeatFreshEpochs: 1 }], // 10 + 12 = 22 -> chosen
      ['padding', { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }], // over ceiling too — ballot padding only
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });
    // attestedLoad is the 9th positional arg (after event,relayState,pendingRooms,
    // logger,weights,txContext,pendingEscrows,validatorState). txContext=undefined => test mode logs topRelays.
    handleEvent(escrow, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), threeValidators(), attested);
    const proposalLog = logger.info.mock.calls.find((c: any[]) => c[1] === 'Room proposal: submitting TX');
    // RED today (PVR-top 'hot' wins the hardcoded slice); GREEN after 8.4 (capacity override picks 'cool').
    expect(proposalLog?.[0].topRelays?.[0]).toBe('cool');
  });

  it('REQ-RMS-002 records a ballot >= MIN_RELAY even when only ONE relay is capacity-eligible', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    // 'ok' is the sole capacity-eligible relay; 'full' is over its ceiling (rejected by selection)
    // but MUST still appear in the recorded ballot to satisfy the on-chain min_relay floor.
    relayState.set('ok',   { minerId: 'ok',   rtt: 0n, load: 0n, stakeAmount: 2_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('full', { minerId: 'full', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('full2', { minerId: 'full2', rtt: 0n, load: 0n, stakeAmount: 900_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    const pendingRooms = new Map<string, RoomCreated>([['room2', { room_id: 'room2', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['ok',   { attestedLoadPaths: 10,  heartbeatFreshEpochs: 1 }], // 10 + 12 = 22 <= 300 -> only eligible
      ['full', { attestedLoadPaths: 299, heartbeatFreshEpochs: 1 }], // 299 + 12 = 311 > 300 -> NOT eligible
      ['full2', { attestedLoadPaths: 299, heartbeatFreshEpochs: 1 }], // also over ceiling — ballot padding only
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e2', room_id: 'room2', amount: '1' });
    handleEvent(escrow, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), threeValidators(), attested);
    const proposalLog = logger.info.mock.calls.find((c: any[]) => c[1] === 'Room proposal: submitting TX');
    const ballot = proposalLog?.[0].topRelays as string[] | undefined;
    expect(ballot?.[0]).toBe('ok');                       // chosen (sole eligible) is index 0
    expect(ballot?.length).toBeGreaterThanOrEqual(3);     // >= MIN_RELAY — back-filled peers clear the on-chain floor
  });
});

describe('REQ-RMS-022 (D1) — tri-state placement-capacity basis log', () => {
  // The basis log fires at the capacity build (event-handler.ts, right after `capacities`),
  // BEFORE poolHealthGate — so it is emitted for all three states, incl. the defer break.
  const basisLogsOf = (logger: ReturnType<typeof mockLogger>): unknown[] =>
    logger.info.mock.calls
      .filter((c: unknown[]) => (c[0] as { action?: string })?.action === 'placement_basis')
      .map((c: unknown[]) => (c[0] as { context: { basis: unknown } }).context.basis);

  const seed = () => ({
    relayState: new Map<string, NodeCandidate>([
      ['r1', { minerId: 'r1', rtt: 0n, load: 5n, stakeAmount: 2_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
    ]),
    pendingRooms: new Map<string, RoomCreated>([['roomB', { room_id: 'roomB', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]),
    escrow: makeSuiEvent('EscrowCreated', { escrow_id: 'eB', room_id: 'roomB', amount: '1' }),
  });

  it('basis=legacy-self-report when NO attestedLoad feed is wired (flag OFF path)', () => {
    const logger = mockLogger();
    const { relayState, pendingRooms, escrow } = seed();
    handleEvent(escrow, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), threeValidators(), undefined);
    expect(basisLogsOf(logger)).toEqual(['legacy-self-report']);
  });

  it('basis=attested when the wired feed has a row for a candidate relay', () => {
    const logger = mockLogger();
    const { relayState, pendingRooms, escrow } = seed();
    const attested = new Map<string, AttestedLoad>([['r1', { attestedLoadPaths: 3, heartbeatFreshEpochs: 1 }]]);
    handleEvent(escrow, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), threeValidators(), attested);
    expect(basisLogsOf(logger)).toEqual(['attested']);
  });

  it('basis=defer when the wired feed is EMPTY (strict no-attestation)', () => {
    const logger = mockLogger();
    const { relayState, pendingRooms, escrow } = seed();
    handleEvent(escrow, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), threeValidators(), new Map());
    expect(basisLogsOf(logger)).toEqual(['defer']);
  });
});

describe('REQ-RMS-004 capacity-selected N-vector reaches submit_pairing_proposal unchanged', () => {
  it('REQ-RMS-004 records the capacity-selected N-vector via submit_pairing_proposal unchanged', async () => {
    const spy = vi.spyOn(roomAssignment, 'submitProposal').mockResolvedValue(true);
    roomAssignment.clearVotedRoom('room1'); // votedRooms is a module Set — clear so the proposal is not skipped as already-voted

    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    relayState.set('hot',  { minerId: 'hot',  rtt: 0n, load: 0n, stakeAmount: 5_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('cool', { minerId: 'cool', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    // 3rd relay to clear the on-chain MIN_RELAY=3 ballot floor — over-capacity, padding only.
    relayState.set('padding', { minerId: 'padding', rtt: 0n, load: 0n, stakeAmount: 1_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    const validatorState = threeValidators();
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot',  { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }],
      ['cool', { attestedLoadPaths: 10,  heartbeatFreshEpochs: 1 }],
      ['padding', { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }],
    ]);
    // Minimal txContext — submitProposal is mocked, so client/signer/config/cpCapId need only satisfy the type.
    const txContext = {
      client: {} as unknown as SuiClient,
      signer: {} as unknown as Ed25519Keypair,
      config: {} as unknown as NetworkConfig,
      cpCapId: '0xcap',
    };
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });
    // Full positional call: event, relayState, pendingRooms, logger, weights, txContext,
    // pendingEscrows, validatorState, attestedLoad.
    handleEvent(escrow, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, txContext, new Map(), validatorState, attested);

    // Placement now round-trips through getRelayReservationLoad (an awaited devInspect read)
    // inside an async IIFE before submitProposal fires — wait for it instead of asserting sync.
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]!;
    // args[5] = relayMinerIds (capacity-selected, length >= MIN_RELAY); args[7] = submittedScore (bigint, PVR consensus).
    expect(Array.isArray(args[5])).toBe(true);
    expect((args[5] as string[]).length).toBeGreaterThanOrEqual(3);
    expect((args[5] as string[])[0]).toBe('cool'); // capacity-selected relay leads the recorded vector
    expect(typeof args[7]).toBe('bigint');
    spy.mockRestore();
  });
});
