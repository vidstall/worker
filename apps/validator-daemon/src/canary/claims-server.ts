/**
 * OQ-7 Phase D-1 STAGE-2 (CANARY CARRIER) — the LIVE `/canary/claims` HTTP carrier (validator-daemon).
 *
 * The off-media-path transport slice for the canary pull-corroboration claim board. This is the PURE
 * TRANSPORT layer — it owns NO board state. It delegates every route to an INJECTED canary-concrete
 * `ClaimBoard` port (the hermetic `InMemoryClaimBoard`, or in M4b the live HTTP board). Five routes
 * (mirror of cp-daemon's quorum-claims-server.ts — but the canary port has NO `kind`):
 *   - POST /canary/claims              {claim,attestation,round} → board.post(claim, attestation, round)
 *   - GET  /canary/claims/open         → board.listOpen()
 *   - POST /canary/claims/get          {key} → board.get(key)
 *   - POST /canary/claims/mark-submitted {key} → board.markSubmitted(key)
 *   - POST /canary/claims/gc           {round} → board.gc(round)
 *
 * Wire codec (INV-A): a `DivergenceAttestation` carries raw `{32B sessionPublicKey, 64B signature}`
 * Uint8Arrays; on the wire they ride as base64 `{pubkey,sig}` fields. The codec WRAPS the pre-signed
 * bytes, NEVER alters them — the decoded bytes are byte-identical to the in-memory shape (the 145-byte
 * `canonicalProofMessage` the attestation signs is itself untouched; see proof.ts — a FROZEN surface
 * this carrier does NOT edit). `listOpen`/`get` re-encode verbatim.
 *
 * INV-C (HARD-GATE, fail-closed BEFORE store): `validateWireSchema` rejects any post whose `claim` or
 * `attestation` carries a FORBIDDEN field — an AUDITING validator's `minerId`/Wallet-A, the salted
 * `assignmentSecret`/`cellSecret`, a `sessionWallet`, or a Wallet-A `signatureA` leg. Only the ACCUSED
 * relay's PUBLIC `relayMinerId` + the divergence-identifying fields + the Wallet-B `{pubkey,sig}` are
 * allowed. A forbidden field → 400 (the post never reaches the board).
 *
 * Auth = FAIL-LOUD bearer (`CANARY_CLAIMS_AUTH_TOKEN`, `timingSafeEqual`, refuse-to-start on unset).
 * Port resolved via `resolveCanaryClaimsPort` + `assertCanaryClaimsPortFree` BEFORE bind.
 *
 * mTLS fork behind `CANARY_CLAIMS_TLS_ENABLED` reusing the SHARED `createMtlsServer` (the SPKI-pin
 * code lives in @dvconf/shared/mtls-carrier.ts — this lane does NOT duplicate it). Default OFF →
 * byte-identical node:http carrier. INV-B: `node:http`/`node:crypto` are imported FRESH here (NEVER
 * from apps/relay/); the TLS imports live in the shared module.
 *
 * LOGGING (HARD-GATE): structured createLogger only — NEVER a console.* and NEVER key material.
 */
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { type Logger, createMtlsServer } from '@dvconf/shared';
import type { RequestListener } from 'node:http';
import type { ClaimBoard, OpenClaimCell } from './claim-board.js';
import type { DivergenceClaim, DivergenceAttestation } from './proof.js';
import {
  resolveCanaryClaimsPort,
  assertCanaryClaimsPortFree,
} from './canary-claims-port.js';

/** Body-size cap — rejects with 400 'body too large'. */
const MAX_BODY_BYTES = 4096;

/** The single CORS origin allowed (NEVER `'*'`). Loopback dashboard origin by default. */
const DEFAULT_CLAIMS_CORS_ORIGIN = 'http://localhost:5173';

/**
 * The ONLY claim fields allowed on the wire (the 6 divergence-identifying fields). ANY other key on
 * `claim` is a fail-closed INV-C violation (an auditor `minerId`, a salted `assignmentSecret`, a
 * `sessionWallet`, etc.). Whitelist > blacklist so a net-new leaky field is rejected by default.
 */
const ALLOWED_CLAIM_FIELDS: ReadonlySet<string> = new Set([
  'roomId',
  'relayMinerId',
  'canaryId',
  'frameSeq',
  'expectedHash',
  'observedHash',
]);

/** The ONLY attestation fields allowed on the wire — Wallet-B `{pubkey,sig}` base64 ONLY. */
const ALLOWED_ATT_FIELDS: ReadonlySet<string> = new Set(['pubkey', 'sig']);

