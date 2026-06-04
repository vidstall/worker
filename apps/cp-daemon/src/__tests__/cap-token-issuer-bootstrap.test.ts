/**
 * F62 M1 Stage 4 / Item #1 — cp-daemon bootstrap factory tests (TDD RED → GREEN).
 *
 * Spec source: ROADMAP § Phase 3.5.1 + STATUS.md § Stage 4 readiness #1.
 *
 * Mirrors the existing turn-issuer.ts `startTurnIssuer` factory pattern. The
 * factory constructs a `CapTokenIssuer` with:
 *   - SubmitFn DI (production wires to `executeWithRetry` per dvconf-daemons
 *     turn-issuer.ts:296-349 precedent)
 *   - LocalCpKeystore (signs with the local Ed25519 key + collects M-of-N
 *     signatures from peer CPs if discovered; degraded single-CP throw if no
 *     peers configured — daemon absorbs the throw + logs ERROR per
 *     cap-token-issuer.ts:291 pattern)
 *
 * Decision deferred under D-014: peer-CP discovery is env-var-driven (single
 * delimited list of peer endpoint URLs); when empty, LocalCpKeystore throws on
 * `collectQuorumSignatures` for any threshold ≥ 2. Stage 4 daemon-main wires the
 * factory; production peer-CP discovery topology is post-thesis.
 */
import { describe, it, expect, vi } from 'vitest';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import {
  startCapTokenIssuer,
  buildLocalCpKeystore,
} from '../index.js';
import type {
  SubmitFn as CapTokenSubmitFn,
  SubmitResult as CapTokenSubmitResult,
} from '../cap-token-issuer.js';

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

describe('startCapTokenIssuer (Item #1 — cp-daemon bootstrap factory)', () => {
  it('returns an issuer instance + stop() handle', async () => {
    const { submitFn } = mkSubmit();
    const signer = Ed25519Keypair.generate();
    const { issuer, stop } = await startCapTokenIssuer({
      submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      signer,
      logger: mockLogger(),
    });
    expect(issuer).toBeDefined();
    expect(typeof issuer.onRoomAssigned).toBe('function');
    expect(typeof stop).toBe('function');
    stop();
  });

  it('default keystore signs with the local keypair (sign() returns 64-byte signature)', async () => {
    const { submitFn } = mkSubmit();
    const signer = Ed25519Keypair.generate();
    const { issuer, stop } = await startCapTokenIssuer({
      submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      signer,
      logger: mockLogger(),
    });
    expect(issuer).toBeDefined();
    stop();
  });

  it('default keystore.getCpAddress() returns the local signer address', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    expect(keystore.getCpAddress()).toBe(signer.toSuiAddress());
  });

  it('default keystore.sign() returns the local signer signature + pubkey + addr', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    const msg = new TextEncoder().encode('test-message');
    const out = await keystore.sign(msg);
    expect(out.signature.length).toBe(64);
    expect(out.pubkey.length).toBe(32);
    expect(out.addr).toBe(signer.toSuiAddress());
  });

  // ── W-P3.5b (OQ-CRR-9 / REQ-ADW-003) — RAW ed25519, not Sui intent-wrapped ──
  //
  // Move `cp_quorum_sig::verify_quorum` does `ed25519_verify` over the RAW canonical
  // bytes. `buildLocalCpKeystore` must therefore sign RAW (signer.sign), NOT
  // intent-wrapped (signer.signPersonalMessage). The verify primitive below is the
  // SAME one Move uses: `Ed25519PublicKey.verify(canonicalMsg, sig64)`.
  it('sign() produces a RAW ed25519 signature that verifies against the message with Ed25519PublicKey.verify (the Move primitive)', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    const msg = new TextEncoder().encode('cp-quorum-canonical-message');
    const out = await keystore.sign(msg);

    const sig64 = Uint8Array.from(out.signature);
    expect(sig64.length).toBe(64);
    const pubkey = new Ed25519PublicKey(signer.getPublicKey().toRawBytes());
    // RAW verification MUST pass (Move ed25519_verify over canonical bytes).
    expect(await pubkey.verify(msg, sig64)).toBe(true);

    // Negative control: the intent-wrapped (signPersonalMessage) sig would NOT
    // verify raw against the plain message — prove the old code path fails this.
    const { signature: wrapped } = await signer.signPersonalMessage(msg);
    const wrapped64 = Uint8Array.from(Buffer.from(wrapped, 'base64').subarray(0, 64));
    expect(await pubkey.verify(msg, wrapped64)).toBe(false);
  });

  it('collectQuorumSignatures(threshold=1) produces a RAW ed25519 sig that verifies against the canonical message (Move verify_quorum parity)', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    const canonicalMsg = new TextEncoder().encode('canonical-revoke-or-issue-bytes');
    const { qs, pubkeys } = await keystore.collectQuorumSignatures(canonicalMsg, 1);

    expect(qs.signers).toEqual([signer.toSuiAddress()]);
    expect(qs.signatures.length).toBe(1);
    expect(qs.signatures[0].length).toBe(64);
    expect(pubkeys).toEqual([Array.from(signer.getPublicKey().toRawBytes())]);

    const sig64 = Uint8Array.from(qs.signatures[0]);
    const pubkey = new Ed25519PublicKey(Uint8Array.from(pubkeys[0]));
    // RAW verification MUST pass — byte-verifiable by Move ed25519_verify.
    expect(await pubkey.verify(canonicalMsg, sig64)).toBe(true);
  });

  it('default keystore.collectQuorumSignatures throws when threshold >= 2 and no peer-CPs are configured (degraded mode is documented)', async () => {
    const signer = Ed25519Keypair.generate();
    const keystore = buildLocalCpKeystore({ signer, logger: mockLogger() });
    const msg = new TextEncoder().encode('test-message');
    await expect(keystore.collectQuorumSignatures(msg, 2)).rejects.toThrow(/peer-CP discovery/);
  });

  it('factory propagates SubmitFn DI to the issuer (handler invokes it on event)', async () => {
    const { submitFn, calls } = mkSubmit();
    const signer = Ed25519Keypair.generate();
    const { issuer, stop } = await startCapTokenIssuer({
      submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      signer,
      logger: mockLogger(),
      // Use a stubbed keystore so we don't hit the "no-peer-CP" throw path.
      cpKeystore: {
        async sign(message) {
          return {
            signature: Array.from(message.slice(0, 64)),
            pubkey: new Array(32).fill(0xaa),
            addr: '0xtest',
          };
        },
        getCpAddress() {
          return '0xtest';
        },
        async collectQuorumSignatures(_msg, threshold) {
          const signers: string[] = [];
          const signatures: number[][] = [];
          const pubkeys: number[][] = [];
          for (let i = 0; i < threshold; i++) {
            signers.push(`0xcp${i + 1}`);
            signatures.push(new Array(64).fill(0xab + i));
            pubkeys.push(new Array(32).fill(0xaa + i));
          }
          const aggregateSig = [0xff, threshold, ...signatures.flat()];
          return { qs: { signers, signatures }, pubkeys, aggregateSig };
        },
      },
    });

    await issuer.onRoomAssigned(
      {
        roomId: '0xroom1',
        relayIds: ['0xrelay1'],
        signalingId: '0xsig1',
        relayMode: 1,
        verifiedScore: '900',
        consensusReached: true,
        winningCp: '0xcp1',
        validatorIds: ['0xval1'],
      },
      'trace-bootstrap-1',
    );

    expect(calls.length).toBe(3); // relay + signaling + validator
    for (const c of calls) {
      expect(c.label).toBe('issue-capability-token');
    }
    stop();
  });
});
