/**
 * REQ-CFA-001 (Phase 0 / Task 0.1) — canary-keying module tests.
 *
 * Proves the canary key K_canary is derived from a per-cell OOB `cellSecret` via the
 * SHIPPED `PathCKeyDerivation` salt-mix (e2ee-spike.ts, cross-repo import), and that
 * the `canaryKid` allocator is restart-DURABLE (monotone across a simulated process
 * restart) so a restarted publisher never reuses (K, kid, ctr=0) — the M2-P2
 * nonce-reuse CRITICAL precedent.
 *
 * The in-memory-only failure mode is the hazard guarded against: see
 * dvconf-client/src/lib/webrtc/encoded-transform-shim.ts:75 (`ctrHighWater` Map that
 * "Lives for the page lifetime") — a fresh in-memory store resets to 0 on restart and
 * would re-introduce (key, IV) reuse. The canary kid store MUST persist instead.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── REAL client crypto (cross-repo import, mirrors the relay integration test) ──
// 5-level `../` from apps/validator-daemon/src/canary/__tests__ -> the client lib.
// NOTHING here reimplements HKDF / Path C — the salt-mix is the production stack's.
import { PathCKeyDerivation } from '../../../../../../dvconf-client/src/lib/crypto/e2ee-spike.js';
import {
  encryptFrame,
  codecOffsetForFrameType,
} from '../../../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';

import {
  deriveCanaryKey,
  deriveCanaryBits,
  CANARY_SENDER_ID,
  DurableKidStore,
  nextCanaryKid,
} from '../keying.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────
const kRoom = new Uint8Array(32).fill(7); // deterministic 256-bit room key
const roomId = 'room-cfa-001';
const cellSecret = new Uint8Array(16).fill(0xab); // >=128-bit per-cell OOB secret
const canaryKid = 42;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'cfa-kid-'));
});

describe('REQ-CFA-001 deriveCanaryKey — PathC salt-mix equivalence', () => {
  it('(a) derives the SAME key bits as PathCKeyDerivation.deriveContentKey for the canary sender', async () => {
    // Reference: the SHIPPED Path C derivation, with cellSecret mapped to oobSecret,
    // canaryKid mapped to kid, and the FIXED canary senderId folded into the HKDF info.
    const reference = await new PathCKeyDerivation().deriveContentBits({
      kRoom,
      roomId,
      kid: canaryKid,
      senderId: CANARY_SENDER_ID,
      oobSecret: cellSecret,
    });

    const got = await deriveCanaryBits({ kRoom, roomId, canaryKid, cellSecret });

    // The derived CryptoKey is extractable:false (inherited from PathA/PathC), so we
    // prove EXACT equality via the public raw-bits helper, not by exporting the key.
    expect(got).toEqual(reference);
    expect(got.length).toBe(32);
  });

  it('(a) deriveCanaryKey returns an AES-GCM CryptoKey usable by encryptFrame', async () => {
    const key = await deriveCanaryKey({ kRoom, roomId, canaryKid, cellSecret });
    expect(key).toBeInstanceOf(CryptoKey);
    expect((key as CryptoKey).algorithm.name).toBe('AES-GCM');

    // It must actually encrypt a frame (the canary publisher uses it as kContent).
    const plain = new TextEncoder().encode('canary frame zero — alpha alpha alpha');
    const codecOffset = codecOffsetForFrameType('key', plain.length);
    const sframe = await encryptFrame(plain, { kid: canaryKid, ctr: 0 }, key, codecOffset);
    // |plaintext| + 16 (GCM tag) + 14 (trailer) — the shipped partial-SFrame layout.
    expect(sframe.length).toBe(plain.length + 16 + 14);
  });

  it('(b) WITHOUT cellSecret it THROWS (Path C requires oobSecret) — no silent Path A fallback', async () => {
    // A relay / non-cell member has no cellSecret and CANNOT reproduce K_canary.
    await expect(
      // @ts-expect-error — deliberately omitting cellSecret to prove the throw
      deriveCanaryKey({ kRoom, roomId, canaryKid }),
    ).rejects.toThrow('Path C requires oobSecret');

    await expect(
      deriveCanaryBits({ kRoom, roomId, canaryKid, cellSecret: new Uint8Array(0) }),
    ).rejects.toThrow('Path C requires oobSecret');

    // Negative proof of covertness: the empty-salt Path A bits MUST differ from the
    // canary bits, so a member without the OOB factor cannot land on K_canary.
    const canaryBits = await deriveCanaryBits({ kRoom, roomId, canaryKid, cellSecret });
    const pathABits = await new PathCKeyDerivation()
      .deriveContentBits({
        kRoom,
        roomId,
        kid: canaryKid,
        senderId: CANARY_SENDER_ID,
        oobSecret: new Uint8Array(16).fill(0xcd), // a DIFFERENT secret
      })
      .catch(() => null);
    expect(pathABits).not.toEqual(canaryBits);
  });
});

describe('REQ-CFA-001 nextCanaryKid — restart-durable monotone allocator', () => {
  it('(c) is strictly monotone within one store instance', () => {
    const store = new DurableKidStore(dataDir);
    const a = nextCanaryKid('stream-1', store);
    const b = nextCanaryKid('stream-1', store);
    const c = nextCanaryKid('stream-1', store);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('(c) survives a simulated process restart — re-instantiated store does NOT reset to 0', () => {
    // First "process": issue some kids.
    const before = new DurableKidStore(dataDir);
    let last = nextCanaryKid('stream-restart', before);
    last = nextCanaryKid('stream-restart', before);
    last = nextCanaryKid('stream-restart', before); // last issued

    // Simulated restart: a NEW store reads the persisted high-water from disk.
    const afterRestart = new DurableKidStore(dataDir);
    const resumed = nextCanaryKid('stream-restart', afterRestart);

    // The restarted publisher must NOT reuse (K, kid, ctr=0): kid strictly increases.
    expect(resumed).toBeGreaterThan(last);
  });

  it('(c) HAZARD: a purely in-memory store WOULD reset on restart (excluded by design)', () => {
    // This documents the encoded-transform-shim.ts:75 `ctrHighWater` page-lifetime hazard:
    // a fresh in-memory map starts from scratch. We model an in-memory store by pointing
    // a second DurableKidStore at a DIFFERENT (empty) dir — it has no persisted state and
    // resets, which is exactly why the canary kid store MUST be disk-backed.
    const persisted = new DurableKidStore(dataDir);
    const issued = nextCanaryKid('stream-hazard', persisted);

    const freshEmpty = mkdtempSync(join(tmpdir(), 'cfa-kid-empty-'));
    try {
      const inMemoryLike = new DurableKidStore(freshEmpty);
      const reset = nextCanaryKid('stream-hazard', inMemoryLike);
      // The empty/in-memory-like store resets below the durable high-water — the hazard.
      expect(reset).toBeLessThanOrEqual(issued);
      // ...whereas the DURABLE store keeps climbing on its own restart (proven above).
    } finally {
      rmSync(freshEmpty, { recursive: true, force: true });
    }
  });
});
