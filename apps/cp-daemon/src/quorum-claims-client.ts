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
import { createLogger, type Logger } from '@dvconf/shared';
import {
  type QuorumClaimBoard,
  type ClaimKind,
  type OpenGenericCell,
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

export interface HttpQuorumClaimBoardOptions {
  /** Base URL of the live 7a carrier, e.g. `http://127.0.0.1:8092`. */
  baseUrl: string;
  /** Bearer token mirroring the server's `QUORUM_CLAIMS_AUTH_TOKEN`. */
  token: string;
  /** Injected fetch for testability (defaults to the global `fetch`). */
  fetch?: typeof fetch;
  /** Optional logger (defaults to a fresh `quorum/claims-client` pino logger). */
  logger?: Logger;
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
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method: httpMethod,
        headers: this.authHeaders(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
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
