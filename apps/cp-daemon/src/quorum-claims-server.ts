/**
 * Multi-CP quorum Phase 1 — Leg 7a: the LIVE `/quorum/claims` HTTP carrier (cp-daemon side).
 *
 * The loopback-127.0.0.1 single-host transport slice for the shared quorum claim board. This is the
 * PURE TRANSPORT layer — it owns NO board state. It delegates every route to an INJECTED
 * `QuorumClaimBoard` port (the hermetic `InMemoryGenericClaimBoard`, or in Leg 7d the live HTTP
 * board). Five routes:
 *   - POST /quorum/claims              → board.post(kind, claim, attestation, round)
 *   - GET  /quorum/claims/open         → board.listOpen()
 *   - POST /quorum/claims/get          {key} → board.get(key)
 *   - POST /quorum/claims/mark-submitted {key} → board.markSubmitted(key)
 *   - POST /quorum/claims/gc           {round} → board.gc(round)  (server-side state-GC ONLY; the
 *                                       fail-LOUD onUnquorumedExpiry callback is NEVER serialized —
 *                                       it stays a client-side JS closure registered on the board).
 *
 * Shape grafts (ROADMAP §7a / recon drift-corrections):
 *   - createServer + loopback `server.listen(port,'127.0.0.1',cb)` + restricted single-origin CORS
 *     (NEVER `'*'`) + GET/405 + 404 + try/catch→500 — cloned from coverage-server.ts:171-243.
 *   - POST handler + `MAX_BODY_BYTES=4096` readBody size-cap + strict JSON parse/validate-or-reject —
 *     cloned from turn-rpc.ts:56,80-117,154-198.
 *   - base64 `{32B pubkey, 64B sig}` codec on the wire (turn-rpc.ts:128) — the ONE net-new byte
 *     surface (INV-A): the codec WRAPS the pre-signed bytes, never alters them. The server is
 *     transport-agnostic about the rest of the attestation shape; it round-trips `pubkey`/`sig`
 *     base64 fields verbatim if present.
 *   - Bearer auth = shared `isBearerAuthorized` (DRY review D2) — length short-circuit →
 *     `Buffer.from(utf8)`×2 → re-check length → `crypto.timingSafeEqual` (metrics-server.ts:111-124
 *     SHAPE; `timingSafeEqual` FRESH from node:crypto in `@dvconf/shared/bearer-auth.ts`; NEVER the
 *     turn-rpc `===`; NEVER imported from apps/relay — INV-B).
 *
 * Auth = FAIL-LOUD: `QUORUM_CLAIMS_AUTH_TOKEN` is read once at factory time; an unset token throws
 * (refuse-to-start). A test-only `opts.authTokenOverride` injects a token without the env. Port is
 * resolved via the SHIPPED `resolveQuorumClaimsPort` + `assertQuorumPortFree` BEFORE bind.
 */
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Logger } from '@dvconf/shared';
import { type QuorumClaimBoard, type ClaimKind, isBearerAuthorized } from '@dvconf/shared';
import {
  resolveQuorumClaimsPort,
  assertQuorumPortFree,
} from './quorum-claims-port.js';
import {
  isQuorumClaimsTlsEnabled,
  createQuorumClaimsTlsServer,
  type QuorumClaimsTlsConfig,
} from './quorum-claims-tls.js';

/** Body-size cap (cloned from turn-rpc.ts:56) — rejects with 400 'body too large'. */
const MAX_BODY_BYTES = 4096;

/** The single CORS origin allowed (NEVER `'*'`). Loopback dashboard origin by default. */
const DEFAULT_CLAIMS_CORS_ORIGIN = 'http://localhost:5173';

/** The four kinds the carrier accepts (mirror of `ClaimKind`). */
const VALID_KINDS: readonly ClaimKind[] = [
  'canary-divergence',
  'captoken-issue',
  'captoken-refresh',
  'captoken-revoke',
];

/** A per-kind counter snapshot exposed for observability (additive — zero consumer change). */
export interface QuorumClaimsMetrics {
  cells: {
    opened: Partial<Record<ClaimKind, number>>;
    quorumed: Partial<Record<ClaimKind, number>>;
    submitted: Partial<Record<ClaimKind, number>>;
    gc: Partial<Record<ClaimKind, number>>;
  };
  /** Coarse poll/append latency tally (count + total ms) for a mean. */
  latency: { append: { count: number; totalMs: number }; poll: { count: number; totalMs: number } };
}

