/**
 * P17 M2a-P8 (REQ-DOH-015) — chain PTB builders + makeChainReporter.
 *
 * `report.ts` is the SINGLE production degraded path: the F61 level machine's
 * injected `DegradationReporter` (D-DOH-M2-HM-4). It ships two FROZEN PTB
 * builders that byte-mirror the on-chain entries verified at node_health.move:71
 * (`report_node_degradation(net_reg, cap: &MinerCap, operator, level, ctx)`) and
 * :110 (`report_cp_degradation(net_reg, cap: &ControlPlaneCap, operator, level,
 * ctx)`) — same arg ORDER `[netReg, cap, operator, level]` (ctx auto-injected).
 *
 * These tests pin (1) each builder's target string + arg order via a fakeTx
 * moveCall recorder, (2) `makeChainReporter` routing by variant ('miner' -> node,
 * 'cp' -> cp), and (3) the `executeWithRetry` null (exhausted retries) -> `false`
 * / non-null `TxResult` -> `true` mapping that satisfies `report(): Promise<boolean>`.
 *
 * Mirrors the cap-token-submitter test idiom (apps/cp-daemon): mock
 * `@dvconf/shared.executeWithRetry` via vi.hoisted; run the captured builder
 * against a fakeTx to read back the moveCall args.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkConfig } from '@dvconf/shared';
import {
  makeChainReporter,
  buildReportNodeDegradationTx,
  buildReportCpDegradationTx,
} from '../report.js';

// Mock executeWithRetry so the factory never touches a real chain; the mock runs
// the supplied builder against a fakeTx and records its moveCall(s) + label.
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, executeWithRetry: mockExecuteWithRetry };
});

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

/** A minimal moveCall recorder mirroring the Sui `Transaction` surface we touch. */
function fakeTx() {
  const calls: any[] = [];
  const tx = {
    object: (x: string) => ({ kind: 'object', x }),
    pure: {
      u8: (v: number) => ({ kind: 'pure', t: 'u8', v }),
      address: (v: string) => ({ kind: 'pure', t: 'address', v }),
    },
    moveCall: (a: any) => {
      calls.push(a);
      return { kind: 'result', of: a.target };
    },
  } as any;
  return { tx, calls };
}

// Only packageId + networkRegistryId are read by the builders.
const CONFIG = { packageId: '0xpkg', networkRegistryId: '0xreg' } as unknown as NetworkConfig;

/** Drive executeWithRetry's builder against a fakeTx; capture calls + label + return `returnVal`. */
function captureBuilder(returnVal: unknown = { digest: '0xdigest' }) {
  let captured: { calls: any[]; label: string } | undefined;
  mockExecuteWithRetry.mockImplementation(
    async (_c: unknown, _s: unknown, builder: (tx: any) => void, label: string) => {
      const { tx, calls } = fakeTx();
      builder(tx);
      captured = { calls, label };
      return returnVal;
    },
  );
  return () => captured!;
}

function baseArgs(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as any,
    signer: {} as any,
    config: CONFIG,
    capId: '0xminercap',
    operator: '0xop',
    variant: 'miner' as const,
    logger: mockLogger(),
    ...overrides,
  };
}

describe('buildReportNodeDegradationTx (P8, DOH-015) — frozen target + arg order', () => {
  it('targets node_health::report_node_degradation with [netReg, minerCap, operator, level]', () => {
    const { tx, calls } = fakeTx();
    buildReportNodeDegradationTx(tx, CONFIG, '0xminercap', '0xop', 1);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::node_health::report_node_degradation');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // net_reg: &NetworkRegistry
      { kind: 'object', x: '0xminercap' }, // cap: &MinerCap
      { kind: 'pure', t: 'address', v: '0xop' }, // operator: address
      { kind: 'pure', t: 'u8', v: 1 }, // level: u8
    ]);
  });
});

describe('buildReportCpDegradationTx (P8, DOH-015) — frozen target + arg order', () => {
  it('targets node_health::report_cp_degradation with [netReg, cpCap, operator, level]', () => {
    const { tx, calls } = fakeTx();
    buildReportCpDegradationTx(tx, CONFIG, '0xcpcap', '0xop', 2);

    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe('0xpkg::node_health::report_cp_degradation');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // net_reg: &NetworkRegistry
      { kind: 'object', x: '0xcpcap' }, // cap: &ControlPlaneCap
      { kind: 'pure', t: 'address', v: '0xop' }, // operator: address
      { kind: 'pure', t: 'u8', v: 2 }, // level: u8
    ]);
  });
});

describe('makeChainReporter (P8, DOH-015) — variant routing + null->false mapping', () => {
  beforeEach(() => {
    mockExecuteWithRetry.mockReset();
  });

  it("variant 'miner' routes report(level) to the node-degradation builder", async () => {
    const get = captureBuilder();
    const reporter = makeChainReporter(baseArgs({ variant: 'miner', capId: '0xminercap' }));

    const ok = await reporter.report(1);

    expect(ok).toBe(true);
    const { calls } = get();
    expect(calls[0].target).toBe('0xpkg::node_health::report_node_degradation');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', x: '0xreg' },
      { kind: 'object', x: '0xminercap' },
      { kind: 'pure', t: 'address', v: '0xop' },
      { kind: 'pure', t: 'u8', v: 1 },
    ]);
  });

  it("variant 'cp' routes report(level) to the cp-degradation builder", async () => {
    const get = captureBuilder();
    const reporter = makeChainReporter(baseArgs({ variant: 'cp', capId: '0xcpcap' }));

    const ok = await reporter.report(2);

    expect(ok).toBe(true);
    const { calls } = get();
    expect(calls[0].target).toBe('0xpkg::node_health::report_cp_degradation');
    expect(calls[0].arguments).toEqual([
      { kind: 'object', x: '0xreg' },
      { kind: 'object', x: '0xcpcap' },
      { kind: 'pure', t: 'address', v: '0xop' },
      { kind: 'pure', t: 'u8', v: 2 },
    ]);
  });

  it('maps a null executeWithRetry result (exhausted retries) to report() === false', async () => {
    captureBuilder(null);
    const reporter = makeChainReporter(baseArgs({ variant: 'miner' }));

    expect(await reporter.report(2)).toBe(false);
  });

  it('maps a non-null TxResult to report() === true', async () => {
    captureBuilder({ digest: '0xabc' });
    const reporter = makeChainReporter(baseArgs({ variant: 'cp', capId: '0xcpcap' }));

    expect(await reporter.report(1)).toBe(true);
  });

  it('passes a variant-specific label to executeWithRetry', async () => {
    const get = captureBuilder();
    const reporter = makeChainReporter(baseArgs({ variant: 'cp', capId: '0xcpcap' }));

    await reporter.report(1);

    expect(get().label).toBe('report-cp-degradation');
  });
});
