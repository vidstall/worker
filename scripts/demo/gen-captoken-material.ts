/**
 * Cross-host cap-token mTLS material generator (spec §7 build item 1). Reuses the shipped
 * canary primitives verbatim: generateP256Cert + buildManifestBundle from gen-canary-material.ts,
 * but binds CP OPERATOR keys (not validator keys). Emits per-host cert/key + one signed manifest
 * bundle (SPKI pin, validUntil). The pin is SPKI-only (buildConnector, not checkServerIdentity),
 * so CN/boardEndpoint are cosmetic — the load-bearing binding is operator-pubkey <-> cert SPKI.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
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

// ── CLI (runbook Stage 4a) ───────────────────────────────────────────────────

interface CaptokenCliArgs {
  leaderIp: string;
  followerIp: string;
  cpKeypairsPath: string;
  outDir: string;
  validDays: number;
}

function parseCaptokenCliArgs(argv: string[]): CaptokenCliArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const need = (flag: string): string => {
    const v = get(flag);
    if (v === undefined || v === '') throw new Error(`gen-captoken-material: missing ${flag}`);
    return v;
  };
  return {
    leaderIp: need('--leader-ip'),
    followerIp: need('--follower-ip'),
    cpKeypairsPath: need('--cp-keypairs'),
    outDir: need('--out-dir'),
    validDays: Number(get('--valid-days') ?? '90') || 90,
  };
}

interface CpKeypairEntry {
  address: string;
  /** bech32 suiprivkey1... (as written by seed-multicp.ts / seed-bootstrap.ts). */
  secretKey: string;
}

/**
 * CLI wrapper (runbook Stage 4a). Loads cp-keypairs.json — an array of >= 2
 * `{ address, secretKey(bech32) }` entries where [0] is the leader/vm1 CP and [1] the
 * follower/vm2 CP — binds each CP OPERATOR key to a per-host P-256 cert, and emits the signed
 * manifest bundle. Emits `<out-dir>/vm1-cert.pem`, `vm1-key.pem`, `vm2-cert.pem`, `vm2-key.pem`,
 * `captoken-manifest-bundle.json`. `opts.now` makes validUntil deterministic in tests.
 */
export async function generateCaptokenMaterialCli(
  argv: string[],
  opts?: { now?: number },
): Promise<CaptokenMaterial> {
  const args = parseCaptokenCliArgs(argv);
  const cps = JSON.parse(readFileSync(args.cpKeypairsPath, 'utf8')) as CpKeypairEntry[];
  if (!Array.isArray(cps) || cps.length < 2) {
    throw new Error(
      `gen-captoken-material: ${args.cpKeypairsPath} must hold >= 2 CP keypairs ` +
        `(got ${Array.isArray(cps) ? cps.length : 'a non-array'})`,
    );
  }
  const leaderKp = Ed25519Keypair.fromSecretKey(cps[0]!.secretKey);
  const followerKp = Ed25519Keypair.fromSecretKey(cps[1]!.secretKey);
  const now = opts?.now ?? Date.now();
  return generateCaptokenMaterial({
    dir: args.outDir,
    hosts: [
      { name: 'vm1', cn: args.leaderIp, boardEndpoint: `${args.leaderIp}:8092`, keypair: leaderKp },
      { name: 'vm2', cn: args.followerIp, boardEndpoint: `${args.leaderIp}:8092`, keypair: followerKp },
    ],
    validUntilMs: now + args.validDays * 24 * 3600 * 1000,
  });
}

// Only run when executed directly (npx tsx scripts/demo/gen-captoken-material.ts ...), not on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  generateCaptokenMaterialCli(process.argv.slice(2))
    .then((out) => {
      process.stdout.write(
        `gen-captoken-material: ${out.hosts.length} host cert/key pairs + bundle ${out.bundlePath}\n` +
          out.hosts.map((h) => `  ${h.name}: ${h.certPath} , ${h.keyPath}`).join('\n') +
          '\n',
      );
    })
    .catch((e: unknown) => {
      process.stderr.write(`gen-captoken-material: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
