import { describe, it, expect } from 'vitest';
import {
  requiredPorts,
  formatCollisions,
  DEFAULT_PORT_CONFIG,
  type PortSpec,
  type Occupied,
} from '../ports.js';

describe('requiredPorts (fixed native-rig set — RECONCILIATION v2, no SMH_PORT_BASE)', () => {
  it('enumerates the full labeled fixed port set, expanding RTC + pipe ranges', () => {
    const specs = requiredPorts();
    const nums = specs.map((p) => p.port);
    // fixed singletons
    expect(nums).toContain(9000); // sui RPC
    expect(nums).toContain(9123); // sui faucet
    // relay WS + metrics band 4000-4005 (3 relays)
    for (const p of [4000, 4001, 4002, 4003, 4004, 4005]) expect(nums).toContain(p);
    // RTC range expanded to individual ports 10000-10500
    expect(nums).toContain(10000);
    expect(nums).toContain(10500);
    // pipe range expanded 40000-40299
    expect(nums).toContain(40000);
    expect(nums).toContain(40299);
    // validator healthz band 8101-8104 (4 validators)
    for (const p of [8101, 8102, 8103, 8104]) expect(nums).toContain(p);
    // the chosen canary /canary/load coverage port
    expect(nums).toContain(DEFAULT_PORT_CONFIG.canaryCoverage);
    // NOT the Vite client port — the harness never launches the client
    expect(nums).not.toContain(5173);
    // every entry carries a human label for the collision table
    expect(specs.every((p: PortSpec) => p.label.length > 0)).toBe(true);
  });

  it('is config-driven — a passed config derives that set instead of the default', () => {
    const nums = requiredPorts({
      suiRpc: 19000,
      suiFaucet: 19123,
      relayWs: [14000],
      relayMetrics: [14001],
      rtcRange: [20000, 20002],
      pipeRange: [50000, 50001],
      validatorHealthz: [18101],
      canaryCoverage: 18105,
    }).map((p) => p.port);
    expect(nums).toEqual(
      expect.arrayContaining([19000, 19123, 14000, 14001, 20000, 20001, 20002, 50000, 50001, 18101, 18105]),
    );
    expect(nums).not.toContain(9000);
  });
});

describe('formatCollisions', () => {
  it('renders a markdown table with port, label, pid and process name', () => {
    const occ: Occupied[] = [{ port: 4000, label: 'relay-1 WS', pid: 1234, processName: 'node' }];
    const out = formatCollisions(occ);
    expect(out).toContain('4000');
    expect(out).toContain('relay-1 WS');
    expect(out).toContain('1234');
    expect(out).toContain('node');
  });
});
