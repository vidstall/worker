/**
 * Multi-CP quorum Phase 1 — Leg 7b: the `HttpQuorumClaimBoard` client.
 *
 * The HTTP-backed board CLIENT for the live `/quorum/claims` loopback carrier (Leg 7a server in
 * `quorum-claims-server.ts`). It implements the EXACT 5-method `QuorumClaimBoard` port over
 * bearer-authed HTTP — the PURE-TRANSPORT substitution for the hermetic `InMemoryGenericClaimBoard`:
 * swapping it in behind the same port changes NOTHING observable (the parity suite is the proof).
 *
 *   - post(kind, claim, attestation, round) → POST   /quorum/claims        {kind,claim,attestation,round}
 *   - listOpen()                            → GET    /quorum/claims/open    → OpenGenericCell[]
 *   - get(key)                              → POST   /quorum/claims/get     {key} → cell | null→undefined
 *   - markSubmitted(key)                    → POST   /quorum/claims/mark-submitted {key}
 *   - gc(round)                             → POST   /quorum/claims/gc      {round}
 *
 * Wire codec (INV-A): the `{32B pubkey, 64B sig}` bytes ride as base64 fields on the attestation. The
 * server round-trips them VERBATIM; this client likewise carries them VERBATIM (the JSON body is
 * `JSON.stringify`-passed through, decode is a structural read of `attestations`). The codec WRAPS the
 * pre-signed bytes, never alters them — byte-identical to the in-memory claim/att shapes.
 *
 * FAIL-CLOSED: any non-2xx response (incl. a 401 bad-token or a 500 board-throw) OR a network error
 * THROWS — never a silent `undefined`. The SOLE exception is the by-contract `get()` miss: the 7a
 * server returns `200` + a `null` body (and a defensive `404`) for an absent/submitted cell, both of
 * which this client maps to `undefined` per the port contract.
 *
 * markSubmitted/gc are CLIENT-DRIVEN: this client only relays the 5 wire methods. The fail-LOUD
 * `onUnquorumedExpiry` closure is NEVER serialized — it stays on the in-memory board the collector
 * owns; `gc(round)` here runs server-side STATE-GC only.
 *
 * Observability: additive client-side pino counters (requests by method + non-2xx + latency) +
 * `getMetrics()`. Zero raw `console.*`.
 */
import type { Agent } from 'undici';
import {
  createLogger,
  type Logger,
  buildPinnedDispatcher,
  manifestsToTrustedSpki as sharedManifestsToTrustedSpki,
} from '@dvconf/shared';
import {
  type QuorumClaimBoard,
  type ClaimKind,
  type OpenGenericCell,
  type OperatorManifest,
} from '@dvconf/shared';

/** Per-method request tally exposed for observability (additive — zero consumer change). */
export interface HttpQuorumClaimMetrics {
  requests: {
    post: number;
    listOpen: number;
    get: number;
    markSubmitted: number;
    gc: number;
  };
  /** Count of non-2xx responses surfaced as a throw (a 404 on /get is NOT counted — by contract). */
  non2xx: number;
  /** Coarse round-trip latency tally (count + total ms) for a mean. */
  latency: { count: number; totalMs: number };
}

type WireMethod = keyof HttpQuorumClaimMetrics['requests'];

/**
 * OQ-7 / ADR-0021 cross-host mTLS CLIENT material. When supplied, `baseUrl` MUST be `https://…` and
 * every request rides a mutually-authenticated TLS channel: the client PRESENTS `{cert,key}` (its own
 * SPKI is what the Phase-B server pins) and PINS the server's SPKI — the peer cert's
 * `spkiFingerprint(peerCert)` MUST be in `trustedServerSpki`, else the TLS handshake fails-closed.
 *
 * NO CA / NO central PKI (DESIGN-cross-host-oq7.md): trust is the SPKI pin, NOT chain-of-trust cert
 * validation — hence `rejectUnauthorized:false` (the self-signed cert is NOT rejected by the default
 * CA path). NOTE (ADR-0021 deviation): undici does NOT fire `connect.checkServerIdentity` under
 * `rejectUnauthorized:false`, so the SPKI pin is enforced by the shared `buildPinnedDispatcher`
 * single-gate `buildConnector` handback instead. The SPKI is pinned to the KEY
 * (`sha256(SubjectPublicKeyInfo DER)`), so it survives a same-key cert re-issue.
 */
