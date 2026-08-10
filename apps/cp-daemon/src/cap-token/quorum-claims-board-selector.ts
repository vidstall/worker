/**
 * F62 Stage 4 Item #1 — Multi-CP quorum Leg 7d LIVE-mode board selection +
 * OQ-7 cross-host mTLS material loader.
 *
 * Pure extraction from bootstrap.ts: `selectQuorumClaimsBoard` +
 * `loadQuorumClaimsCrossHostTls`. See bootstrap.ts's module doc for the
 * file-ownership boundary (this stays under cap-token/, not index.ts).
 *
 * ROADMAP Leg 7d: a small, testable selector that decides whether the daemon runs the
 * HERMETIC default (`QUORUM_CLAIMS_ENABLED` unset → `undefined`, so `buildLocalCpKeystore`
 * keeps its in-memory `InMemoryGenericClaimBoard` default BYTE-IDENTICAL) or the LIVE
 * transport (`QUORUM_CLAIMS_ENABLED` set → a `HttpQuorumClaimBoard` pointed at the LOCAL
 * loopback 7a carrier). It is PURE TRANSPORT SUBSTITUTION: the returned board slots behind the
 * SAME injected `quorumCollector.board` port — the protocol core never changes.
 *
 * FAIL-LOUD (mirrors the 7a server): live-mode with `QUORUM_CLAIMS_AUTH_TOKEN` unset throws
 * (a transport carrying quorum signatures must never run open). The port is resolved via the
 * SHIPPED `resolveQuorumClaimsPort` (fail-closed on a non-numeric/out-of-range value).
 */
import { readFileSync } from 'node:fs';
import { loadManifests } from '@dvconf/shared';
import type { Logger, SignedManifest } from '@dvconf/shared';
import {
  HttpQuorumClaimBoard,
  manifestsToTrustedSpki,
  type HttpQuorumClaimTlsConfig,
} from '../quorum-claims-client.js';
import { resolveQuorumClaimsPort } from '../quorum-claims-port.js';
import {
  isQuorumClaimsTlsEnabled,
  type QuorumClaimsTlsConfig,
} from '../quorum-claims-tls.js';

/**
 * Decide the quorum-collector board for daemon startup.
 *
 * OQ-7 cross-host boot-wiring (gap #1): the client baseUrl is derived from `QUORUM_CLAIMS_PEER_URL`
 * (default `http(s)://127.0.0.1:${port}` — loopback, byte-identical when unset) so a FOLLOWER CP can
 * point at the LEADER's board. When mTLS is on (`QUORUM_CLAIMS_TLS_ENABLED`) the caller supplies the
 * client's `{cert,key,trustedServerSpki}` (built in `main()` from the loaded operator manifests) and
 * it rides every request; when off, the plain-HTTP loopback path is byte-identical.
 *
 * @returns a `HttpQuorumClaimBoard` (live carrier) when `QUORUM_CLAIMS_ENABLED` is set (with
 *          `QUORUM_CLAIMS_AUTH_TOKEN`), or `undefined` when unset so the hermetic
 *          `InMemoryGenericClaimBoard` default is preserved BYTE-IDENTICAL.
 * @throws  when live-mode is enabled but `QUORUM_CLAIMS_AUTH_TOKEN` is unset (fail-LOUD), or when
 *          mTLS is enabled but no client material is supplied (fail-LOUD — refuse a silent downgrade).
 */
export function selectQuorumClaimsBoard(args: {
  env?: Record<string, string | undefined>;
  logger: Logger;
  /**
   * OQ-7 Phase C cross-host mTLS CLIENT material (cert/key + the pinned server-SPKI set). Threaded in
   * from `main()`'s manifest-derived load. REQUIRED when `QUORUM_CLAIMS_TLS_ENABLED` is on; IGNORED
   * (and unnecessary) on the plain-HTTP loopback path — absent → the byte-identical existing client.
   */
  tls?: HttpQuorumClaimTlsConfig;
}): HttpQuorumClaimBoard | undefined {
  const env = args.env ?? process.env;
  const enabled = env['QUORUM_CLAIMS_ENABLED'];
  if (enabled === undefined || enabled === '' || enabled === '0' || enabled === 'false') {
    // HERMETIC default — buildLocalCpKeystore keeps its in-memory board (byte-identical).
    return undefined;
  }
  // FAIL-LOUD: a live transport carrying quorum signatures must never run without a token.
  const token = env['QUORUM_CLAIMS_AUTH_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'QUORUM_CLAIMS_ENABLED is set but QUORUM_CLAIMS_AUTH_TOKEN is unset — refusing to build a ' +
        'live /quorum/claims board (security-critical transport; set the token or unset the flag).',
    );
  }
  const port = resolveQuorumClaimsPort(env);
  const tlsEnabled = isQuorumClaimsTlsEnabled(env);
  // FAIL-LOUD: mTLS on but no client material would be a SILENT DOWNGRADE to plain-HTTP against an
  // mTLS-only carrier — refuse to start (the follower MUST present its cert + pin the peer SPKI).
  if (tlsEnabled && args.tls === undefined) {
    throw new Error(
      'QUORUM_CLAIMS_TLS_ENABLED is set but no cross-host mTLS client material ' +
        '(cert/key/trustedServerSpki) was provided to selectQuorumClaimsBoard — refusing to build a ' +
        'plain-HTTP client against the mTLS carrier (set the cert/key/manifest paths or unset the flag).',
    );
  }
  // Peer URL (cross-host) → the leader's board; default loopback (scheme follows the TLS flag so an
  // mTLS-on default still yields an `https://` baseUrl the pinned dispatcher can handshake over).
  const peerUrl = env['QUORUM_CLAIMS_PEER_URL'];
  const baseUrl =
    peerUrl !== undefined && peerUrl !== ''
      ? peerUrl
      : `${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${port}`;
  args.logger.info(
    {
      module: 'cap-token-bootstrap',
      context: { baseUrl, mode: tlsEnabled ? 'live-crosshost-mtls' : 'live-loopback' },
    },
    'quorum-claims live transport ENABLED — collector board = HttpQuorumClaimBoard',
  );
  return new HttpQuorumClaimBoard({
    baseUrl,
    token,
    logger: args.logger,
    ...(tlsEnabled && args.tls !== undefined ? { tls: args.tls } : {}),
  });
}

