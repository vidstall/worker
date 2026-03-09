import { useCallback, useRef, useState } from 'react';

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

export function useWebRTC() {
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const pendingCandidates = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  const clearMediaError = useCallback(() => setMediaError(null), []);

  const startLocalStream = useCallback(async (): Promise<MediaStream | null> => {
    setMediaError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      return stream;
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === 'NotAllowedError') {
        setMediaError('Camera/microphone permission denied');
      } else if (name === 'NotFoundError') {
        setMediaError('No camera or microphone found');
      } else if (name === 'NotReadableError') {
        setMediaError('Camera is already in use');
      } else {
        setMediaError('Could not access camera/microphone');
      }
      return null;
    }
  }, []);

  const createPC = useCallback((
    stream: MediaStream,
    onIceCandidate: (candidate: RTCIceCandidateInit, targetPeerId: string) => void,
    targetPeerId: string,
  ) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peerConnections.current.set(targetPeerId, pc);

    stream.getTracks().forEach((track) => pc.addTrack(track, stream));

    const remote = new MediaStream();
    setRemoteStream(remote);
    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => remote.addTrack(track));
      setRemoteStream(new MediaStream(remote.getTracks()));
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) onIceCandidate(event.candidate.toJSON(), targetPeerId);
    };

    return pc;
  }, []);

  const createOffer = useCallback(async (
    stream: MediaStream,
    remotePeerId: string,
    sendOffer: (sdp: string, targetPeerId: string) => void,
    onIceCandidate: (candidate: RTCIceCandidateInit, targetPeerId: string) => void,
  ) => {
    const pc = createPC(stream, onIceCandidate, remotePeerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendOffer(offer.sdp!, remotePeerId);
  }, [createPC]);

  const handleOffer = useCallback(async (
    sdp: RTCSessionDescriptionInit,
    fromPeerId: string,
    stream: MediaStream,
    sendAnswer: (sdp: string, targetPeerId: string) => void,
    onIceCandidate: (candidate: RTCIceCandidateInit, targetPeerId: string) => void,
  ) => {
    const pc = createPC(stream, onIceCandidate, fromPeerId);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const queued = pendingCandidates.current.get(fromPeerId) ?? [];
    for (const c of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    pendingCandidates.current.delete(fromPeerId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendAnswer(answer.sdp!, fromPeerId);
  }, [createPC]);

  const handleAnswer = useCallback(async (sdp: RTCSessionDescriptionInit, fromPeerId: string) => {
    const pc = peerConnections.current.get(fromPeerId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const queued = pendingCandidates.current.get(fromPeerId) ?? [];
    for (const c of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    }
    pendingCandidates.current.delete(fromPeerId);
  }, []);

  const handleIceCandidate = useCallback(async (candidate: RTCIceCandidateInit, fromPeerId: string) => {
    const pc = peerConnections.current.get(fromPeerId);
    if (!pc || !pc.remoteDescription) {
      const queued = pendingCandidates.current.get(fromPeerId) ?? [];
      queued.push(candidate);
      pendingCandidates.current.set(fromPeerId, queued);
      return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }, []);

  const cleanupPeer = useCallback((peerId: string) => {
    const pc = peerConnections.current.get(peerId);
    if (pc) {
      pc.close();
      peerConnections.current.delete(peerId);
    }
    pendingCandidates.current.delete(peerId);
    if (peerConnections.current.size === 0) {
      setRemoteStream(null);
    }
  }, []);

  const cleanup = useCallback(() => {
    peerConnections.current.forEach((pc) => pc.close());
    peerConnections.current.clear();
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteStream(null);
    pendingCandidates.current.clear();
  }, [localStream]);

  return {
    localStream, remoteStream, mediaError, clearMediaError, startLocalStream,
    createOffer, handleOffer, handleAnswer, handleIceCandidate, cleanup, cleanupPeer,
  };
}
