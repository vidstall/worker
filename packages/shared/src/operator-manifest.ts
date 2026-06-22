/**
 * Operator manifest — the OOB discovery + trust-anchor primitive for the cross-host mTLS carrier
 * (OQ-7 / ADR-0021, Phase A). NO transport here: this module only mints, verifies, and loads the
 * signed manifests that a carrier client later uses to (a) discover a peer's `host:8092` board
 * endpoint and (b) pin the peer's TLS identity via its SPKI fingerprint.
 *
 * Design (locked in DESIGN-cross-host-oq7.md):
 *   - NO CA / NO central PKI. Each operator self-signs an X.509 cert with a DISTINCT TLS keypair
 *     (TLS cannot use the on-chain ed25519 key). The trust anchor is the cert's
 *     `sha256(SubjectPublicKeyInfo DER)` fingerprint — pinned to the KEY, so it survives cert
 *     rotation/re-issue for the same key. NOT Node's `getPeerCertificate().fingerprint256` (which
 *     digests the whole cert and changes on same-key re-issue).
 *   - The manifest itself is ed25519-signed with the operator's ON-CHAIN identity key (the same
 *     `Ed25519Keypair` family used everywhere else), so a verifier trusts the {endpoint, fingerprint}
 *     binding without a CA. Discovery stays OOB (deploy-config) — 0 Move change, no peer→URL on chain.
 *
 * INV-B: imports `node:crypto` FRESH (never from apps/relay/). Pure off-relay shared code.
 */
import { createHash, createPublicKey, X509Certificate, type KeyObject } from 'node:crypto';
import { Ed25519PublicKey, type Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger } from './logger.js';

const log = createLogger('operator-manifest');

/** Domain-separation tag + version for the canonical signing bytes. Bump on any layout change. */
const MANIFEST_DOMAIN = 'DVCONF-OPMANIFEST-v1';

/** The OOB-distributed binding a verifier needs to reach + trust a peer's carrier board. */
export interface OperatorManifest {
  /** Operator's on-chain ed25519 identity pubkey — raw 32 bytes as lowercase hex (no `0x`). */
  operatorPubkey: string;
  /** Reachable carrier endpoint, `host:port` (port 8092). Opaque to this module beyond well-formedness. */
  boardEndpoint: string;
  /** `sha256(SubjectPublicKeyInfo DER)` of the operator's self-signed TLS cert — lowercase hex. */
  certFingerprint: string;
  /** Unix epoch MILLISECONDS after which this manifest is stale (bounds key-rotation staleness). */
  validUntil: number;
}

/** A manifest plus the operator's ed25519 signature over its canonical bytes (raw 64 bytes, hex). */
export interface SignedManifest {
  manifest: OperatorManifest;
  /** Raw ed25519 signature over `canonicalManifestBytes(manifest)` — 64 bytes as lowercase hex. */
  signature: string;
}

/** Fail-closed verification outcome with a machine-readable reason. */
export type ManifestVerifyResult =
  | { valid: true; manifest: OperatorManifest }
  | { valid: false; reason: 'malformed' | 'bad-signature' | 'expired' };

const HEX64 = /^[0-9a-f]{64}$/;

/** True iff `m` has the exact shape the canonical encoding requires (no throw). */
function isWellFormed(m: OperatorManifest): boolean {
  return (
    typeof m.operatorPubkey === 'string' &&
    HEX64.test(m.operatorPubkey) &&
    typeof m.certFingerprint === 'string' &&
    HEX64.test(m.certFingerprint) &&
    typeof m.boardEndpoint === 'string' &&
    m.boardEndpoint.length > 0 &&
    !m.boardEndpoint.includes('\n') &&
    typeof m.validUntil === 'number' &&
    Number.isInteger(m.validUntil) &&
    m.validUntil > 0
  );
}

/**
 * Deterministic byte encoding signed/verified over. A fixed-order, newline-delimited, domain-tagged
 * layout (fields are constrained by `isWellFormed` so none can contain a `\n` separator).
 * Throws on a malformed manifest — callers that must not throw guard with `isWellFormed` first.
 */
