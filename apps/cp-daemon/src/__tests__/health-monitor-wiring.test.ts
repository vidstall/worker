/**
 * P17 M2a-P11 — cp-daemon F61 HealthMonitor startup wiring (DOH-014/016/017/018).
 *
 * Asserts the exported `startHealthMonitor` factory binds the HARD GATE
 * (`operator := signer.toSuiAddress()`), variant 'cp' (the daemon holds a
 * ControlPlaneCap → report_cp_degradation, node_type=3 hardcoded on-chain) and the
 * live ControlPlaneCap id into `makeChainReporter`, and that the monitor start()s +
 * the returned stop() tears the poll interval down. `makeChainReporter` is mocked.
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

describe('cp-daemon startHealthMonitor — F61 wiring (DOH-018)', () => {
  beforeEach(() => {
    mockMakeChainReporter.mockClear();
    mockMakeChainReporter.mockReturnValue({ report: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds operator := signer.toSuiAddress() + variant cp + cpCapId, and starts/stops the monitor', () => {
    const signer = Ed25519Keypair.generate();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { monitor, stop } = startHealthMonitor({
      client: {} as never,
      signer,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      cpCapId: '0xcpcap',
      logger: mockLogger(),
      deps: {
        getRpcErrorRate: () => 0,
        getEventLagMs: () => 0,
      },
      env: {},
    });

    // HARD GATE: operator == signer address, variant 'cp', the ControlPlaneCap id.
    expect(mockMakeChainReporter).toHaveBeenCalledTimes(1);
    expect(mockMakeChainReporter).toHaveBeenCalledWith(
      expect.objectContaining({
        operator: signer.toSuiAddress(),
        variant: 'cp',
        capId: '0xcpcap',
        signer,
      }),
    );

    expect(setIntervalSpy).toHaveBeenCalled();
    expect(monitor).toBeDefined();
    stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
