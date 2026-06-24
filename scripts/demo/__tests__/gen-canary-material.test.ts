import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
// scripts/ tests can't resolve the @dvconf/shared workspace alias under vitest — import the
// relative SOURCE path (the same convention .scratch-build-manifests.ts + the runner use).
import {
  verifyManifest,
  manifestsToTrustedSpki,
  loadManifests,
  spkiFingerprint,
} from '../../../packages/shared/src/index.ts';
import { renderCanaryEnvFile, buildManifestBundle } from '../gen-canary-material.ts';

// Two test-only P-256 self-signed certs (the @dvconf/shared mtls fixtures) — DISTINCT TLS keypairs,
// independent of the ed25519 operator keys. We only need their SPKIs to differ.
const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBdjCCARygAwIBAgITLk6LHxyZYLvyEDBN2E0VqiZORDAKBggqhkjOPQQDAjAR
MQ8wDQYDVQQDDAZzZXJ2ZXIwHhcNMjYwNjIyMTgwMTQyWhcNMzYwNjE5MTgwMTQy
WjARMQ8wDQYDVQQDDAZzZXJ2ZXIwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATX
7ONnRYHKj0gzjrUKi+C/qaht3BdwKN41wrC+Xbfal8CIsPxDdYhdG6969SSquADX
xvXkFZK8QP/okr+0bAN4o1MwUTAdBgNVHQ4EFgQUE8eKn1c3yC2zqiInaBP4KIzX
BhIwHwYDVR0jBBgwFoAUE8eKn1c3yC2zqiInaBP4KIzXBhIwDwYDVR0TAQH/BAUw
AwEB/zAKBggqhkjOPQQDAgNIADBFAiEAxoymLE37QQYPvz3hS0MKWlKyBkg7tVfx
P3gqS3x336UCIHSLLPB1qr5UBw32BwYe0q4ynaEDYeUQFwcRN3IUAWD9
-----END CERTIFICATE-----`;
const CERT_B = `-----BEGIN CERTIFICATE-----
MIIBdzCCAR2gAwIBAgIUc0VSaZgWI8jYEhEYs5xgqAihONAwCgYIKoZIzj0EAwIw
ETEPMA0GA1UEAwwGY2xpZW50MB4XDTI2MDYyMjE4MDE0MloXDTM2MDYxOTE4MDE0
MlowETEPMA0GA1UEAwwGY2xpZW50MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
Hctld68bMyCCrmPUMvgF5LD0FXKZLu2VA2Qy7NA9M9bcvjgT3CSNzaaFBXnNUKEj
aU1D4BCQEIZYSNcsd96uqaNTMFEwHQYDVR0OBBYEFPA4xfWYpCspU4nc5NO0sZKU
7YcYMB8GA1UdIwQYMBaAFPA4xfWYpCspU4nc5NO0sZKU7YcYMA8GA1UdEwEB/wQF
MAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgQrfFkBAEz0elMGLAg084dtWCKiuxicYY
VmUMCzzzw6QCIQDeHbhj5i8ihd38paJY2URQVDdnPEwTu8deN6yMlePIxg==
-----END CERTIFICATE-----`;

describe('renderCanaryEnvFile', () => {
  it('emits sourceable shell exports for the 4 canary vars', () => {
    const out = renderCanaryEnvFile({
      roomId: '0xroom',
      relayMinerId: '0xrelay',
      val1Pub: 'aa11',
      val2Pub: 'bb22',
    });
    expect(out).toContain("export CANARY_DEMO_ROOM_ID='0xroom'");
    expect(out).toContain("export CANARY_DEMO_RELAY_MINER_ID='0xrelay'");
    expect(out).toContain("export VAL1_SELF_PUBKEY='aa11'");
    expect(out).toContain("export VAL2_SELF_PUBKEY='bb22'");
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('buildManifestBundle', () => {
  it('binds each operatorPubkey to its cert SPKI, signs verifiably, and yields a 2-SPKI trust set', async () => {
    const kpA = new Ed25519Keypair();
    const kpB = new Ed25519Keypair();
    const validUntilMs = 4_000_000_000_000; // far future (deterministic, not Date.now())

    const bundle = await buildManifestBundle(
      [
        { keypair: kpA, certPem: CERT_A, boardEndpoint: 'validator-daemon:8092' },
        { keypair: kpB, certPem: CERT_B, boardEndpoint: 'validator-daemon-2:8093' },
      ],
      validUntilMs,
    );

    expect(bundle).toHaveLength(2);

    // operatorPubkey == the signing keypair's pubkey (signManifest refuses a foreign-key manifest).
    const pubA = Buffer.from(kpA.getPublicKey().toRawBytes()).toString('hex');
    expect(bundle[0].manifest.operatorPubkey).toBe(pubA);
    // certFingerprint == the SPKI the mTLS pin will compute for the SAME cert.
    expect(bundle[0].manifest.certFingerprint).toBe(spkiFingerprint(CERT_A));
    expect(bundle[0].manifest.boardEndpoint).toBe('validator-daemon:8092');

    // Both manifests verify (the live carrier rejects any that don't).
    for (const m of bundle) {
      const r = await verifyManifest(m, { now: validUntilMs - 1 });
      expect(r.valid).toBe(true);
    }

    // The trusted-SPKI set the validators pin has exactly the 2 distinct cert SPKIs.
    const trusted = manifestsToTrustedSpki(await loadManifests(bundle, { now: validUntilMs - 1 }));
    expect(trusted).toEqual(new Set([spkiFingerprint(CERT_A), spkiFingerprint(CERT_B)]));
  });
});