/** OQ-7 cross-host boot-wiring: the derived mTLS material for BOTH the server + client boot selectors. */
export interface QuorumClaimsCrossHostTls {
  /** Server-side TLS: own cert/key + the trusted PEER SPKI set (`startQuorumClaimsServer` opts.tls). */
  serverTls: QuorumClaimsTlsConfig;
  /** Client-side TLS: own cert/key + the trusted SERVER SPKI set (`HttpQuorumClaimBoard` opts.tls). */
  clientTls: HttpQuorumClaimTlsConfig;
}

/**
 * OQ-7 Phase C cross-host boot LOADER (gap #1): when `QUORUM_CLAIMS_TLS_ENABLED` is on, load this CP's
 * own TLS cert/key + the SIGNED operator-manifest bundle from disk, verify the manifests, and DERIVE
 * the trusted-SPKI peer set (the REAL manifest trust path — NO injected set, NO CA). Returns the tls
 * config for BOTH boot selectors (`serverTls` for `startQuorumClaimsServer`, `clientTls` for
 * `selectQuorumClaimsBoard`), symmetric because the manifest bundle carries every operator's SPKI.
 *
 * OFF by default: when the flag is unset it returns `undefined` WITHOUT reading any file — the boot is
 * byte-identical to the plain-HTTP loopback path. FAIL-LOUD when the flag is on but a required path is
 * unset or the bundle yields no valid peer.
 *
 * Env (all required only when `QUORUM_CLAIMS_TLS_ENABLED` is on):
 *   - `QUORUM_CLAIMS_TLS_CERT_PATH`        — PEM path of this CP's self-signed TLS cert.
 *   - `QUORUM_CLAIMS_TLS_KEY_PATH`         — PEM path of this CP's TLS private key.
 *   - `QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH` — JSON path of the `SignedManifest[]` OOB bundle.
 */
export async function loadQuorumClaimsCrossHostTls(args: {
  env?: Record<string, string | undefined>;
  logger: Logger;
}): Promise<QuorumClaimsCrossHostTls | undefined> {
  const env = args.env ?? process.env;
  // OFF path — no file reads, no manifest load, no tls. Byte-identical boot.
  if (!isQuorumClaimsTlsEnabled(env)) return undefined;

  const certPath = env['QUORUM_CLAIMS_TLS_CERT_PATH'];
  const keyPath = env['QUORUM_CLAIMS_TLS_KEY_PATH'];
  const bundlePath = env['QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH'];
  if (!certPath || !keyPath || !bundlePath) {
    throw new Error(
      'QUORUM_CLAIMS_TLS_ENABLED is set but one of QUORUM_CLAIMS_TLS_CERT_PATH / ' +
        'QUORUM_CLAIMS_TLS_KEY_PATH / QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH is unset — the cross-host ' +
        'mTLS carrier needs its own cert/key + the signed operator-manifest bundle (fail-closed).',
    );
  }

  const cert = readFileSync(certPath, 'utf8');
  const key = readFileSync(keyPath, 'utf8');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as SignedManifest[];
  const manifests = await loadManifests(bundle);
  const trustedSpki = manifestsToTrustedSpki(manifests);
  if (trustedSpki.size === 0) {
    throw new Error(
      'QUORUM_CLAIMS_MANIFEST_BUNDLE yielded NO valid operator manifests — the trusted-SPKI peer set ' +
        'is empty; the mTLS carrier would trust no peer (fail-closed refuse-to-start).',
    );
  }

  args.logger.info(
    {
      module: 'cap-token-bootstrap',
      context: { trustedPeers: trustedSpki.size, certPath, bundlePath },
    },
    'quorum-claims cross-host mTLS material loaded (manifest-derived trusted-SPKI set)',
  );
  return {
    serverTls: { key, cert, trustedSpki },
    clientTls: { cert, key, trustedServerSpki: trustedSpki },
  };
}
