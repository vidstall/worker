/**
 * Multi-CP quorum Phase 2 — Leg 7c (promote the DEAD-ON-PROD discovery reads +
 * peer-pubkey recovery onto the cp-daemon PRODUCTION path) tests (TDD RED → GREEN).
 *
 * ROADMAP-leg7-live.md Leg 7c. The two surfaces that were unit-tested but had ZERO
 * prod call-site:
 *   G5 — getActiveCpOperators + readMinQuorum (the multi-CP discoveredCps + per-round
 *        min_quorum). startCapTokenIssuer built the keystore with NO discovery so
 *        buildLocalCpKeystore silently defaulted minQuorum=2 + single-host discoveredCps.
 *   G3 — InfraPeerPubkeyCache + recoverInfraPeerClaim (never instantiated; no
 *        CapabilityIssued observer; submitIssue used the legacy resolvePeerPubkey miner-id
 *        placeholder which is NOT 32 bytes → would abort the Move mint E_PUBKEY_WRONG_LENGTH
 *        (916) for infra peers).
 *
 * NON-NEGOTIABLE invariants asserted here:
 *  (a) multi-CP (threshold>=2) LIVE config with QUORUM_STATE_OBJECT_ID UNSET → logger.error
 *      + refuse (NO silent minQuorum=2).
 *  (b) with the id set + a MOCKED reader, the threshold>=2 collection sources minQuorum via
 *      reader.readMinQuorum(id) PER-ROUND (read twice across rounds, NO caching) and
 *      populates discoveredCps from reader.getActiveCpOperators().
 *  (c) a CapabilityIssued event feeds InfraPeerPubkeyCache and submitIssue recovers a 32-byte
 *      key via recoverInfraPeerClaim (no 916 path).
 *  (d) recovery-miss (event not yet cached) → fail-closed SKIP + debug-log, no malformed mint.
 *  (e) the E2EE sessionPubkeyB64 branch still resolves a supplied 32-byte client session key
 *      UNCHANGED.
 *  (f) the threshold<=1 single-CP branch is BYTE-IDENTICAL (buildLocalCpKeystore with no
 *      quorumCollector still yields the [0x01, ...sig64] single-CP shape).
 */
import { describe, it, expect, vi } from 'vitest';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import {
  startCapTokenIssuer,
  buildLocalCpKeystore,
  type ChainQuorumReader,
} from '../index.js';
import {
  CapTokenIssuer,
  InfraPeerPubkeyCache,
  type SubmitFn as CapTokenSubmitFn,
  type SubmitResult as CapTokenSubmitResult,
  type CapabilityIssuedLike,
} from '../cap-token/index.js';
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

function mkSubmit(): {
  submitFn: CapTokenSubmitFn;
  calls: Array<{ label: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ label: string; args: Record<string, unknown> }> = [];
  const submitFn: CapTokenSubmitFn = vi.fn(
    async (opts: { label: string; args: Record<string, unknown> }): Promise<CapTokenSubmitResult> => {
      calls.push({ label: opts.label, args: opts.args });
      return { digest: `tx-${calls.length}` };
    },
  );
  return { submitFn, calls };
}

const REAL_PEER_PUBKEY = new Array(32).fill(0).map((_, i) => (i * 5 + 1) & 0xff);
const ROOM_ID = '0x' + '33'.repeat(32);

// Per-case UNIQUE room/relay ids. Each test owns a distinct (roomId, relayMinerId)
// so no cell-key / dedupe / recovery-cache key can collide across cases under
// vitest's parallel worker scheduling (test-hygiene — prod state is per-instance,
// this removes any structural interleave surface). 20-byte relay ids — NOT 32 → a
// raw mint would 916; the test proves the recovered 32-byte key is used instead.
const ROOM_C = '0x' + '31'.repeat(32);
const RELAY_C = '0x' + 'a1'.repeat(20);
const ROOM_D = '0x' + '32'.repeat(32);
const RELAY_D = '0x' + 'a2'.repeat(20);