export interface StartQuorumClaimsOptions {
  /** The INJECTED board port — the server is transport only; it never constructs a board. */
  board: QuorumClaimBoard;
  logger: Logger;
  /** Env source (defaults to process.env). Drives QUORUM_CLAIMS_PORT + QUORUM_CLAIMS_AUTH_TOKEN. */
  env?: Record<string, string | undefined>;
  /**
   * OQ-7 cross-host boot-wiring: the network interface host to bind. Resolution order is
   * `opts.bindHost` → `QUORUM_CLAIMS_BIND_HOST` env → `'127.0.0.1'` (the byte-identical loopback
   * default — unreachable by a remote host, the single-host slice). Set to `'0.0.0.0'` (or a specific
   * NIC IP) to EXPOSE the board to remote peers over the mTLS carrier (leader-hosts-board topology).
   * Purely a bind target — no behavior change when unset.
   */
  bindHost?: string;
  /** Test-only token injection — bypasses the env read but NOT the fail-LOUD requirement. */
  authTokenOverride?: string;
  /** Override the single CORS origin (default QUORUM_CLAIMS_CORS_ORIGIN env). */
  corsOrigin?: string;
  /**
   * Test-only ephemeral-port escape hatch. When supplied (typically `0` for an OS-assigned port),
   * the factory binds this port DIRECTLY and SKIPS `resolveQuorumClaimsPort`/`assertQuorumPortFree`
   * — the shipped resolver rejects `0` (MIN_PORT=1) by design. Production NEVER sets this; the
   * resolve+assert path is the prod path and is exercised by the collision test.
   */
  portOverride?: number;
  /**
   * OQ-7 Phase B cross-host mTLS material + the pinned peer trust set. REQUIRED when the TLS fork is
   * enabled (`QUORUM_CLAIMS_TLS_ENABLED` is `'1'`/`'true'`); IGNORED otherwise (the OFF path is the
   * byte-identical node:http carrier). When the flag is ON but this is absent the factory FAILS LOUD.
   * In Phase C `trustedSpki` is derived from the loaded operator manifests; here it is injected.
   */
  tls?: QuorumClaimsTlsConfig;
}

export interface StartQuorumClaimsResult {
  server: Server;
  stop: () => Promise<void>;
  /** A snapshot of the additive observability counters. */
  getMetrics: () => QuorumClaimsMetrics;
}

// Bearer auth = the shared constant-time `isBearerAuthorized` (DRY review D2): the byte-identical
// per-carrier check is single-sourced in `@dvconf/shared/bearer-auth.ts` (FAIL-CLOSED on empty token;
// node:crypto timingSafeEqual; NOT imported from apps/relay — INV-B).

interface PostBody {
  kind: ClaimKind;
  claim: unknown;
  attestation: unknown;
  round: number;
}

/** Strict parse/validate-or-reject of the POST /quorum/claims body (turn-rpc.ts:100-117 SHAPE). */
function parsePostBody(raw: string): PostBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['kind'] !== 'string' || !VALID_KINDS.includes(o['kind'] as ClaimKind)) return null;
  if (typeof o['claim'] !== 'object' || o['claim'] === null) return null;
  if (typeof o['attestation'] !== 'object' || o['attestation'] === null) return null;
  if (typeof o['round'] !== 'number' || !Number.isFinite(o['round'])) return null;
  return {
    kind: o['kind'] as ClaimKind,
    claim: o['claim'],
    attestation: o['attestation'],
    round: o['round'],
  };
}

/** Strict parse of a `{key:string}` body (used by /get + /mark-submitted). */
function parseKeyBody(raw: string): { key: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['key'] !== 'string' || o['key'] === '') return null;
  return { key: o['key'] };
}

/** Strict parse of a `{round:number}` body (used by /gc). */
function parseRoundBody(raw: string): { round: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['round'] !== 'number' || !Number.isFinite(o['round'])) return null;
  return { round: o['round'] };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A distinct-attester count proxy so the observability layer can flag "quorumed" cells. The board's
 *  per-kind `distinctCount` is the authority; the carrier uses ≥2 attesters on a cell as the coarse
 *  quorumed signal (MIN_ATTESTERS=2 floor, NOT relaxed). */
