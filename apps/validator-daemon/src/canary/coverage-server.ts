/**
 * REQ-CFA-013/014/015 / D-CFA-11/12/13/18 (M2 chunk 1) — off-chain canary coverage feed
 * (validator-daemon).
 *
 * Surfaces per-relay canary coverage over an OFF-CHAIN validator-local HTTP feed
 * (`GET /canary/coverage`) — NOT an on-chain `CanaryCellAssigned` event. An on-chain event
 * is `queryEvents`-readable by ANY party incl. the audited relay -> a direct D-CFA-2
 * covertness leak; the off-chain feed adds ZERO on-chain surface and removes that leak.
 * Closes M1 gate partial P1. The divergence->slash half STAYS chain-sourced
 * (`CanaryDivergenceSlashed`).
 *
 * HONESTY (DA-3 / W-M2-1): this feed is a daemon SELF-REPORT of the auditor's CLAIMED
 * coverage — NOT a chain-verified fact. The PUNISHING half (divergence->slash) stays
 * chain-authoritative. On record.
 *
 * CLONE PROVENANCE: startCoverageServer is cloned from relay/metrics-server.ts
 * (startMetricsServer): built-in node:http createServer, GET-only/405, 404, try/catch->500,
 * ProbeStateProvider-style injected provider. TWO DELIBERATE DIVERGENCES (D-CFA-18) from
 * that clone:
 *   1. It binds LOOPBACK 127.0.0.1 (not 0.0.0.0) — a remote relay cannot reach it.
 *   2. It MUST NOT emit `Access-Control-Allow-Origin: *` — CORS is restricted to the
 *      dashboard origin (CANARY_COVERAGE_CORS_ORIGIN, default the dev dashboard).
 * Rationale: even with salted assignment (D-CFA-19) defeating PREDICTION, the feed reports
 * CURRENT coverage status per round; a relay that could READ it would learn it is covered
 * and cheat elsewhere. Loopback + restricted CORS make the feed unreachable to a remote
 * relay so D-CFA-2 holds.
 *
 * INV-C: buildCoveragePayload drops sessionWallet/publish/consume; distinctness is counted
 * by minerId ONLY; reporterMinerId is the Wallet-A validatorMinerId (NEVER sessionAddress).
 * assignmentSecret is NEVER on this wire (it lives only in the cell loop closure).
 *
 * REQ-RMS-005/019 (additive): GET /canary/load exposes the per-relay ATTESTED forwarding-path
 * load (cumulative canary `sends`, the content-blind l_i proxy) + heartbeat freshness, mapped
 * PURE by buildLoadPayload (INV-C — minerId-only, never sessionWallet, never relay self-report).
 * It inherits the loopback bind + restricted CORS, so it is UNREACHABLE by a remote relay
 * (D-CFA-18). The CP-daemon load reader MUST be CO-LOCATED with this validator daemon (loopback).
 * The route is OPTIONAL: 404 ("load feed disabled") when no loadProvider is injected.
 *
 * LOGGING (HARD-GATE): structured createLogger only — no console.*.
 */

import { createServer, type Server } from 'node:http';
import { type Logger } from '@dvconf/shared';
import { MIN_DISTINCT_CANARY_VALIDATORS, type CellRoundSnapshot } from './cell.js';
import type { DropAccumulator } from './loss-classifier.js';

/** One relay's coverage row on the wire (LOCKED camelCase, DESIGN section 2.1). */
export interface CoverageRelayRow {
  /** CellAssignment.relayId — the audited relay's miner_id. */
  relayMinerId: string;
  /** Count of DISTINCT validator miner_ids covering this relay (Wallet-B dups collapsed). */
  distinctValidatorCount: number;
  /** The DISTINCT validator miner_ids — NO sessionWallet (INV-C). */
  validatorMinerIds: string[];
  /** CellAssignment.covered — true iff distinctValidatorCount >= minDistinct. */
  covered: boolean;
}