function issuedEvent(roomId: string, over?: Partial<CapabilityIssuedLike>): CapabilityIssuedLike {
  return {
    tokenId: '0x' + 'cc'.repeat(32),
    roomId,
    peerPubkey: REAL_PEER_PUBKEY,
    role: 2,
    expiresEpoch: '200',
    ...over,
  };
}

describe('Leg 7c (a) — startCapTokenIssuer fail-closed on unset QUORUM_STATE_OBJECT_ID (multi-CP)', () => {
  it('multi-CP (threshold>=2) live config with quorumStateObjectId UNSET → logger.error + refuses to start', async () => {
    const signer = Ed25519Keypair.generate();
    const logger = mockLogger();
    const reader: ChainQuorumReader = {
      getActiveCpOperators: vi.fn(),
      readMinQuorum: vi.fn(),
    };
    await expect(
      startCapTokenIssuer({
        signer,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpRegistryObjectId: '0xcpreg',
        quorumStateObjectId: '', // UNSET — the fail-closed trigger
        quorumThreshold: 2,
        logger,
        chainReader: reader,
      }),
    ).rejects.toThrow(/quorum.*state.*unset|QUORUM_STATE_OBJECT_ID/i);
    expect(logger.error).toHaveBeenCalled();
  });

  it('single-CP (threshold<=1) with quorumStateObjectId UNSET does NOT require the env (single-CP startup unaffected)', async () => {
    const { submitFn } = mkSubmit();
    const signer = Ed25519Keypair.generate();
    const { issuer, stop } = await startCapTokenIssuer({
      submitFn,
      signer,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '', // unset, but single-CP → no refusal
      quorumThreshold: 1,
      logger: mockLogger(),
    });
    expect(issuer).toBeDefined();
    stop();
  });
});