/** The TLS material + the pinned peer trust anchors for the canary mTLS server fork. */
export interface CanaryClaimsTlsConfig {
  /** The carrier's self-signed TLS private key (PEM). */
  key: string;
  /** The carrier's self-signed TLS cert (PEM). */
  cert: string;
  /**
   * The set of TRUSTED peer (client) SPKI fingerprints (`spkiFingerprint(peerCert)` — lowercase hex).
   * A client whose presented cert's SPKI is NOT in this set is rejected post-handshake (403). In a
   * later phase this is derived from `loadManifests(...)` → `m.certFingerprint`.
   */
  trustedSpki: ReadonlySet<string>;
}

export interface StartCanaryClaimsOptions {
  /** The INJECTED canary `ClaimBoard` port — the server is transport only; it never constructs a board. */
  board: ClaimBoard;
  logger: Logger;
  /** Env source (defaults to process.env). Drives CANARY_CLAIMS_PORT + CANARY_CLAIMS_AUTH_TOKEN + TLS flag. */
  env?: Record<string, string | undefined>;
  /** Test-only token injection — bypasses the env read but NOT the fail-LOUD requirement. */
  authTokenOverride?: string;
  /** Override the single CORS origin (default CANARY_CLAIMS_CORS_ORIGIN env). */
  corsOrigin?: string;
  /**
   * Test-only ephemeral-port escape hatch. When supplied (typically `0` for an OS-assigned port), the
   * factory binds this port DIRECTLY and SKIPS `resolveCanaryClaimsPort`/`assertCanaryClaimsPortFree`
   * (the resolver rejects `0`). Production NEVER sets this; the resolve+assert path is the prod path,
   * exercised by the collision test.
   */
  portOverride?: number;
  /**
   * OQ-7 cross-host mTLS material + the pinned peer trust set. REQUIRED when the TLS fork is enabled
   * (`CANARY_CLAIMS_TLS_ENABLED` is `'1'`/`'true'`); IGNORED otherwise (the OFF path is the
   * byte-identical node:http carrier). When the flag is ON but this is absent the factory FAILS LOUD.
   */
  tls?: CanaryClaimsTlsConfig;
}

export interface StartCanaryClaimsResult {
  server: Server;
  stop: () => Promise<void>;
}

/** Resolve whether the cross-host TLS fork is enabled. OFF by default (byte-identical node:http). */
export function isCanaryClaimsTlsEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env['CANARY_CLAIMS_TLS_ENABLED'];
  return raw === '1' || raw === 'true';
}

/**
 * Fresh constant-time bearer check. NOT a `===`; NOT imported from apps/relay (INV-B). FAIL-CLOSED
 * when no token configured — `expectedToken` is guaranteed non-empty by the factory's fail-LOUD
 * construction, but the guard is defensive.
 */
function isCanaryClaimsAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  if (expectedToken === '') return false; // FAIL-CLOSED (security-critical transport)
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length);
  if (presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false; // length is not secret; short-circuit before the call
  return timingSafeEqual(a, b);
}

/** The on-the-wire attestation shape: Wallet-B `{pubkey,sig}` base64 ONLY (INV-C). */
interface WireAttestation {
  /** base64 of the raw 32-byte Wallet-B session public key. */
  pubkey: string;
  /** base64 of the raw 64-byte ed25519 signature over the 145-byte canonical message. */
  sig: string;
}

interface PostBody {
  claim: Record<string, unknown>;
  /** The RAW attestation object (ALL keys preserved) so the INV-C allow-list can see a leaky field. */
  attestation: Record<string, unknown>;
  round: number;
}

/**
 * INV-C per-post wire-schema allow-list (fail-closed BEFORE store). Returns an error string when the
 * claim/attestation carries ANY forbidden field, else `null`. Whitelist-based: a net-new leaky field
 * (an auditor `minerId`/Wallet-A, a salted `assignmentSecret`/`cellSecret`, a `sessionWallet`, a
 * Wallet-A `signatureA` leg, …) is rejected by default because it is not in the allowed set.
 */