/** The LOCKED coverage wire payload (DESIGN section 2.1). */
export interface CoveragePayload {
  service: 'validator-daemon';
  /** Who is reporting — the homing validator's Wallet-A miner_id (NEVER sessionAddress). */
  reporterMinerId: string;
  /** snapshot.round (-1 if pre-first-tick / null snapshot). */
  round: number;
  /** The >=2-distinct coverage floor (MIN_DISTINCT_CANARY_VALIDATORS). */
  minDistinct: number;
  relays: CoverageRelayRow[];
  /** ms epoch the payload was built. */
  ts: number;
}

/**
 * Resolves the current cell-loop snapshot. Injected by the daemon wiring (index.ts) so the
 * server stays decoupled from cell-loop state — mirrors relay metrics-server's
 * ProbeStateProvider. Returns null when no snapshot is available (pre-first-tick).
 */
export type CoverageStateProvider = () => CellRoundSnapshot | null;

/**
 * PURE map of a cell-loop snapshot to the LOCKED coverage wire shape.
 *
 * - Dedups each cell's validators by `minerId` (Wallet-B sessions collapse to one).
 * - DROPS sessionWallet/publish/consume entirely (INV-C — never on the wire).
 * - `reporterMinerId` is passed through verbatim (the Wallet-A validatorMinerId).
 * - null/empty snapshot -> { round:-1, relays:[] } (honest pre-first-tick state).
 *
 * No HTTP, no I/O — unit-testable in isolation.
 */
export function buildCoveragePayload(
  snapshot: CellRoundSnapshot | null,
  reporterMinerId: string,
): CoveragePayload {
  const relays: CoverageRelayRow[] = (snapshot?.cells ?? []).map((cell) => {
    // Dedup by minerId — distinctness is counted by stable identity, never sessionWallet.
    const distinct = [...new Set(cell.validators.map((v) => v.minerId))];
    return {
      relayMinerId: cell.relayId,
      distinctValidatorCount: distinct.length,
      validatorMinerIds: distinct, // DISTINCT miner_ids ONLY — no sessionWallet
      covered: cell.covered,
    };
  });

  return {
    service: 'validator-daemon',
    reporterMinerId,
    round: snapshot?.round ?? -1,
    minDistinct: MIN_DISTINCT_CANARY_VALIDATORS,
    relays,
    ts: Date.now(),
  };
}

/** One relay's ATTESTED load row (REQ-RMS-005/019) — forwarding-path load, NOT self-report. */
export interface LoadRelayRow {
  relayMinerId: string;
  /** Verified forwarding-path observations (cumulative canary `sends`) — the l_i proxy. */
  attestedLoadPaths: number;
  /** Epochs since this relay's last on-chain heartbeat (freshness for pool-health). */
  heartbeatFreshEpochs: number;
}

/** The LOCKED attested-load wire payload (REQ-RMS-005/019) — minerId-only, INV-C. */
export interface LoadPayload {
  service: 'validator-daemon';
  reporterMinerId: string;
  relays: LoadRelayRow[];
  ts: number;
}

/** Injected provider for the load feed: the live per-relay DropAccumulator + heartbeat freshness map. */
export type LoadStateProvider = () => { acc: DropAccumulator; heartbeatFresh: Map<string, number> };

/**
 * PURE map of the per-relay DropAccumulator (+ heartbeat freshness) to the attested-load wire
 * shape. INV-C: minerId-only, NEVER sessionWallet. `attestedLoadPaths` = cumulative `sends`
 * (forwarding-path observations the canary verify-loop recorded) — the content-blind l_i proxy,
 * NOT the relay's self-reported calculateLoad.
 *
 * No HTTP, no I/O — unit-testable in isolation (mirrors buildCoveragePayload).
 */
