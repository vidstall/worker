import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerUserMock = vi.fn();
const createRoomMock = vi.fn();
const createEscrowMock = vi.fn();
const resolveRoomRelayUrlMock = vi.fn();
const getStandbyRelayUrlsMock = vi.fn();

vi.mock('../chain.js', () => ({
  registerUser: registerUserMock,
  createRoom: createRoomMock,
  createEscrow: createEscrowMock,
  resolveRoomRelayUrl: resolveRoomRelayUrlMock,
  getStandbyRelayUrls: getStandbyRelayUrlsMock,
  CREATE_ROOM_POLL_OPTS: { timeoutMs: 30_000, pollIntervalMs: 2_000 },
  JOIN_ROOM_POLL_OPTS: { timeoutMs: 10_000, pollIntervalMs: 1_000 },
}));

const flapGateCheckMock = vi.fn();
vi.mock('../standby-flap-gate.js', () => ({
  createStandbyFlapGate: vi.fn().mockImplementation(() => ({ check: flapGateCheckMock })),
  wsToProbeUrl: vi.fn((url: string) => url.replace(/^ws/, 'http')),
}));

const connectMock = vi.fn();
const produceVideoMock = vi.fn();
const produceAudioMock = vi.fn();
const closeMock = vi.fn();

vi.mock('../bot-peer.js', () => ({
  BotPeer: vi.fn().mockImplementation(() => ({
    connect: connectMock,
    produceVideo: produceVideoMock,
    produceAudio: produceAudioMock,
    close: closeMock,
  })),
}));

// Imported AFTER the mock so this is the same mock constructor `startBotSession`
// uses internally — lets tests inspect each construction's opts (e.g. to grab
// onRelayClosed and simulate a WS close, or assert the standby peer's relayUrl).
const { BotPeer } = await import('../bot-peer.js');
const botPeerMock = vi.mocked(BotPeer);

const probeVideoDimensionsMock = vi.fn();
const startVideoSourceMock = vi.fn();
const startAudioSourceMock = vi.fn();

vi.mock('../media/ffmpeg-source.js', () => ({
  probeVideoDimensions: probeVideoDimensionsMock,
  startVideoSource: startVideoSourceMock,
  startAudioSource: startAudioSourceMock,
}));

const loadWrtcNonstandardMock = vi.fn();

vi.mock('@dvconf/shared', () => ({
  loadWrtcNonstandard: loadWrtcNonstandardMock,
}));

const { startBotSession } = await import('../session.js');

function fakeLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const fakeBotConfig = {
  mp4Path: '/default.mp4',
  roomPassword: '123',
  expectedParticipants: 4,
  clientUrl: 'http://localhost:5173',
  port: 8095,
  controlToken: '',
  metricsPort: 8096,
  wsHeartbeatIntervalMs: 30000,
};

function baseDeps() {
  return {
    client: {} as never,
    signer: {} as never,
    networkConfig: {} as never,
    botConfig: fakeBotConfig,
    logger: fakeLogger() as never,
  };
}

