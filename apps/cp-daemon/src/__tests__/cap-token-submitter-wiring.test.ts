import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// W-P1 wiring half (D-W6): startCapTokenIssuer must select the REAL single-CP submitter
// (-> executeWithRetry) when threshold==1 and no submitFn is injected, and keep the
// deferred (throwing, no-dispatch) stub at threshold>=2. executeWithRetry is mocked so
// the wired submitter builds a PTB without a chain.
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, executeWithRetry: mockExecuteWithRetry };
});

import { startCapTokenIssuer } from '../index.js';

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

const ROOM_EVENT = {
  roomId: '0xroom1',
  relayIds: ['0xrelay1'],
  signalingId: '0xsig1',
  relayMode: 1,
  verifiedScore: '900',
  consensusReached: true,
  winningCp: '0xcp1',
  validatorIds: ['0xval1'],
};

/** A keystore that always returns a `threshold`-sized quorum (bypasses the no-peer throw). */
function fakeKeystore() {
  return {
    async sign(message: Uint8Array) {
      return { signature: Array.from(message.slice(0, 64)), pubkey: new Array(32).fill(0xaa), addr: '0xtest' };
    },
    getCpAddress() {
      return '0xtest';
    },
    async collectQuorumSignatures(_msg: Uint8Array, threshold: number) {
      const signers: string[] = [];
      const signatures: number[][] = [];
      const pubkeys: number[][] = [];
      for (let i = 0; i < threshold; i++) {
        signers.push(`0xcp${i + 1}`);
        signatures.push(new Array(64).fill(0xab + i));
        pubkeys.push(new Array(32).fill(0xaa + i));
      }
      return { qs: { signers, signatures }, pubkeys, aggregateSig: [0x01, ...signatures.flat()] };
    },
  };
}

describe('startCapTokenIssuer — production submitFn selection (D-W6)', () => {
  beforeEach(() => {
    mockExecuteWithRetry.mockReset();
    mockExecuteWithRetry.mockResolvedValue({ digest: '0xwired' });
  });

  it('wires the real single-CP submitter (-> executeWithRetry) at threshold==1 with no injected submitFn', async () => {
    const { issuer, stop } = await startCapTokenIssuer({
      client: {} as any, // executeWithRetry is mocked -> client unused
      signer: Ed25519Keypair.generate(),
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      quorumThreshold: 1,
      cpKeystore: fakeKeystore(),
      logger: mockLogger(),
    });

    await issuer.onRoomAssigned(ROOM_EVENT, 'trace-wire-1');

    expect(mockExecuteWithRetry).toHaveBeenCalled();
    const labels = mockExecuteWithRetry.mock.calls.map((c) => c[3]);
    expect(labels.some((l) => l === 'cap-token-issue-capability-token')).toBe(true);
    stop();
  });

  it('keeps the deferred (no-dispatch) stub at threshold>=2 — never reaches executeWithRetry', async () => {
    const { issuer, stop } = await startCapTokenIssuer({
      client: {} as any,
      signer: Ed25519Keypair.generate(),
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      quorumThreshold: 2, // multi-CP -> deferred (D-014)
      cpKeystore: fakeKeystore(),
      logger: mockLogger(),
    });

    // The deferred submitFn throws; the issuer absorbs it (logs error) — either way,
    // no on-chain dispatch is attempted.
    await issuer.onRoomAssigned(ROOM_EVENT, 'trace-wire-2').catch(() => undefined);

    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
    stop();
  });
});
