import { describe, it, expect, vi, beforeEach } from 'vitest';

const signAndAssertMock = vi.fn();
const extractRoomIdMock = vi.fn();

vi.mock('@dvconf/shared', () => ({
  signAndAssert: signAndAssertMock,
  extractRoomId: extractRoomIdMock,
}));

// Import after the mock so chain.ts picks up the mocked module.
const { registerAndCreateRoom, registerUser, createRoom, getAssignedRelayIds, getActiveRelays, resolveRoomRelayUrl } =
  await import('../chain.js');

function fakeLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

const fakeConfig = {
  packageId: '0xpkg',
  networkRegistryId: '0xnet',
  userRegistryId: '0xuser',
  roomManagerId: '0xroom',
  relayRegistryId: '0xrelayreg',
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

describe('registerUser (standalone)', () => {
  beforeEach(() => {
    signAndAssertMock.mockReset();
  });

  it('calls register_user exactly once and does not touch create_room', async () => {
    signAndAssertMock.mockResolvedValueOnce({ digest: 'tx1' });
    await registerUser({} as never, {} as never, fakeConfig, fakeLogger() as never);
    expect(signAndAssertMock).toHaveBeenCalledTimes(1);
    expect(signAndAssertMock.mock.calls[0]?.[3]).toBe('register_user');
  });
});

describe('createRoom (standalone)', () => {
  beforeEach(() => {
    signAndAssertMock.mockReset();
    extractRoomIdMock.mockReset();
  });

  it('calls create_room and returns the extracted room id', async () => {
    signAndAssertMock.mockResolvedValueOnce({ digest: 'tx2' });
    extractRoomIdMock.mockReturnValueOnce('0xnewroom');
    const result = await createRoom({} as never, {} as never, fakeConfig, { expectedParticipants: 4 }, fakeLogger() as never);
    expect(result).toEqual({ roomId: '0xnewroom' });
    expect(signAndAssertMock.mock.calls[0]?.[3]).toBe('create_room');
  });
});

// ── Relay-assignment resolution (BCS decode via a mocked SuiClient) ─────────

/** Encode a `vector<ID>` (32-byte addresses) the way `bcs.vector(bcs.Address)` would. */
function encodeIdVector(ids: string[]): number[] {
  const out: number[] = [ids.length];
  for (const id of ids) {
    const hex = id.replace(/^0x/, '').padStart(64, '0');
    for (let i = 0; i < hex.length; i += 2) {
      out.push(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  return out;
}

/** Encode a `vector<u8>` (ULEB128 length prefix, single-byte for short vectors). */
function encodeByteVector(bytes: number[]): number[] {
  return [bytes.length, ...bytes];
}

function encodeU64(n: number): number[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return Array.from(buf);
}

function encodeAddress(id: string): number[] {
  const hex = id.replace(/^0x/, '').padStart(64, '0');
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

const RELAY_ID = `0x${'a'.repeat(64)}`;
const OTHER_RELAY_ID = `0x${'b'.repeat(64)}`;
const ROOM_ID = `0x${'c'.repeat(64)}`;

/** Encode one RelayNodeInfo entry matching chain.ts's RelayNodeInfoBcs field order. */
function encodeRelayNodeInfo(minerId: string, endpointUrl: string): number[] {
  const url = Array.from(new TextEncoder().encode(endpointUrl));
  return [
    ...encodeAddress(RELAY_ID), // operator (unused, arbitrary)
    ...encodeAddress(minerId), // miner_id
    ...encodeU64(1000), // stake_amount
    ...encodeU64(50), // reputation
    ...encodeU64(0), // registered_at
    ...encodeU64(0), // last_heartbeat
    ...encodeByteVector([]), // region
    ...encodeByteVector(url), // endpoint_url
  ];
}

function encodeRelayNodeInfoVector(entries: number[][]): number[] {
  return [entries.length, ...entries.flat()];
}

function makeClient(devInspectImpl: (tx: unknown) => { error?: string | null; results?: unknown }) {
  return {
    devInspectTransactionBlock: vi.fn(async ({ transactionBlock }: { transactionBlock: unknown }) =>
      devInspectImpl(transactionBlock),
    ),
  };
}

describe('getAssignedRelayIds', () => {
  it('decodes a non-empty assigned_relays vector', async () => {
    const bytes = encodeIdVector([RELAY_ID]);
    const client = makeClient(() => ({
      results: [{ returnValues: [[bytes, 'vector<u8>']] }],
    }));
    const ids = await getAssignedRelayIds(client as never, fakeConfig, ROOM_ID, fakeLogger() as never);
    expect(ids).toHaveLength(1);
    expect(ids[0]?.toLowerCase()).toBe(RELAY_ID.toLowerCase());
  });

  it('returns [] when assigned_relays is empty', async () => {
    const bytes = encodeIdVector([]);
    const client = makeClient(() => ({
      results: [{ returnValues: [[bytes, 'vector<u8>']] }],
    }));
    const ids = await getAssignedRelayIds(client as never, fakeConfig, ROOM_ID, fakeLogger() as never);
    expect(ids).toEqual([]);
  });

  it('returns [] (tolerant) when devInspect errors', async () => {
    const client = makeClient(() => ({ error: 'room not found' }));
    const ids = await getAssignedRelayIds(client as never, fakeConfig, ROOM_ID, fakeLogger() as never);
    expect(ids).toEqual([]);
  });

  it('returns [] (tolerant) when the client throws', async () => {
    const client = {
      devInspectTransactionBlock: vi.fn(async () => {
        throw new Error('rpc down');
      }),
    };
    const ids = await getAssignedRelayIds(client as never, fakeConfig, ROOM_ID, fakeLogger() as never);
    expect(ids).toEqual([]);
  });
});

describe('getActiveRelays', () => {
  it('decodes miner_id + endpoint_url for each active relay', async () => {
    const bytes = encodeRelayNodeInfoVector([encodeRelayNodeInfo(RELAY_ID, 'wss://relay-a.example')]);
    const client = makeClient(() => ({
      results: [{ returnValues: [[bytes, 'vector<u8>']] }],
    }));
    const relays = await getActiveRelays(client as never, fakeConfig, fakeLogger() as never);
    expect(relays).toHaveLength(1);
    expect(relays[0]?.minerId.toLowerCase()).toBe(RELAY_ID.toLowerCase());
    expect(relays[0]?.endpointUrl).toBe('wss://relay-a.example');
  });

  it('throws a clear error when devInspect errors', async () => {
    const client = makeClient(() => ({ error: 'boom' }));
    await expect(getActiveRelays(client as never, fakeConfig, fakeLogger() as never)).rejects.toThrow(/boom/);
  });
});

describe('resolveRoomRelayUrl', () => {
  it('resolves immediately when the room is already assigned', async () => {
    const assignBytes = encodeIdVector([RELAY_ID]);
    const relayBytes = encodeRelayNodeInfoVector([encodeRelayNodeInfo(RELAY_ID, 'wss://relay-a.example')]);
    let call = 0;
    const client = makeClient(() => {
      call += 1;
      if (call === 1) return { results: [{ returnValues: [[assignBytes, 'vector<u8>']] }] };
      return { results: [{ returnValues: [[relayBytes, 'vector<u8>']] }] };
    });
    const url = await resolveRoomRelayUrl(client as never, fakeConfig, ROOM_ID, fakeLogger() as never, {
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    });
    expect(url).toBe('wss://relay-a.example');
  });

  it('polls until assigned_relays becomes non-empty, then resolves', async () => {
    const emptyBytes = encodeIdVector([]);
    const assignBytes = encodeIdVector([RELAY_ID]);
    const relayBytes = encodeRelayNodeInfoVector([encodeRelayNodeInfo(RELAY_ID, 'wss://relay-a.example')]);
    let assignmentCalls = 0;
    // Sequence: assignment empty twice (still polling), then non-empty, then the relay list.
    let n = 0;
    const client = {
      devInspectTransactionBlock: vi.fn(async () => {
        n += 1;
        if (n <= 2) return { results: [{ returnValues: [[emptyBytes, 'vector<u8>']] }] };
        if (n === 3) return { results: [{ returnValues: [[assignBytes, 'vector<u8>']] }] };
        assignmentCalls += 1;
        return { results: [{ returnValues: [[relayBytes, 'vector<u8>']] }] };
      }),
    };

    const url = await resolveRoomRelayUrl(client as never, fakeConfig, ROOM_ID, fakeLogger() as never, {
      timeoutMs: 5_000,
      pollIntervalMs: 5,
    });
    expect(url).toBe('wss://relay-a.example');
    expect(assignmentCalls).toBeGreaterThan(0);
  });

  it('throws a clear timeout error when never assigned', async () => {
    const emptyBytes = encodeIdVector([]);
    const client = makeClient(() => ({ results: [{ returnValues: [[emptyBytes, 'vector<u8>']] }] }));
    await expect(
      resolveRoomRelayUrl(client as never, fakeConfig, ROOM_ID, fakeLogger() as never, {
        timeoutMs: 20,
        pollIntervalMs: 5,
      }),
    ).rejects.toThrow(/not assigned a relay/);
  });

  it('throws a clear error when the assigned relay is missing from the active-relay set', async () => {
    const assignBytes = encodeIdVector([OTHER_RELAY_ID]);
    const relayBytes = encodeRelayNodeInfoVector([encodeRelayNodeInfo(RELAY_ID, 'wss://relay-a.example')]);
    let call = 0;
    const client = makeClient(() => {
      call += 1;
      if (call === 1) return { results: [{ returnValues: [[assignBytes, 'vector<u8>']] }] };
      return { results: [{ returnValues: [[relayBytes, 'vector<u8>']] }] };
    });
    await expect(
      resolveRoomRelayUrl(client as never, fakeConfig, ROOM_ID, fakeLogger() as never, {
        timeoutMs: 5_000,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/was not found in relay_registry/);
  });
});
