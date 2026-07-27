/**
 * Wire message types for the mediasoup client-relay signaling protocol.
 *
 * Pure types — no behavior. Extracted verbatim from the original signaling.ts
 * (protocol message types section).
 *
 * Requirements: RELAY-05
 */

import type { types as msTypes } from 'mediasoup';

// ── Protocol message types ──────────────────────────────────────────

export interface JoinMessage {
  type: 'join';
  roomId: string;
  peerId: string;
  /** Room mode: 'sfu' (default) or 'mcu'. First joiner sets the mode. */
  mode?: 'sfu' | 'mcu';
  /**
   * W5 M2 P1.0 (REQ-MCS-012, CONTEXT D-M2-18) — Zoom-style ADMISSION password.
   * Carried in cleartext over the (TLS) WS; the relay hashes it and checks it
   * online (first-joiner-sets-it, §below). DISTINCT from the mediasoup ICE
   * `iceParameters.password` (DTLS/ICE credential) — this is the room-join
   * secret, NOT a media-transport credential. Wire field name `roomPassword`
   * (shared verbatim with the client `buildJoinMessage`) — deliberately NOT
   * `password`, to avoid the ICE `iceParameters.password` collision.
   */
  roomPassword?: string;
  /**
   * W5 M2 P1.0 (REQ-MCS-013) — the joiner's in-browser ed25519 SESSION public
   * key, base64 (decodes to exactly 32 bytes). Recorded in the room roster as
   * `{ peerId → sessionPubkey }`; the coordinator later seals K_room to it
   * (P1/P3). PUBLIC key only — safe to log/announce. A malformed (non-32-byte)
   * key FAILS admission loud (no silent placeholder).
   */
  peerPubkey?: string;
  /**
   * W5 M2 P1.0 (decision #2) — proof-of-possession signature over the join, and
   * its nonce. The client signs these (auth.ts byte-shape); for M2 the relay
   * does NOT verify them (admission gate = the password, D-M2-8) — they ride the
   * wire UNVERIFIED, reserved for the M3 on-chain-bind hardening. Carried so the
   * wire contract is stable now and verification is purely additive in M3.
   */
  signature?: string;
  nonce?: number;
  /**
   * W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5 `RoomModeProperty`) — the HOST (first
   * joiner) declares whether the room runs the SFrame E2EE transform. Stored on
   * the per-room `RoomConfig` (NOT on-chain, D-M2-2); LATER joiners INHERIT the
   * host-set value and CANNOT flip it (the field is read only when the room is
   * first created). Absent ⇒ `false` (legacy / M1 rooms unchanged — opt-in, like
   * `roomPassword`). The relay only PROPAGATES this as a room property
   * (signaling/client-asserted, NOT tamper-evident, D-M2-2); it does not gate
   * media on it. Crypto-claim discipline (D-M2-8): E2EE here is the per-room
   * SFrame state — NOT a relay/validator "cannot decrypt" guarantee.
   */
  e2ee?: boolean;
}

export interface CreateTransportMessage {
  type: 'createTransport';
  direction: 'send' | 'recv';
}

export interface ConnectTransportMessage {
  type: 'connectTransport';
  transportId: string;
  dtlsParameters: msTypes.DtlsParameters;
}

export interface ProduceMessage {
  type: 'produce';
  transportId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
}

export interface ConsumeMessage {
  type: 'consume';
  /**
   * Optional. On the PRIMARY a client supplies the producerId it learned via a
   * `newProducer` notification. On the STANDBY (G1 reconciliation) the client
   * sends `{ type:'consume', rtpCapabilities }` WITHOUT a producerId and the
   * standby resolves the piped producer from room context. See dev-fe client-consume
   * contract reconciliation.
   */
  producerId?: string;
  rtpCapabilities: msTypes.RtpCapabilities;
}

export interface LeaveMessage {
  type: 'leave';
}

/**
 * W5 M1 (REQ-MCS-002) — client requests the relay apply a per-consumer simulcast
 * layer preference. `setPreferredLayers` is a SERVER-SIDE mediasoup call
 * (CONTRACTS.md C0): the client NEVER calls it, it only sends this request and
 * the relay looks up the stored Consumer by `consumerId` and applies it.
 */
export interface SetConsumerLayersMessage {
  type: 'setConsumerLayers';
  /** mediasoup Consumer.id, as returned to the client in the `consumed` reply. */
  consumerId: string;
  /** Spatial layer 0|1|2 (CONTRACTS.md C1: 0=low/thumbnail, 2=high/active-speaker). */
  spatialLayer: number;
  /**
   * Temporal layer 0|1|2 (VP8 L1T3). Optional-semantics: omit → relay keeps the
   * current temporal layer (passes only { spatialLayer } to setPreferredLayers).
   */
  temporalLayer?: number;
}

