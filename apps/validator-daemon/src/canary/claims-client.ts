/**
 * OQ-7 Phase D-1 STAGE-2 (CANARY CARRIER) — the `HttpClaimBoard` client.
 *
 * The HTTP-backed CLIENT for the live `/canary/claims` loopback carrier (claims-server.ts). It
 * implements the EXACT canary `ClaimBoard` port over bearer-authed HTTP — the PURE-TRANSPORT
 * substitution for the hermetic `InMemoryClaimBoard`: swapping it in behind the same port changes
 * NOTHING observable (the parity suite is the proof). Mirrors cp-daemon's `HttpQuorumClaimBoard` but
 * the canary port has NO `kind`:
 *   - post(claim, attestation, round)       → POST   /canary/claims        {claim,attestation,round}
 *   - listOpen()                            → GET    /canary/claims/open    → OpenClaimCell[]
 *   - get(key)                              → POST   /canary/claims/get     {key} → cell | null→undefined
 *   - markSubmitted(key)                    → POST   /canary/claims/mark-submitted {key}
 *   - gc(round)                             → POST   /canary/claims/gc      {round}
 *
 * Wire codec (INV-A): a `DivergenceAttestation` carries raw `{32B sessionPublicKey, 64B signature}`
 * Uint8Arrays; this client encodes them to base64 `{pubkey,sig}` for the wire and decodes the server's
 * cells back to raw bytes — the bytes ride VERBATIM (base64 wraps, never alters). The 145-byte
 * `canonicalProofMessage` the attestation signs is a FROZEN surface this client never touches.
 *
 * FAIL-CLOSED: any non-2xx response (incl. a 401 bad-token or a 500 board-throw) OR a network error
 * THROWS — never a silent `undefined`. The SOLE exception is the by-contract `get()` miss: the server
 * returns 200+`null` (and a defensive 404) for an absent/submitted cell, both mapped to `undefined`.
 *
 * TLS path via the SHARED `buildPinnedDispatcher` (the SPKI-pin code lives in @dvconf/shared — this
 * lane does NOT duplicate it). Bearer retained on every request.
 *
 * LOGGING (HARD-GATE): structured createLogger only — NEVER a console.* and NEVER key material.
 */
import { createLogger, type Logger, buildPinnedDispatcher } from '@dvconf/shared';
import type { ClaimBoard, OpenClaimCell } from './claim-board.js';
import type { DivergenceClaim, DivergenceAttestation } from './proof.js';

/** Per-method request tally exposed for observability (additive — zero consumer change). */
export interface HttpClaimBoardMetrics {
  requests: { post: number; listOpen: number; get: number; markSubmitted: number; gc: number };
  /** Count of non-2xx responses surfaced as a throw (a 404 on /get is NOT counted — by contract). */
  non2xx: number;
  /** Coarse round-trip latency tally (count + total ms) for a mean. */
  latency: { count: number; totalMs: number };
}

type WireMethod = keyof HttpClaimBoardMetrics['requests'];

/**
 * OQ-7 cross-host mTLS CLIENT material. When supplied, `baseUrl` MUST be `https://…` and every request
 * rides a mutually-authenticated TLS channel: the client PRESENTS `{cert,key}` (its own SPKI is what
 * the server pins) and PINS the server's SPKI — the peer cert's `spkiFingerprint` MUST be in
 * `trustedServerSpki`, else the handshake fails-closed. NO CA / NO central PKI.
 */
export interface HttpClaimBoardTlsConfig {
  /** The client's self-signed TLS cert (PEM) — its SPKI is what the server pins. */
  cert: string;
  /** The client's self-signed TLS private key (PEM). */
  key: string;
  /** Trusted server SPKI fingerprints (`spkiFingerprint` lowercase hex). The peer must be in this set. */
  trustedServerSpki: ReadonlySet<string>;
}

export interface HttpClaimBoardOptions {
  /** Base URL of the live carrier, e.g. `http://127.0.0.1:8092` (or `https://…` in TLS mode). */
  baseUrl: string;
  /** Bearer token mirroring the server's `CANARY_CLAIMS_AUTH_TOKEN`. */
  token: string;
  /** Injected fetch for testability (defaults to the global `fetch`). */
  fetch?: typeof fetch;
  /** Optional logger (defaults to a fresh `canary/claims-client` pino logger). */
  logger?: Logger;
  /**
   * OQ-7 cross-host mTLS material + the pinned server trust set. When supplied, the client builds an
   * undici `Agent` dispatcher (presents the cert, pins the server SPKI) and rides it on every request.
   * When ABSENT the plain-`fetch` path is byte-identical (zero behavior change).
   */
  tls?: HttpClaimBoardTlsConfig;
}

/** The on-the-wire attestation shape: Wallet-B `{pubkey,sig}` base64 ONLY (INV-C). */
interface WireAttestation {
  pubkey: string;
  sig: string;
}

/** The wire shape of an open cell — attestations as base64 `{pubkey,sig}`. */
interface WireOpenCell {
  key: string;
  claim: DivergenceClaim;
  attestations: WireAttestation[];
  openedRound: number;
}

/** Encode a raw-bytes attestation to the wire (INV-A: base64 wraps, never alters). */
function encodeAttestation(a: DivergenceAttestation): WireAttestation {
  return {
    pubkey: Buffer.from(a.sessionPublicKey).toString('base64'),
    sig: Buffer.from(a.signature).toString('base64'),
  };
}

