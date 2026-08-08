/**
 * SMH-LIVE port set derivation + collision pre-flight scan.
 *
 * RECONCILIATION v2 (post Task-1 audit): there is NO `SMH_PORT_BASE` — the native
 * rig launcher `run-rms-live-local.ps1` HARDCODES every port base (AUDIT Step 5), so
 * the only collision-safety mechanism is DETECT-and-ABORT: enumerate the fixed set a
 * run will bind, probe it, and if ANY port is already listening, print the table and
 * ABORT (never bind over a live port). No auto port-shift.
 *
 * `requiredPorts` is a pure derivation (unit-tested); `scanCollisions` is a thin
 * `Get-NetTCPConnection` probe boundary (live-only, not unit-tested).
 */

import { execFileSync } from 'node:child_process';

export interface PortConfig {
  /** Sui full-node RPC (hardcoded 9000, not overridable). */
  suiRpc: number;
  /** Sui faucet (hardcoded 9123, not overridable). */
  suiFaucet: number;
  /** Relay WS ports (4000 + (i-1)*2 → 4000/4002/4004 at N=3). */
  relayWs: number[];
  /** Relay metrics ports (4001 + (i-1)*2 → 4001/4003/4005 at N=3). */
  relayMetrics: number[];
  /** Relay RTC media band, inclusive (10000-10500 across the mesh). */
  rtcRange: [number, number];
  /** Inter-relay pipe band, inclusive (40000-40299 across the mesh). */
  pipeRange: [number, number];
  /** Validator healthz ports (8100 + index → 8101-8104 at N=4). */
  validatorHealthz: number[];
  /** Validator canary /canary/load coverage port (see DEFAULT_CANARY_COVERAGE_PORT). */
  canaryCoverage: number;
}

export interface PortSpec {
  port: number;
  label: string;
}

export interface Occupied extends PortSpec {
  pid: number;
  processName: string;
}

/**
 * The /canary/load coverage port the harness enables for D1a. The daemon DEFAULT is
 * 8102, which COLLIDES with validator-2 healthz (8100+2=8102), so we place it OUTSIDE
 * the 8101-8104 healthz band. Task 8 sets `VALIDATOR_CANARY_COVERAGE_PORT` to this and
 * points the cp's `RMS_LOAD_FEED_URL` at it — keep the two in sync.
 */
export const DEFAULT_CANARY_COVERAGE_PORT = 8105;

/**
 * The FIXED native-rig port set at N=3 relays / N=4 validators, exactly as
 * `run-rms-live-local.ps1` binds it (AUDIT Step 5). `5173` (Vite) is EXCLUDED — the
 * harness never launches the client sub-command.
 */
export const DEFAULT_PORT_CONFIG: PortConfig = {
  suiRpc: 9000,
  suiFaucet: 9123,
  relayWs: [4000, 4002, 4004],
  relayMetrics: [4001, 4003, 4005],
  rtcRange: [10000, 10500],
  pipeRange: [40000, 40299],
  validatorHealthz: [8101, 8102, 8103, 8104],
  canaryCoverage: DEFAULT_CANARY_COVERAGE_PORT,
};

function expand(range: [number, number], label: string): PortSpec[] {
  const out: PortSpec[] = [];
  for (let p = range[0]; p <= range[1]; p++) out.push({ port: p, label });
  return out;
}

/** Enumerate the full labeled port set a run will bind (ranges expanded to individual ports). */
export function requiredPorts(cfg: PortConfig = DEFAULT_PORT_CONFIG): PortSpec[] {
  return [
    { port: cfg.suiRpc, label: 'sui RPC' },
    { port: cfg.suiFaucet, label: 'sui faucet' },
    ...cfg.relayWs.map((p, i) => ({ port: p, label: `relay-${i + 1} WS` })),
    ...cfg.relayMetrics.map((p, i) => ({ port: p, label: `relay-${i + 1} metrics` })),
    ...expand(cfg.rtcRange, 'relay RTC'),
    ...expand(cfg.pipeRange, 'inter-relay pipe'),
    ...cfg.validatorHealthz.map((p, i) => ({ port: p, label: `validator-${i + 1} healthz` })),
    { port: cfg.canaryCoverage, label: 'validator canary /canary/load' },
  ];
}

/** Render the occupied-port rows as a markdown table for an abort message. */
export function formatCollisions(occ: Occupied[]): string {
  const header = '| port | label | pid | process |\n|---|---|---|---|';
  const rows = occ.map((o) => `| ${o.port} | ${o.label} | ${o.pid} | ${o.processName} |`);
  return [header, ...rows].join('\n');
}

/**
 * Probe the host for which of `specs` are already `Listen`ing. Live-only (Windows):
 * ONE `Get-NetTCPConnection -State Listen` snapshot (O(1) shell calls regardless of
 * how many ports the ranges expand to), joined to the owning process name, then
 * filtered to the requested set. Returns the occupied subset.
 */
export function scanCollisions(specs: PortSpec[]): Occupied[] {
  const ps =
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; ' +
    'Write-Output ("$($_.LocalPort);$($_.OwningProcess);$($p.ProcessName)") }';
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });

  const live = new Map<number, { pid: number; processName: string }>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    const [portStr, pidStr, name] = t.split(';');
    const port = Number(portStr);
    if (!Number.isFinite(port)) continue;
    if (!live.has(port)) {
      live.set(port, { pid: Number(pidStr), processName: name && name.length > 0 ? name : 'unknown' });
    }
  }

  const occupied: Occupied[] = [];
  for (const s of specs) {
    const hit = live.get(s.port);
    if (hit !== undefined) occupied.push({ ...s, pid: hit.pid, processName: hit.processName });
  }
  return occupied;
}