export interface HttpQuorumClaimTlsConfig {
  /** The client's self-signed TLS cert (PEM) — its SPKI is what the server pins. */
  cert: string;
  /** The client's self-signed TLS private key (PEM). */
  key: string;
  /** Trusted server SPKI fingerprints (`spkiFingerprint` lowercase hex). The peer must be in this set. */
  trustedServerSpki: ReadonlySet<string>;
}

export interface HttpQuorumClaimBoardOptions {
  /** Base URL of the live 7a carrier, e.g. `http://127.0.0.1:8092` (or `https://…` in TLS mode). */
  baseUrl: string;
  /** Bearer token mirroring the server's `QUORUM_CLAIMS_AUTH_TOKEN`. */
  token: string;
  /** Injected fetch for testability (defaults to the global `fetch`). */
  fetch?: typeof fetch;
  /** Optional logger (defaults to a fresh `quorum/claims-client` pino logger). */
  logger?: Logger;
  /**
   * OQ-7 Phase C cross-host mTLS material + the pinned server trust set. When supplied, the client
   * builds an undici `Agent` dispatcher (presents the cert, pins the server SPKI) and rides it on
   * every request. When ABSENT the existing plain-`fetch` path is byte-identical (zero behavior change).
   */
  tls?: HttpQuorumClaimTlsConfig;
}

/**
 * OQ-7 Phase C — MANIFEST-DERIVED trust. Distill the `certFingerprint` (SPKI) column from a verified
 * `loadManifests(...)` map into the trusted-SPKI `Set` consumed by BOTH the Phase-B server's
 * `trustedSpki` and this client's `trustedServerSpki`. This CLOSES the Phase-B "trustedSpki injected
 * in tests" caveat: trust now flows from the signed {operatorPubkey → certFingerprint} bindings the
 * operator manifests carry, with NO injected set and NO CA.
 */
export function manifestsToTrustedSpki(
  manifests: ReadonlyMap<string, OperatorManifest>,
): Set<string> {
  // Phase D-1 PROMOTE: thin re-point to the shared generic (single-sourced in @dvconf/shared).
  return sharedManifestsToTrustedSpki(manifests);
}

/**
 * The HTTP transport implementation of the `QuorumClaimBoard` port. The EXACT 5 async methods — never
 * widened. Bearer-authed; fail-closed on any non-2xx / network error (except the `get()` miss → undefined).
 */
export class HttpQuorumClaimBoard implements QuorumClaimBoard {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly log: Logger;
  /**
   * OQ-7 Phase C: the undici `Agent` dispatcher carrying the client cert + the server-SPKI pin. Set
   * only in TLS mode; `undefined` on the plain-fetch path (so that path stays byte-identical).
   * `globalThis.fetch` is undici and IGNORES a `node:https` Agent — the cert/trust MUST ride on the
   * non-standard `dispatcher` init field (needs an as-cast for the `RequestInit` type gap).
   */
  private readonly dispatcher: Agent | undefined;
  private readonly metrics: HttpQuorumClaimMetrics = {
    requests: { post: 0, listOpen: 0, get: 0, markSubmitted: 0, gc: 0 },
    non2xx: 0,
    latency: { count: 0, totalMs: 0 },
  };

