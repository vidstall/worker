import { describe, it, expect } from 'vitest';
import { buildJoinMessage, generatePeerPubkeyB64 } from '../bot-peer.js';

describe('generatePeerPubkeyB64', () => {
  it('produces a base64 string decoding to exactly 32 bytes', () => {
    const pubkey = generatePeerPubkeyB64();
    const decoded = Buffer.from(pubkey, 'base64');
    expect(decoded.length).toBe(32);
  });

  it('produces a fresh key each call', () => {
    expect(generatePeerPubkeyB64()).not.toBe(generatePeerPubkeyB64());
  });
});

describe('buildJoinMessage', () => {
  const opts = {
    relayUrl: 'ws://localhost:4000',
    roomId: '0xroom',
    peerId: 'bot-0xroom',
    roomPassword: '123',
  };

  it('includes the room id, peer id, and password', () => {
    const msg = buildJoinMessage(opts);
    expect(msg.type).toBe('join');
    expect(msg.roomId).toBe('0xroom');
    expect(msg.peerId).toBe('bot-0xroom');
    expect(msg.roomPassword).toBe('123');
  });

  it('includes a 32-byte base64 peerPubkey (relay validateSessionPubkey requirement)', () => {
    const msg = buildJoinMessage(opts);
    expect(Buffer.from(msg.peerPubkey, 'base64').length).toBe(32);
  });

  it('includes a placeholder signature/nonce (unverified server-side per M2)', () => {
    const msg = buildJoinMessage(opts);
    expect(msg.signature).toBe('unverified');
    expect(msg.nonce).toBe(1);
  });
});
