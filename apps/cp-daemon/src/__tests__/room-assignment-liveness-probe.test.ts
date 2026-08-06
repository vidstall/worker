/**
 * Coverage for the opt-in (RMS_RELAY_HEALTH_PROBE=1) relay liveness gate in
 * room-assignment.ts's handleEscrowCreated -- added alongside
 * relay_registry.move's update_endpoint_url fix. cp-daemon's existing
 * poolHealthGate only checks on-chain heartbeat freshness, which a relay
 * keeps refreshing even while its registered endpoint_url is stale garbage,
 * so this probe is what actually catches a heartbeating-but-unreachable
 * relay before it's handed to a bot.
 *
 * Default (env var unset) behavior is covered by the existing REQ-RMS-004
 * test in event-handler.test.ts, which asserts submitProposal is called
 * SYNCHRONOUSLY -- proof the probe is a no-op when disabled. These tests
 * only exercise the RMS_RELAY_HEALTH_PROBE=1 path.
 *
 * Capacity setup mirrors REQ-RMS-004's exactly: roomLoad = 12 (small/sfu/0
 * participants), cWorker default 300. 'hot' (attested 295) has NO headroom
 * (295+12=307>300) -- it never wins selectPlacementRelay regardless of
 * liveness. 'cool' (attested 10) and 'warm' (attested 50, added for the
 * retry test) both fit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, RoomCreated } from '@dvconf/shared';

const { mockProbeCandidates } = vi.hoisted(() => ({
  mockProbeCandidates: vi.fn(),
}));

vi.mock('../relay-liveness-probe.js', () => ({
  probeCandidates: mockProbeCandidates,
}));

import { handleEvent, DEFAULT_WEIGHTS } from '../event-handler.js';
import type { NodeCandidate } from '../scoring.js';
import type { SignalingCandidate } from '../room-assignment.js';
import * as roomAssignment from '../room-assignment.js';
import { PVR_DEFAULT_HISTORY } from '../scoring.js';
import type { AttestedLoad } from '../coverage-load-reader.js';

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

function candidate(minerId: string, stakeAmount: bigint): NodeCandidate {
  return { minerId, rtt: 0n, load: 0n, stakeAmount, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY };
}

function baseTxContext() {
  return {
    client: {} as unknown as SuiClient,
    signer: {} as unknown as Ed25519Keypair,
    config: {} as unknown as NetworkConfig,
    cpCapId: '0xcap',
  };
}

/** room_health_validators floor (room_health_alerts.move) needs >= 3 to reach placement logic at all. */
function threeValidators(): Map<string, NodeCandidate> {
  return new Map<string, NodeCandidate>([
    ['val-1', candidate('val-1', 1_000_000_000n)],
    ['val-2', candidate('val-2', 1_000_000_000n)],
    ['val-3', candidate('val-3', 1_000_000_000n)],
  ]);
}

