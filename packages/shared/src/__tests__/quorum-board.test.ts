/**
 * Multi-CP quorum Phase 1 — Leg 5 RED→GREEN tests for the GENERIC quorum claim board.
 *
 * The generic board (`packages/shared/src/quorum-board.ts`) is the parametric sibling of the
 * canary-concrete `validator-daemon/src/canary/claim-board.ts` `InMemoryClaimBoard` (which stays
 * BYTE-IDENTICAL). It is generic over `<Claim, Attestation>`, lives in `@dvconf/shared` so both the
 * canary (validator-daemon) and the cap-token Leg-6 collector (cp-daemon) can import it WITHOUT a
 * cross-app import, and is parametrised by an injected per-`kind` config:
 *   - a `kind` discriminator,
 *   - a per-kind `cellKey(claim)` fn (the BOARD namespaces it by kind so canary & cap-token cells
 *     with identical identifying fields can never collide),
 *   - a per-kind `attesterKey(att)` dedup key + `distinctCount(atts)` semantics,
 *   - a per-kind `gc()` FAIL-MODE branch (canary = fail-CLOSED silent-GC-no-slash, byte-identical to
 *     the canary board; cap-token = fail-LOUD bounded-retry+fresh-nonce escalation, Fork-5),
 *   - a per-kind INV-C wire-schema ALLOW-LIST validating every posted claim/attestation.
 *
 * These tests pin the kind-namespaced key isolation, the per-kind gc fail-mode + its non-leak
 * across kinds, and the canary INV-C allow-list (reject auditing-validator miner_id / salted secret).
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryGenericClaimBoard,
  type BoardKindConfig,
  type QuorumClaimBoard,
} from '../quorum-board.js';

// ── Synthetic claim/attestation shapes (generic board is agnostic to the concrete ones) ──

interface CanaryClaim {
  kind: 'canary-divergence';
  roomId: string;
  relayMinerId: string;
  canaryId: number;
  frameSeq: number;
  expectedHash: string;
  observedHash: string;
}
interface CanaryAtt {
  sessionPublicKey: Uint8Array;
  signature: Uint8Array;
}

interface CapTokenClaim {
  kind: 'captoken-issue';
  roomId: string;
  relayMinerId: string; // same identifying-field NAME as canary on purpose (collision bait)
  canaryId: number;
  frameSeq: number;
  nonce: number;
}
interface CapTokenAtt {
  pubkey: number[];
  signature: number[];
  addr: string;
}

function hex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// ── Per-kind configs under test ────────────────────────────────────────────────

function canaryConfig(): BoardKindConfig<CanaryClaim, CanaryAtt> {
  return {
    kind: 'canary-divergence',
    cellKey: (c) => `${c.roomId}|${c.relayMinerId}|${c.canaryId}|${c.frameSeq}`,
    attesterKey: (a) => hex(a.sessionPublicKey),
    distinctCount: (atts) => new Set(atts.map((a) => hex(a.sessionPublicKey))).size,
    minDistinct: 2,
    gcFailMode: 'fail-closed-silent', // silent GC, no slash, no escalation
    // INV-C POSITIVE allow-list: a canary post may carry ONLY the ACCUSED relay public id +
    // the divergence identifiers + Wallet-B pubkeys/sigs. Whitelist the permitted keys and
    // REJECT everything else — so a RENAMED leak field (sessionWallet, auditorMinerId,
    // validatorMinerId, a salt under any name, ...) is caught precisely because it is NOT on
    // the whitelist. Structurally stronger than a deny-list (which only catches known names).
    validateWireSchema: (claim, att) => {
      const CLAIM_KEYS = new Set([
        'kind', 'roomId', 'relayMinerId', 'canaryId', 'frameSeq', 'expectedHash', 'observedHash',
      ]);
      const ATT_KEYS = new Set(['sessionPublicKey', 'signature']);
      const reject = 'not in canary allow-list (possible auditing miner_id / salted secret / Wallet-A leak)';
      for (const k of Object.keys(claim as object)) {
        if (!CLAIM_KEYS.has(k)) return `canary claim key "${k}" ${reject}`;
      }
      for (const k of Object.keys(att as object)) {
        if (!ATT_KEYS.has(k)) return `canary attestation key "${k}" ${reject}`;
      }
      return null; // allowed
    },
  };
}

function capTokenConfig(escalate: (key: string) => void): BoardKindConfig<CapTokenClaim, CapTokenAtt> {
  return {
    kind: 'captoken-issue',
    cellKey: (c) => `${c.roomId}|${c.relayMinerId}|${c.canaryId}|${c.frameSeq}`,
    attesterKey: (a) => a.addr, // cap-token dedups by operator ADDRESS (public)
    distinctCount: (atts) => new Set(atts.map((a) => a.addr)).size,
    minDistinct: 2,
    gcFailMode: { kind: 'fail-loud', onUnquorumedExpiry: escalate }, // Fork-5
    validateWireSchema: () => null, // CP operator addresses are PUBLIC — own allow-list
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────────

function canaryClaim(): CanaryClaim {
  return {
    kind: 'canary-divergence',
    roomId: 'room1',
    relayMinerId: 'relayR',
    canaryId: 7,
    frameSeq: 42,
    expectedHash: 'aa',
    observedHash: 'bb',
  };
}
function capClaim(): CapTokenClaim {
  // SAME identifying fields as canaryClaim() — bait for a cross-kind key collision.
  return { kind: 'captoken-issue', roomId: 'room1', relayMinerId: 'relayR', canaryId: 7, frameSeq: 42, nonce: 1 };
}
function canaryAtt(seed: number): CanaryAtt {
  return { sessionPublicKey: new Uint8Array(32).fill(seed), signature: new Uint8Array(64).fill(seed) };
}
function capAtt(addr: string, seed: number): CapTokenAtt {
  return { pubkey: new Array(32).fill(seed), signature: new Array(64).fill(seed), addr };
}

describe('GenericClaimBoard — kind-namespaced cellKey isolation', () => {
  it('a canary cell and a cap-token cell with IDENTICAL identifying fields get DIFFERENT keys (no collision)', async () => {
    const escalations: string[] = [];
    const board: QuorumClaimBoard = new InMemoryGenericClaimBoard([
      canaryConfig(),
      capTokenConfig((k) => escalations.push(k)),
    ]);

    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 1), 0);

    const open = await board.listOpen();
    expect(open).toHaveLength(2); // two distinct cells, not one merged cell
    const keys = open.map((c) => c.key);
    expect(new Set(keys).size).toBe(2);
    // every key is namespaced by kind
    expect(keys.some((k) => k.startsWith('canary-divergence|'))).toBe(true);
    expect(keys.some((k) => k.startsWith('captoken-issue|'))).toBe(true);
  });

  it('get() is scoped by kind — a canary key never returns a cap-token cell', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 1), 0);

    const open = await board.listOpen();
    for (const cell of open) {
      const got = await board.get(cell.key);
      expect(got?.key).toBe(cell.key);
      expect(got?.kind).toBe(cell.kind);
    }
  });
});

describe('GenericClaimBoard — per-kind gc fail-mode + cross-kind non-leak (ISOLATION)', () => {
  it('canary gc SILENT-drops an un-quorumed cell below quorum, NO escalation', async () => {
    const escalations: string[] = [];
    const board = new InMemoryGenericClaimBoard([
      canaryConfig(),
      capTokenConfig((k) => escalations.push(k)),
    ]);
    // 1 attester only → below minDistinct=2
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    await board.gc(100); // far past W_corr

    expect(await board.listOpen()).toHaveLength(0); // silently dropped
    expect(escalations).toHaveLength(0); // canary NEVER escalates (no slash, no loud)
  });

  it('cap-token gc FAIL-LOUD escalates an un-quorumed cell at expiry (Fork-5)', async () => {
    const escalations: string[] = [];
    const board = new InMemoryGenericClaimBoard([
      canaryConfig(),
      capTokenConfig((k) => escalations.push(k)),
    ]);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 1), 0); // 1 distinct addr only
    await board.gc(100);

    expect(escalations).toHaveLength(1); // a blocked room-join is VISIBLE
    expect(escalations[0]).toContain('captoken-issue|');
  });

  it('ISOLATION: a cap-token fail-loud must NOT fire on an un-quorumed CANARY cell', async () => {
    const escalations: string[] = [];
    const board = new InMemoryGenericClaimBoard([
      canaryConfig(),
      capTokenConfig((k) => escalations.push(k)),
    ]);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0); // canary, below quorum
    await board.gc(100);
    // canary silent-GC'd; the cap-token fail-loud branch never touched the canary cell.
    expect(escalations).toHaveLength(0);
    expect(await board.listOpen()).toHaveLength(0);
  });

  it('ISOLATION: canary silent-GC must NOT swallow an un-quorumed CAP-TOKEN cell (it escalates instead)', async () => {
    const escalations: string[] = [];
    const board = new InMemoryGenericClaimBoard([
      canaryConfig(),
      capTokenConfig((k) => escalations.push(k)),
    ]);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 1), 0);
    await board.gc(100);
    // The cap-token cell was NOT silently swallowed by canary's fail-closed branch.
    expect(escalations).toHaveLength(1);
  });

  it('a quorumed canary cell (>=2 distinct) is RETAINED past the window (defensive, matches canary board)', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(2), 0); // 2 distinct
    await board.gc(100);
    expect(await board.listOpen()).toHaveLength(1); // retained
  });

  it('a SUBMITTED cell is dropped past the window regardless of kind', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(2), 0);
    const [cell] = await board.listOpen();
    await board.markSubmitted(cell.key);
    await board.gc(100);
    expect(await board.listOpen()).toHaveLength(0);
  });
});

describe('GenericClaimBoard — INV-C wire-schema allow-list (canary)', () => {
  it('REJECTS a canary post carrying an auditing-validator miner_id', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    const leaky = { ...canaryClaim(), minerId: 'auditor-wallet-A' } as unknown as CanaryClaim;
    await expect(board.post('canary-divergence', leaky, canaryAtt(1), 0)).rejects.toThrow(/miner_id|secret/i);
    expect(await board.listOpen()).toHaveLength(0); // nothing posted
  });

  it('REJECTS a canary post carrying a salted assignmentSecret', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    const leaky = { ...canaryClaim(), assignmentSecret: 'salt-deadbeef' } as unknown as CanaryClaim;
    await expect(board.post('canary-divergence', leaky, canaryAtt(1), 0)).rejects.toThrow(/secret|miner_id/i);
  });

  it('REJECTS a canary attestation carrying a Wallet-A leak', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    const leakyAtt = { ...canaryAtt(1), walletA: 'pub-A' } as unknown as CanaryAtt;
    await expect(board.post('canary-divergence', canaryClaim(), leakyAtt, 0)).rejects.toThrow(/Wallet-A|miner_id|secret/i);
  });

  it('REJECTS a canary post carrying a RENAMED leak field NOT on the allow-list (a deny-list would miss this)', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    // `sessionWallet` is a Wallet-A↔Wallet-B linking field under a name no deny-list enumerates,
    // yet it is not on the positive allow-list, so the post is rejected fail-closed.
    const leaky = { ...canaryClaim(), sessionWallet: 'validator-session-wallet' } as unknown as CanaryClaim;
    await expect(board.post('canary-divergence', leaky, canaryAtt(1), 0)).rejects.toThrow(/allow-list|miner_id|secret/i);
    expect(await board.listOpen()).toHaveLength(0);
  });

  it('ALLOWS a clean canary post (accused relay id + Wallet-B pubkey/sig only)', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    expect(await board.listOpen()).toHaveLength(1);
  });

  it('ALLOWS a cap-token post with a PUBLIC operator address (its own allow-list)', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 1), 0);
    expect(await board.listOpen()).toHaveLength(1);
  });

  it('rejects a post for an UNREGISTERED kind (fail-closed)', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig()]);
    await expect(
      // captoken-issue config not provided
      board.post('captoken-issue', capClaim() as never, capAtt('0xCPa', 1) as never, 0),
    ).rejects.toThrow(/kind/i);
  });
});

describe('GenericClaimBoard — dedup (idempotent per attester key)', () => {
  it('re-posting the same canary Wallet-B pubkey is idempotent (no distinct inflation)', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0);
    await board.post('canary-divergence', canaryClaim(), canaryAtt(1), 0); // same pubkey
    const [cell] = await board.listOpen();
    expect(cell.attestations).toHaveLength(1);
  });

  it('re-posting the same cap-token operator addr is idempotent', async () => {
    const board = new InMemoryGenericClaimBoard([canaryConfig(), capTokenConfig(() => {})]);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 1), 0);
    await board.post('captoken-issue', capClaim(), capAtt('0xCPa', 9), 0); // same addr, diff seed
    const [cell] = await board.listOpen();
    expect(cell.attestations).toHaveLength(1);
  });
});