function attestationCount(cell: { attestations: unknown[] }): number {
  return cell.attestations.length;
}

/**
 * Start the loopback `/quorum/claims` carrier. FAIL-LOUD on an unset token. Resolves + asserts the
 * port BEFORE bind. Returns the server + a graceful `stop()` + a metrics snapshot accessor.
 */
export async function startQuorumClaimsServer(
  opts: StartQuorumClaimsOptions,
): Promise<StartQuorumClaimsResult> {
  const env = opts.env ?? process.env;
  const { board, logger } = opts;

  // ── FAIL-LOUD: read the token once; refuse-to-start when unset AND no test override. ──
  const token = opts.authTokenOverride ?? env['QUORUM_CLAIMS_AUTH_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'QUORUM_CLAIMS_AUTH_TOKEN is unset — the /quorum/claims carrier refuses to start ' +
        '(security-critical transport; set the env or inject opts.authTokenOverride in tests).',
    );
  }

  // ── Resolve + pre-flight assert the port BEFORE any bind (fail-closed on collision). ──
  // The test-only `portOverride` (typically 0) bypasses the shipped resolver, which rejects 0
  // (MIN_PORT=1) by design; production always goes through resolve+assert.
  let port: number;
  if (opts.portOverride !== undefined) {
    port = opts.portOverride;
  } else {
    port = resolveQuorumClaimsPort(env);
    assertQuorumPortFree(port);
  }

  const corsOrigin =
    opts.corsOrigin ?? env['QUORUM_CLAIMS_CORS_ORIGIN'] ?? DEFAULT_CLAIMS_CORS_ORIGIN;

  // RESTRICTED CORS — a single origin, NEVER `'*'`.
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    Vary: 'Origin',
  } as const;

  // ── Additive observability counters (pino-logged on tick; ZERO consumer change). ──
  const metrics: QuorumClaimsMetrics = {
    cells: { opened: {}, quorumed: {}, submitted: {}, gc: {} },
    latency: { append: { count: 0, totalMs: 0 }, poll: { count: 0, totalMs: 0 } },
  };
  const bump = (
    bucket: Partial<Record<ClaimKind, number>>,
    kind: ClaimKind,
  ): void => {
    bucket[kind] = (bucket[kind] ?? 0) + 1;
  };

  function send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status, jsonHeaders);
      res.end();
      return;
    }
    res.writeHead(status, jsonHeaders);
    res.end(JSON.stringify(body));
  }

  // The shared application listener — identical logic on BOTH the http and https forks. The mTLS
  // fork wraps this with a per-request SPKI pin check; this listener still enforces the bearer
  // token (defense-in-depth in BOTH modes).
  const appListener = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res);
  };

  // ── Carrier transport selection (OQ-7 Phase B). ──
  //   OFF (default): the EXISTING node:http carrier — byte-identical, no behavior change.
  //   ON:            a node:https mTLS server (self-signed cert, requestCert + post-handshake SPKI
  //                  pin against `opts.tls.trustedSpki`). FAIL-LOUD if the flag is on but no tls cfg.
  const tlsEnabled = isQuorumClaimsTlsEnabled(env);
  let server: Server;
  if (tlsEnabled) {
    if (opts.tls === undefined) {
      throw new Error(
        'QUORUM_CLAIMS_TLS_ENABLED is set but no opts.tls (key/cert/trustedSpki) was provided — ' +
          'the cross-host mTLS carrier refuses to start without its TLS material + pinned peer set.',
      );
    }
    server = createQuorumClaimsTlsServer(opts.tls, appListener) as unknown as Server;
  } else {
    server = createServer(appListener);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      // Route table: only the five known routes exist; anything else is 404.
      const isClaims = url === '/quorum/claims';
      const isOpen = url === '/quorum/claims/open';
      const isGet = url === '/quorum/claims/get';
      const isMark = url === '/quorum/claims/mark-submitted';
      const isGc = url === '/quorum/claims/gc';

      if (!isClaims && !isOpen && !isGet && !isMark && !isGc) {
        return send(res, 404, { error: 'not found' });
      }

      // Auth gate (all routes; constant-time).
      if (!isBearerAuthorized(req, token!)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      // ── GET /quorum/claims/open ──
      if (isOpen) {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        const t0 = Date.now();
        const open = await board.listOpen();
        metrics.latency.poll.count += 1;
        metrics.latency.poll.totalMs += Date.now() - t0;
        return send(res, 200, open);
      }

      // ── POST /quorum/claims (append) ──
      if (isClaims) {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          return send(res, 400, { error: 'body too large' });
        }
        const body = parsePostBody(raw);
        if (body === null) return send(res, 400, { error: 'malformed request body' });

        const t0 = Date.now();
        // The board owns dedup/idempotency; we observe opened/quorumed AFTER the post resolves.
        await board.post(body.kind, body.claim, body.attestation, body.round);
        metrics.latency.append.count += 1;
        metrics.latency.append.totalMs += Date.now() - t0;
        bump(metrics.cells.opened, body.kind);
        // Quorumed signal: re-read this cell's attester count; ≥2 distinct → quorumed tick.
        const open = await board.listOpen();
        for (const cell of open) {
          if (cell.kind === body.kind && attestationCount(cell) >= 2) {
            bump(metrics.cells.quorumed, body.kind);
            break;
          }
        }
        logger.info({ kind: body.kind, round: body.round }, 'quorum/claims: appended');
        return send(res, 200, { ok: true });
      }

      // ── POST /quorum/claims/get ──
      if (isGet) {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          return send(res, 400, { error: 'body too large' });
        }
        const body = parseKeyBody(raw);
        if (body === null) return send(res, 400, { error: 'malformed request body' });
        const cell = await board.get(body.key);
        return send(res, 200, cell ?? null);
      }

      // ── POST /quorum/claims/mark-submitted ──
      if (isMark) {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          return send(res, 400, { error: 'body too large' });
        }
        const body = parseKeyBody(raw);
        if (body === null) return send(res, 400, { error: 'malformed request body' });
        // Best-effort: derive the kind from the namespaced key prefix for the counter.
        const prefix = body.key.split('|', 1)[0] as ClaimKind;
        await board.markSubmitted(body.key);
        if (VALID_KINDS.includes(prefix)) bump(metrics.cells.submitted, prefix);
        logger.info({ key: body.key }, 'quorum/claims: marked submitted');
        return send(res, 200, { ok: true });
      }

      // ── POST /quorum/claims/gc (server-side state-GC ONLY; callback never serialized) ──
      if (isGc) {
        if (method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          return send(res, 400, { error: 'body too large' });
        }
        const body = parseRoundBody(raw);
        if (body === null) return send(res, 400, { error: 'malformed request body' });
        await board.gc(body.round);
        logger.info({ round: body.round }, 'quorum/claims: gc');
        return send(res, 200, { ok: true });
      }
    } catch (err) {
      logger.error({ err, url: req.url }, 'quorum/claims: unhandled error');
      try {
        send(res, 500, { error: 'internal' });
      } catch {
        /* response may already be partially written */
      }
    }
  }

  // ── Bind host (OQ-7 cross-host boot-wiring). Default '127.0.0.1' → the byte-identical LOOPBACK
  //    bind (unreachable by a remote host, the single-host slice). '0.0.0.0'/NIC-IP EXPOSES the board
  //    to remote peers over the mTLS carrier (leader-hosts-board). Resolution: opts → env → loopback. ──
  const bindHost = opts.bindHost ?? env['QUORUM_CLAIMS_BIND_HOST'] ?? '127.0.0.1';
  await new Promise<void>((resolve) => {
    server.listen(port, bindHost, () => resolve());
  });

  const boundPort = (server.address() as { port: number } | null)?.port ?? port;
  logger.info(
    { port: boundPort, host: bindHost, corsOrigin, scheme: tlsEnabled ? 'https-mtls' : 'http' },
    'quorum/claims carrier listening',
  );

  return {
    server,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    getMetrics: () => ({
      cells: {
        opened: { ...metrics.cells.opened },
        quorumed: { ...metrics.cells.quorumed },
        submitted: { ...metrics.cells.submitted },
        gc: { ...metrics.cells.gc },
      },
      latency: {
        append: { ...metrics.latency.append },
        poll: { ...metrics.latency.poll },
      },
    }),
  };
}
