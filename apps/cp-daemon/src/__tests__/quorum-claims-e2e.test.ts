/**
 * Multi-CP quorum Phase 1 — Leg 7d: the LIVE-mode wiring + the loopback 2-CP E2E capstone
 * (TDD RED → GREEN).
 *
 * This is the END-TO-END proof that the live `/quorum/claims` transport is a PURE substitution behind
 * the SAME injected `QuorumClaimBoard` port: TWO cp keystores (distinct signer addrs), each backed by a
 * REAL {@link HttpQuorumClaimBoard} (Leg 7b) pointed at ONE REAL Leg-7a `startQuorumClaimsServer`
 * (Leg 7a) on an ephemeral loopback port, assemble a 2-of-2 `verify_quorum`-shaped proof BYTE-IDENTICAL
 * in shape to the in-memory Leg-6 capstone (`aggregateSig = [0x01, ...sig64×2]`).
 *
 * The server holds ONE shared server-side `InMemoryGenericClaimBoard` (the captoken-issue
 * `BoardKindConfig`). Both CP HTTP clients hit the SAME baseUrl + token. CP-A drives
 * `collectQuorumSignatures(canonicalMsg, 2)`; CP-B concurrently signs the SAME canonical bytes and POSTs
 * its self-attestation leg over the live HTTP board. CP-A polls `listOpen()`, sees 2 distinct attesters,
 * and assembles.
 *
 * Asserts:
 *   (e2e-assemble) a real loopback 2-of-2 proof: index-aligned {signers,signatures,pubkeys}, each
 *                  (pubkey,sig) ed25519-verifies the canonical bytes, aggregateSig = [0x01, ...64, ...64].
 *   (e2e-mark)     markSubmitted excludes the cell from a subsequent listOpen.
 *   (e2e-faillout) with only 1 attester posting in the window → the collector ESCALATES + throws
 *                  (fail-LOUD, NOT a silent stall).
 *   (select-on)    the daemon board-selector returns a HttpQuorumClaimBoard when QUORUM_CLAIMS_ENABLED is
 *                  set (+token+port).
 *   (select-off)   the selector returns undefined when QUORUM_CLAIMS_ENABLED is unset → buildLocalCpKeystore
 *                  keeps its hermetic InMemoryGenericClaimBoard default BYTE-IDENTICAL.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { InMemoryGenericClaimBoard, type QuorumClaimBoard } from '@dvconf/shared';
import {
  startQuorumClaimsServer,
  type StartQuorumClaimsResult,
} from '../quorum-claims-server.js';
import { HttpQuorumClaimBoard } from '../quorum-claims-client.js';
import {
  buildCapTokenIssueBoardConfig,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from '../cap-token/index.js';
import { buildLocalCpKeystore, selectQuorumClaimsBoard } from '../index.js';
import type { CpOperator } from '../sui-chain-state-reader.js';

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

const TOKEN = 'quorum-claims-e2e-token-2c5f7a';

/** lowercase hex (no 0x) of bytes — mirrors index.ts canonicalBytesToHex (the captoken-issue cellKey). */
function toHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** A server-side board hosting the captoken-issue kind (production per-kind config). */
function makeServerBoard(): QuorumClaimBoard {
  return new InMemoryGenericClaimBoard([
    buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
  ]);
}

interface ServerFixture {
  handle: StartQuorumClaimsResult;
  baseUrl: string;
  board: QuorumClaimBoard;
}

async function startServerFixture(): Promise<ServerFixture> {
  const board = makeServerBoard();
  const handle = await startQuorumClaimsServer({
    board,
    portOverride: 0,
    authTokenOverride: TOKEN,
    logger: mockLogger(),
  });
  const addr = handle.server.address() as AddressInfo;
  return { handle, baseUrl: `http://127.0.0.1:${addr.port}`, board };
}

/** A REAL HttpQuorumClaimBoard pointed at the live 7a server (the pure-transport substitution). */
function httpBoard(baseUrl: string): HttpQuorumClaimBoard {
  return new HttpQuorumClaimBoard({ baseUrl, token: TOKEN, logger: mockLogger() });
}

