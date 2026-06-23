/**
 * @dvconf/shared mtls-carrier — OQ-7 Phase D-1 PROMOTE (RED-first → GREEN).
 *
 * The GENERIC (carrier-agnostic) mTLS primitives single-sourced out of apps/cp-daemon so the canary
 * carrier (validator-daemon) reuses the SAME SPKI-pin code. This suite proves the security-critical
 * gates at the SHARED layer:
 *   - createMtlsServer SPKI-mismatch REJECT: a peer whose cert SPKI is NOT in trustedClientSpki gets
 *     a 403 before the app handler runs (and a trusted peer reaches the app → 200).
 *   - buildPinnedDispatcher rejects a wrong-server-SPKI: a client pinning a trusted server SPKI set
 *     that does NOT contain the live server's SPKI fails-closed (the request THROWS — the socket is
 *     destroyed before any byte is exchanged).
 *   - manifestsToTrustedSpki maps each manifest's `certFingerprint` into the trusted Set.
 *
 * Trust anchor = `spkiFingerprint(<peer cert>)` (sha256(SPKI DER), pinned to the KEY) — NOT Node's
 * whole-cert fingerprint256.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { Server as HttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent } from 'undici';
import { fetch as undiciFetch } from 'undici';
import {
  spkiFingerprint,
  createMtlsServer,
  buildPinnedDispatcher,
  isPeerSpkiTrusted,
  manifestsToTrustedSpki,
  type OperatorManifest,
} from '../index.js';
import {
  SERVER_KEY_PEM,
  SERVER_CERT_PEM,
  CLIENT_KEY_PEM,
  CLIENT_CERT_PEM,
  WRONG_CLIENT_KEY_PEM,
  WRONG_CLIENT_CERT_PEM,
} from './fixtures/mtls-fixtures.js';

const servers: HttpsServer[] = [];
const dispatchers: Agent[] = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await new Promise<void>((res) => s.close(() => res()));
  }
  while (dispatchers.length) {
    const d = dispatchers.pop()!;
    await d.close().catch(() => {});
  }
});

const TRUSTED_CLIENT = new Set<string>([spkiFingerprint(CLIENT_CERT_PEM)]);

function appOk(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function startServer(trusted: Set<string>): Promise<number> {
  const server = createMtlsServer(
    { key: SERVER_KEY_PEM, cert: SERVER_CERT_PEM, trustedClientSpki: trusted },
    appOk,
  );
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  return (server.address() as AddressInfo).port;
}

/** Raw mTLS GET via tls.connect — returns the HTTP status code, or rejects on a handshake failure. */
function tlsGet(port: number, clientKey: string, clientCert: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = tls.connect(
      { host: '127.0.0.1', port, key: clientKey, cert: clientCert, rejectUnauthorized: false },
      () => {
        socket.write(
          `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    let raw = '';
    socket.on('data', (d) => (raw += d.toString('utf8')));
    socket.on('end', () => {
      const m = raw.match(/^HTTP\/1\.\d (\d{3})/);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`no HTTP status: ${raw.slice(0, 120)}`));
    });
    socket.on('error', (err) => reject(err));
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error('tls request timeout'));
    });
  });
}

describe('@dvconf/shared mtls-carrier — generic SPKI-pin primitives', () => {
  it('createMtlsServer: a trusted-SPKI client reaches the app handler → 200', async () => {
    const port = await startServer(TRUSTED_CLIENT);
    const status = await tlsGet(port, CLIENT_KEY_PEM, CLIENT_CERT_PEM);
    expect(status).toBe(200);
  });

  it('createMtlsServer: SPKI-mismatch peer is 403-before-handler (security gate)', async () => {
    const port = await startServer(TRUSTED_CLIENT);
    // WRONG cert's SPKI is NOT in the trusted set → post-handshake 403, app handler never runs.
    const status = await tlsGet(port, WRONG_CLIENT_KEY_PEM, WRONG_CLIENT_CERT_PEM);
    expect(status).toBe(403);
  });

  it('buildPinnedDispatcher: rejects a wrong-server-SPKI (fail-closed pin)', async () => {
    // Real mTLS server presenting SERVER_CERT.
    const port = await startServer(TRUSTED_CLIENT);
    // The client pins a trusted-server set that does NOT include the live server's SPKI → the socket
    // is destroyed at connect time and the request THROWS (no byte exchanged).
    const wrongPin = new Set<string>([spkiFingerprint(WRONG_CLIENT_CERT_PEM)]);
    const dispatcher = buildPinnedDispatcher({
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      trustedServerSpki: wrongPin,
    });
    dispatchers.push(dispatcher);
    await expect(
      undiciFetch(`https://127.0.0.1:${port}/`, { dispatcher }),
    ).rejects.toThrow();
  });

  it('buildPinnedDispatcher: a correct server-SPKI pin lets the request through (200)', async () => {
    const port = await startServer(TRUSTED_CLIENT);
    const goodPin = new Set<string>([spkiFingerprint(SERVER_CERT_PEM)]);
    const dispatcher = buildPinnedDispatcher({
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      trustedServerSpki: goodPin,
    });
    dispatchers.push(dispatcher);
    const res = await undiciFetch(`https://127.0.0.1:${port}/`, { dispatcher });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('isPeerSpkiTrusted: a null/undefined-ish socket without a peer cert is NOT trusted (fail-closed)', () => {
    const fakeSocket = {
      getPeerCertificate: () => ({} as never),
    } as unknown as tls.TLSSocket;
    expect(isPeerSpkiTrusted(fakeSocket, TRUSTED_CLIENT)).toBe(false);
  });

  it('manifestsToTrustedSpki: maps each manifest certFingerprint into the trusted Set', () => {
    const fpA = spkiFingerprint(CLIENT_CERT_PEM);
    const fpB = spkiFingerprint(SERVER_CERT_PEM);
    const mk = (pk: string, fp: string): OperatorManifest => ({
      operatorPubkey: pk,
      boardEndpoint: 'host:8092',
      certFingerprint: fp,
      validUntil: 9_999_999_999_999,
    });
    const map = new Map<string, OperatorManifest>([
      ['a'.repeat(64), mk('a'.repeat(64), fpA)],
      ['b'.repeat(64), mk('b'.repeat(64), fpB)],
    ]);
    const set = manifestsToTrustedSpki(map);
    expect(set.has(fpA)).toBe(true);
    expect(set.has(fpB)).toBe(true);
    expect(set.size).toBe(2);
  });
});
