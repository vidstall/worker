import { useState, useCallback, useRef } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { WalletConnect } from './components/WalletConnect';
import { RoomControls } from './components/RoomControls';
import { VideoGrid } from './components/VideoGrid';
import { useChain } from './hooks/useChain';
import { useSignaling } from './hooks/useSignaling';
import { useWebRTC } from './hooks/useWebRTC';

export default function App() {
  const account = useCurrentAccount();
  const [registered, setRegistered] = useState(false);
  const [joined, setJoined] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const lastRoomIdRef = useRef<string>('');

  const { registerUser, createRoom, loading } = useChain();
  const {
    localStream, remoteStream, mediaError, clearMediaError, startLocalStream,
    createOffer, handleOffer, handleAnswer, handleIceCandidate, cleanup, cleanupPeer,
  } = useWebRTC();

  const { connect, joinRoom, sendOffer, sendAnswer, sendIceCandidate, connected } = useSignaling({
    onPeerJoined: (remotePeerId) => {
      const stream = localStreamRef.current;
      if (stream) createOffer(stream, remotePeerId, sendOffer, sendIceCandidate);
    },
    onOffer: (sdp, fromPeerId) => {
      const stream = localStreamRef.current;
      if (stream) handleOffer(sdp, fromPeerId, stream, sendAnswer, sendIceCandidate);
    },
    onAnswer: (sdp, fromPeerId) => handleAnswer(sdp, fromPeerId),
    onIceCandidate: (candidate, fromPeerId) => handleIceCandidate(candidate, fromPeerId),
    onPeerLeft: (peerId) => cleanupPeer(peerId),
  });

  const handleRegister = useCallback(async (name: string) => {
    const ok = await registerUser(name);
    if (ok) setRegistered(true);
    return ok;
  }, [registerUser]);

  const handleCreateRoom = useCallback(async (): Promise<string | null> => {
    setRoomError(null);
    const id = await createRoom();
    if (!id) setRoomError('Room creation failed. The RoomCreated event was not returned.');
    return id;
  }, [createRoom]);

  const handleJoin = useCallback(async (roomId: string) => {
    setConnectionError(null);
    lastRoomIdRef.current = roomId;
    const stream = await startLocalStream();
    if (!stream) return; // mediaError already set by useWebRTC
    localStreamRef.current = stream;
    try {
      await connect();
    } catch {
      setConnectionError('Could not connect to signaling server. Check your network and try again.');
      return;
    }
    joinRoom(roomId);
    setJoined(true);
  }, [startLocalStream, connect, joinRoom]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 900, margin: '0 auto' }}>
      <h1 style={{ textAlign: 'center', margin: '24px 0 8px' }}>DVConf</h1>
      <p style={{ textAlign: 'center', color: '#666', margin: 0 }}>Decentralized Video Conference on Sui</p>

      <WalletConnect />

      {account && (
        <RoomControls
          onRegister={handleRegister}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoin}
          registered={registered}
          loading={loading}
          roomError={roomError}
        />
      )}

      {connectionError && (
        <div style={{ background: '#dc2626', color: 'white', padding: '12px 16px', borderRadius: 8, margin: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{connectionError}</span>
          <button onClick={() => handleJoin(lastRoomIdRef.current)} style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: 'white', color: '#dc2626', cursor: 'pointer', fontWeight: 600 }}>Retry</button>
        </div>
      )}

      {mediaError && (
        <div style={{ background: '#dc2626', color: 'white', padding: '12px 16px', borderRadius: 8, margin: '8px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{mediaError}</span>
          <button onClick={() => { clearMediaError(); startLocalStream(); }} style={{ padding: '4px 12px', borderRadius: 4, border: 'none', background: 'white', color: '#dc2626', cursor: 'pointer', fontWeight: 600 }}>Retry</button>
        </div>
      )}

      {joined && <VideoGrid localStream={localStream} remoteStream={remoteStream} />}

      {joined && (
        <p style={{ textAlign: 'center', fontSize: 12, color: connected ? 'green' : 'orange' }}>
          Signaling: {connected ? 'connected' : 'connecting...'}
        </p>
      )}
    </div>
  );
}
