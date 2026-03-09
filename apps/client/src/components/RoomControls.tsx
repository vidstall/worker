import { useState } from 'react';

interface Props {
  onRegister: (name: string) => Promise<boolean>;
  onCreateRoom: () => Promise<string | null>;
  onJoinRoom: (roomId: string) => void;
  registered: boolean;
  loading: boolean;
  roomError: string | null;
}

const btn: React.CSSProperties = {
  padding: '8px 16px', cursor: 'pointer', borderRadius: 4,
  border: '1px solid #ccc', background: '#f5f5f5', fontSize: 14,
};

export function RoomControls({ onRegister, onCreateRoom, onJoinRoom, registered, loading, roomError }: Props) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [createdRoomId, setCreatedRoomId] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', gap: 24, justifyContent: 'center', padding: 16, flexWrap: 'wrap' }}>
      {/* Register */}
      {!registered && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Display name" style={{ padding: 8, borderRadius: 4, border: '1px solid #ccc' }} />
          <button style={btn} disabled={loading || !name}
            onClick={async () => { await onRegister(name); }}>
            {loading ? '...' : 'Register'}
          </button>
        </div>
      )}
      {registered && <span style={{ color: 'green' }}>Registered</span>}

      {/* Room Error Banner */}
      {roomError && (
        <div style={{ background: '#dc2626', color: 'white', padding: '8px 12px', borderRadius: 4, fontSize: 13, width: '100%', textAlign: 'center' }}>
          {roomError}
        </div>
      )}

      {/* Create Room */}
      {registered && (
        <button style={btn} disabled={loading}
          onClick={async () => {
            const id = await onCreateRoom();
            if (id) { setCreatedRoomId(id); setRoomId(id); }
          }}>
          {loading ? '...' : 'Create Room'}
        </button>
      )}

      {createdRoomId && (
        <span style={{ fontSize: 12, color: '#666', maxWidth: 200, wordBreak: 'break-all' }}>
          Room: {createdRoomId.slice(0, 16)}...
          <button style={{ ...btn, padding: '2px 6px', marginLeft: 4, fontSize: 12 }}
            onClick={() => navigator.clipboard.writeText(createdRoomId)}>Copy</button>
        </span>
      )}

      {/* Join Room */}
      {registered && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input value={roomId} onChange={(e) => setRoomId(e.target.value)}
            placeholder="Room ID" style={{ padding: 8, borderRadius: 4, border: '1px solid #ccc', width: 180 }} />
          <button style={btn} disabled={!roomId}
            onClick={() => onJoinRoom(roomId)}>
            Join
          </button>
        </div>
      )}
    </div>
  );
}
