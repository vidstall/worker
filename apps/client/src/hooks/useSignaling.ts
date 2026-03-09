import { useCallback, useRef, useState } from 'react';
import { CONFIG } from '../config';

export interface SignalingCallbacks {
  onPeerJoined: (peerId: string) => void;
  onOffer: (sdp: RTCSessionDescriptionInit, fromPeerId: string) => void;
  onAnswer: (sdp: RTCSessionDescriptionInit, fromPeerId: string) => void;
  onIceCandidate: (candidate: RTCIceCandidateInit, fromPeerId: string) => void;
  onPeerLeft: (peerId: string) => void;
}

export function useSignaling(callbacks: SignalingCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const [peerId, setPeerId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback((): Promise<void> => {
    if (wsRef.current) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(CONFIG.SIGNALING_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        resolve();
      };

      ws.onerror = () => {
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        const cb = callbacksRef.current;

        switch (msg.type) {
          case 'welcome':
            setPeerId(msg.peerId);
            break;
          case 'peer-joined':
            cb.onPeerJoined(msg.peerId);
            break;
          case 'offer':
            cb.onOffer({ type: 'offer', sdp: msg.sdp }, msg.fromPeerId);
            break;
          case 'answer':
            cb.onAnswer({ type: 'answer', sdp: msg.sdp }, msg.fromPeerId);
            break;
          case 'ice-candidate':
            cb.onIceCandidate(msg.candidate, msg.fromPeerId);
            break;
          case 'peer-left':
            cb.onPeerLeft(msg.peerId);
            break;
        }
      };
    });
  }, []);

  const joinRoom = useCallback((roomId: string) => {
    send({ type: 'join', roomId });
  }, [send]);

  const sendOffer = useCallback((sdp: string, targetPeerId: string) => {
    send({ type: 'offer', sdp, targetPeerId });
  }, [send]);

  const sendAnswer = useCallback((sdp: string, targetPeerId: string) => {
    send({ type: 'answer', sdp, targetPeerId });
  }, [send]);

  const sendIceCandidate = useCallback((candidate: RTCIceCandidateInit, targetPeerId: string) => {
    send({ type: 'ice-candidate', candidate, targetPeerId });
  }, [send]);

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  return { connect, joinRoom, sendOffer, sendAnswer, sendIceCandidate, disconnect, peerId, connected };
}