/**
 * Build the EXACT cell CLAIM the index.ts collector posts (cellKey = canonicalMsgHex). CP-A and CP-B
 * independently re-derive the identical canonical bytes → identical canonicalMsgHex → the SAME cell.
 * The non-key fields are advisory (the attestations carry the signed bytes).
 */
function issueClaim(canonicalMsg: Uint8Array): CapTokenIssueClaim {
  return {
    kind: 'captoken-issue',
    roomId: '0x' + '00'.repeat(32),
    peerPubkey: new Array(32).fill(0),
    role: 0,
    // wire-safe advisory expiry (number, not bigint) — mirrors the production collector claim
    // (index.ts), so `JSON.stringify` over the live HTTP board never trips on a `bigint`.
    expiresEpoch: 0 as unknown as bigint,
    nonce: 1,
    canonicalMsgHex: toHex(canonicalMsg),
  };
}

/** CP-B's self-attestation leg — RAW ed25519 over the SAME canonical bytes (single-CP-branch shape). */
async function selfAttest(
  signer: Ed25519Keypair,
  canonicalMsg: Uint8Array,
): Promise<CapTokenIssueAttestation> {
  const sig = await signer.sign(canonicalMsg);
  return {
    signature: Array.from(sig.slice(0, 64)),
    pubkey: Array.from(signer.getPublicKey().toRawBytes()),
    addr: signer.toSuiAddress(),
  };
}

describe('Leg 7d — loopback 2-CP E2E over a REAL 7a server + REAL HTTP clients', () => {
  // Each test owns its server lifetime via try/finally so ALL collector HTTP work (every poll/post)
  // is strictly bounded by an UP server — no stray in-flight request can outlive the close and leak
  // an unhandled ECONNREFUSED across tests (deterministic settle + bounded poll + unique ids).

  it('(e2e-assemble + e2e-mark) two CPs over loopback HTTP assemble a 2-of-2 verify_quorum-shaped proof byte-identical to the in-memory capstone, then markSubmitted excludes the cell', async () => {
    const fx = await startServerFixture();
    try {
      const cpA = Ed25519Keypair.generate();
      const cpB = Ed25519Keypair.generate();
      // Unique per-test canonical bytes so a repeat run never re-uses a prior cell key.
      const canonicalMsg = new TextEncoder().encode(`leg7d-e2e-assemble-${cpA.toSuiAddress()}`);

      const discoveredCps: CpOperator[] = [
        { minerId: '0xa', operator: cpA.toSuiAddress() },
        { minerId: '0xb', operator: cpB.toSuiAddress() },
      ];

      // CP-A's keystore is backed by a REAL HTTP board → the same live 7a server.
      const keystoreA = buildLocalCpKeystore({
        signer: cpA,
        logger: mockLogger(),
        quorumCollector: {
          board: httpBoard(fx.baseUrl),
          discoveredCps,
          minQuorum: 2,
          pollIntervalMs: 5,
          maxPollRounds: 400,
        },
      });

      // CP-B independently posts its self-attestation leg over its OWN REAL HTTP board (same server).
      const boardB = httpBoard(fx.baseUrl);
      const claim = issueClaim(canonicalMsg);
      const attB = await selfAttest(cpB, canonicalMsg);
      // Deterministic settle: CP-B's leg is posted BEFORE CP-A collects, so the first poll round
      // already sees 2 distinct attesters (no timing race on the assemble path).
      await boardB.post('captoken-issue', claim, attB, 0);
      const { qs, pubkeys, aggregateSig } = await keystoreA.collectQuorumSignatures(
        canonicalMsg,
        2,
      );

      // ── 2 distinct signers, index-aligned arrays ──
      expect(qs.signers.length).toBe(2);
      expect(qs.signatures.length).toBe(2);
      expect(pubkeys.length).toBe(2);
      expect(new Set(qs.signers)).toEqual(
        new Set([cpA.toSuiAddress(), cpB.toSuiAddress()]),
      );

      // ── each (pubkey, sig) ed25519-verifies the canonical bytes (index-aligned) ──
      for (let i = 0; i < qs.signers.length; i++) {
        const pk = new Ed25519PublicKey(Uint8Array.from(pubkeys[i]));
        expect(await pk.verify(canonicalMsg, Uint8Array.from(qs.signatures[i]))).toBe(true);
      }

      // ── byte-identical SHAPE to the Leg-6 in-memory capstone: aggregateSig = [0x01, ...64, ...64] ──
      expect(aggregateSig[0]).toBe(0x01);
      expect(aggregateSig.length).toBe(1 + 64 + 64);

      // ── markSubmitted excluded the cell from a subsequent listOpen (collector calls it on assemble) ──
      const open = await boardB.listOpen();
      const cellKey = `captoken-issue|${toHex(canonicalMsg)}`;
      expect(open.find((c) => c.key === cellKey)).toBeUndefined();
    } finally {
      await fx.handle.stop();
    }
  });

  it('(e2e-faillout) only 1 attester posts within the window → the collector escalates + throws (fail-LOUD, not a silent stall)', async () => {
    const fx = await startServerFixture();
    try {
      const cpA = Ed25519Keypair.generate();
      const cpB = Ed25519Keypair.generate();
      const logger = mockLogger();
      const canonicalMsg = new TextEncoder().encode(`leg7d-e2e-faillout-${cpA.toSuiAddress()}`);

      const keystoreA = buildLocalCpKeystore({
        signer: cpA,
        logger,
        quorumCollector: {
          board: httpBoard(fx.baseUrl),
          // CP-B is a registered operator but NEVER posts → only CP-A's leg accrues → quorum unreachable.
          discoveredCps: [
            { minerId: '0xa', operator: cpA.toSuiAddress() },
            { minerId: '0xb', operator: cpB.toSuiAddress() },
          ],
          minQuorum: 2,
          pollIntervalMs: 2,
          maxPollRounds: 8, // bounded window → fail-LOUD after it elapses
        },
      });

      // The whole collect (self-post + bounded poll + final gc + throw) is AWAITED to settle before
      // the finally closes the server — no in-flight request can leak past the close.
      await expect(keystoreA.collectQuorumSignatures(canonicalMsg, 2)).rejects.toThrow(
        /quorum|escalat|distinct|peer-CP/i,
      );
      // fail-LOUD must be VISIBLE (an ERROR log, not a silent stall).
      expect(logger.error).toHaveBeenCalled();
    } finally {
      await fx.handle.stop();
    }
  });
});

