/**
 * Phase A — operator-manifest primitive (cross-host mTLS carrier, OQ-7 / ADR-0021).
 *
 * Covers the four net-new primitives WITHOUT any transport:
 *   - spkiFingerprint    = sha256(SubjectPublicKeyInfo DER), pinned to the KEY not the cert
 *   - signManifest       = ed25519 (operator on-chain key) over the canonical manifest bytes
 *   - verifyManifest     = signature + validUntil expiry, fail-closed with a reason
 *   - loadManifests      = verify a bundle, return the VALID ones keyed by operatorPubkey
 *
 * Cert fixtures are openssl-minted self-signed P-256 certs (Phase A has no cert-gen dependency):
 *   CERT_A1 / CERT_A2  = the SAME keypair re-issued (different serial + validity + subject)
 *   CERT_B1            = a DISTINCT keypair
 *   PUB_A_PEM          = the raw public key of CERT_A1/A2 (proves the fingerprint is of the KEY)
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  spkiFingerprint,
  signManifest,
  verifyManifest,
  loadManifests,
  canonicalManifestBytes,
  type OperatorManifest,
  type SignedManifest,
} from '../operator-manifest.js';

const CERT_A1 = `-----BEGIN CERTIFICATE-----
MIIBcTCCARegAwIBAgIUf3gqt/KwgJdYbjGI2ercP3pcVcQwCgYIKoZIzj0EAwIw
DjEMMAoGA1UEAwwDb3BBMB4XDTI2MDYyMjE3NTE1M1oXDTI2MDYyMzE3NTE1M1ow
DjEMMAoGA1UEAwwDb3BBMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBFQVzEDu
2yqdTovJVfmL8T+ISD7k7YYhyIsZmaYJS3rLZ5B3ex8dxexexZzWS+jUDeaBqLYS
EJJuNGLgvLI4uaNTMFEwHQYDVR0OBBYEFDsrePC0Ixd5eu7rikcJCgvvCMkjMB8G
A1UdIwQYMBaAFDsrePC0Ixd5eu7rikcJCgvvCMkjMA8GA1UdEwEB/wQFMAMBAf8w
CgYIKoZIzj0EAwIDSAAwRQIgBkZvCemwE1CdKFa6asFZe0QxAds0+bi8wWClCTMu
Y14CIQCAba01Ifha/4cku6oU+bQfgba2wiQ9Wx3mh3MW9fnldQ==
-----END CERTIFICATE-----`;

const CERT_A2 = `-----BEGIN CERTIFICATE-----
MIIBgjCCASmgAwIBAgIUR84da4Htf5BzJAfhEmTQwWgVAlowCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMb3BBLXJlaXNzdWVkMB4XDTI2MDYyMjE3NTE1M1oXDTI4MDYy
MTE3NTE1M1owFzEVMBMGA1UEAwwMb3BBLXJlaXNzdWVkMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEBFQVzEDu2yqdTovJVfmL8T+ISD7k7YYhyIsZmaYJS3rLZ5B3
ex8dxexexZzWS+jUDeaBqLYSEJJuNGLgvLI4uaNTMFEwHQYDVR0OBBYEFDsrePC0
Ixd5eu7rikcJCgvvCMkjMB8GA1UdIwQYMBaAFDsrePC0Ixd5eu7rikcJCgvvCMkj
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgcNuj90fypNMlrk+V
crGOvbHyJkUw4cG9r5519KC9aDgCIDivVTqmoZjKdZFL6W0Fzp3bDch2IrAts1gT
25PAJDjj
-----END CERTIFICATE-----`;

const CERT_B1 = `-----BEGIN CERTIFICATE-----
MIIBcjCCARegAwIBAgIUBmRzttSibM+pBrt226FkgzP88jYwCgYIKoZIzj0EAwIw
DjEMMAoGA1UEAwwDb3BCMB4XDTI2MDYyMjE3NTE1M1oXDTI2MDYyMzE3NTE1M1ow
DjEMMAoGA1UEAwwDb3BCMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEMWYAsPQQ
a46cN4FuJof6qWtej2JvCMHAy9HpwB4tyLUE/6V5AugmevO1Y/tqb/YU8xex8l4f
rIfb6T86uTz72KNTMFEwHQYDVR0OBBYEFMMkF0zDrTMlgXEzLCP19tlVVKTuMB8G
A1UdIwQYMBaAFMMkF0zDrTMlgXEzLCP19tlVVKTuMA8GA1UdEwEB/wQFMAMBAf8w
CgYIKoZIzj0EAwIDSQAwRgIhAMxjFAFI1L1yHz8q7u32u4TEo4iYNdZOns33PqHG
5GUxAiEA8u7lleiR55EEhDx1hv6vbPIdIP91X2cdKYci8SJSwXc=
-----END CERTIFICATE-----`;

const PUB_A_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEBFQVzEDu2yqdTovJVfmL8T+ISD7k
7YYhyIsZmaYJS3rLZ5B3ex8dxexexZzWS+jUDeaBqLYSEJJuNGLgvLI4uQ==
-----END PUBLIC KEY-----`;

const YEAR_2100 = 4_102_444_800_000; // unix ms, far future
const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Build a well-formed manifest for `kp` (operatorPubkey = kp's raw pubkey hex). */
function manifestFor(kp: Ed25519Keypair, over: Partial<OperatorManifest> = {}): OperatorManifest {
  return {
    operatorPubkey: toHex(kp.getPublicKey().toRawBytes()),
    boardEndpoint: 'op-a.internal:8092',
    certFingerprint: 'ab'.repeat(32),
    validUntil: YEAR_2100,
    ...over,
  };
}

