/**
 * OQ-7 / ADR-0021 cross-host mTLS carrier — Phase B: the mTLS SERVER fork (RED-first → GREEN).
 *
 * This suite exercises ONLY the server side of the cross-host `/quorum/claims` carrier (the undici
 * client + the full 2-party loopback-over-TLS claim round-trip is Phase C). It proves:
 *   - mTLS handshake SUCCESS: a tls client presenting CLIENT_CERT/KEY (SPKI in the trusted set) +
 *     the bearer token gets an authorized request through (200).
 *   - SPKI-mismatch REJECT: a client presenting WRONG_CLIENT_CERT (SPKI NOT in the trusted set) does
 *     NOT succeed — the request never reaches a 200 (handshake refused OR 401/403).
 *   - vanilla flag-OFF byte-identical: with QUORUM_CLAIMS_TLS_ENABLED unset the server is plain
 *     node:http and the existing bearer behavior is unchanged.
 *   - fail-LOUD on an unset QUORUM_CLAIMS_AUTH_TOKEN, preserved in TLS mode.
 *   - port-8092 collision assert still fires (resolve+assert path) in TLS mode.
 *
 * Trust anchor = `spkiFingerprint(<peer cert>)` (SPKI = sha256(SPKI DER), pinned to the KEY so it
 * survives cert re-issue) — NOT Node's whole-cert fingerprint256.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { spkiFingerprint } from '@dvconf/shared';
import {
  InMemoryGenericClaimBoard,
  type BoardKindConfig,
  type QuorumClaimBoard,
} from '@dvconf/shared';
import {
  startQuorumClaimsServer,
  type StartQuorumClaimsResult,
} from '../quorum-claims-server.js';
import {
  SERVER_KEY_PEM,
  SERVER_CERT_PEM,
  CLIENT_KEY_PEM,
  CLIENT_CERT_PEM,
  WRONG_CLIENT_KEY_PEM,
  WRONG_CLIENT_CERT_PEM,
} from './fixtures/mtls-fixtures.js';

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

const TOKEN = 'quorum-claims-tls-token-7f3a9c';

interface WireClaim {
  room: string;
  peer: string;
  nonce: number;
}
interface WireAttestation {
  pubkey: string;
  sig: string;
  operator: string;
}

function captokenIssueConfig(): BoardKindConfig<WireClaim, WireAttestation> {
  return {
    kind: 'captoken-issue',
    cellKey: (c) => `${c.room}|${c.peer}|${c.nonce}`,
    attesterKey: (a) => a.operator,
    distinctCount: (atts) => new Set(atts.map((a) => a.operator)).size,
    minDistinct: 2,
    gcFailMode: 'fail-closed-silent',
    validateWireSchema: () => null,
  };
}

function makeBoard(): QuorumClaimBoard {
  return new InMemoryGenericClaimBoard([captokenIssueConfig()]);
}

const PUBKEY_B64 = Buffer.from(new Uint8Array(32)).toString('base64');
const SIG_B64 = Buffer.from(new Uint8Array(64)).toString('base64');

const VALID_POST = () => ({
  kind: 'captoken-issue',
  claim: { room: '0xroom', peer: '0xpeer', nonce: 42 } as WireClaim,
  attestation: { pubkey: PUBKEY_B64, sig: SIG_B64, operator: '0xopA' } as WireAttestation,
  round: 1,
});

/** The trusted SPKI set = the authorized peer's key (CLIENT). WRONG is deliberately excluded. */
const TRUSTED_SPKI = new Set<string>([spkiFingerprint(CLIENT_CERT_PEM)]);

const handles: StartQuorumClaimsResult[] = [];
afterEach(async () => {
  while (handles.length) {
    const h = handles.pop()!;
    await h.stop().catch(() => {});
  }
});

async function startTlsHarness(
  trusted: Set<string> = TRUSTED_SPKI,
): Promise<{ handle: StartQuorumClaimsResult; port: number }> {
  const handle = await startQuorumClaimsServer({
    board: makeBoard(),
    portOverride: 0,
    authTokenOverride: TOKEN,
    logger: mockLogger(),
    env: { QUORUM_CLAIMS_TLS_ENABLED: '1' },
    tls: {
      key: SERVER_KEY_PEM,
      cert: SERVER_CERT_PEM,
      trustedSpki: trusted,
    },
  });
  handles.push(handle);
  const port = (handle.server.address() as AddressInfo).port;
  return { handle, port };
}

/**
 * Raw mTLS POST to /quorum/claims using a tls.connect socket (no undici — that's Phase C). Returns
 * the HTTP status line code, or rejects on a TLS handshake failure (SPKI-reject manifests either as
 * a refused handshake OR a 401/403 — the caller asserts the negative either way).
 */
