/**
 * Cross-host cap-token mTLS material generator (spec §7 build item 1). Reuses the shipped
 * canary primitives verbatim: generateP256Cert + buildManifestBundle from gen-canary-material.ts,
 * but binds CP OPERATOR keys (not validator keys). Emits per-host cert/key + one signed manifest
 * bundle (SPKI pin, validUntil). The pin is SPKI-only (buildConnector, not checkServerIdentity),
 * so CN/boardEndpoint are cosmetic — the load-bearing binding is operator-pubkey <-> cert SPKI.
 */
import { writeFileSync } from 'node:fs';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SignedManifest } from '../../packages/shared/src/index.ts';
import { generateP256Cert, buildManifestBundle } from './gen-canary-material.ts';

export interface CaptokenHost {
  name: string;
  cn: string;
  boardEndpoint: string;
  keypair: Ed25519Keypair;
}

export interface CaptokenMaterial {
  hosts: Array<{ name: string; certPath: string; keyPath: string; certPem: string }>;
  bundle: SignedManifest[];
  bundlePath: string;
}

export async function generateCaptokenMaterial(opts: {
  dir: string;
  hosts: CaptokenHost[];
  validUntilMs: number;
}): Promise<CaptokenMaterial> {
  const hostsOut: CaptokenMaterial['hosts'] = [];
  const manifestInputs: Array<{ keypair: Ed25519Keypair; certPem: string; boardEndpoint: string }> = [];
  for (const h of opts.hosts) {
    const { certPath, keyPath, certPem } = generateP256Cert(h.cn, opts.dir, h.name);
    hostsOut.push({ name: h.name, certPath, keyPath, certPem });
    manifestInputs.push({ keypair: h.keypair, certPem, boardEndpoint: h.boardEndpoint });
  }
  const bundle = await buildManifestBundle(manifestInputs, opts.validUntilMs);
  const bundlePath = `${opts.dir}/captoken-manifest-bundle.json`;
  writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');
  return { hosts: hostsOut, bundle, bundlePath };
}
