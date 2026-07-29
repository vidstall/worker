import { describe, it, expect, vi, beforeEach } from 'vitest';

const registerUserMock = vi.fn();
const createRoomMock = vi.fn();
const resolveRoomRelayUrlMock = vi.fn();

vi.mock('../chain.js', () => ({
  registerUser: registerUserMock,
  createRoom: createRoomMock,
  resolveRoomRelayUrl: resolveRoomRelayUrlMock,
  CREATE_ROOM_POLL_OPTS: { timeoutMs: 30_000, pollIntervalMs: 2_000 },
  JOIN_ROOM_POLL_OPTS: { timeoutMs: 10_000, pollIntervalMs: 1_000 },
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
    resolveRoomRelayUrlMock.mockReset();
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