/** Decode a wire `{pubkey,sig}` back to raw bytes (INV-A: verbatim). Throws on a wrong length. */
function decodeAttestation(w: WireAttestation): DivergenceAttestation {
  const sessionPublicKey = new Uint8Array(Buffer.from(w.pubkey, 'base64'));
  const signature = new Uint8Array(Buffer.from(w.sig, 'base64'));
  if (sessionPublicKey.length !== 32 || signature.length !== 64) {
    throw new Error('canary/claims-client: decoded attestation is not 32B pubkey / 64B sig (fail-closed)');
  }
  return { sessionPublicKey, signature };
}

/** Decode a wire cell back to the in-memory `OpenClaimCell` shape. */
function decodeCell(w: WireOpenCell): OpenClaimCell {
  return {
    key: w.key,
    claim: w.claim,
    attestations: w.attestations.map(decodeAttestation),
    openedRound: w.openedRound,
  };
}

/**
 * The HTTP transport implementation of the canary `ClaimBoard` port. The EXACT 5 async methods (NO
 * kind on post). Bearer-authed; fail-closed on any non-2xx / network error (except get() miss → undefined).
 */
export class HttpClaimBoard implements ClaimBoard {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly log: Logger;
  /**
   * The undici `Agent` dispatcher carrying the client cert + the server-SPKI pin. Set only in TLS
   * mode; `undefined` on the plain-fetch path (so that path stays byte-identical). `globalThis.fetch`
   * is undici and IGNORES a node:https Agent — the cert/trust MUST ride on the non-standard
   * `dispatcher` init field (needs an as-cast for the `RequestInit` type gap).
   */
  private readonly dispatcher: ReturnType<typeof buildPinnedDispatcher> | undefined;
  private readonly metrics: HttpClaimBoardMetrics = {
    requests: { post: 0, listOpen: 0, get: 0, markSubmitted: 0, gc: 0 },
    non2xx: 0,
    latency: { count: 0, totalMs: 0 },
  };

  constructor(opts: HttpClaimBoardOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = opts.logger ?? createLogger('canary/claims-client');

    // In TLS mode, build the undici Agent dispatcher ONCE via the SHARED `buildPinnedDispatcher`
    // (single-sourced in @dvconf/shared). It PRESENTS the client {cert,key} and PINS the server SPKI
    // fail-closed (an untrusted carrier is REFUSED — the socket is destroyed before any application
    // byte). The HARDENED single-gate connector lives in the shared module — this is a no-op re-point.
    if (opts.tls !== undefined) {
      const { cert, key, trustedServerSpki } = opts.tls;
      this.dispatcher = buildPinnedDispatcher({ cert, key, trustedServerSpki });
    } else {
      this.dispatcher = undefined;
    }
  }

  private authHeaders(json: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (json) h['content-type'] = 'application/json';
    return h;
  }

  /**
   * One authed request with method-tagged metrics + latency. Returns the `Response` on a 2xx; THROWS
   * on any non-2xx (incrementing `non2xx`) or a network error (fail-closed). A 404 is allowed through
   * to the caller (only `get()` interprets it) WITHOUT counting as a surfaced non-2xx error.
   */
  private async request(
    method: WireMethod,
    path: string,
    httpMethod: 'GET' | 'POST',
    body?: unknown,
  ): Promise<Response> {
    this.metrics.requests[method] += 1;
    const t0 = Date.now();
    let res: Response;
    try {
      const init = {
        method: httpMethod,
        headers: this.authHeaders(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        ...(this.dispatcher !== undefined ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit;
      res = await this.doFetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      this.metrics.latency.count += 1;
      this.metrics.latency.totalMs += Date.now() - t0;
      this.metrics.non2xx += 1;
      this.log.error({ err, method, path }, 'canary/claims-client: network error (fail-closed)');
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.metrics.latency.count += 1;
    this.metrics.latency.totalMs += Date.now() - t0;

    if (res.status === 404) {
      this.log.debug({ method, path }, 'canary/claims-client: 404 (cell absent — get() maps to undefined)');
      return res;
    }
    if (!res.ok) {
      this.metrics.non2xx += 1;
      this.log.error(
        { method, path, status: res.status },
        'canary/claims-client: non-2xx response (fail-closed)',
      );
      throw new Error(`canary/claims-client: ${method} ${path} → HTTP ${res.status} (fail-closed)`);
    }
    return res;
  }

  async post(claim: DivergenceClaim, attestation: DivergenceAttestation, round: number): Promise<void> {
    // The {pk,sig} bytes ride VERBATIM as base64 fields (INV-A: wrap, never alter).
    await this.request('post', '/canary/claims', 'POST', {
      claim,
      attestation: encodeAttestation(attestation),
      round,
    });
  }

  async listOpen(): Promise<OpenClaimCell[]> {
    const res = await this.request('listOpen', '/canary/claims/open', 'GET');
    const parsed = (await res.json()) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('canary/claims-client: /open returned a non-array body (fail-closed)');
    }
    return (parsed as WireOpenCell[]).map(decodeCell);
  }

  async get(key: string): Promise<OpenClaimCell | undefined> {
    const res = await this.request('get', '/canary/claims/get', 'POST', { key });
    if (res.status === 404) return undefined;
    const parsed = (await res.json()) as unknown;
    if (parsed === null) return undefined;
    return decodeCell(parsed as WireOpenCell);
  }

  async markSubmitted(key: string): Promise<void> {
    await this.request('markSubmitted', '/canary/claims/mark-submitted', 'POST', { key });
  }

  async gc(currentRound: number): Promise<void> {
    await this.request('gc', '/canary/claims/gc', 'POST', { round: currentRound });
  }

  /** A snapshot of the additive client-side observability counters. */
  getMetrics(): HttpClaimBoardMetrics {
    return {
      requests: { ...this.metrics.requests },
      non2xx: this.metrics.non2xx,
      latency: { ...this.metrics.latency },
    };
  }
}
