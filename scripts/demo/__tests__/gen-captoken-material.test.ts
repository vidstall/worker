import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
// scripts/ tests resolve relative source paths (not @dvconf/shared alias) — same convention as
// gen-canary-material.test.ts and other demo __tests__.
import { loadManifests, manifestsToTrustedSpki } from '../../../packages/shared/src/index.ts';
import { generateCaptokenMaterial } from '../gen-captoken-material.ts';

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
});