describe('startBotSession', () => {
  beforeEach(() => {
    registerUserMock.mockReset().mockResolvedValue(undefined);
    createRoomMock.mockReset();
    createEscrowMock.mockReset().mockResolvedValue(undefined);
    resolveRoomRelayUrlMock.mockReset();
    getStandbyRelayUrlsMock.mockReset();
    flapGateCheckMock.mockReset().mockResolvedValue(true);
    botPeerMock.mockClear();
    connectMock.mockReset().mockResolvedValue(undefined);
    produceVideoMock.mockReset().mockResolvedValue(undefined);
    produceAudioMock.mockReset().mockResolvedValue(undefined);
    closeMock.mockReset();
    probeVideoDimensionsMock.mockReset().mockResolvedValue({ width: 640, height: 480, fps: 30 });
    startVideoSourceMock.mockReset().mockReturnValue(vi.fn());
    startAudioSourceMock.mockReset().mockReturnValue(vi.fn());
    loadWrtcNonstandardMock.mockReset().mockResolvedValue({
      RTCVideoSource: vi.fn().mockImplementation(() => ({ createTrack: vi.fn(() => 'video-track') })),
      RTCAudioSource: vi.fn().mockImplementation(() => ({ createTrack: vi.fn(() => 'audio-track') })),
    });
  });

  it('roomMode=create: registers, creates a room, resolves relay, and connects', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xnewroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay-a.example');

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'listen' }, baseDeps());

    expect(registerUserMock).toHaveBeenCalledTimes(1);
    expect(createRoomMock).toHaveBeenCalledTimes(1);
    expect(resolveRoomRelayUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '0xnewroom',
      expect.anything(),
      { timeoutMs: 30_000, pollIntervalMs: 2_000 },
    );
    expect(session.roomId).toBe('0xnewroom');
    expect(session.joinUrl).toBe('http://localhost:5173/rooms/0xnewroom?pw=123');
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it('roomMode=join: requires roomId and skips create_room', async () => {
    await expect(startBotSession({ roomMode: 'join', mediaMode: 'listen' }, baseDeps())).rejects.toThrow(
      /roomId is required/,
    );
    expect(createRoomMock).not.toHaveBeenCalled();
  });

  it('roomMode=join: resolves the existing room assignment directly', async () => {
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay-b.example');

    const session = await startBotSession(
      { roomMode: 'join', roomId: '0xexisting', mediaMode: 'listen' },
      baseDeps(),
    );

    expect(createRoomMock).not.toHaveBeenCalled();
    expect(resolveRoomRelayUrlMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '0xexisting',
      expect.anything(),
      { timeoutMs: 10_000, pollIntervalMs: 1_000 },
    );
    expect(session.roomId).toBe('0xexisting');
  });

  it('mediaMode=listen: produces neither video nor audio, no ffmpeg spawned', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay.example');

    await startBotSession({ roomMode: 'create', mediaMode: 'listen' }, baseDeps());

    expect(produceVideoMock).not.toHaveBeenCalled();
    expect(produceAudioMock).not.toHaveBeenCalled();
    expect(startVideoSourceMock).not.toHaveBeenCalled();
    expect(startAudioSourceMock).not.toHaveBeenCalled();
    expect(loadWrtcNonstandardMock).not.toHaveBeenCalled();
  });

  it('mediaMode=camera: produces only video', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay.example');

    await startBotSession({ roomMode: 'create', mediaMode: 'camera' }, baseDeps());

    expect(produceVideoMock).toHaveBeenCalledTimes(1);
    expect(produceAudioMock).not.toHaveBeenCalled();
    expect(startVideoSourceMock).toHaveBeenCalledTimes(1);
    expect(startAudioSourceMock).not.toHaveBeenCalled();
  });

  it('mediaMode=mic: produces only audio', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay.example');

    await startBotSession({ roomMode: 'create', mediaMode: 'mic' }, baseDeps());

    expect(produceAudioMock).toHaveBeenCalledTimes(1);
    expect(produceVideoMock).not.toHaveBeenCalled();
    expect(startAudioSourceMock).toHaveBeenCalledTimes(1);
    expect(startVideoSourceMock).not.toHaveBeenCalled();
  });

  it('mediaMode=both: produces video and audio', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay.example');

    await startBotSession({ roomMode: 'create', mediaMode: 'both' }, baseDeps());

    expect(produceVideoMock).toHaveBeenCalledTimes(1);
    expect(produceAudioMock).toHaveBeenCalledTimes(1);
  });

  it('stop() calls ffmpeg stop functions and peer.close()', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay.example');
    const stopVideo = vi.fn();
    const stopAudio = vi.fn();
    startVideoSourceMock.mockReturnValueOnce(stopVideo);
    startAudioSourceMock.mockReturnValueOnce(stopAudio);

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'both' }, baseDeps());
    session.stop();

    expect(stopVideo).toHaveBeenCalledTimes(1);
    expect(stopAudio).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);

    // stop() is idempotent
    session.stop();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('uses opts.mp4Path override over the botConfig default when producing video', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    resolveRoomRelayUrlMock.mockResolvedValueOnce('wss://relay.example');

    await startBotSession({ roomMode: 'create', mediaMode: 'camera', mp4Path: '/custom.mp4' }, baseDeps());

    expect(probeVideoDimensionsMock).toHaveBeenCalledWith('/custom.mp4');
  });
});

