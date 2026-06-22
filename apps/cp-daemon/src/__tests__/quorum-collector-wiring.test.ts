/**
 * Multi-CP quorum Phase 1 — Leg 6 (collector wiring / integration capstone) tests
 * (TDD RED → GREEN).
 *
 * DESIGN-connection-arch.md build-seams + ROADMAP Leg 6: REPLACE the `threshold>=2`
 * THROW in `buildLocalCpKeystore.collectQuorumSignatures` (index.ts ~153-162) with a
 * board-backed collector:
 *   1. post the LOCAL CP's own self-attestation leg (RAW ed25519 over the canonical
 *      message, single-CP-branch shape) to an INJECTED `QuorumClaimBoard`
 *      (`InMemoryGenericClaimBoard` from `@dvconf/shared`, a `captoken-issue`
 *      `BoardKindConfig`),
 *   2. poll `listOpen()` until the cell reaches `minQuorum` DISTINCT attesters
 *      (threshold from Leg-1 `readMinQuorum`; hermetic tests inject it), then
 *   3. call Leg-4 `assembleCapTokenQuorum` → `{ qs:{signers,signatures}, pubkeys,
 *      aggregateSig }` — the EXACT single-CP shape (index.ts:147-151) the FROZEN
 *      `makeCapTokenSubmitter` consumer accepts UNCHANGED.
 *
 * The board MUST be INJECTED (so Leg 7 can swap `InMemoryGenericClaimBoard` for the
 * live `/quorum/claims` HTTP board behind the SAME `QuorumClaimBoard` port — a pure
 * transport substitution). It is NOT hard-coded inside the collector.
 *
 * FAIL-LOUD (Fork-5): if the cell does NOT reach `minQuorum` distinct within the
 * bounded poll window, the collector ESCALATES + throws (a blocked room-join must be
 * VISIBLE) — NOT a silent stall.
 *
 * Asserts:
 *   (a) threshold<=1 path is BYTE-IDENTICAL (single-CP RAW ed25519 unchanged).
 *   (b) threshold>=2 with 2 distinct CP self-attestations posted to the injected board
 *       → poll → assemble → a verify_quorum-shaped proof with index-aligned arrays.
 *   (c) <minQuorum within the window → fail-LOUD escalation (throw, not silent).
 *   (d) `selectProductionSubmitFn` threshold>=2 no longer throws on the deferred stub
 *       path — it routes to the board-backed collector.
 */
import { describe, it, expect, vi } from 'vitest';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import {
  InMemoryGenericClaimBoard,
  type BoardKindConfig,
  type QuorumClaimBoard,
} from '@dvconf/shared';
import { buildLocalCpKeystore, selectProductionSubmitFnForTest } from '../index.js';
import {
  buildCapTokenIssueBoardConfig,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from '../cap-token-issuer.js';
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

/** lowercase hex (no 0x) of bytes — the board cellKey for a captoken-issue cell. */
function toHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Build a captoken-issue board with the production per-kind config (escalation hook injected). */
function makeBoard(onEscalate: (key: string) => void): QuorumClaimBoard {
  const cfg: BoardKindConfig<CapTokenIssueClaim, CapTokenIssueAttestation> =
    buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: onEscalate });
  return new InMemoryGenericClaimBoard([cfg]);
}