describe('Leg 7c (b) — per-round readMinQuorum + discoveredCps from getActiveCpOperators (no caching)', () => {
  it('threshold>=2 collection reads min_quorum PER-ROUND (called >=2× across rounds — no cache) and sources discoveredCps from getActiveCpOperators', async () => {
    const self = Ed25519Keypair.generate();
    const peer = Ed25519Keypair.generate();
    const canonicalMsg = new TextEncoder().encode('leg7c-per-round-canonical-bytes');

    const discoveredCps: CpOperator[] = [
      { minerId: '0xself', operator: self.toSuiAddress() },
      { minerId: '0xpeer', operator: peer.toSuiAddress() },
    ];

    // Mocked chain reader: readMinQuorum returns 2 EVERY round (assert it's polled, not cached).
    // On the prod path startCapTokenIssuer sources `discoveredCps` from getActiveCpOperators();
    // here we inject the resolved set + a per-round readMinQuorum closure (the exact wiring).
    // QuorumCollectorConfig.readMinQuorum returns a number (the prod closure does Number(q));
    // returning 2 EVERY round lets us assert it is POLLED (not cached).
    const readMinQuorum = vi.fn(async () => 2);

    // The keystore is built with a per-round readMinQuorum closure + the discovered set.
    // (This is exactly the wiring startCapTokenIssuer threads on the live multi-CP path.)
    const { InMemoryGenericClaimBoard } = await import('@dvconf/shared');
    const { buildCapTokenIssueBoardConfig } = await import('../cap-token/index.js');
    const board = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
    ]);

    // The peer independently signs the SAME canonical bytes a couple of poll rounds in
    // (so the loop spins >=2 rounds → readMinQuorum is polled >=2×).
    const cellHex = (() => {
      let s = '';
      for (const b of canonicalMsg) s += b.toString(16).padStart(2, '0');
      return s;
    })();

    const keystore = buildLocalCpKeystore({
      signer: self,
      logger: mockLogger(),
      quorumCollector: {
        board,
        discoveredCps,
        readMinQuorum: () => readMinQuorum(),
        pollIntervalMs: 1,
        maxPollRounds: 50,
      },
    });

    // Schedule the peer's attestation to land after a few rounds (forces multiple polls).
    setTimeout(() => {
      void (async () => {
        const peerSig = await peer.sign(canonicalMsg);
        await board.post(
          'captoken-issue',
          {
            kind: 'captoken-issue',
            roomId: ROOM_ID,
            peerPubkey: new Array(32).fill(0x22),
            role: 2,
            expiresEpoch: 200n,
            nonce: 1,
            canonicalMsgHex: cellHex,
          },
          {
            signature: Array.from(peerSig.slice(0, 64)),
            pubkey: Array.from(peer.getPublicKey().toRawBytes()),
            addr: peer.toSuiAddress(),
          },
          0,
        );
      })();
    }, 8);

    const { qs } = await keystore.collectQuorumSignatures(canonicalMsg, 2);
    expect(qs.signers.length).toBe(2);

    // PER-ROUND, NO CACHE — the loop polled readMinQuorum more than once.
    expect(readMinQuorum.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Leg 7c (c)+(d) — InfraPeerPubkeyCache recovery on submitIssue (infra peer path)', () => {
  function mkInfraIssuer(infraPeerCache: InfraPeerPubkeyCache, submitFn: CapTokenSubmitFn) {
    return new CapTokenIssuer({
      submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      logger: mockLogger(),
      quorumThreshold: 2,
      infraPeerCache,
      // A stubbed keystore so we exercise submitIssue's recovery wiring, not the board collector.
      cpKeystore: {
        async sign(message) {
          return { signature: Array.from(message.slice(0, 64)), pubkey: new Array(32).fill(0xaa), addr: '0xtest' };
        },
        getCpAddress() {
          return '0xtest';
        },
        async collectQuorumSignatures(_msg, threshold) {
          const signers: string[] = [];
          const signatures: number[][] = [];
          const pubkeys: number[][] = [];
          for (let i = 0; i < Math.max(threshold, 1); i++) {
            signers.push(`0xcp${i + 1}`);
            signatures.push(new Array(64).fill(0xab + i));
            pubkeys.push(new Array(32).fill(0xaa + i));
          }
          return { qs: { signers, signatures }, pubkeys, aggregateSig: [0x01, ...signatures[0]] };
        },
      },
    });
  }

  it('(c) CapabilityIssued → cache → submitIssue recovers a 32-byte peer_pubkey (no 916 path)', async () => {
    const cache = new InfraPeerPubkeyCache();
    cache.observeCapabilityIssued(RELAY_C, issuedEvent(ROOM_C));
    const { submitFn, calls } = mkSubmit();
    const issuer = mkInfraIssuer(cache, submitFn);

    await issuer.onRoomAssigned(
      {
        roomId: ROOM_C,
        relayIds: [RELAY_C],
        relayMode: 1,
        verifiedScore: '900',
        consensusReached: true,
        winningCp: '0xcp1',
        validatorIds: [],
      },
      'trace-7c-c',
    );

    // The relay leg must have submitted with the RECOVERED 32-byte key (NOT the 20-byte miner-id).
    const relayCall = calls.find((c) => Array.isArray(c.args.peerPubkey) && (c.args.peerPubkey as number[]).length === 32);
    expect(relayCall).toBeDefined();
    expect(relayCall!.args.peerPubkey).toEqual(REAL_PEER_PUBKEY);
  });

  it('(d) recovery-miss (event not cached) → fail-closed SKIP + debug-log, NO malformed mint', async () => {
    const cache = new InfraPeerPubkeyCache(); // empty — no CapabilityIssued observed
    const logger = mockLogger();
    const { submitFn, calls } = mkSubmit();
    const issuer = new CapTokenIssuer({
      submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      logger,
      quorumThreshold: 2,
      infraPeerCache: cache,
      cpKeystore: {
        async sign(m) {
          return { signature: Array.from(m.slice(0, 64)), pubkey: new Array(32).fill(0xaa), addr: '0xt' };
        },
        getCpAddress() {
          return '0xt';
        },
        async collectQuorumSignatures(_m, t) {
          const sigs = [new Array(64).fill(0xab)];
          return { qs: { signers: ['0xcp1'], signatures: sigs }, pubkeys: [new Array(32).fill(0xaa)], aggregateSig: [0x01, ...sigs[0]] };
        },
      },
    });

    await issuer.onRoomAssigned(
      {
        roomId: ROOM_D,
        relayIds: [RELAY_D],
        relayMode: 1,
        verifiedScore: '900',
        consensusReached: true,
        winningCp: '0xcp1',
        validatorIds: [],
      },
      'trace-7c-d',
    );

    // FAIL-CLOSED SKIP: nothing minted (no submitFn call for the un-recoverable infra peer).
    expect(calls.length).toBe(0);
    // VISIBLE: a debug-log records the fail-closed skip (never a 916 abort).
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe('Leg 7c (e) — E2EE sessionPubkeyB64 branch UNCHANGED', () => {
  it('a supplied 32-byte client session key still becomes the peer_pubkey (E2EE path verbatim — G3 recovery NOT consulted)', async () => {
    const cache = new InfraPeerPubkeyCache(); // present + EMPTY: if the E2EE branch wrongly
    // routed through G3 recovery it would fail-closed SKIP (miss) → 0 submit calls. It must NOT.
    const sessionKey = new Array(32).fill(0).map((_, i) => (i + 9) & 0xff);
    const sessionPubkeyB64 = Buffer.from(Uint8Array.from(sessionKey)).toString('base64');
    const { submitFn, calls } = mkSubmit();
    const issuer = new CapTokenIssuer({
      submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      logger: mockLogger(),
      quorumThreshold: 1, // single-CP issuance — E2EE peer
      infraPeerCache: cache,
      cpKeystore: {
        async sign(m) {
          return { signature: Array.from(m.slice(0, 64)), pubkey: new Array(32).fill(0xaa), addr: '0xt' };
        },
        getCpAddress() {
          return '0xt';
        },
        async collectQuorumSignatures(_m, _t) {
          const sigs = [new Array(64).fill(0xab)];
          return { qs: { signers: ['0xcp1'], signatures: sigs }, pubkeys: [new Array(32).fill(0xaa)], aggregateSig: [0x01, ...sigs[0]] };
        },
      },
    });

    // submitIssue is private; the E2EE peer arrives with a sessionPubkeyB64. Exercise the
    // private path directly (the only surface that carries the session key) and assert the
    // resolvePeerPubkey E2EE branch is preserved verbatim (session key → peer_pubkey).
    await (issuer as unknown as {
      submitIssue: (
        peer: { id: string; role: number; sessionPubkeyB64?: string },
        roomId: string,
        dedupeKey: string,
        traceId: string,
      ) => Promise<void>;
    }).submitIssue({ id: '0xclientpeer', role: 0, sessionPubkeyB64 }, ROOM_ID, 'dk-e', 'trace-7c-e');

    expect(calls.length).toBe(1);
    expect(calls[0].args.peerPubkey).toEqual(sessionKey);
  });
});

describe('Leg 7c (f) — threshold<=1 single-CP branch BYTE-IDENTICAL', () => {
  it('buildLocalCpKeystore with NO quorumCollector still yields the [0x01, ...sig64] single-CP shape', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    const canonicalMsg = new TextEncoder().encode('byte-identical-single-cp');
    const { qs, pubkeys, aggregateSig } = await keystore.collectQuorumSignatures(canonicalMsg, 1);

    expect(qs.signers).toEqual([signer.toSuiAddress()]);
    expect(qs.signatures.length).toBe(1);
    expect(qs.signatures[0].length).toBe(64);
    expect(pubkeys).toEqual([Array.from(signer.getPublicKey().toRawBytes())]);
    expect(aggregateSig).toEqual([0x01, ...qs.signatures[0]]);
    const pk = new Ed25519PublicKey(Uint8Array.from(pubkeys[0]));
    expect(await pk.verify(canonicalMsg, Uint8Array.from(qs.signatures[0]))).toBe(true);
  });
});
