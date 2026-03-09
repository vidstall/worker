import { useEffect, useRef } from 'react';

interface Props {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
}

export function VideoGrid({ localStream, remoteStream }: Props) {
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localRef.current && localStream) localRef.current.srcObject = localStream;
  }, [localStream]);

  useEffect(() => {
    if (remoteRef.current && remoteStream) remoteRef.current.srcObject = remoteStream;
  }, [remoteStream]);

  return (
    <div style={{ display: 'flex', gap: 16, justifyContent: 'center', padding: 16 }}>
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: '0 0 8px' }}>You</p>
        <video ref={localRef} autoPlay muted playsInline
          style={{ width: 400, height: 300, background: '#111', borderRadius: 8 }} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <p style={{ margin: '0 0 8px' }}>Remote</p>
        <video ref={remoteRef} autoPlay playsInline
          style={{ width: 400, height: 300, background: '#111', borderRadius: 8 }} />
      </div>
    </div>
  );
}