describe('Leg 6 — board-backed collectQuorumSignatures (multi-CP collector wiring)', () => {
  it('(a) threshold<=1 path stays BYTE-IDENTICAL: single-CP RAW ed25519 over the canonical message verifies, unchanged shape', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    const canonicalMsg = new TextEncoder().encode('single-cp-canonical-bytes');

    const { qs, pubkeys, aggregateSig } = await keystore.collectQuorumSignatures(canonicalMsg, 1);

    expect(qs.signers).toEqual([signer.toSuiAddress()]);
    expect(qs.signatures.length).toBe(1);
    expect(qs.signatures[0].length).toBe(64);
    expect(pubkeys).toEqual([Array.from(signer.getPublicKey().toRawBytes())]);
    // single-CP aggregateSig is EXACTLY [0x01, ...sig64] (byte-identical to the original branch).
    expect(aggregateSig).toEqual([0x01, ...qs.signatures[0]]);

    const pk = new Ed25519PublicKey(Uint8Array.from(pubkeys[0]));
    expect(await pk.verify(canonicalMsg, Uint8Array.from(qs.signatures[0]))).toBe(true);
  });

  it('(b) threshold>=2: 2 distinct CP self-attestations on the INJECTED board → poll → assemble → index-aligned verify_quorum-shaped proof', async () => {
    const self = Ed25519Keypair.generate();
    const peer = Ed25519Keypair.generate();
    const canonicalMsg = new TextEncoder().encode('multi-cp-canonical-issue-bytes');
    const cellHex = toHex(canonicalMsg);

    const board = makeBoard(() => {});
    const discoveredCps: CpOperator[] = [
      { minerId: '0xself', operator: self.toSuiAddress() },
      { minerId: '0xpeer', operator: peer.toSuiAddress() },
    ];

    // Simulate the synthetic PEER's self-attestation already on the shared board (it
    // independently signed the SAME canonical bytes).
    const peerSig = await peer.sign(canonicalMsg);
    const peerAtt: CapTokenIssueAttestation = {
      signature: Array.from(peerSig.slice(0, 64)),
      pubkey: Array.from(peer.getPublicKey().toRawBytes()),
      addr: peer.toSuiAddress(),
    };
    const claim: CapTokenIssueClaim = {
      kind: 'captoken-issue',
      roomId: '0x' + '11'.repeat(32),
      peerPubkey: new Array(32).fill(0x22),
      role: 2,
      expiresEpoch: 200n,
      nonce: 1,
      canonicalMsgHex: cellHex,
    };
    await board.post('captoken-issue', claim, peerAtt, 0);

    const keystore = buildLocalCpKeystore({
      signer: self,
      logger: mockLogger(),
      quorumCollector: {
        board,
        discoveredCps,
        minQuorum: 2,
        pollIntervalMs: 1,
        maxPollRounds: 50,
      },
    });

    const { qs, pubkeys, aggregateSig } = await keystore.collectQuorumSignatures(canonicalMsg, 2);

    // ── two distinct signers, index-aligned arrays ──
    expect(qs.signers.length).toBe(2);
    expect(qs.signatures.length).toBe(2);
    expect(pubkeys.length).toBe(2);
    expect(new Set(qs.signers)).toEqual(new Set([self.toSuiAddress(), peer.toSuiAddress()]));

    // ── verify_quorum-shaped consumer ACCEPTS the assembled proof (M=2 of N=2) ──
    const registered = new Set([self.toSuiAddress(), peer.toSuiAddress()]);
    for (let i = 0; i < qs.signers.length; i++) {
      expect(registered.has(qs.signers[i])).toBe(true);
      const pk = new Ed25519PublicKey(Uint8Array.from(pubkeys[i]));
      expect(await pk.verify(canonicalMsg, Uint8Array.from(qs.signatures[i]))).toBe(true);
    }
    // aggregateSig = [0x01, ...64, ...64] audit blob (vestigial, never on-chain-parsed).
    expect(aggregateSig[0]).toBe(0x01);
    expect(aggregateSig.length).toBe(1 + 64 + 64);
  });

  it('(c) <minQuorum within the poll window → fail-LOUD escalation (throws; not a silent stall)', async () => {
    const self = Ed25519Keypair.generate();
    const canonicalMsg = new TextEncoder().encode('lonely-cp-no-peer-bytes');

    let escalated = false;
    const board = makeBoard(() => {
      escalated = true;
    });
    const logger = mockLogger();
    const keystore = buildLocalCpKeystore({
      signer: self,
      logger,
      quorumCollector: {
        board,
        discoveredCps: [{ minerId: '0xself', operator: self.toSuiAddress() }],
        minQuorum: 2, // need 2 distinct, only self posts → never reached
        pollIntervalMs: 1,
        maxPollRounds: 5, // bounded window → fail-loud after expiry
      },
    });

    // Only the local CP posts → never reaches 2 distinct → must FAIL-LOUD (throw).
    await expect(keystore.collectQuorumSignatures(canonicalMsg, 2)).rejects.toThrow(
      /quorum|escalat|distinct|peer-CP/i,
    );
    // Fail-LOUD must be VISIBLE: an error log was emitted (not a silent stall).
    expect(logger.error).toHaveBeenCalled();
    expect(escalated).toBe(true);
  });

  it('(d) selectProductionSubmitFn threshold>=2 WITH a client no longer routes to the deferred stub — it routes to the real submitter (no "deferred" throw)', async () => {
    const signer = Ed25519Keypair.generate();
    const baseOpts = {
      signer,
      logger: mockLogger(),
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
    };

    // threshold>=2 WITH a wired client → the real `makeCapTokenSubmitter` path (collection
    // happens inside the keystore), NOT the throwing deferred stub. The deferred stub throws
    // the "deferred" marker (essentially) immediately; the real submitter instead attempts a
    // PTB against the stub client and does NOT carry that marker. We race the call against a
    // short timer: if it does not throw the "deferred" marker promptly, the DEFERRED route was
    // NOT taken (the only thing this test asserts).
    const withClient = selectProductionSubmitFnForTest({
      ...baseOpts,
      quorumThreshold: 2,
      client: { mock: true } as any,
    });
    expect(typeof withClient).toBe('function');
    const NOT_DEFERRED = Symbol('not-deferred');
    const raced = await Promise.race([
      withClient({ label: 'issue-capability-token', args: {} }).then(
        () => NOT_DEFERRED,
        (e: Error) => (/deferred/i.test(e.message) ? 'DEFERRED' : NOT_DEFERRED),
      ),
      new Promise<typeof NOT_DEFERRED>((resolve) => setTimeout(() => resolve(NOT_DEFERRED), 200)),
    ]);
    expect(raced).toBe(NOT_DEFERRED);

    // threshold>=2 WITHOUT a client → the deferred stub still throws the "deferred" marker.
    const noClient = selectProductionSubmitFnForTest({ ...baseOpts, quorumThreshold: 2 });
    await expect(noClient({ label: 'issue-capability-token', args: {} })).rejects.toThrow(
      /deferred/i,
    );
  });
});
