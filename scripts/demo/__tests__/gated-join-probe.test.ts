import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import { buildJoinPayload, classifyClose } from '../gated-join-probe.ts';

describe('gated-join-probe — canonical payload + close classification', () => {
  it('buildJoinPayload is byte-identical to the AuthHook JoinPayload BCS (auth.ts:134-142)', () => {
    const kp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(kp.getPublicKey().toRawBytes());
    const roomId = '0xroom-probe';
    const nonce = 2;
    const expected = bcs
      .struct('JoinPayload', { roomId: bcs.string(), peerPubkey: bcs.vector(bcs.u8()), nonce: bcs.u64() })
      .serialize({ roomId, peerPubkey, nonce: BigInt(nonce) })
      .toBytes();
    expect(Array.from(buildJoinPayload(roomId, peerPubkey, nonce))).toEqual(Array.from(expected));
  });

  it('classifyClose maps 4401 -> rejected, normal-open(no close) -> accepted', () => {
    expect(classifyClose(4401, 'no-token')).toEqual({ accepted: false, code: 4401 });
    expect(classifyClose(null, undefined)).toEqual({ accepted: true, code: null });
  });
});