describe('startBotSession — standby cutover on relay death', () => {
  beforeEach(() => {
    registerUserMock.mockReset().mockResolvedValue(undefined);
    createRoomMock.mockReset();
    createEscrowMock.mockReset().mockResolvedValue(undefined);
    resolveRoomRelayUrlMock.mockReset().mockResolvedValue('wss://primary.example:4000');
    getStandbyRelayUrlsMock.mockReset();
    flapGateCheckMock.mockReset().mockResolvedValue(true);
    botPeerMock.mockClear();
    connectMock.mockReset().mockResolvedValue(undefined);
    produceVideoMock.mockReset().mockResolvedValue(undefined);
    produceAudioMock.mockReset().mockResolvedValue(undefined);
    closeMock.mockReset();
    probeVideoDimensionsMock.mockReset().mockResolvedValue({ width: 640, height: 480, fps: 30 });
    startVideoSourceMock.mockReset().mockReturnValue(vi.fn());
    startAudioSourceMock.mockReset().mockReturnValue(vi.fn());
    loadWrtcNonstandardMock.mockReset().mockResolvedValue({
      RTCVideoSource: vi.fn().mockImplementation(() => ({ createTrack: vi.fn(() => 'video-track') })),
      RTCAudioSource: vi.fn().mockImplementation(() => ({ createTrack: vi.fn(() => 'audio-track') })),
    });
  });

  it('cuts over to the standby relay when the primary dies and the standby is healthy', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    getStandbyRelayUrlsMock.mockResolvedValueOnce(['wss://standby.example:4000']);

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'camera' }, baseDeps());
    expect(session.isDegraded()).toBe(false);
    expect(botPeerMock).toHaveBeenCalledTimes(1);

    // Simulate the primary relay's WS closing.
    const onRelayClosed = botPeerMock.mock.calls[0]![0].onRelayClosed!;
    onRelayClosed();

    await vi.waitFor(() => expect(botPeerMock).toHaveBeenCalledTimes(2));
    expect(botPeerMock.mock.calls[1]![0].relayUrl).toBe('wss://standby.example:4000');
    await vi.waitFor(() => expect(closeMock).toHaveBeenCalledTimes(1)); // old peer torn down
    expect(produceVideoMock).toHaveBeenCalledTimes(2); // once at startup, once post-cutover
    expect(session.isDegraded()).toBe(false);
  });

  it('falls through to standby 2 when standby 1 is unhealthy (not just retrying the same dead relay)', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    getStandbyRelayUrlsMock.mockResolvedValueOnce(['wss://standby-1.example:4000', 'wss://standby-2.example:4000']);
    flapGateCheckMock.mockReset().mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'camera' }, baseDeps());
    expect(botPeerMock).toHaveBeenCalledTimes(1);

    const onRelayClosed = botPeerMock.mock.calls[0]![0].onRelayClosed!;
    onRelayClosed();

    await vi.waitFor(() => expect(botPeerMock).toHaveBeenCalledTimes(2));
    expect(botPeerMock.mock.calls[1]![0].relayUrl).toBe('wss://standby-2.example:4000');
    expect(flapGateCheckMock).toHaveBeenCalledTimes(2); // standby 1 probed (failed), then standby 2 (succeeded)
    expect(session.isDegraded()).toBe(false);
  });

  it('marks the session degraded (no second BotPeer) when no standby is assigned', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    getStandbyRelayUrlsMock.mockResolvedValueOnce([]);

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'listen' }, baseDeps());
    const onRelayClosed = botPeerMock.mock.calls[0]![0].onRelayClosed!;
    onRelayClosed();

    await vi.waitFor(() => expect(session.isDegraded()).toBe(true));
    expect(botPeerMock).toHaveBeenCalledTimes(1);
  });

  it('marks the session degraded (no cutover) when the standby flap-gate reports unhealthy', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });
    getStandbyRelayUrlsMock.mockResolvedValueOnce(['wss://standby.example:4000']);
    flapGateCheckMock.mockResolvedValueOnce(false);

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'listen' }, baseDeps());
    const onRelayClosed = botPeerMock.mock.calls[0]![0].onRelayClosed!;
    onRelayClosed();

    await vi.waitFor(() => expect(session.isDegraded()).toBe(true));
    expect(botPeerMock).toHaveBeenCalledTimes(1);
  });

  it('a user-initiated stop() does not trigger a bogus cutover when its own WS close fires afterward', async () => {
    createRoomMock.mockResolvedValueOnce({ roomId: '0xroom' });

    const session = await startBotSession({ roomMode: 'create', mediaMode: 'listen' }, baseDeps());
    session.stop();

    // Simulate the ws's own 'close' event firing as a RESULT of stop()'s peer.close().
    const onRelayClosed = botPeerMock.mock.calls[0]![0].onRelayClosed!;
    onRelayClosed();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(getStandbyRelayUrlsMock).not.toHaveBeenCalled();
    expect(botPeerMock).toHaveBeenCalledTimes(1);
    expect(session.isDegraded()).toBe(false);
  });
});
