/**
 * OQ-7 / ADR-0021 cross-host mTLS carrier — Phase B: the cap-token SERVER-side TLS trust wrapper.
 *
 * Phase D-1 PROMOTE: the GENERIC SPKI-pin server primitives were single-sourced into
 * `@dvconf/shared` (`mtls-carrier.ts`) so the canary carrier (validator-daemon) reuses the SAME
 * security-critical pin code WITHOUT a cross-app import. This module now holds ONLY the
 * cap-token-specific thin wrappers: the `QUORUM_CLAIMS_TLS_ENABLED` flag reader, the cap-token
 * `QuorumClaimsTlsConfig` shape, and route-bound re-exports of the shared generics. cp-daemon
 * behavior is UNCHANGED.
 *
 * NO CA / NO central PKI (DESIGN-cross-host-oq7.md). The carrier server presents a self-signed cert
 * and asks every client for one (`requestCert:true, rejectUnauthorized:false`); the trust decision is
 * the post-handshake SPKI-pin check in the shared `createMtlsServer` (an untrusted peer gets a 403
 * before the inner application handler runs). The pin is `spkiFingerprint(peerCert)` — pinned to the
 * KEY so it survives cert re-issue — NOT Node's whole-cert `fingerprint256`.
 *
 * INV-B: the FRESH `node:https`/`node:tls`/`node:crypto`/`undici` imports live in @dvconf/shared's
 * `mtls-carrier.ts` (NEVER from apps/relay/). Strictly additive: nothing imports this until the
 * carrier's TLS fork is enabled behind QUORUM_CLAIMS_TLS_ENABLED.
 */
import type { Server as HttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { RequestListener } from 'node:http';
import {
  isPeerSpkiTrusted as sharedIsPeerSpkiTrusted,
  createMtlsServer,
} from '@dvconf/shared';

/** The TLS material + the pinned peer trust anchors for the mTLS server fork. */
export interface QuorumClaimsTlsConfig {
  /** The carrier's self-signed TLS private key (PEM). */
  key: string;
  /** The carrier's self-signed TLS cert (PEM). */
  cert: string;
  /**
   * The set of TRUSTED peer SPKI fingerprints (`spkiFingerprint(peerCert)` — lowercase hex). A
   * client whose presented cert's SPKI is NOT in this set is rejected post-handshake (403). In
   * Phase C this is derived from `loadManifests(...)` → `m.certFingerprint`.
   */
  trustedSpki: ReadonlySet<string>;
}

/**
 * Resolve whether the cross-host TLS fork is enabled. OFF by default — an unset (or any non-`'1'`/
 * non-`'true'`) flag means the EXISTING node:http carrier runs byte-identical. Cap-token-specific
 * flag name; NOT promoted to shared.
 */
export function isQuorumClaimsTlsEnabled(
  env: Record<string, string | undefined>,
): boolean {
  const raw = env['QUORUM_CLAIMS_TLS_ENABLED'];
  return raw === '1' || raw === 'true';
}

/**
 * Post-handshake SPKI pin check — thin re-point to the shared generic `isPeerSpkiTrusted`. Fail-closed
 * on a missing peer cert / any extraction error.
 */
export function isPeerSpkiTrusted(
  socket: TLSSocket,
  trustedSpki: ReadonlySet<string>,
): boolean {
  return sharedIsPeerSpkiTrusted(socket, trustedSpki);
}

/**
 * Build the node:https mTLS server fork — thin re-point to the shared generic `createMtlsServer`
 * (`requestCert:true, rejectUnauthorized:false`, post-handshake SPKI 403-before-handler). The
 * existing bearer-token check still runs inside `appListener` (defense-in-depth in BOTH modes).
 */
export function createQuorumClaimsTlsServer(
  config: QuorumClaimsTlsConfig,
  appListener: RequestListener,
): HttpsServer {
  return createMtlsServer(
    { key: config.key, cert: config.cert, trustedClientSpki: config.trustedSpki },
    appListener,
  );
}