/**
 * W5 M1 P6 (REQ-MCS-004) — client requests the relay pause a consumer to stop
 * forwarding RTP for an off-page tile. Server effect: paused consumer forwards
 * RTCP only (~0 media bytes). CONTRACTS.md C2.2.
 */
export interface PauseConsumerMessage {
  type: 'pauseConsumer';
  /** mediasoup Consumer.id for the off-page consumer to stop paying for. */
  consumerId: string;
}

/**
 * W5 M1 P6 (REQ-MCS-004) — client requests the relay resume a consumer to
 * restart RTP for a tile entering the visible set. CONTRACTS.md C2.3.
 */
export interface ResumeConsumerMessage {
  type: 'resumeConsumer';
  /** mediasoup Consumer.id for the on-page consumer to resume. */
  consumerId: string;
}

/**
 * Inbound inter-relay producer-announce frame (G1). Received by the STANDBY
 * relay on the same WS server, distinguished from client frames by `type`.
 * Shape matches PipeProducerAnnounce in inter-relay.ts.
 */
export interface PipeProducerMessage {
  type: 'pipe-producer';
  roomId: string;
  producerId: string;
  kind: msTypes.MediaKind;
  /** REQ-RO-018 — publisher peerId (optional on the wire, back-compat). */
  producerPeerId?: string;
  /** REQ-RMS-026/036 — origin relay (reverse leg). Optional/additive. */
  peerRelayId?: string;
  /** REQ-RMS-026 — remapped consumer params (reverse leg). Optional/additive. */
  rtpParameters?: msTypes.RtpParameters;
}

/**
 * REQ-RO-006 — inbound inter-relay connect-param frame on the relay WS server,
 * distinguished from client frames by `type`. Shape mirrors PipeConnectFrame in
 * inter-relay.ts.
 */
export interface PipeConnectMessage {
  type: 'pipe-connect';
  roomId: string;
  ip: string;
  port: number;
  srtpParameters?: msTypes.SrtpParameters;
  /**
   * C6 part-2 (REQ-RMS-008) — the cascade peerRelayId the standby tags on its UP
   * pipe-connect (= its own x-inter-relay-peer-id). OPTIONAL / additive (mirrors
   * PipeConnectFrame): a legacy frame omits it → DEFAULT_PEER_RELAY_ID downstream.
   */
  peerRelayId?: string;
}

/**
 * W5 M2 P4 (REQ-MCS-012, transport half) — the coordinator-sealed group-key
 * bundle, broadcast BLIND over signaling (CONTRACTS.md §1, FROZEN). The client's
 * KeyManager (P3) PRODUCES this; signaling only FORWARDS it recipient-oblivious
 * to the OTHER room members. Signaling NEVER holds, derives, decrypts, or logs a
 * key — every field below is opaque transport, and `sealedKey` is NEVER logged.
 */
export interface SealedEnvelope {
  /** base64 of the recipient's ed25519 session pubkey (matches a roster entry). */
  recipientPubkey: string;
  /**
   * base64 libsodium crypto_box_seal( K_room, X25519(recipientPubkey) ). OPAQUE
   * to signaling + relay — NEVER logged (only the envelope COUNT is, see §1).
   */
  sealedKey: string;
}

export interface E2EEKeyBundleMessage {
  type: 'e2eeKeyBundle';
  /** Sui room id (0x-hex); MUST match the sender's joined room or it is ignored. */
  roomId: string;
  /** monotonic membership epoch; == kid. u32 range. */
  epoch: number;
  /** SFrame Key ID written to the cleartext header (== epoch). u8 wire. */
  kid: number;
  /** base64 ed25519 session pubkey of the electing coordinator (audit/anti-spoof). */
  coordinatorPubkey: string;
  /** one per roster member; ORDER-INSENSITIVE (recipient-oblivious). */
  envelopes: SealedEnvelope[];
}

export type SignalingMessage =
  | JoinMessage
  | CreateTransportMessage
  | ConnectTransportMessage
  | ProduceMessage
  | ConsumeMessage
  | SetConsumerLayersMessage
  | PauseConsumerMessage
  | ResumeConsumerMessage
  | LeaveMessage
  | PipeProducerMessage
  | PipeConnectMessage
  | E2EEKeyBundleMessage;
