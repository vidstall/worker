/**
 * OQ-7 / ADR-0021 cross-host mTLS carrier — Phase D-1 PROMOTE: the GENERIC (carrier-agnostic)
 * SPKI-pin primitives, single-sourced in @dvconf/shared.
 *
 * These were extracted VERBATIM (semantically byte-for-byte for the security-critical paths) out of
 * apps/cp-daemon's cap-token carrier so the canary carrier (validator-daemon) reuses the SAME pin
 * code instead of duplicating it — cross-app imports are forbidden, so the shared security gate lives
 * here. The cap-token-specific thin wrappers (flag name, route, config) stay in apps/cp-daemon and
 * re-point to these generics.
 *
 * NO CA / NO central PKI (DESIGN-cross-host-oq7.md). Each operator self-signs an X.509 cert with a
 * DISTINCT TLS keypair. The trust anchor is the peer cert's `spkiFingerprint` =
 * sha256(SubjectPublicKeyInfo DER) — pinned to the KEY so it survives a same-key cert re-issue. NOT
 * Node's whole-cert `fingerprint256` (which changes on re-issue).
 *
 *   - SERVER side: `createMtlsServer` presents `{cert,key}` and asks every client for a cert
 *     (`requestCert:true, rejectUnauthorized:false` — TLS does NOT reject the peer; we do, AFTER the
 *     handshake). A post-handshake SPKI check 403s an untrusted peer BEFORE the app handler runs.
 *   - CLIENT side: `buildPinnedDispatcher` returns an undici Agent whose `connect` enforces the
 *     server-SPKI pin as the ENTIRE, ALWAYS-RUN trust decision: exactly ONE `callback(null, socket)`
 *     handback dominated by `pinned === true`; ANY other path (read error / empty cert / mismatch /
 *     throw) destroys the socket BEFORE the error callback. `pipelining:0` + `maxCachedSessions:0`
 *     harden against pooled/resumed sockets bypassing the pin.
 *
 * INV-B: `node:https` + `node:tls` + `node:crypto` (via the shared `spkiFingerprint`) + `undici` are
 * imported FRESH here — NEVER from apps/relay/. Pure off-relay shared code.
 */
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { TLSSocket, DetailedPeerCertificate } from 'node:tls';
import type { IncomingMessage, ServerResponse, RequestListener } from 'node:http';
import { Agent, buildConnector } from 'undici';
import { spkiFingerprint } from './operator-manifest.js';
import type { OperatorManifest } from './operator-manifest.js';

/** The carrier's TLS material + the pinned client trust anchors for a generic mTLS server. */
export interface MtlsServerConfig {
  /** The carrier's self-signed TLS private key (PEM). */
  key: string;
  /** The carrier's self-signed TLS cert (PEM). */
  cert: string;
  /**
   * The set of TRUSTED peer (client) SPKI fingerprints (`spkiFingerprint(peerCert)` — lowercase hex).
   * A client whose presented cert's SPKI is NOT in this set is rejected post-handshake (403).
   */
  trustedClientSpki: ReadonlySet<string>;
}

/** The client's TLS material + the pinned SERVER trust anchors for a generic pinned dispatcher. */
export interface PinnedDispatcherConfig {
  /** The client's self-signed TLS cert (PEM) — its SPKI is what the peer server pins. */
  cert: string;
  /** The client's self-signed TLS private key (PEM). */
  key: string;
  /** Trusted SERVER SPKI fingerprints (`spkiFingerprint` lowercase hex). The peer must be in this set. */
  trustedServerSpki: ReadonlySet<string>;
}

/**
 * Post-handshake SPKI pin check: extract the peer cert from the (already-handshaken) TLS socket,
 * compute its SPKI fingerprint, and assert membership in `trustedSpki`. Fail-closed: a missing peer
 * cert (the peer presented none) or any extraction error → NOT trusted.
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
 * Build a generic node:https mTLS server. `requestCert:true, rejectUnauthorized:false` so the
 * handshake completes for ANY client cert (or none) — the SPKI pin is enforced PER-REQUEST in the
 * wrapped listener: an untrusted peer gets a 403 before the inner `appListener` runs. Any
 * carrier-specific app-level auth (e.g. a bearer-token check) runs INSIDE `appListener`.
 */
export function createMtlsServer(
  config: MtlsServerConfig,
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
      if (!isPeerSpkiTrusted(socket, config.trustedClientSpki)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden: peer SPKI not in trusted set' }));
        return;
      }
      appListener(req, res);
    },
  );
}

