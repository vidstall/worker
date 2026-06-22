/**
 * OQ-7 / ADR-0021 cross-host mTLS carrier — Phase B: the SERVER-side TLS trust helper.
 *
 * NO CA / NO central PKI (DESIGN-cross-host-oq7.md). The carrier server presents a self-signed cert
 * and asks every client for one (`requestCert:true, rejectUnauthorized:false` — TLS does NOT reject
 * the peer; we do, AFTER the handshake). The trust decision is a post-handshake check that the
 * client's SPKI fingerprint — `spkiFingerprint(peerCert)` = sha256(SubjectPublicKeyInfo DER), pinned
 * to the KEY so it survives cert re-issue — is in a provided TRUSTED SET (derived from the loaded
 * operator manifests in Phase C; injected directly here). This is NOT Node's whole-cert
 * `fingerprint256`, which changes on a same-key re-issue.
 *
 * INV-B: `node:https` + `node:tls` + `node:crypto` (via the shared `spkiFingerprint`) are imported
 * FRESH here / in shared — NEVER from apps/relay/. Strictly additive: nothing imports this until the
 * carrier's TLS fork is enabled behind QUORUM_CLAIMS_TLS_ENABLED.
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { TLSSocket, DetailedPeerCertificate } from 'node:tls';
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { spkiFingerprint } from '@dvconf/shared';

/** The TLS material + the pinned peer trust anchors for the mTLS server fork. */
export interface QuorumClaimsTlsConfig {
  /** The carrier's self-signed TLS private key (PEM). */
  key: string;
  /** The carrier's self-signed TLS cert (PEM). */
  cert: string;
  /**
   * The set of TRUSTED peer SPKI fingerprints (`spkiFingerprint(peerCert)` — lowercase hex). A
   * client whose presented cert's SPKI is NOT in this set is rejected post-handshake (403). In
   * Phase C this is derived from `loadManifests(...)` → `m.certFingerprint`; here it is injected.
   */
  trustedSpki: ReadonlySet<string>;
}

/**
 * Resolve whether the cross-host TLS fork is enabled. OFF by default — an unset (or any non-`'1'`/
 * non-`'true'`) flag means the EXISTING node:http carrier runs byte-identical.
 */
export function isQuorumClaimsTlsEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env['QUORUM_CLAIMS_TLS_ENABLED'];
  return raw === '1' || raw === 'true';
}

/**
 * Post-handshake SPKI pin check: extract the peer cert from the (already-handshaken) TLS socket,
 * compute its SPKI fingerprint, and assert membership in `trustedSpki`. Fail-closed: a missing peer
 * cert (the client presented none) or any extraction error → NOT trusted.
 */
export function isPeerSpkiTrusted(
  socket: TLSSocket,
  trustedSpki: ReadonlySet<string>,
): boolean {
  let peer: DetailedPeerCertificate | undefined;
  try {
    peer = socket.getPeerCertificate(true);
  } catch {
    return false;
  }
  // An empty object means no client cert was presented.
  if (!peer || Object.keys(peer).length === 0 || !peer.raw) return false;
  let fp: string;
  try {
    // Re-encode the DER peer cert as a PEM so the shared SPKI helper can read its public key.
    const pem =
      '-----BEGIN CERTIFICATE-----\n' +
      peer.raw.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') +
      '\n-----END CERTIFICATE-----\n';
    fp = spkiFingerprint(pem);
  } catch {
    return false;
  }
  return trustedSpki.has(fp);
}

/**
 * Build the node:https mTLS server fork. `requestCert:true, rejectUnauthorized:false` so the
 * handshake completes for ANY client cert (or none) — the SPKI pin is enforced PER-REQUEST in the
 * wrapped listener: an untrusted peer gets a 403 before the inner application handler runs. The
 * existing bearer-token check still runs inside `appListener` (defense-in-depth in BOTH modes).
 */
export function createQuorumClaimsTlsServer(
  config: QuorumClaimsTlsConfig,
  appListener: RequestListener,
): HttpsServer {
  return createHttpsServer(
    {
      key: config.key,
      cert: config.cert,
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const socket = req.socket as TLSSocket;
      if (!isPeerSpkiTrusted(socket, config.trustedSpki)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: peer SPKI not in trusted set' }));
        return;
      }
      appListener(req, res);
    },
  );
}
