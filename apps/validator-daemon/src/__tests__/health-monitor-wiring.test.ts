/**
 * P17 M2a-P11 — validator-daemon F61 HealthMonitor startup wiring (DOH-014/016/017/018).
 *
 * Asserts the exported `startHealthMonitor` factory binds the HARD GATE
 * (`operator := signer.toSuiAddress()`) using the MAIN wallet (the operator that
 * owns the MinerCap — NOT the session wallet), variant 'miner' (node_type=1
 * validator, derived on-chain) and the live MinerCap id (validatorCapId) into
 * `makeChainReporter`, and that the monitor start()s + the returned stop() tears
 * the poll interval down. `makeChainReporter` is mocked (no chain).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const { mockMakeChainReporter } = vi.hoisted(() => ({
  mockMakeChainReporter: vi.fn(() => ({ report: vi.fn().mockResolvedValue(true) })),
}));
vi.mock('@dvconf/health-monitor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/health-monitor')>();
  return { ...actual, makeChainReporter: mockMakeChainReporter };
});

import { startHealthMonitor } from '../index.js';

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
  } as never;
}

describe('validator-daemon startHealthMonitor — F61 wiring (DOH-018)', () => {
  beforeEach(() => {
    mockMakeChainReporter.mockClear();
    mockMakeChainReporter.mockReturnValue({ report: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds operator := mainKeypair address + variant miner + validatorCapId, and starts/stops the monitor', () => {
    // The MAIN wallet owns the MinerCap; the reporter MUST use it (not the session key).
    const mainKeypair = Ed25519Keypair.generate();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { monitor, stop } = startHealthMonitor({
      client: {} as never,
      signer: mainKeypair,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      validatorCapId: '0xvalcap',
      logger: mockLogger(),
      deps: {
        getRttMs: () => 0,
        getConsecutiveUnreachable: () => 0,
      },
      env: {},
    });

    expect(mockMakeChainReporter).toHaveBeenCalledTimes(1);
    expect(mockMakeChainReporter).toHaveBeenCalledWith(
      expect.objectContaining({
        operator: mainKeypair.toSuiAddress(),
        variant: 'miner',
        capId: '0xvalcap',
        signer: mainKeypair,
      }),
    );

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(monitor).toBeDefined();
    stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