/**
 * Build the HARDENED pinned undici `Agent` dispatcher: it PRESENTS the client `{cert,key}` and PINS
 * the server SPKI fail-closed. An untrusted carrier is REFUSED — the socket is destroyed before any
 * application byte is exchanged.
 *
 * NO CA / NO central PKI → `rejectUnauthorized:false` to skip the CA chain check on the self-signed
 * server cert. IMPORTANT DEVIATION FROM THE DESIGN PROSE: Node's `tls.connect` only invokes
 * `checkServerIdentity` when `rejectUnauthorized !== false`, so a `checkServerIdentity` pin would
 * NEVER FIRE under `rejectUnauthorized:false`. We therefore enforce the SPKI pin in a `buildConnector`
 * wrapper that inspects the negotiated TLS socket's peer cert AFTER connect and destroys the socket on
 * a non-match. This makes the SPKI pin the ENTIRE, ALWAYS-RUN trust decision.
 *
 * `maxCachedSessions:0` DISABLES TLS session resumption: when the client presents a cert, a resumed
 * session returns an EMPTY peer certificate, which would make the SPKI pin spuriously fail-closed on
 * the 2nd+ connection. With resumption off, the full peer cert is presented on every fresh secure
 * connection so the pin always has a cert to check. `pipelining:0` forbids request pipelining so an
 * in-flight request can't share a connection whose pin context could differ.
 */
export function buildPinnedDispatcher(config: PinnedDispatcherConfig): Agent {
  const { cert, key, trustedServerSpki } = config;
  const baseConnect = buildConnector({ cert, key, rejectUnauthorized: false, maxCachedSessions: 0 });

  // RACE FIX (by construction): the SPKI pin BLOCKS socket handback. undici's `buildConnector` fires
  // this callback on the `secureConnect` event, at which point the peer cert is available. We compute
  // a single boolean `pinned` from the peer SPKI and hand the live socket to undici ONLY on
  // `pinned === true`; on ANY other path (read error / empty cert / SPKI mismatch / unexpected throw)
  // we DESTROY the socket and call `callback(error)`. There is exactly ONE `callback(null, socket)`
  // site and it is dominated by `pinned === true`, so a request can NEVER flow on a not-yet-pinned or
  // untrusted socket — the pin is the ENTIRE, ALWAYS-RUN trust gate.
  const pinnedConnect: buildConnector.connector = (connectOpts, callback) => {
    baseConnect(connectOpts, (err, socket) => {
      if (err) return callback(err, null);
      const tlsSocket = socket as TLSSocket;
      // `pinned` starts false and is set true ONLY after a positive trusted-set membership check.
      // The sole handback (`callback(null, tlsSocket)`) is guarded on it — fail-closed by default.
      let pinned = false;
      let failReason = 'mtls-carrier: server SPKI pin did not pass (fail-closed)';
      try {
        const peer = tlsSocket.getPeerCertificate(true) as { raw?: Buffer } | undefined;
        if (peer === undefined || peer.raw === undefined || peer.raw.length === 0) {
          failReason = 'mtls-carrier: server presented no certificate (fail-closed)';
        } else {
          // Re-encode the DER peer cert to PEM so the shared SPKI helper can read its public key.
          const pem =
            '-----BEGIN CERTIFICATE-----\n' +
            peer.raw.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '') +
            '\n-----END CERTIFICATE-----\n';
          const fp = spkiFingerprint(pem);
          if (trustedServerSpki.has(fp)) {
            pinned = true;
          } else {
            failReason = 'mtls-carrier: server SPKI not in the trusted set (fail-closed pin)';
          }
        }
      } catch (e) {
        // Any read/encode/fingerprint error → stay fail-closed; surface the cause.
        failReason =
          e instanceof Error
            ? `mtls-carrier: SPKI pin error — ${e.message} (fail-closed)`
            : 'mtls-carrier: SPKI pin error (fail-closed)';
        pinned = false;
      }
      if (!pinned) {
        // Destroy BEFORE the error callback so undici can never hand this socket to a request.
        tlsSocket.destroy();
        return callback(new Error(failReason), null);
      }
      // Trusted — and ONLY now — hand the live, pinned socket back to undici.
      return callback(null, tlsSocket);
    });
  };

  // No pooled/keep-alive socket may skip the pin. `pipelining:0` forbids request pipelining on a
  // connection; the load-bearing guarantee is that the pin runs inside `connect` for EVERY fresh
  // secure connection and the handback is gated on `pinned`. Keep-alive REUSE of an already-pinned
  // socket is sound (that socket passed the pin at connect time and TLS resumption is OFF via
  // `maxCachedSessions:0`, so no un-pinned resumed socket can appear).
  return new Agent({ connect: pinnedConnect, pipelining: 0 });
}

/**
 * MANIFEST-DERIVED trust. Distill the `certFingerprint` (SPKI) column from a verified
 * `loadManifests(...)` map into the trusted-SPKI `Set` consumed by BOTH a server's
 * `trustedClientSpki` and a client's `trustedServerSpki`. Trust flows from the signed
 * {operatorPubkey → certFingerprint} bindings the operator manifests carry, with NO injected set and
 * NO CA.
 */
export function manifestsToTrustedSpki(
  manifests: ReadonlyMap<string, OperatorManifest>,
): Set<string> {
  const out = new Set<string>();
  for (const m of manifests.values()) out.add(m.certFingerprint);
  return out;
}
