/**
 * P17 M2a-P11 — relay F61 HealthMonitor startup wiring (DOH-014/016/017/018).
 *
 * Asserts the exported `startHealthMonitor` factory binds the HARD GATE
 * (`operator := signer.toSuiAddress()`), the correct cap variant ('miner') and
 * the live MinerCap id into `makeChainReporter`, and that the monitor is
 * start()ed and the returned stop() tears the poll interval down. `makeChainReporter`
 * is mocked so no chain is touched; `HealthMonitor` + `buildHealthSignals` stay real.
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

import { startHealthMonitor } from '../health-monitor-wiring.js';

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

describe('relay startHealthMonitor — F61 wiring (DOH-018)', () => {
  beforeEach(() => {
    mockMakeChainReporter.mockClear();
    mockMakeChainReporter.mockReturnValue({ report: vi.fn().mockResolvedValue(true) });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('binds operator := signer.toSuiAddress() + variant miner + minerCapId, and starts/stops the monitor', () => {
    const signer = Ed25519Keypair.generate();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { monitor, stop } = startHealthMonitor({
      client: {} as never,
      signer,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      minerCapId: '0xminercap',
      logger: mockLogger(),
      deps: {
        getWorkerResourceUsages: () => [],
        getPacketLossBps: () => 0,
        getWorkerDiedCount: () => 0,
      },
      env: {},
    });

    // HARD GATE: operator MUST equal the signer's address (== tx sender), with the
    // 'miner' variant + the MinerCap id, or report_node_degradation aborts on-chain
    // (E_NOT_OPERATOR, node_health.move:81).
    expect(mockMakeChainReporter).toHaveBeenCalledTimes(1);
    expect(mockMakeChainReporter).toHaveBeenCalledWith(
      expect.objectContaining({
        operator: signer.toSuiAddress(),
        variant: 'miner',
        capId: '0xminercap',
        signer,
      }),
    );

    // Lifecycle: start() began polling; stop() tears the interval down.
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(monitor).toBeDefined();
    stop();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