describe('Leg 7d — live-mode board selection helper', () => {
  it('(select-off) QUORUM_CLAIMS_ENABLED unset → returns undefined (hermetic InMemory default unchanged)', () => {
    const board = selectQuorumClaimsBoard({
      env: {}, // QUORUM_CLAIMS_ENABLED unset
      logger: mockLogger(),
    });
    expect(board).toBeUndefined();
  });

  it('(select-off-token) QUORUM_CLAIMS_ENABLED set but token unset → fail-LOUD (refuse to build a live board)', () => {
    expect(() =>
      selectQuorumClaimsBoard({
        env: { QUORUM_CLAIMS_ENABLED: '1' }, // no QUORUM_CLAIMS_AUTH_TOKEN
        logger: mockLogger(),
      }),
    ).toThrow(/QUORUM_CLAIMS_AUTH_TOKEN/i);
  });

  it('(select-on) QUORUM_CLAIMS_ENABLED + token + port → returns a HttpQuorumClaimBoard at the local loopback carrier', () => {
    const board = selectQuorumClaimsBoard({
      env: {
        QUORUM_CLAIMS_ENABLED: '1',
        QUORUM_CLAIMS_AUTH_TOKEN: TOKEN,
        QUORUM_CLAIMS_PORT: '8092',
      },
      logger: mockLogger(),
    });
    expect(board).toBeInstanceOf(HttpQuorumClaimBoard);
    expect((board as HttpQuorumClaimBoard).baseUrl).toBe('http://127.0.0.1:8092');
  });
});
