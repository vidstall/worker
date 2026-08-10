/**
 * m2b/common.ts — shared paths, env-derived constants, and small cross-cutting helpers used by the
 * m2b-live-bhermetic-slash orchestrator modules (extracted verbatim from the original single-file
 * script — pure code movement, no behavior change).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

export const MOD = 'm2b-live-bhermetic-slash';

// ── workspace paths (this file is dvconf-daemons/scripts/demo/m2b/) ──────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../../..'); // m2b -> demo -> scripts -> dvconf-daemons -> workspace root
export const DEMO_SHARED = join(ROOT, '.demo-shared');
export const ROOM_FILE = join(DEMO_SHARED, 'room.json');
export const ONCHAIN_CONFIG_FILE = join(DEMO_SHARED, 'onchain-config.json');
export const EVIDENCE_DIR = join(ROOT, '.evidence', 'verification');

// ── host-reachable booted-stack endpoints (compose publishes 9000 RPC + 9123 faucet) ────────────
export const HOST_RPC_URL = process.env['SUI_NETWORK'] && /^https?:\/\//.test(process.env['SUI_NETWORK'])
  ? process.env['SUI_NETWORK']
  : 'http://127.0.0.1:9000';
export const HOST_FAUCET_URL = process.env['FAUCET_URL'] ?? 'http://127.0.0.1:9123/gas';

// ── canary stream params for the browser↔verifier pair (internally consistent; NOT chain-checked) ─
// The chain verifies only ed25519 over the 145-byte proof + room/relay binding — NOT cellSecret/kRoom
// (those are off-chain crypto). So the producer + verifier just need to agree on these to make the
// divergence REAL. Distinct from the booted validators' CANARY_CELL_SECRET (which audits a DIFFERENT
// stream) — irrelevant here because the proof carries the hashes the verifier computed, not a secret.
// B-WAN (REQ-MLW-B-15 conjunct-1, closes P2): source the producer<->verifier crypto-metadata from OOB
// per-host provisioning (env CANARY_CELL_SECRET, the STEP-3 posture), NOT hardcoded constants.
// INV-C: cellSecret/kRoom NEVER appear on the claims wire / media wire / signed manifest.
function hexEnv32(name: string): Uint8Array {
  const hx = process.env[name];
  if (!hx || !/^[0-9a-fA-F]{64}$/.test(hx)) {
    throw new Error(`${MOD}: ${name} must be 32-byte hex (64 chars) — OOB-provision it per-host (INV-C); refusing a hardcoded secret`);
  }
  return Uint8Array.from(Buffer.from(hx, 'hex'));
}
export const K_ROOM = hexEnv32('CANARY_DEMO_K_ROOM');          // was: new Uint8Array(32).fill(0x5c)
export const CELL_SECRET = hexEnv32('CANARY_CELL_SECRET');     // was: new Uint8Array(32).fill(0xab)
export const CANARY_KID = parseInt(process.env['CANARY_DEMO_CANARY_KID'] ?? '7', 10);
export const CTRS = (process.env['CANARY_DEMO_CTRS'] ?? '0,1,2,3,4,5,6,7').split(',').map((s) => parseInt(s, 10));

export const FAUCET_TIMEOUT_MS = 90_000;
export const FAUCET_POLL_MS = 1000;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Stake tiers (MIST) — mirror canary-localnet-helpers (validator min 0.1; 0.3 clears the apply guard).
export const VALIDATOR_STAKE_MIST = 300_000_000n;

/**
 * Retry a chain op on the Sui "owned-object already locked by a different transaction" / equivocation
 * error. The seed CP + the publisher deployer keypairs are ALSO held by LIVE containers (the cp-daemon
 * signs cap-token issuance / role votes; the publisher rarely signs), so a tx that reuses one of those
 * keys can briefly race a live tx for the shared gas coin. This is a transient lock — wait for the
 * conflicting tx to finalize and retry. NOT used for the fresh-keypair ops (no contention there).
 */
export async function withLockRetry<T>(label: string, fn: () => Promise<T>, attempts = 6, backoffMs = 2500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /already locked by a different transaction|equivocat|reserved for another transaction|JsonRpcError.*-3200|quorum of validators/i.test(msg);
      if (!transient || i === attempts - 1) throw e;
      lastErr = e;
      process.stdout.write(`  [retry ${i + 1}/${attempts}] ${label}: transient lock — backing off ${backoffMs}ms\n`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

export interface RoomManifest { roomId: string; relayId?: string; primaryUrl?: string }

/** A keypair from a bech32 `suiprivkey1...` secret. */
export function kpFromSecret(secret: string): Ed25519Keypair {
  return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secret).secretKey);
}

export const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null || v === '') throw new Error(`${MOD}: ${what} required`);
  return v;
};

/**
 * B-WAN cross-host F1 endpoints (Task-7.1, REQ-MLW-B-11/14). Returns the relay host + peer validator
 * host routable VPN/VNet iface IPs when the 2-host run is active, or null for the single-process
 * loopback path (127.0.0.1, byte-identical default). Triggered ONLY by the NEW cross-host-only var
 * CANARY_PEER_VPN_IP — so a stray ANNOUNCED_IP (e.g. the single-host realmedia compose sets 127.0.0.1)
 * can NEVER flip the orchestrator off loopback. At live time need() hard-requires BOTH: a half-set env
 * fails LOUD instead of silently binding loopback. Mirrors the PIPE_SRTP env-gate style (additive, OFF).
 */
export function crossHostF1Endpoints(): { relayVpnIp: string; peerVpnIp: string } | null {
  if (!process.env['CANARY_PEER_VPN_IP']) return null; // single-process loopback (byte-identical)
  return {
    relayVpnIp: need(process.env['ANNOUNCED_IP'], 'ANNOUNCED_IP (this relay host VPN/VNet iface — cross-host F1)'),
    peerVpnIp: need(process.env['CANARY_PEER_VPN_IP'], 'CANARY_PEER_VPN_IP (peer validator host VPN/VNet iface — cross-host F1)'),
  };
}

// ── run-log accumulation (written to .evidence/, gitignored) ─────────────────────────────────────
export const runLog: string[] = [];
export function logLine(s: string): void {
  runLog.push(s);
  process.stdout.write(`${s}\n`);
}

/**
 * Hydrate the FRESH per-regenesis on-chain ids from the host bind-mount into process.env so
 * loadNetworkConfig() reads the LIVE package + registries, NOT the stale committed dvconf-daemons/.env.
 * Mirrors run-consolidated-demo.ts::hydrateOnchainEnv. Also pins SUI_NETWORK to the host-reachable RPC.
 */
export function hydrateOnchainEnv(): void {
  process.env['SUI_NETWORK'] = HOST_RPC_URL; // override the container-internal sui-localnet:9000
  if (!existsSync(ONCHAIN_CONFIG_FILE)) {
    throw new Error(`${MOD}: ${ONCHAIN_CONFIG_FILE} not found — is the consolidated stack booted (--keep-up)?`);
  }
  const ids = JSON.parse(readFileSync(ONCHAIN_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
  let set = 0;
  for (const [k, v] of Object.entries(ids)) {
    if (typeof v === 'string' && v.length > 0) { process.env[k] = v; set += 1; }
  }
  logLine(`[env] hydrated ${set} on-chain ids from ${ONCHAIN_CONFIG_FILE}; RPC=${HOST_RPC_URL}`);
}
