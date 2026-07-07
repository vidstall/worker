import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
// scripts/ tests resolve relative source paths (not @dvconf/shared alias) — same convention as
// gen-canary-material.test.ts and other demo __tests__.
import { loadManifests, manifestsToTrustedSpki } from '../../../packages/shared/src/index.ts';
import { generateCaptokenMaterial, generateCaptokenMaterialCli } from '../gen-captoken-material.ts';

describe('generateCaptokenMaterial', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('emits a cert/key per host and a bundle whose SPKI set has 2 entries matching the certs', async () => {
    dir = mkdtempSync(join(tmpdir(), 'captoken-mat-'));
    const cpA = Ed25519Keypair.generate();
    const cpB = Ed25519Keypair.generate();
    const out = await generateCaptokenMaterial({
      dir,
      hosts: [
        { name: 'vm1', cn: '10.0.0.4', boardEndpoint: '10.0.0.4:8092', keypair: cpA },
        { name: 'vm2', cn: '10.0.0.5', boardEndpoint: '10.0.0.5:8092', keypair: cpB },
      ],
      validUntilMs: Date.now() + 90 * 24 * 3600 * 1000,
    });
    expect(out.hosts).toHaveLength(2);
    // loadManifests is async — must await before passing to manifestsToTrustedSpki.
    const trusted = manifestsToTrustedSpki(await loadManifests(out.bundle));
    expect(trusted.size).toBe(2);
  });

  it('CLI: loads cp-keypairs.json (2 CPs) and emits the runbook-named cert/key + 2-SPKI bundle', async () => {
    dir = mkdtempSync(join(tmpdir(), 'captoken-cli-'));
    const cpA = Ed25519Keypair.generate();
    const cpB = Ed25519Keypair.generate();
    const cpKeypairsPath = join(dir, 'cp-keypairs.json');
    // Mirror the seed-multicp.ts / seed-bootstrap.ts shape: [{ address, secretKey(bech32) }].
    writeFileSync(
      cpKeypairsPath,
      JSON.stringify([
        { address: cpA.toSuiAddress(), secretKey: cpA.getSecretKey() },
        { address: cpB.toSuiAddress(), secretKey: cpB.getSecretKey() },
      ]),
      'utf8',
    );

    // Use the real clock (default now) so validUntil is in the future — loadManifests checks
    // expiry against the real time, so a pinned past `now` would make the manifest "expired".
    const out = await generateCaptokenMaterialCli(
      ['--leader-ip', '10.0.0.4', '--follower-ip', '10.0.0.5', '--cp-keypairs', cpKeypairsPath, '--out-dir', dir],
    );

    expect(out.hosts.map((h) => h.name)).toEqual(['vm1', 'vm2']);
    // The EXACT filenames the runbook (Stage 4/5) must reference:
    expect(out.hosts[0]!.certPath.endsWith('vm1-cert.pem')).toBe(true);
    expect(out.hosts[0]!.keyPath.endsWith('vm1-key.pem')).toBe(true);
    expect(out.hosts[1]!.certPath.endsWith('vm2-cert.pem')).toBe(true);
    expect(out.hosts[1]!.keyPath.endsWith('vm2-key.pem')).toBe(true);
    expect(out.bundlePath.endsWith('captoken-manifest-bundle.json')).toBe(true);
    for (const h of out.hosts) {
      expect(existsSync(h.certPath)).toBe(true);
      expect(existsSync(h.keyPath)).toBe(true);
    }
    expect(existsSync(out.bundlePath)).toBe(true);
    // The bundle binds BOTH CP operator keys → trusted-SPKI set size 2.
    const trusted = manifestsToTrustedSpki(await loadManifests(out.bundle));
    expect(trusted.size).toBe(2);
  });
});
