/**
 * `handleDisconnect`'s stats-window cleanup — a peer's cached client-reported
 * quality stats (PeerStatsWindow) must be cleared on disconnect, the same way
 * `metrics.clearSession(roomId, peerId)` already is, so a disconnected peer's
 * last values don't keep showing up in every future scrape/scenario snapshot.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { handleDisconnect, handleConnection } from '../signaling/lifecycle-handler.js';
import { createSignalingServerState } from '../signaling/state.js';
import { MetricsTracker } from '../metrics.js';
import { PeerStatsWindow, type PeerQualitySample } from '../stats-window.js';
import type { RoomState, PeerState } from '../room-handler.js';

const logger = createLogger('test:lifecycle-handler');

function sample(): PeerQualitySample {
  return {
    latencyMs: 10,
    packetLoss: 0,
    jitterMs: 1,
    bitrateUpKbps: 100,
    bitrateDownKbps: 200,
    resolutionWidth: 640,
    resolutionHeight: 480,
    framerate: 30,
    packetReorderingRate: 0,
    encodeLatencyMs: 1,
    decodeLatencyMs: 1,
    freezeCount: 0,
    pauseCount: 0,
    connectionSetupMs: 100,
    iceSuccess: true,
    reconnectMs: 0,
    avSyncDriftMs: 0,
  };
}

function fakePeer(peerId: string): PeerState {
  return {
    peerId,
    ws: { readyState: WebSocket.CLOSED, send: vi.fn() } as unknown as PeerState['ws'],
    sendTransport: null,
    recvTransport: null,
    producers: [],
    consumers: [],
    samplerStops: new Map(),
  };
}

function fakeRoom(roomId: string, peerIds: string[]): RoomState {
  const peers = new Map<string, PeerState>();
  for (const id of peerIds) peers.set(id, fakePeer(id));
  return {
    roomId,
    router: { close: vi.fn() } as unknown as RoomState['router'],
    mode: 'sfu',
    peers,
  } as unknown as RoomState;
}

describe('handleDisconnect + PeerStatsWindow cleanup', () => {
  it('clears the disconnecting peer\'s cached stats when a statsWindow is provided', async () => {
    const state = createSignalingServerState();
    const room = fakeRoom('room-1', ['peer-a', 'peer-b']);
    state.rooms.set('room-1', room);
    const ws = {} as WebSocket;
    state.wsToRoom.set(ws, { roomId: 'room-1', peerId: 'peer-a' });

    const statsWindow = new PeerStatsWindow();
    statsWindow.push('room-1', 'peer-a', sample());
    expect(statsWindow.current('peer-a')).toBeDefined();

    const metrics = new MetricsTracker();
    await handleDisconnect(state, ws, metrics, undefined, logger, statsWindow);

    expect(statsWindow.current('peer-a')).toBeUndefined();
  });

  it('leaves other peers\' cached stats untouched', async () => {
    const state = createSignalingServerState();
    const room = fakeRoom('room-1', ['peer-a', 'peer-b']);
    state.rooms.set('room-1', room);
    const ws = {} as WebSocket;
    state.wsToRoom.set(ws, { roomId: 'room-1', peerId: 'peer-a' });

    const statsWindow = new PeerStatsWindow();
    statsWindow.push('room-1', 'peer-a', sample());
    statsWindow.push('room-1', 'peer-b', sample());

    const metrics = new MetricsTracker();
    await handleDisconnect(state, ws, metrics, undefined, logger, statsWindow);

    expect(statsWindow.current('peer-a')).toBeUndefined();
    expect(statsWindow.current('peer-b')).toBeDefined();
  });

  it('is a no-op (no throw) when no statsWindow is provided, matching prior behavior', async () => {
    const state = createSignalingServerState();
    const room = fakeRoom('room-1', ['peer-a']);
    state.rooms.set('room-1', room);
    const ws = {} as WebSocket;
    state.wsToRoom.set(ws, { roomId: 'room-1', peerId: 'peer-a' });

    const metrics = new MetricsTracker();
    await expect(handleDisconnect(state, ws, metrics, undefined, logger)).resolves.toBeUndefined();
  });
});

describe('handleConnection — pong wiring', () => {
  /** Minimal EventEmitter-based fake `ws` -- handleConnection registers real
   *  `.on('message'|'close'|'error'|'pong', ...)` listeners, so a bare
   *  `{} as WebSocket` cast (used elsewhere in this file for handleDisconnect-
   *  only tests) can't exercise this path; a real emitter can. */
  function fakeConnectingWs(): WebSocket {
    return new EventEmitter() as unknown as WebSocket;
  }

  it('calls markAlive(ws) exactly once when the socket emits pong', () => {
    const state = createSignalingServerState();
    const ws = fakeConnectingWs();
    const req = { headers: {} } as IncomingMessage;
    const metrics = new MetricsTracker();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const markAlive = vi.fn();

    handleConnection(state, ws, req, '', metrics, undefined, dispatch, logger, markAlive);
    (ws as unknown as EventEmitter).emit('pong');

    expect(markAlive).toHaveBeenCalledOnce();
    expect(markAlive).toHaveBeenCalledWith(ws);
  });

  it('does not call markAlive before a pong is received', () => {
    const state = createSignalingServerState();
    const ws = fakeConnectingWs();
    const req = { headers: {} } as IncomingMessage;
    const metrics = new MetricsTracker();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const markAlive = vi.fn();

    handleConnection(state, ws, req, '', metrics, undefined, dispatch, logger, markAlive);

    expect(markAlive).not.toHaveBeenCalled();
  });
});
