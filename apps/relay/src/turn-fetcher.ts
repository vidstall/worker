/**
 * S30.C — Fetch a TURN credential from cp-daemon's RPC endpoint.
 *
 * Wire shape (matches turn-rpc.ts on cp-daemon side):
 *   POST {cpRpcUrl}/turn/issue
 *   Authorization: Bearer {token}
 *   Body: { targetMinerId, userId, ttlSec? }
 *
 *   200 + CredentialPayload JSON, OR
 *   200 + { skipped: true, reason } when cp marked the relay as slashed
 *   401 / 5xx / network failure → throws
 *
 * Returns null on the skipped-slashed path so callers can degrade
 * gracefully and emit transportCreated without iceServers.
 */

export interface TurnCredentialPayload {
  username: string;
  password: string;
  expiry: number;
  /** SHA-256 of password, base64-encoded over the wire. */
  credentialHash: string;
  secretId: number;
  txDigest: string;
}

export interface FetchTurnOptions {
  cpRpcUrl: string;
  token: string;
  targetMinerId: string;
  userId: string;
  ttlSec?: number;
  /** Test seam — inject a fake fetch. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export async function fetchTurnCredential(
  opts: FetchTurnOptions,
): Promise<TurnCredentialPayload | null> {
  const fetchImpl = opts.fetchFn ?? fetch;

  const body: Record<string, unknown> = {
    targetMinerId: opts.targetMinerId,
    userId: opts.userId,
  };
  if (opts.ttlSec !== undefined) body['ttlSec'] = opts.ttlSec;

  const res = await fetchImpl(`${opts.cpRpcUrl}/turn/issue`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    throw new Error(`TURN RPC: 401 unauthorized`);
  }
  if (res.status >= 500) {
    throw new Error(`TURN RPC: ${res.status} internal`);
  }
  if (!res.ok) {
    throw new Error(`TURN RPC: ${res.status}`);
  }

  const data = (await res.json()) as unknown;

  if (typeof data !== 'object' || data === null) {
    throw new Error('TURN RPC: response is not a JSON object');
  }

  const obj = data as Record<string, unknown>;
  if (obj['skipped'] === true) {
    return null;
  }

  if (
    typeof obj['username'] !== 'string' ||
    typeof obj['password'] !== 'string' ||
    typeof obj['expiry'] !== 'number' ||
    typeof obj['credentialHash'] !== 'string' ||
    typeof obj['secretId'] !== 'number' ||
    typeof obj['txDigest'] !== 'string'
  ) {
    throw new Error('TURN RPC: invalid response shape');
  }

  return {
    username: obj['username'],
    password: obj['password'],
    expiry: obj['expiry'],
    credentialHash: obj['credentialHash'],
    secretId: obj['secretId'],
    txDigest: obj['txDigest'],
  };
}
