import { describe, it, expect, vi, beforeEach } from 'vitest';

const signAndAssertMock = vi.fn();
const extractRoomIdMock = vi.fn();

vi.mock('@dvconf/shared', () => ({
  signAndAssert: signAndAssertMock,
  extractRoomId: extractRoomIdMock,
}));

// Import after the mock so chain.ts picks up the mocked module.
const { registerAndCreateRoom } = await import('../chain.js');

function fakeLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn() };
}

const fakeConfig = {
  packageId: '0xpkg',
  networkRegistryId: '0xnet',
  userRegistryId: '0xuser',
  roomManagerId: '0xroom',
} as never;

describe('registerAndCreateRoom', () => {
  beforeEach(() => {
    signAndAssertMock.mockReset();
    extractRoomIdMock.mockReset();
  });

  it('calls register_user then create_room, and returns the extracted room id', async () => {
    signAndAssertMock.mockResolvedValueOnce({ digest: 'tx1' }).mockResolvedValueOnce({ digest: 'tx2' });
    extractRoomIdMock.mockReturnValueOnce('0xnewroom');

    const result = await registerAndCreateRoom(
      {} as never,
      {} as never,
      fakeConfig,
      { expectedParticipants: 4 },
      fakeLogger() as never,
    );

    expect(result).toEqual({ roomId: '0xnewroom' });
    expect(signAndAssertMock).toHaveBeenCalledTimes(2);
    expect(signAndAssertMock.mock.calls[0]?.[3]).toBe('register_user');
    expect(signAndAssertMock.mock.calls[1]?.[3]).toBe('create_room');
    expect(extractRoomIdMock).toHaveBeenCalledWith({ digest: 'tx2' });
  });

  it('swallows an E_ALREADY_REGISTERED (540) error from register_user and proceeds to create_room', async () => {
    signAndAssertMock
      .mockRejectedValueOnce(new Error('MoveAbort ... 540 ...'))
      .mockResolvedValueOnce({ digest: 'tx2' });
    extractRoomIdMock.mockReturnValueOnce('0xnewroom');

    const result = await registerAndCreateRoom(
      {} as never,
      {} as never,
      fakeConfig,
      { expectedParticipants: 4 },
      fakeLogger() as never,
    );

    expect(result).toEqual({ roomId: '0xnewroom' });
    expect(signAndAssertMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows a register_user error that is not the 540 already-registered code', async () => {
    signAndAssertMock.mockRejectedValueOnce(new Error('some other chain failure'));

    await expect(
      registerAndCreateRoom({} as never, {} as never, fakeConfig, { expectedParticipants: 4 }, fakeLogger() as never),
    ).rejects.toThrow('some other chain failure');
    expect(signAndAssertMock).toHaveBeenCalledTimes(1);
  });

  it('never calls assign_relay_and_signaling (cp-daemon handles assignment automatically)', async () => {
    signAndAssertMock.mockResolvedValueOnce({ digest: 'tx1' }).mockResolvedValueOnce({ digest: 'tx2' });
    extractRoomIdMock.mockReturnValueOnce('0xnewroom');

    await registerAndCreateRoom({} as never, {} as never, fakeConfig, { expectedParticipants: 4 }, fakeLogger() as never);

    for (const call of signAndAssertMock.mock.calls) {
      const label = call[3] as string;
      expect(label).not.toBe('assign_relay_and_signaling');
    }
  });
});
