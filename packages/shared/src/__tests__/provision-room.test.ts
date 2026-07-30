import { describe, it, expect, vi } from 'vitest';
import { extractRoomId, createRoomWithRelay, type TxStatusLike } from '../chain/provision-room.js';
import type { NetworkConfig, Logger } from '../index.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

describe('extractRoomId', () => {
  it('reads room_id from a RoomCreated event', () => {
    const result: TxStatusLike = {
      digest: '0xabc',
      events: [{ type: '0x2::room_manager_events::RoomCreated', parsedJson: { room_id: '0x7c60b80e' } }],
    };
    expect(extractRoomId(result)).toBe('0x000000000000000000000000000000000000000000000000000000007c60b80e');
  });
  it('throws when RoomCreated is missing', () => {
    expect(() => extractRoomId({ digest: '0x0', events: [] })).toThrow('RoomCreated event missing');
  });
});

describe('createRoomWithRelay fundAddress injection', () => {
  it('funds the user address via the injected callback before any TX', async () => {
    const fundAddress = vi.fn().mockResolvedValue(undefined);
    const client = {
      signAndExecuteTransaction: vi.fn().mockResolvedValue({
        digest: '0xd', effects: { status: { status: 'success' } },
        events: [{ type: '0x2::room_manager_events::RoomCreated', parsedJson: { room_id: '0x1' } }],
        objectChanges: [],
      }),
      waitForTransaction: vi.fn().mockResolvedValue({}),
    } as unknown as Parameters<typeof createRoomWithRelay>[0];
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const config = { packageId: '0x2', networkRegistryId: '0x3', userRegistryId: '0x4', roomManagerId: '0x5' } as unknown as NetworkConfig;
    // Valid 32-byte Sui addresses (the real @mysten/sui BCS validates tx.pure.id/address; '0xcap'/'0xrelay' are rejected).
    const capId = '0x000000000000000000000000000000000000000000000000000000000000ca90';
    const relayId = '0x0000000000000000000000000000000000000000000000000000000000000e1a';
    await createRoomWithRelay(client, new Ed25519Keypair(), new Ed25519Keypair(), capId, relayId, config, logger, fundAddress);
    expect(fundAddress).toHaveBeenCalledTimes(1);
  });
});