describe('RMS_RELAY_HEALTH_PROBE=1 liveness gate', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, RMS_RELAY_HEALTH_PROBE: '1' };
    roomAssignment.clearVotedRoom('room1');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('submits the original ballot when the chosen relay probes alive', async () => {
    const spy = vi.spyOn(roomAssignment, 'submitProposal').mockResolvedValue(true);
    // 3 relays now actively serve (1 primary + 2 pre-warmed standby, MIN_RELAY=3) — all alive.
    mockProbeCandidates.mockResolvedValue(new Set(['cool', 'peerA', 'hot']));

    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>([
      ['hot', candidate('hot', 5_000_000_000n)],
      ['cool', candidate('cool', 1_000_000_000n)],
      ['peerA', candidate('peerA', 500_000_000n)],
    ]);
    const signalingState = new Map<string, SignalingCandidate>([['sig', { minerId: 'sig', load: 0n, region: '' }]]);
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot', { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }], // over ceiling -- ballot padding only
      ['cool', { attestedLoadPaths: 10, heartbeatFreshEpochs: 1 }], // best ratio -- chosen
      ['peerA', { attestedLoadPaths: 20, heartbeatFreshEpochs: 1 }], // eligible peer, fills the 3rd slot
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });

    handleEvent(escrow, relayState, signalingState, pendingRooms, logger, DEFAULT_WEIGHTS, baseTxContext(), new Map(), threeValidators(), attested);

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect(mockProbeCandidates).toHaveBeenCalledWith(expect.anything(), expect.anything(), ['cool', 'peerA', 'hot'], logger);
    const args = spy.mock.calls[0]!;
    expect((args[5] as string[])[0]).toBe('cool');
    spy.mockRestore();
  });

  it('retries against the remaining pool when the chosen relay probes dead, and submits the replacement', async () => {
    const spy = vi.spyOn(roomAssignment, 'submitProposal').mockResolvedValue(true);
    // 'cool' (chosen) + 'peerA'/'peerB' (eligible, fill the initial 3-slot active set) all probe
    // dead; 'warm' has headroom but was pushed past the MIN_RELAY=3 slice on the first pass, so
    // it's untouched by the dead first-round probe and becomes the retry's chosen relay.
    mockProbeCandidates.mockResolvedValue(new Set());

    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>([
      ['hot', candidate('hot', 5_000_000_000n)],
      ['cool', candidate('cool', 1_000_000_000n)],
      ['peerA', candidate('peerA', 500_000_000n)],
      ['peerB', candidate('peerB', 400_000_000n)],
      ['warm', candidate('warm', 300_000_000n)],
    ]);
    const signalingState = new Map<string, SignalingCandidate>([['sig', { minerId: 'sig', load: 0n, region: '' }]]);
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot', { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }],
      ['cool', { attestedLoadPaths: 10, heartbeatFreshEpochs: 1 }],
      ['peerA', { attestedLoadPaths: 20, heartbeatFreshEpochs: 1 }],
      ['peerB', { attestedLoadPaths: 25, heartbeatFreshEpochs: 1 }],
      ['warm', { attestedLoadPaths: 50, heartbeatFreshEpochs: 1 }],
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });

    handleEvent(escrow, relayState, signalingState, pendingRooms, logger, DEFAULT_WEIGHTS, baseTxContext(), new Map(), threeValidators(), attested);

    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    const args = spy.mock.calls[0]!;
    expect((args[5] as string[])[0]).toBe('warm');
    spy.mockRestore();
  });

  it('defers the assignment (no submit) when every candidate fails liveness + retry', async () => {
    const spy = vi.spyOn(roomAssignment, 'submitProposal').mockResolvedValue(true);
    mockProbeCandidates.mockResolvedValue(new Set());

    const logger = mockLogger();
    // Exactly 3 relays (the full pool == the active set): cool (chosen) + peerA (eligible) +
    // hot (over-capacity padding). Every one probes dead and there's nothing left outside the
    // active set for the retry's selectPlacementRelay to find — genuinely nothing survives.
    const relayState = new Map<string, NodeCandidate>([
      ['hot', candidate('hot', 5_000_000_000n)],
      ['cool', candidate('cool', 1_000_000_000n)],
      ['peerA', candidate('peerA', 500_000_000n)],
    ]);
    const signalingState = new Map<string, SignalingCandidate>([['sig', { minerId: 'sig', load: 0n, region: '' }]]);
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot', { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }],
      ['cool', { attestedLoadPaths: 10, heartbeatFreshEpochs: 1 }],
      ['peerA', { attestedLoadPaths: 20, heartbeatFreshEpochs: 1 }],
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });

    handleEvent(escrow, relayState, signalingState, pendingRooms, logger, DEFAULT_WEIGHTS, baseTxContext(), new Map(), threeValidators(), attested);

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room1' }),
      expect.stringContaining('No live relay candidate survived liveness probing'),
    ));
    expect(spy).not.toHaveBeenCalled();
    expect(pendingRooms.has('room1')).toBe(true);
    spy.mockRestore();
  });
});