export function validateWireSchema(claim: Record<string, unknown>, attestation: Record<string, unknown>): string | null {
  for (const k of Object.keys(claim)) {
    if (!ALLOWED_CLAIM_FIELDS.has(k)) {
      return `INV-C: forbidden claim field "${k}" (only the divergence-identifying fields may cross the wire)`;
    }
  }
  for (const k of Object.keys(attestation)) {
    if (!ALLOWED_ATT_FIELDS.has(k)) {
      return `INV-C: forbidden attestation field "${k}" (only Wallet-B {pubkey,sig} may cross the wire)`;
    }
  }
  return null;
}

/** Strict parse/validate-or-reject of the POST /canary/claims body. NO `kind`. */
function parsePostBody(raw: string): PostBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['claim'] !== 'object' || o['claim'] === null) return null;
  if (typeof o['attestation'] !== 'object' || o['attestation'] === null) return null;
  if (typeof o['round'] !== 'number' || !Number.isFinite(o['round'])) return null;
  const att = o['attestation'] as Record<string, unknown>;
  if (typeof att['pubkey'] !== 'string' || typeof att['sig'] !== 'string') return null;
  // Preserve the RAW attestation (do NOT strip extra keys here) — the INV-C allow-list must see a
  // leaky field (a Wallet-A `signatureA`/`minerId`) to reject it fail-closed BEFORE store.
  return {
    claim: o['claim'] as Record<string, unknown>,
    attestation: att,
    round: o['round'],
  };
}

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
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Decode a wire `{pubkey,sig}` (base64) into a raw-bytes `DivergenceAttestation` (INV-A: the bytes
 * ride VERBATIM — base64 wraps, never alters). Returns null on a malformed base64 / wrong length.
 */
function decodeAttestation(wire: WireAttestation): DivergenceAttestation | null {
  const sessionPublicKey = new Uint8Array(Buffer.from(wire.pubkey, 'base64'));
  const signature = new Uint8Array(Buffer.from(wire.sig, 'base64'));
  if (sessionPublicKey.length !== 32 || signature.length !== 64) return null;
  return { sessionPublicKey, signature };
}

/** Re-encode a stored `DivergenceAttestation` to the wire `{pubkey,sig}` (verbatim base64). */
function encodeAttestation(a: DivergenceAttestation): WireAttestation {
  return {
    pubkey: Buffer.from(a.sessionPublicKey).toString('base64'),
    sig: Buffer.from(a.signature).toString('base64'),
  };
}

/** The wire shape of an open cell — attestations re-encoded to base64 `{pubkey,sig}`. */
interface WireOpenCell {
  key: string;
  claim: DivergenceClaim;
  attestations: WireAttestation[];
  openedRound: number;
}

function encodeCell(cell: OpenClaimCell): WireOpenCell {
  return {
    key: cell.key,
    claim: cell.claim,
    attestations: cell.attestations.map(encodeAttestation),
    openedRound: cell.openedRound,
  };
}

/**
 * Start the `/canary/claims` carrier. FAIL-LOUD on an unset token. Resolves + asserts the port BEFORE
 * bind. Returns the server + a graceful `stop()`.
 */