export function buildLoadPayload(
  acc: DropAccumulator,
  heartbeatFresh: Map<string, number>,
  reporterMinerId: string,
): LoadPayload {
  const relays: LoadRelayRow[] = [...acc.byRelay.entries()].map(([relayMinerId, s]) => ({
    relayMinerId,
    attestedLoadPaths: s.sends,
    heartbeatFreshEpochs: heartbeatFresh.get(relayMinerId) ?? Number.MAX_SAFE_INTEGER,
  }));
  return { service: 'validator-daemon', reporterMinerId, relays, ts: Date.now() };
}

/**
 * Default dashboard origin allowed to read the coverage feed cross-origin. Restricted (NOT
 * `*`, D-CFA-18) — override via CANARY_COVERAGE_CORS_ORIGIN for a deployed dashboard host.
 */
const DEFAULT_DASHBOARD_ORIGIN = 'http://localhost:5173';

/**
 * Start the off-chain coverage feed HTTP server.
 *
 * BINDS LOOPBACK 127.0.0.1 (D-CFA-18) — unreachable by a remote relay. CORS is restricted
 * to a single dashboard origin (NEVER `*`). GET-only (405 otherwise); 404 unknown routes;
 * try/catch -> 500. Cloned from relay/metrics-server.ts with those two divergences.
 *
 * @returns the http.Server (closed in the daemon's LAST shutdown group next to /healthz).
 */
export function startCoverageServer(args: {
  port: number;
  provider: CoverageStateProvider;
  reporterMinerId: string;
  logger: Logger;
  /** Override the CORS-allowed dashboard origin (default CANARY_COVERAGE_CORS_ORIGIN env). */
  corsOrigin?: string;
  /**
   * OPTIONAL attested-load feed provider (REQ-RMS-005/019). When supplied, GET /canary/load
   * returns the per-relay attested forwarding-path load + heartbeat freshness; when omitted the
   * route 404s ("load feed disabled"). LOOPBACK-only (inherits the D-CFA-18 unreachable-to-relay
   * property): the CP-daemon reader MUST be co-located with this validator daemon; a relay must
   * never reach this feed.
   */
  loadProvider?: LoadStateProvider;
}): Server {
  const { port, provider, reporterMinerId, logger } = args;
  const corsOrigin =
    args.corsOrigin ?? process.env['CANARY_COVERAGE_CORS_ORIGIN'] ?? DEFAULT_DASHBOARD_ORIGIN;

  // RESTRICTED CORS (D-CFA-18) — a single dashboard origin, NEVER `*`.
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    Vary: 'Origin',
  } as const;

  const server = createServer((req, res) => {
    // GET-only (clone of metrics-server's method guard).
    if (req.method !== 'GET') {
      res.writeHead(405, jsonHeaders);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const url = req.url ?? '/';
    try {
      if (url === '/canary/coverage') {
        const payload = buildCoveragePayload(provider(), reporterMinerId);
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(payload));
        return;
      }
      // REQ-RMS-005/019 — attested forwarding-path load feed (loopback-only, 404 when disabled).
      if (url === '/canary/load') {
        if (!args.loadProvider) {
          res.writeHead(404, jsonHeaders);
          res.end(JSON.stringify({ error: 'load feed disabled' }));
          return;
        }
        const { acc, heartbeatFresh } = args.loadProvider();
        const payload = buildLoadPayload(acc, heartbeatFresh, reporterMinerId);
        res.writeHead(200, jsonHeaders);
        res.end(JSON.stringify(payload));
        return;
      }
      // 404 for unknown routes.
      res.writeHead(404, jsonHeaders);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error({ err, url }, 'coverage server error');
      res.writeHead(500, jsonHeaders);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  // LOOPBACK bind (D-CFA-18) — the feed is unreachable by a remote relay.
  server.listen(port, '127.0.0.1', () => {
    logger.info({ port, host: '127.0.0.1', corsOrigin }, 'canary coverage feed listening (loopback)');
  });

  return server;
}
