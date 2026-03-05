/**
 * Type compilation check — verifies all event interfaces are correctly defined
 * and can be instantiated with valid data.
 */

import { describe, it, expect } from 'vitest';
import type {
  MinerRegistered,
  MinerUnregistered,
  RoleChanged,
  CPRegistered,
  CPHeartbeat,
  CPAssignedToRoom,
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  ValidatorRegistered,
  SessionWalletAssigned,
  SessionWalletRevealed,
  RoomCreated,
  RoomClosed,
  RoomRulesUpdated,
  UserRegistered,
  UserProfileUpdated,
} from '../types/events.js';
import { RelayMode, MinerRole, ErrorCodes } from '../types/constants.js';
import type { NetworkConfig, TxResult, SuiObjectRef } from '../types/chain.js';

describe('Event types compile and conform to Move structs', () => {
  it('MinerRegistered matches registration::MinerRegistered', () => {
    const event: MinerRegistered = {
      miner_id: '0xabc',
      owner: '0xdef',
      role: 0,
      stake_amount: '1000000000',
    };
    expect(event.miner_id).toBe('0xabc');
    expect(typeof event.role).toBe('number');
    expect(typeof event.stake_amount).toBe('string');
  });

  it('MinerUnregistered', () => {
    const event: MinerUnregistered = { miner_id: '0x1', owner: '0x2' };
    expect(event.miner_id).toBeTruthy();
  });

  it('RoleChanged', () => {
    const event: RoleChanged = {
      miner_id: '0x1',
      old_role: 0,
      new_role: 3,
      new_stake: '2000000000',
    };
    expect(event.new_role).toBe(3);
  });

  it('CPRegistered', () => {
    const event: CPRegistered = {
      miner_id: '0x1',
      operator: '0x2',
      stake_amount: '2000000000',
    };
    expect(event.operator).toBeTruthy();
  });

  it('CPHeartbeat', () => {
    const event: CPHeartbeat = { miner_id: '0x1', epoch: '42' };
    expect(typeof event.epoch).toBe('string');
  });

  it('CPAssignedToRoom', () => {
    const event: CPAssignedToRoom = { miner_id: '0x1', room_id: '0xroom' };
    expect(event.room_id).toBeTruthy();
  });

  it('RelayRegistered', () => {
    const event: RelayRegistered = {
      miner_id: '0x1',
      operator: '0x2',
      mode: RelayMode.SFU,
      region: [117, 115], // "us" as bytes
      stake_amount: '1000000000',
    };
    expect(event.mode).toBe(0);
    expect(Array.isArray(event.region)).toBe(true);
  });

  it('RelayLoadUpdated', () => {
    const event: RelayLoadUpdated = { miner_id: '0x1', new_load: '5' };
    expect(typeof event.new_load).toBe('string');
  });

  it('RelayRTTUpdated', () => {
    const event: RelayRTTUpdated = { miner_id: '0x1', rtt: '45' };
    expect(typeof event.rtt).toBe('string');
  });

  it('ValidatorRegistered', () => {
    const event: ValidatorRegistered = {
      miner_id: '0x1',
      operator: '0x2',
      stake_amount: '500000000',
    };
    expect(event.stake_amount).toBeTruthy();
  });

  it('SessionWalletAssigned', () => {
    const event: SessionWalletAssigned = { session_wallet: '0xsession' };
    expect(typeof event.session_wallet).toBe('string');
  });

  it('SessionWalletRevealed', () => {
    const event: SessionWalletRevealed = {
      miner_id: '0x1',
      session_wallet: '0xsession',
    };
    expect(event.miner_id).toBeTruthy();
  });

  it('RoomCreated', () => {
    const event: RoomCreated = {
      room_id: '0xroom',
      creator: '0xcreator',
      relay_mode: RelayMode.MCU,
    };
    expect(event.relay_mode).toBe(1);
  });

  it('RoomClosed', () => {
    const event: RoomClosed = {
      room_id: '0xroom',
      closed_by: '0xuser',
      epoch: '100',
    };
    expect(typeof event.epoch).toBe('string');
  });

  it('RoomRulesUpdated', () => {
    const event: RoomRulesUpdated = {
      min_relay: '2',
      min_cp: '1',
      min_validator: '1',
    };
    expect(event.min_relay).toBe('2');
  });

  it('UserRegistered', () => {
    const event: UserRegistered = {
      user: '0xuser',
      display_name: [65, 108, 105, 99, 101], // "Alice"
    };
    expect(Array.isArray(event.display_name)).toBe(true);
  });

  it('UserProfileUpdated', () => {
    const event: UserProfileUpdated = {
      user: '0xuser',
      display_name: [66, 111, 98],
    };
    expect(event.display_name).toHaveLength(3);
  });
});

describe('Constants match on-chain values', () => {
  it('RelayMode enum', () => {
    expect(RelayMode.SFU).toBe(0);
    expect(RelayMode.MCU).toBe(1);
  });

  it('MinerRole enum', () => {
    expect(MinerRole.User).toBe(0);
    expect(MinerRole.Validator).toBe(1);
    expect(MinerRole.Relay).toBe(2);
    expect(MinerRole.CP).toBe(3);
  });

  it('Error code namespaces', () => {
    expect(ErrorCodes.registration.E_PAUSED).toBe(403);
    expect(ErrorCodes.roomManager.E_NOT_FOUND).toBe(502);
    expect(ErrorCodes.controlPlaneRegistry.E_NOT_CP).toBe(510);
    expect(ErrorCodes.relayRegistry.E_NOT_RELAY).toBe(520);
    expect(ErrorCodes.validatorRegistry.E_NOT_VALIDATOR).toBe(530);
    expect(ErrorCodes.userRegistry.E_ALREADY_REGISTERED).toBe(540);
  });
});

describe('Chain types compile correctly', () => {
  it('NetworkConfig', () => {
    const config: NetworkConfig = {
      rpcUrl: 'http://127.0.0.1:9000',
      packageId: '0xpkg',
      networkRegistryId: '0x1',
      minerStoreId: '0x2',
      cpRegistryId: '0x3',
      relayRegistryId: '0x4',
      validatorRegistryId: '0x5',
      userRegistryId: '0x6',
      roomManagerId: '0x7',
    };
    expect(config.packageId).toBe('0xpkg');
  });

  it('TxResult', () => {
    const result: TxResult = {
      digest: 'abc123',
      effects: { status: { status: 'success' } },
      events: [{ type: 'test', parsedJson: {} }],
    };
    expect(result.digest).toBeTruthy();
  });

  it('SuiObjectRef', () => {
    const ref: SuiObjectRef = {
      objectId: '0x1',
      version: '1',
      digest: 'abc',
    };
    expect(ref.objectId).toBeTruthy();
  });
});