export async function startCanaryClaimsServer(
  opts: StartCanaryClaimsOptions,
): Promise<StartCanaryClaimsResult> {
  const env = opts.env ?? process.env;
  const { board, logger } = opts;

  // ── FAIL-LOUD: read the token once; refuse-to-start when unset AND no test override. ──
  const token = opts.authTokenOverride ?? env['CANARY_CLAIMS_AUTH_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'CANARY_CLAIMS_AUTH_TOKEN is unset — the /canary/claims carrier refuses to start ' +
        '(security-critical transport; set the env or inject opts.authTokenOverride in tests).',
    );
  }

  // ── Resolve + pre-flight assert the port BEFORE any bind (fail-closed on collision). ──
  let port: number;
  if (opts.portOverride !== undefined) {
    port = opts.portOverride;
  } else {
    port = resolveCanaryClaimsPort(env);
    assertCanaryClaimsPortFree(port);
  }

  const corsOrigin =
    opts.corsOrigin ?? env['CANARY_CLAIMS_CORS_ORIGIN'] ?? DEFAULT_CLAIMS_CORS_ORIGIN;

  // RESTRICTED CORS — a single origin, NEVER `'*'`.
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': corsOrigin,
    Vary: 'Origin',
  } as const;

  function send(res: ServerResponse, status: number, body?: unknown): void {
    if (body === undefined) {
      res.writeHead(status, jsonHeaders);
      res.end();
      return;
    }
    res.writeHead(status, jsonHeaders);
    res.end(JSON.stringify(body));
  }

  // The shared application listener — identical on BOTH the http and https forks. The mTLS fork wraps
  // this with a per-request SPKI pin (403-before-handler); this listener still enforces the bearer
  // token (defense-in-depth in BOTH modes).
  const appListener: RequestListener = (req, res) => {
    void handle(req, res);
  };

  // ── Carrier transport selection (OQ-7). ──
  //   OFF (default): the node:http carrier — byte-identical, no behavior change.
  //   ON:            the SHARED node:https mTLS server (self-signed cert, requestCert + post-handshake
  //                  SPKI pin against opts.tls.trustedSpki). FAIL-LOUD if the flag is on but no tls cfg.
  const tlsEnabled = isCanaryClaimsTlsEnabled(env);
  let server: Server;
  if (tlsEnabled) {
    if (opts.tls === undefined) {
      throw new Error(
        'CANARY_CLAIMS_TLS_ENABLED is set but no opts.tls (key/cert/trustedSpki) was provided — ' +
          'the cross-host mTLS canary carrier refuses to start without its TLS material + pinned peer set.',
      );
    }
    server = createMtlsServer(
      { key: opts.tls.key, cert: opts.tls.cert, trustedClientSpki: opts.tls.trustedSpki },
      appListener,
    ) as unknown as Server;
  } else {
    server = createServer(appListener);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = req.url ?? '/';
      const method = req.method ?? 'GET';

      const isClaims = url === '/canary/claims';
      const isOpen = url === '/canary/claims/open';
      const isGet = url === '/canary/claims/get';
      const isMark = url === '/canary/claims/mark-submitted';
      const isGc = url === '/canary/claims/gc';

      if (!isClaims && !isOpen && !isGet && !isMark && !isGc) {
        return send(res, 404, { error: 'not found' });
      }

      // Auth gate (all routes; constant-time).
      if (!isCanaryClaimsAuthorized(req, token!)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      // ── GET /canary/claims/open ──
      if (isOpen) {
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' });
        const open = await board.listOpen();
        return send(res, 200, open.map(encodeCell));
      }

      // ── POST /canary/claims (append, NO kind) ──
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

        // INV-C: reject (fail-closed) BEFORE store if any forbidden field rides the wire (the RAW
        // claim + RAW attestation are inspected so a leaky extra key cannot slip past a down-parse).
        const schemaErr = validateWireSchema(body.claim, body.attestation);
        if (schemaErr !== null) {
          logger.warn({ reason: schemaErr }, 'canary/claims: INV-C wire-schema reject (fail-closed)');
          return send(res, 400, { error: schemaErr });
        }

        // Past the allow-list: the attestation is exactly {pubkey,sig} — decode to raw bytes.
        const att = decodeAttestation({
          pubkey: body.attestation['pubkey'] as string,
          sig: body.attestation['sig'] as string,
        });
        if (att === null) {
          return send(res, 400, { error: 'INV-A: attestation pubkey/sig must decode to 32B/64B' });
        }
        // The claim passed the allow-list, so it is exactly the 6 identifying fields.
        const claim = body.claim as unknown as DivergenceClaim;
        await board.post(claim, att, body.round);
        logger.info(
          { relayMinerId: claim.relayMinerId, canaryId: claim.canaryId, frameSeq: claim.frameSeq, round: body.round },
          'canary/claims: appended',
        );
        return send(res, 200, { ok: true });
      }

      // ── POST /canary/claims/get ──
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
        return send(res, 200, cell ? encodeCell(cell) : null);
      }

      // ── POST /canary/claims/mark-submitted ──
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
        await board.markSubmitted(body.key);
        logger.info({ key: body.key }, 'canary/claims: marked submitted');
        return send(res, 200, { ok: true });
      }

      // ── POST /canary/claims/gc ──
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
        logger.info({ round: body.round }, 'canary/claims: gc');
        return send(res, 200, { ok: true });
      }
    } catch (err) {
      logger.error({ err, url: req.url }, 'canary/claims: unhandled error');
      try {
        send(res, 500, { error: 'internal' });
      } catch {
        /* response may already be partially written */
      }
    }
  }

  // ── LOOPBACK bind (127.0.0.1) — off-media-path, unreachable by a remote host in the single-host slice. ──
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const boundPort = (server.address() as { port: number } | null)?.port ?? port;
  logger.info(
    { port: boundPort, host: '127.0.0.1', corsOrigin, scheme: tlsEnabled ? 'https-mtls' : 'http' },
    'canary/claims carrier listening (loopback)',
  );

  return {
    server,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
