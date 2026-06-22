/**
 * Multi-CP quorum Phase 1 — Leg 3 (G3 peer_pubkey recovery) tests (RED-first → GREEN).
 *
 * DESIGN-connection-arch.md G3 + ROADMAP Leg 3: a real multi-CP cap-token issue must
 * sign over the REAL 32-byte infra-peer ed25519 key, NOT the `hexToBytes(miner_id)`
 * placeholder `resolvePeerPubkey`'s infra path returns. A miner-id hex is NOT 32 bytes
 * for an arbitrary miner id → the Move mint would abort `E_PUBKEY_WRONG_LENGTH` (code
 * 916, room_capability.move:200/504).
 *
 * The fix (ADDITIVE — `resolvePeerPubkey` UNCHANGED, the Move devInspect getter DEFERRED):
 * a NEW caller recovers the real 32-byte key from the FROZEN `CapabilityIssued.peer_pubkey`
 * event field (capability_events.move:67-74) via the cp-daemon event cache (fed off the
 * event-handler RoomAssigned arm). The recovered 32 bytes populate the cell CLAIM's
 * `peerPubkey` + `canonicalMsgHex` (G4) BEFORE the canonical message is built, so every
 * CP signs byte-identical bytes.
 *
 * FAIL-CLOSED (the crux): if recovery yields a non-32-byte value (e.g. the miner_id
 * placeholder, or no cached event) the recovery DEGRADES fail-closed (null — no quorum,
 * no cell) — a wrong-length key NEVER reaches the Move mint (no 916 abort).
 *
 * SHAPE mirror: same fail-closed-or-value contract as Leg 2's
 * `rebuildCanonicalAndSignIfMatches`; reuses the FROZEN `buildIssueCanonicalMsg` verbatim
 * for the G4 `canonicalMsgHex`.
 */
import { describe, it, expect } from 'vitest';
import {
  buildIssueCanonicalMsg,
  InfraPeerPubkeyCache,
  recoverInfraPeerClaim,
  type CapabilityIssuedLike,
} from '../cap-token-issuer.js';

/** A real 32-byte ed25519 infra-peer pubkey (the value CapabilityIssued.peer_pubkey carries). */
const REAL_PEER_PUBKEY = new Array(32).fill(0).map((_, i) => (i * 7 + 3) & 0xff);
const ROOM_ID = '0x' + '11'.repeat(32);
/** The relay/signaling/validator Sui miner-id hex (the placeholder source). */
const PEER_MINER_ID = '0x' + 'ab'.repeat(20); // 20 bytes — NOT 32 → would abort 916 if signed

function bytesToHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function issuedEvent(over?: Partial<CapabilityIssuedLike>): CapabilityIssuedLike {
  return {
    tokenId: '0x' + 'cc'.repeat(32),
    roomId: ROOM_ID,
    peerPubkey: REAL_PEER_PUBKEY,
    role: 2,
    expiresEpoch: '200',
    ...over,
  };
}

describe('Leg 3 — G3 InfraPeerPubkeyCache (event-cache feed off RoomAssigned arm)', () => {
  it('caches the 32-byte peer_pubkey from a CapabilityIssued event keyed by (roomId, peerId)', () => {
    const cache = new InfraPeerPubkeyCache();
    cache.observeCapabilityIssued(PEER_MINER_ID, issuedEvent());
    expect(cache.get(ROOM_ID, PEER_MINER_ID)).toEqual(REAL_PEER_PUBKEY);
  });

  it('returns undefined for an unseen (roomId, peerId)', () => {
    const cache = new InfraPeerPubkeyCache();
    expect(cache.get(ROOM_ID, PEER_MINER_ID)).toBeUndefined();
  });

  it('REJECTS caching a non-32-byte peer_pubkey (a malformed event never poisons the cache)', () => {
    const cache = new InfraPeerPubkeyCache();
    // A wrong-length value (e.g. the miner-id placeholder leaked into the event field).
    cache.observeCapabilityIssued(PEER_MINER_ID, issuedEvent({ peerPubkey: [1, 2, 3, 4] }));
    expect(cache.get(ROOM_ID, PEER_MINER_ID)).toBeUndefined();
  });
});

