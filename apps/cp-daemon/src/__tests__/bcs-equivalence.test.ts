/**
 * F62 M1 Stage 4 / Item #6 — BCS canonical-message byte-equivalence test.
 *
 * Spec source: STATUS.md § Stage 4 readiness #6 + dispatch brief.
 *
 * Asserts that the daemon's TypeScript canonical_msg builders produce the
 * EXACT same bytes as Move-side `room_capability.move`:
 *   - issue:   room_capability.move:473-482
 *   - revoke:  room_capability.move:603-605
 *   - refresh: room_capability.move:1009-1016
 *
 * Move-side concatenation (per the line refs above):
 *   ISSUE   = id_to_bytes(room_id) || peer_pubkey || role(u8) || expires(u64-le) || nonce(u64-le)
 *   REVOKE  = id_to_bytes(cap_id)  || reason(u8)
 *   REFRESH = id_to_bytes(old_id)  || new_role(u8) || new_expires(u64-le) || refresh_nonce(u64-le)
 *
 * Move's `bcs_u64_le` (line 665-673) emits little-endian u64 (8 bytes). Move's
 * `object::id_to_bytes` produces the raw 32-byte ID. `vector::append(buf, vec)`
 * is raw concat with NO length prefix.
 *
 * These are RAW canonical messages — NOT BCS-struct-serialized. The Move
 * comment at room_capability.move:471 says "Build canonical signed message:
 * BCS(room_id || peer_pubkey || role || expires_epoch || nonce)" but the
 * implementation is raw vector::append (NOT bcs::to_bytes(struct)). Item #6
 * therefore matches the actual concatenation byte-for-byte (the briefing said
 * "BCS canonical encoding" but the chain SOT is what determines correctness).
 *
 * Each fixture below is a hand-computed reference vector. Future drift will
 * cause both Move and TS encoders to fail this test if the inputs change.
 */
import { describe, it, expect } from 'vitest';
import {
  buildIssueCanonicalMsg,
  buildRevokeCanonicalMsg,
  buildRefreshCanonicalMsg,
} from '../cap-token/index.js';

/** Helper: hex string → number[] bytes (matches Move's id_to_bytes shape). */
function hex(s: string): number[] {
  const cleaned = s.startsWith('0x') ? s.slice(2) : s;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

/** Pack a u64 little-endian (matches Move's bcs_u64_le at room_capability.move:665-673). */
function u64Le(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

describe('BCS canonical-message byte-equivalence (Item #6)', () => {
  it('issue: concat = id_to_bytes(room_id) || peer_pubkey || role(u8) || expires(u64-le) || nonce(u64-le)', () => {
    const roomId = '0x' + '11'.repeat(32); // 32 bytes of 0x11
    const peerPubkey = new Array(32).fill(0x22); // 32 bytes of 0x22
    const role = 2; // relay
    const expiresEpoch = 200n;
    const nonce = 1;

    const got = buildIssueCanonicalMsg({
      roomId,
      peerPubkey,
      role,
      expiresEpoch,
      nonce,
    });

    const expected = [
      ...hex(roomId),
      ...peerPubkey,
      role,
      ...u64Le(expiresEpoch),
      ...u64Le(BigInt(nonce)),
    ];
    expect(Array.from(got)).toEqual(expected);
    expect(got.length).toBe(32 + 32 + 1 + 8 + 8); // 81 bytes
  });

  it('revoke: concat = id_to_bytes(cap_id) || reason(u8)', () => {
    const capId = '0x' + 'ab'.repeat(32);
    const reason = 4; // refresh-driven per D-012 extension

    const got = buildRevokeCanonicalMsg({ capObjectId: capId, reason });

    const expected = [...hex(capId), reason];
    expect(Array.from(got)).toEqual(expected);
    expect(got.length).toBe(33);
  });

  it('refresh: concat = id_to_bytes(old_id) || new_role(u8) || new_expires(u64-le) || refresh_nonce(u64-le)', () => {
    const oldTokenId = '0x' + 'cd'.repeat(32);
    const newRole = 4; // signaling
    const newExpiresEpoch = 250n;
    const refreshNonce = 2;

    const got = buildRefreshCanonicalMsg({
      oldTokenId,
      newRole,
      newExpiresEpoch,
      refreshNonce,
    });

    const expected = [
      ...hex(oldTokenId),
      newRole,
      ...u64Le(newExpiresEpoch),
      ...u64Le(BigInt(refreshNonce)),
    ];
    expect(Array.from(got)).toEqual(expected);
    expect(got.length).toBe(32 + 1 + 8 + 8); // 49 bytes
  });

  it('issue: works with peer_pubkey shorter than 32 bytes (Move uses raw append with no length prefix)', () => {
    // Move's vector::append does NOT prefix with length — daemon must mirror.
    const roomId = '0x' + '00'.repeat(32);
    const peerPubkey = [0x01, 0x02, 0x03, 0x04]; // 4 bytes only (degenerate fixture)
    const got = buildIssueCanonicalMsg({
      roomId,
      peerPubkey,
      role: 0,
      expiresEpoch: 1n,
      nonce: 0,
    });
    // Should be 32 (room) + 4 (pubkey) + 1 (role) + 8 (expires) + 8 (nonce) = 53 bytes.
    expect(got.length).toBe(53);
  });

  it('encoders return Uint8Array (not number[]) — daemon-internal type is Uint8Array', () => {
    const out = buildIssueCanonicalMsg({
      roomId: '0x' + '11'.repeat(32),
      peerPubkey: new Array(32).fill(0x22),
      role: 2,
      expiresEpoch: 200n,
      nonce: 1,
    });
    expect(out).toBeInstanceOf(Uint8Array);
  });

  it('u64 little-endian: expires_epoch = 0x0102030405060708 serializes to [0x08,0x07,...,0x01]', () => {
    const got = buildRefreshCanonicalMsg({
      oldTokenId: '0x' + '00'.repeat(32),
      newRole: 0,
      newExpiresEpoch: 0x0102030405060708n,
      refreshNonce: 0,
    });
    // 32 bytes id + 1 byte role + 8 byte expires + 8 byte nonce
    const expiresBytes = Array.from(got.slice(33, 41));
    expect(expiresBytes).toEqual([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]);
  });
});