describe('spkiFingerprint — sha256(SPKI DER), pinned to the KEY not the cert', () => {
  it('is deterministic for the same cert', () => {
    expect(spkiFingerprint(CERT_A1)).toBe(spkiFingerprint(CERT_A1));
  });

  it('is a 64-char lowercase hex sha256 digest', () => {
    expect(spkiFingerprint(CERT_A1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SURVIVES same-key cert re-issue: CERT_A1 and CERT_A2 (different serial/validity/subject, same key) → SAME fingerprint', () => {
    expect(spkiFingerprint(CERT_A2)).toBe(spkiFingerprint(CERT_A1));
  });

  it('DISTINGUISHES a different key: CERT_B1 → DIFFERENT fingerprint', () => {
    expect(spkiFingerprint(CERT_B1)).not.toBe(spkiFingerprint(CERT_A1));
  });

  it('cert fingerprint == raw-public-key fingerprint (proves it is the SPKI of the key, not the cert)', () => {
    expect(spkiFingerprint(PUB_A_PEM)).toBe(spkiFingerprint(CERT_A1));
  });
});

describe('signManifest / verifyManifest — ed25519 over canonical bytes', () => {
  it('round-trips: a freshly signed manifest verifies', async () => {
    const kp = new Ed25519Keypair();
    const signed = await signManifest(manifestFor(kp), kp);
    const r = await verifyManifest(signed, { now: YEAR_2100 - 1 });
    expect(r.valid).toBe(true);
  });

  it('the signature is 128-char hex (64 raw ed25519 bytes)', async () => {
    const kp = new Ed25519Keypair();
    const signed = await signManifest(manifestFor(kp), kp);
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/);
  });

  it('REJECTS a tampered field (boardEndpoint mutated after signing) as bad-signature', async () => {
    const kp = new Ed25519Keypair();
    const signed = await signManifest(manifestFor(kp), kp);
    const tampered: SignedManifest = {
      ...signed,
      manifest: { ...signed.manifest, boardEndpoint: 'evil.attacker:8092' },
    };
    const r = await verifyManifest(tampered, { now: YEAR_2100 - 1 });
    expect(r).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('REJECTS a signature made by a DIFFERENT key than the declared operatorPubkey', async () => {
    const kpDeclared = new Ed25519Keypair();
    const kpSigner = new Ed25519Keypair();
    const m = manifestFor(kpDeclared); // declares kpDeclared's pubkey
    const sig = await kpSigner.sign(canonicalManifestBytes(m)); // but signed by kpSigner
    const forged: SignedManifest = { manifest: m, signature: toHex(sig) };
    const r = await verifyManifest(forged, { now: YEAR_2100 - 1 });
    expect(r).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('REJECTS an expired manifest (now > validUntil) as expired, even with a valid signature', async () => {
    const kp = new Ed25519Keypair();
    const signed = await signManifest(manifestFor(kp, { validUntil: 1000 }), kp);
    const r = await verifyManifest(signed, { now: 2000 });
    expect(r).toEqual({ valid: false, reason: 'expired' });
  });

  it('treats validUntil == now as still valid (boundary)', async () => {
    const kp = new Ed25519Keypair();
    const signed = await signManifest(manifestFor(kp, { validUntil: 5000 }), kp);
    const r = await verifyManifest(signed, { now: 5000 });
    expect(r.valid).toBe(true);
  });

  it('REJECTS a malformed manifest (bad pubkey hex length) as malformed', async () => {
    const kp = new Ed25519Keypair();
    const signed = await signManifest(manifestFor(kp), kp);
    const bad: SignedManifest = {
      ...signed,
      manifest: { ...signed.manifest, operatorPubkey: 'deadbeef' },
    };
    const r = await verifyManifest(bad, { now: YEAR_2100 - 1 });
    expect(r).toEqual({ valid: false, reason: 'malformed' });
  });

  it('signManifest FAILS LOUD when the keypair does not match the declared operatorPubkey', async () => {
    const kp = new Ed25519Keypair();
    const other = new Ed25519Keypair();
    const m = manifestFor(other); // declares `other`, but we sign with `kp`
    await expect(signManifest(m, kp)).rejects.toThrow(/operator-manifest/);
  });

  it('signManifest THROWS on a malformed manifest', async () => {
    const kp = new Ed25519Keypair();
    const m = manifestFor(kp, { certFingerprint: 'xyz' });
    await expect(signManifest(m, kp)).rejects.toThrow(/operator-manifest/);
  });

  // ── v2 (B-13): the OPTIONAL relayPipe descriptor — additive + back-compat ──
  it('v2: a relayPipe-bearing manifest signs + verifies (round-trip)', async () => {
    const kp = new Ed25519Keypair();
    const m = manifestFor(kp, { relayPipe: { ip: '10.0.0.1', port: 40000 } });
    const signed = await signManifest(m, kp);
    const res = await verifyManifest(signed, { now: m.validUntil - 1 });
    expect(res.valid).toBe(true);
  });

  it('v2: a manifest with NO relayPipe stays valid (back-compat trust anchor)', async () => {
    const kp = new Ed25519Keypair();
    const m = manifestFor(kp);
    const signed = await signManifest(m, kp);
    const res = await verifyManifest(signed, { now: m.validUntil - 1 });
    expect(res.valid).toBe(true);
  });

  it('v2: a malformed relayPipe (bad port) is rejected as malformed', async () => {
    const kp = new Ed25519Keypair();
    const m = manifestFor(kp, { relayPipe: { ip: '10.0.0.1', port: 99999 } } as Partial<OperatorManifest>);
    const signed = await signManifest(m, kp).catch(() => null);
    expect(signed === null || (await verifyManifest(signed, {})).valid === false).toBe(true);
  });
});

describe('loadManifests — verify a bundle, keep the VALID ones keyed by operatorPubkey', () => {
  it('keeps valid, drops expired + tampered, dedups by operatorPubkey', async () => {
    const kpA = new Ed25519Keypair();
    const kpB = new Ed25519Keypair();
    const kpC = new Ed25519Keypair();

    const validA = await signManifest(manifestFor(kpA, { boardEndpoint: 'a:8092' }), kpA);
    const expiredB = await signManifest(manifestFor(kpB, { validUntil: 1000 }), kpB);
    const validCsigned = await signManifest(manifestFor(kpC, { boardEndpoint: 'c:8092' }), kpC);
    const tamperedC: SignedManifest = {
      ...validCsigned,
      manifest: { ...validCsigned.manifest, boardEndpoint: 'evil:8092' },
    };
    // a duplicate, also-valid manifest for kpA (later endpoint) — first wins
    const dupA = await signManifest(manifestFor(kpA, { boardEndpoint: 'a-dup:8092' }), kpA);

    const map = await loadManifests([validA, expiredB, tamperedC, dupA], { now: 2000 });

    expect(map.size).toBe(1);
    const aHex = toHex(kpA.getPublicKey().toRawBytes());
    expect(map.get(aHex)?.boardEndpoint).toBe('a:8092'); // first-valid wins
    expect(map.has(toHex(kpB.getPublicKey().toRawBytes()))).toBe(false); // expired dropped
    expect(map.has(toHex(kpC.getPublicKey().toRawBytes()))).toBe(false); // tampered dropped
  });

  it('returns an empty map for an empty bundle', async () => {
    const map = await loadManifests([], { now: 2000 });
    expect(map.size).toBe(0);
  });
});