describe('Leg 3 — G3 recoverInfraPeerClaim (fail-closed before signing)', () => {
  const baseClaimFields = { role: 2, expiresEpoch: 200n, nonce: 1 };

  it('recovers the REAL 32-byte key → claim carries peerPubkey + matching canonicalMsgHex (G4)', () => {
    const cache = new InfraPeerPubkeyCache();
    cache.observeCapabilityIssued(PEER_MINER_ID, issuedEvent());

    const claim = recoverInfraPeerClaim(
      { roomId: ROOM_ID, peerId: PEER_MINER_ID, ...baseClaimFields },
      cache,
    );

    expect(claim).not.toBeNull();
    expect(claim!.kind).toBe('captoken-issue');
    expect(claim!.peerPubkey).toEqual(REAL_PEER_PUBKEY);
    expect(claim!.peerPubkey.length).toBe(32);

    // G4: canonicalMsgHex is the FROZEN builder's output over the recovered key.
    const expected = buildIssueCanonicalMsg({
      roomId: ROOM_ID,
      peerPubkey: REAL_PEER_PUBKEY,
      role: baseClaimFields.role,
      expiresEpoch: baseClaimFields.expiresEpoch,
      nonce: baseClaimFields.nonce,
    });
    expect(claim!.canonicalMsgHex).toBe(bytesToHex(expected));
  });

  it('FAIL-CLOSED: no cached event (recovery yields nothing) → null, no cell (never a 916 mint)', () => {
    const cache = new InfraPeerPubkeyCache();
    const claim = recoverInfraPeerClaim(
      { roomId: ROOM_ID, peerId: PEER_MINER_ID, ...baseClaimFields },
      cache,
    );
    expect(claim).toBeNull();
  });

  it('FAIL-CLOSED: a miner_id-hex PLACEHOLDER (≠32 bytes) is rejected BEFORE signing (the 916 crux)', () => {
    // Simulate the resolvePeerPubkey infra-path placeholder leaking into the event:
    // a 20-byte miner-id hex is NOT a valid ed25519 key.
    const cache = new InfraPeerPubkeyCache();
    cache.observeCapabilityIssued(PEER_MINER_ID, issuedEvent({ peerPubkey: Array.from(Buffer.from('ab'.repeat(20), 'hex')) }));

    const claim = recoverInfraPeerClaim(
      { roomId: ROOM_ID, peerId: PEER_MINER_ID, ...baseClaimFields },
      cache,
    );
    // The non-32-byte placeholder must NOT produce a signable claim.
    expect(claim).toBeNull();
  });

  it('a recovered 32-byte claim is signable: Leg-2 predicate accepts it (round-trip with G1)', async () => {
    const cache = new InfraPeerPubkeyCache();
    cache.observeCapabilityIssued(PEER_MINER_ID, issuedEvent());
    const claim = recoverInfraPeerClaim(
      { roomId: ROOM_ID, peerId: PEER_MINER_ID, ...baseClaimFields },
      cache,
    );
    expect(claim).not.toBeNull();

    // Re-derive via the FROZEN builder and confirm it byte-matches the claim's G4 hex —
    // exactly the predicate Leg 2's rebuildCanonicalAndSignIfMatches enforces before signing.
    const rederived = buildIssueCanonicalMsg({
      roomId: claim!.roomId,
      peerPubkey: claim!.peerPubkey,
      role: claim!.role,
      expiresEpoch: claim!.expiresEpoch,
      nonce: claim!.nonce,
    });
    expect(bytesToHex(rederived)).toBe(claim!.canonicalMsgHex);
  });
});