export function canonicalManifestBytes(m: OperatorManifest): Uint8Array {
  if (!isWellFormed(m)) {
    throw new Error('operator-manifest: cannot encode a malformed manifest');
  }
  const line = [
    MANIFEST_DOMAIN,
    m.operatorPubkey,
    m.boardEndpoint,
    m.certFingerprint,
    String(m.validUntil),
  ].join('\n');
  return new TextEncoder().encode(line);
}

/**
 * `sha256(SubjectPublicKeyInfo DER)` of a public key — the trust anchor pinned in a manifest.
 * Accepts a cert PEM (extracts its public key), a public-key PEM, or a `KeyObject`. Because it
 * fingerprints the SPKI (the key) and not the cert wrapper, two certs over the same key — a
 * re-issue — yield the SAME fingerprint.
 */
export function spkiFingerprint(input: KeyObject | string): string {
  let pub: KeyObject;
  if (typeof input === 'string') {
    pub = input.includes('BEGIN CERTIFICATE')
      ? new X509Certificate(input).publicKey
      : createPublicKey(input);
  } else {
    pub = input;
  }
  const der = pub.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/**
 * Sign a manifest with the operator's on-chain ed25519 keypair. FAILS LOUD when the keypair's
 * public key does not match `manifest.operatorPubkey` (an operator can only sign a manifest that
 * declares its OWN key) and when the manifest is malformed.
 */
export async function signManifest(
  manifest: OperatorManifest,
  operatorKeypair: Ed25519Keypair,
): Promise<SignedManifest> {
  const bytes = canonicalManifestBytes(manifest); // throws on malformed
  const keyHex = toHex(operatorKeypair.getPublicKey().toRawBytes());
  if (keyHex !== manifest.operatorPubkey) {
    throw new Error(
      'operator-manifest: signing keypair does not match the declared operatorPubkey (refusing to sign a foreign-key manifest)',
    );
  }
  const signature = await operatorKeypair.sign(bytes);
  return { manifest, signature: toHex(signature) };
}

/**
 * Verify a signed manifest fail-closed: malformed → `malformed`; signature not from the declared
 * `operatorPubkey` → `bad-signature`; `now > validUntil` → `expired`. `opts.now` (unix ms) is
 * injectable for testability and defaults to `Date.now()`.
 */
export async function verifyManifest(
  signed: SignedManifest,
  opts: { now?: number } = {},
): Promise<ManifestVerifyResult> {
  const { manifest, signature } = signed;
  if (!isWellFormed(manifest) || typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) {
    return { valid: false, reason: 'malformed' };
  }

  let sigOk = false;
  try {
    const pub = new Ed25519PublicKey(new Uint8Array(Buffer.from(manifest.operatorPubkey, 'hex')));
    sigOk = await pub.verify(
      canonicalManifestBytes(manifest),
      new Uint8Array(Buffer.from(signature, 'hex')),
    );
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { valid: false, reason: 'bad-signature' };

  const now = opts.now ?? Date.now();
  if (now > manifest.validUntil) return { valid: false, reason: 'expired' };

  return { valid: true, manifest };
}

/**
 * Verify a bundle of signed manifests and return the VALID ones keyed by `operatorPubkey`. Invalid
 * manifests are dropped (warn-logged with their reason); a duplicate operator keeps the FIRST valid
 * entry (deterministic). `opts.now` is forwarded to `verifyManifest`.
 */
export async function loadManifests(
  bundle: SignedManifest[],
  opts: { now?: number } = {},
): Promise<Map<string, OperatorManifest>> {
  const out = new Map<string, OperatorManifest>();
  for (const signed of bundle) {
    const r = await verifyManifest(signed, opts);
    if (!r.valid) {
      log.warn({ reason: r.reason, endpoint: signed.manifest?.boardEndpoint }, 'operator-manifest: dropping invalid manifest');
      continue;
    }
    if (out.has(r.manifest.operatorPubkey)) {
      log.warn({ operatorPubkey: r.manifest.operatorPubkey }, 'operator-manifest: duplicate operator, keeping the first valid manifest');
      continue;
    }
    out.set(r.manifest.operatorPubkey, r.manifest);
  }
  return out;
}
