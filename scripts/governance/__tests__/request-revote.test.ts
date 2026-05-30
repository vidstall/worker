import { describe, it, expect, vi, beforeEach } from 'vitest';

// executeWithRetry is mocked so submitRequestRevote builds a PTB without a chain.
// Manual mock (NO importOriginal): the root/scripts package does not declare
// @dvconf/shared, so vitest's resolver cannot load the real module from this
// context. The test only needs executeWithRetry; the other named exports exist so
// request-revote.ts's import binding resolves (its main() is never run here).
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', () => ({
  executeWithRetry: mockExecuteWithRetry,
  createSuiClient: vi.fn(),
  createLogger: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadKeypair: vi.fn(),
}));

import type { NetworkConfig } from '@dvconf/shared';
import { buildRequestRevoteTx, submitRequestRevote, parseMinerCapFlag } from '../request-revote.js';

function mockConfig(): NetworkConfig {
  return {
    rpcUrl: 'http://localhost:9000',
    packageId: '0xpkg',
    networkRegistryId: '0xreg',
    minerStoreId: '0xstore',
    cpRegistryId: '0xcp',
    relayRegistryId: '0xrelay',
    validatorRegistryId: '0xval',
    userRegistryId: '0xuser',
    roomManagerId: '0xroom',
    signalingRegistryId: '0xsig',
    roleVoteBoxId: '0xvotebox',
  } as NetworkConfig;
}

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

// ── buildRequestRevoteTx — locks the PTB shape against role_voting.move:491 ──
describe('buildRequestRevoteTx', () => {
  it('builds mark_revote_eligible_miner_request with the 4 Move args in exact order', () => {
    const calls: any[] = [];
    const tx = {
      object: (x: string) => ({ kind: 'object', x }),
      moveCall: (a: any) => calls.push(a),
    } as any;
    buildRequestRevoteTx(tx, mockConfig(), '0xminercap');

    expect(calls[0].target).toBe('0xpkg::role_voting::mark_revote_eligible_miner_request');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // net_reg: &NetworkRegistry
      { kind: 'object', x: '0xvotebox' }, // vote_box: &mut RoleVoteBox
      { kind: 'object', x: '0xstore' }, // miner_store: &MinerStore
      { kind: 'object', x: '0xminercap' }, // cap: &MinerCap
    ]);
  });
});

// ── submitRequestRevote — signs + submits via executeWithRetry ──
describe('submitRequestRevote', () => {
  // Block body: `mockReset()` returns the mock, which vitest would treat as a
  // teardown hook and call with zero args otherwise.
  beforeEach(() => {
    mockExecuteWithRetry.mockReset();
  });

  it('submits with the request-revote label and the correct PTB', async () => {
    let captured: { calls: any[]; label: string } | undefined;
    mockExecuteWithRetry.mockImplementation(
      async (_c: unknown, _s: unknown, builder: (tx: any) => void, label: string) => {
        const calls: any[] = [];
        builder({ object: (x: string) => ({ kind: 'object', x }), moveCall: (a: any) => calls.push(a) });
        captured = { calls, label };
      },
    );
    await submitRequestRevote({} as any, {} as any, mockConfig(), '0xcap', mockLogger());

    expect(captured!.label).toBe('request-revote');
    expect(captured!.calls[0].target).toBe('0xpkg::role_voting::mark_revote_eligible_miner_request');
    expect(captured!.calls[0].arguments[3]).toEqual({ kind: 'object', x: '0xcap' }); // cap
  });

  it('logs structured confirmation with trace_id + action + miner cap id (daemon-wide convention)', async () => {
    mockExecuteWithRetry.mockResolvedValue(undefined);
    const logger = mockLogger();
    await submitRequestRevote({} as any, {} as any, mockConfig(), '0xcap', logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: expect.any(String),
        module: 'miner-request-revote',
        action: 'request_revote_tx',
        context: expect.objectContaining({ minerCapId: '0xcap' }),
      }),
      expect.any(String),
    );
  });
});

// ── parseMinerCapFlag — CLI arg extraction ──
describe('parseMinerCapFlag', () => {
  it('extracts the --miner-cap value', () => {
    expect(parseMinerCapFlag(['--miner-cap', '0xabc'])).toBe('0xabc');
  });
  it('returns null when the flag is absent', () => {
    expect(parseMinerCapFlag(['--other', 'x'])).toBeNull();
  });
  it('returns null when the flag has no following value', () => {
    expect(parseMinerCapFlag(['--miner-cap', '--next'])).toBeNull();
  });
});