  constructor(opts: HttpQuorumClaimBoardOptions) {
    // Strip a single trailing slash so `${baseUrl}/quorum/claims` never double-slashes.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = opts.logger ?? createLogger('quorum/claims-client');

    // OQ-7 Phase C / Phase D-1 PROMOTE: in TLS mode, build the undici Agent dispatcher ONCE via the
    // shared generic `buildPinnedDispatcher` (single-sourced in @dvconf/shared). It PRESENTS the
    // client {cert,key} and PINS the server SPKI fail-closed (an untrusted carrier is REFUSED — the
    // socket is destroyed before any application byte is exchanged). The HARDENED single-gate pinned
    // connector (one success handback dominated by `if(pinned)`; destroy-before-error on any
    // mismatch/empty/throw; `pipelining:0`; `maxCachedSessions:0`) lives in the shared module — this
    // is a semantic no-op re-point.
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
   * One authed request with method-tagged metrics + latency. Returns the parsed `Response` on a 2xx;
   * THROWS on any non-2xx (incrementing `non2xx`) or a network error (fail-closed). A 404 is allowed
   * through to the caller (only `get()` interprets it) WITHOUT counting as a surfaced non-2xx error.
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
      // The `dispatcher` field is undici-specific (NOT in the DOM `RequestInit`) — as-cast the gap.
      // Plain-fetch path: `dispatcher` is undefined, so this object is byte-identical to the original.
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
      this.log.error({ err, method, path }, 'quorum/claims-client: network error (fail-closed)');
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.metrics.latency.count += 1;
    this.metrics.latency.totalMs += Date.now() - t0;

    // A 404 is the by-contract get()-miss signal — pass it through un-thrown; the caller decides.
    if (res.status === 404) {
      this.log.debug({ method, path }, 'quorum/claims-client: 404 (cell absent — get() maps to undefined)');
      return res;
    }
    if (!res.ok) {
      this.metrics.non2xx += 1;
      this.log.error(
        { method, path, status: res.status },
        'quorum/claims-client: non-2xx response (fail-closed)',
      );
      throw new Error(`quorum/claims-client: ${method} ${path} → HTTP ${res.status} (fail-closed)`);
    }
    return res;
  }

  async post<Claim, Attestation>(
    kind: ClaimKind,
    claim: Claim,
    attestation: Attestation,
    round: number,
  ): Promise<void> {
    // The {pk,sig} base64 fields ride VERBATIM inside `attestation` (INV-A: wrap, never alter).
    await this.request('post', '/quorum/claims', 'POST', { kind, claim, attestation, round });
  }

  async listOpen(): Promise<OpenGenericCell<unknown, unknown>[]> {
    const res = await this.request('listOpen', '/quorum/claims/open', 'GET');
    const parsed = (await res.json()) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('quorum/claims-client: /open returned a non-array body (fail-closed)');
    }
    return parsed as OpenGenericCell<unknown, unknown>[];
  }

  async get(key: string): Promise<OpenGenericCell<unknown, unknown> | undefined> {
    const res = await this.request('get', '/quorum/claims/get', 'POST', { key });
    // Defensive 404 → undefined (the 7a server returns 200+null today; mirror BOTH).
    if (res.status === 404) return undefined;
    const parsed = (await res.json()) as unknown;
    // The server sends `cell ?? null` — a `null` body is the absent/submitted signal → undefined.
    if (parsed === null) return undefined;
    return parsed as OpenGenericCell<unknown, unknown>;
  }

  async markSubmitted(key: string): Promise<void> {
    await this.request('markSubmitted', '/quorum/claims/mark-submitted', 'POST', { key });
  }

  async gc(currentRound: number): Promise<void> {
    // Server-side STATE-GC only; the fail-LOUD onUnquorumedExpiry closure is NEVER serialized.
    await this.request('gc', '/quorum/claims/gc', 'POST', { round: currentRound });
  }

  /** A snapshot of the additive client-side observability counters. */
  getMetrics(): HttpQuorumClaimMetrics {
    return {
      requests: { ...this.metrics.requests },
      non2xx: this.metrics.non2xx,
      latency: { ...this.metrics.latency },
    };
  }
}
