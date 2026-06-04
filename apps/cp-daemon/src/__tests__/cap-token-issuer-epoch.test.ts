/**
 * F62 M2 daemon-wiring W-P2 (REQ-ADW-001, D-W7) — issuer token expiry from a live epoch.
 *
 * The placeholder `expiresEpoch = 100n` (cap-token-issuer.ts:608) and the matching
 * refresh-side `newExpiresEpoch = 100n` (:838) are replaced by
 * `currentEpoch + DEFAULT_EXPIRES_OFFSET_EPOCHS`, where `currentEpoch` comes from an
 * injected `getCurrentEpoch()` (a cached-epoch source wired in startCapTokenIssuer).
 * Back-compat: with NO provider injected, `currentEpoch` resolves to 0 → 100n (unchanged).
 *
 * TDD RED-first: fails until CapTokenIssuerOpts.getCurrentEpoch + resolveExpiresEpoch land.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CapTokenIssuer,
  type SubmitFn,
  type SubmitResult,
  type CpKeystore,
  type RoomAssignedEvent,
} from '../cap-token-issuer.js';

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

function keystoreOk(): CpKeystore {
  return {
    async sign(message) {
      return { signature: Array.from(message.slice(0, 64)), pubkey: new Array(32).fill(0xaa), addr: '0xcp1' };
    },
    getCpAddress() { return '0xcp1'; },
    async collectQuorumSignatures(_msg, threshold) {
      const signers: string[] = [], signatures: number[][] = [], pubkeys: number[][] = [];
      for (let i = 0; i < threshold; i++) {
        signers.push(`0xcp${i + 1}`); signatures.push(new Array(64).fill(0xab)); pubkeys.push(new Array(32).fill(0xaa));
      }
      return { qs: { signers, signatures }, pubkeys, aggregateSig: [0xff, ...signatures.flat()] };
    },
  };
}

function mkSubmit() {
  const calls: Array<{ label: string; args: Record<string, unknown> }> = [];
  const submitFn: SubmitFn = vi.fn(async (opts): Promise<SubmitResult> => {
    calls.push({ label: opts.label, args: opts.args });
    return { digest: `tx-${calls.length}` };
  });
  return { submitFn, calls };
}

const ROOM: RoomAssignedEvent = {
  roomId: '0xroom1', relayIds: ['0xrelay1'], signalingId: '0xsig1', relayMode: 0,
  verifiedScore: '1', consensusReached: true, winningCp: '0xcp1', validatorIds: [],
};

function mkIssuer(getCurrentEpoch?: () => bigint) {
  const { submitFn, calls } = mkSubmit();
  const issuer = new CapTokenIssuer({
    submitFn,
    packageId: '0xpkg',
    networkRegistryId: '0xnet',
    cpRegistryObjectId: '0xcpreg',
    quorumStateObjectId: '0xquorum',
    cpKeystore: keystoreOk(),
    logger: mockLogger(),
    quorumThreshold: 1,
    ...(getCurrentEpoch && { getCurrentEpoch }),
  });
  return { issuer, calls };
}

describe('CapTokenIssuer expiry from live epoch (W-P2, D-W7)', () => {
  it('issue expiresEpoch = currentEpoch + DEFAULT_EXPIRES_OFFSET_EPOCHS (100) when provider injected', async () => {
    const { issuer, calls } = mkIssuer(() => 42n);
    await issuer.onRoomAssigned(ROOM, 'trace-epoch-1');
    expect(calls).toHaveLength(2); // 1 relay + 1 signaling
    for (const c of calls) {
      expect(c.args.expiresEpoch).toBe(142n);
    }
  });

  it('back-compat: with NO provider, expiresEpoch falls back to 100n (0 + offset)', async () => {
    const { issuer, calls } = mkIssuer(); // no getCurrentEpoch
    await issuer.onRoomAssigned(ROOM, 'trace-epoch-2');
    expect(calls[0]!.args.expiresEpoch).toBe(100n);
  });

  it('reads the provider lazily at submit time (epoch advanced between construction and event)', async () => {
    let epoch = 10n;
    const { issuer, calls } = mkIssuer(() => epoch);
    epoch = 99n; // advance after construction, before the event
    await issuer.onRoomAssigned(ROOM, 'trace-epoch-3');
    expect(calls[0]!.args.expiresEpoch).toBe(199n);
  });
});