function tlsPost(
  port: number,
  clientKey: string,
  clientCert: string,
  body: unknown,
  token: string = TOKEN,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const socket = tls.connect(
      {
        host: '127.0.0.1',
        port,
        key: clientKey,
        cert: clientCert,
        rejectUnauthorized: false, // self-signed server; we pin via SPKI on the SERVER side
      },
      () => {
        const req =
          `POST /quorum/claims HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Authorization: Bearer ${token}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          `Connection: close\r\n\r\n` +
          payload;
        socket.write(req);
      },
    );
    let raw = '';
    socket.on('data', (d) => {
      raw += d.toString('utf8');
    });
    socket.on('end', () => {
      const m = raw.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`no HTTP status in response: ${raw.slice(0, 120)}`));
    });
    socket.on('error', (err) => reject(err));
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error('tls request timeout'));
    });
  });
}

describe('startQuorumClaimsServer — Phase B mTLS server fork', () => {
  it('(B1) mTLS handshake SUCCESS: authorized CLIENT cert (SPKI trusted) + bearer → 200', async () => {
    const { port } = await startTlsHarness();
    const status = await tlsPost(port, CLIENT_KEY_PEM, CLIENT_CERT_PEM, VALID_POST());
    expect(status).toBe(200);
  });

  it('(B2) SPKI-mismatch REJECT: WRONG client cert (SPKI not in trusted set) does NOT 200', async () => {
    const { port } = await startTlsHarness();
    // The reject can surface as a refused TLS handshake (socket error) OR an app-level 401/403.
    let status: number | null = null;
    let threw = false;
    try {
      status = await tlsPost(port, WRONG_CLIENT_KEY_PEM, WRONG_CLIENT_CERT_PEM, VALID_POST());
    } catch {
      threw = true;
    }
    expect(threw || (status !== null && status !== 200)).toBe(true);
    if (status !== null) expect([401, 403]).toContain(status);
  });

  it('(B3) vanilla flag-OFF byte-identical: TLS_ENABLED unset → plain http, bearer still gates', async () => {
    // No tls opts, no QUORUM_CLAIMS_TLS_ENABLED → the existing node:http carrier, unchanged.
    const handle = await startQuorumClaimsServer({
      board: makeBoard(),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
    });
    handles.push(handle);
    const port = (handle.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // plain-http authorized POST → 200 (proves it is NOT an https server)
    const ok = await fetch(`${baseUrl}/quorum/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(VALID_POST()),
    });
    expect(ok.status).toBe(200);

    // wrong bearer still 401 (defense-in-depth retained, OFF mode)
    const bad = await fetch(`${baseUrl}/quorum/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer wrong` },
      body: JSON.stringify(VALID_POST()),
    });
    expect(bad.status).toBe(401);
  });

  it('(B4) fail-LOUD on unset QUORUM_CLAIMS_AUTH_TOKEN, preserved in TLS mode', async () => {
    await expect(
      startQuorumClaimsServer({
        board: makeBoard(),
        portOverride: 0,
        logger: mockLogger(),
        env: { QUORUM_CLAIMS_TLS_ENABLED: '1' }, // TLS on, but NO token
        tls: {
          key: SERVER_KEY_PEM,
          cert: SERVER_CERT_PEM,
          trustedSpki: TRUSTED_SPKI,
        },
      }),
    ).rejects.toThrow(/QUORUM_CLAIMS_AUTH_TOKEN/);
  });

  it('(B5) port-8092 collision assert still fires in TLS mode (resolve+assert before bind)', async () => {
    await expect(
      startQuorumClaimsServer({
        board: makeBoard(),
        authTokenOverride: TOKEN,
        logger: mockLogger(),
        // 8090 is in DAEMON_PORTS_IN_USE → the resolve+assert must throw before any bind.
        env: { QUORUM_CLAIMS_TLS_ENABLED: '1', QUORUM_CLAIMS_PORT: '8090' },
        tls: {
          key: SERVER_KEY_PEM,
          cert: SERVER_CERT_PEM,
          trustedSpki: TRUSTED_SPKI,
        },
      }),
    ).rejects.toThrow(/in use|EADDRINUSE|collision/i);
  });

  it('(B6) TLS mode also rejects a wrong bearer of the SAME LENGTH with the trusted cert (defense-in-depth)', async () => {
    const { port } = await startTlsHarness();
    const sameLen = 'X'.repeat(TOKEN.length);
    const status = await tlsPost(port, CLIENT_KEY_PEM, CLIENT_CERT_PEM, VALID_POST(), sameLen);
    expect(status).toBe(401);
  });
});
