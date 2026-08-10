/**
 * CLI argument parsing + ICE server construction for the mediasoup-client
 * bench harness. Split out of `mediasoup-client-harness.ts` — see that
 * file's header for the harness-wide module layout notes.
 */

const DEFAULT_RELAY_URL = 'ws://localhost:4000';
const DEFAULT_DURATION_S = 60;
const DEFAULT_PEERS = 2;
const MAX_PEERS = 26; // letter-based peer IDs (A..Z)

/**
 * Public Google STUN endpoint — the canonical free probe used by browsers
 * + reference clients to learn server-reflexive candidates. Selected over
 * Mozilla/Cloudflare because Google's anycast has the lowest RTT from APAC
 * and is the de-facto example in WebRTC docs ([[ch2-01-webrtc-primer]] § ICE).
 */
export const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';

export type IceMode = 'none' | 'stun' | 'turn';
const VALID_ICE_MODES: readonly IceMode[] = ['none', 'stun', 'turn'];

export interface CliArgs {
  relayUrl: string;
  roomId: string;
  durationMs: number;
  peers: number;
  iceMode: IceMode;
}

/**
 * Build a mediasoup-compatible `iceServers` array for the chosen network
 * mode. Phase I of [[internet-benchmark-plan]] threads STUN-only through
 * the harness so the pipeline survives real NAT without TURN deployment;
 * Phase II adds TURN once ADR-0005 credential issuance is wired.
 *
 * - `none` (default) → `[]`, the pre-S28 localhost behaviour. ICE uses
 *   host candidates only; works on loopback + LAN.
 * - `stun` → `[{ urls: [DEFAULT_STUN_URL] }]`. Adds srflx candidates so
 *   peers behind cone NATs can connect directly.
 * - `turn` → `[stun, turn]`. Last-resort relay path for symmetric NAT or
 *   UDP-blocked firewalls. TURN config is env-driven, not flag-driven,
 *   because credentials are short-lived secrets (ADR-0005 § TTL = 20 min).
 *
 * Note: this helper validates env presence but does NOT verify the
 * HMAC-SHA1 signature against coturn's `static-auth-secret`. That contract
 * is exercised end-to-end in S30 Phase II once `cp-daemon/turn-issuer.ts`
 * is wired.
 */
export interface BuildIceServersOpts {
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
}

export function buildIceServers(
  mode: IceMode,
  opts: BuildIceServersOpts = {},
): Array<{ urls: string[]; username?: string; credential?: string }> {
  if (mode === 'none') return [];
  const stun = { urls: [DEFAULT_STUN_URL] };
  if (mode === 'stun') return [stun];
  // mode === 'turn'
  const { turnUrl, turnUsername, turnCredential } = opts;
  if (turnUrl === undefined || turnUrl === '') {
    throw new Error(
      '--ice-mode turn requires BENCH_TURN_URL env (e.g. turn:relay.example.com:3478?transport=udp)',
    );
  }
  if (turnUsername === undefined || turnUsername === '') {
    throw new Error(
      '--ice-mode turn requires BENCH_TURN_USERNAME env (HMAC-SHA1 username, typically "<unix-ts>:<userId>")',
    );
  }
  if (turnCredential === undefined || turnCredential === '') {
    throw new Error(
      '--ice-mode turn requires BENCH_TURN_CREDENTIAL env (base64-encoded HMAC-SHA1 of username with static-auth-secret)',
    );
  }
  return [
    stun,
    { urls: [turnUrl], username: turnUsername, credential: turnCredential },
  ];
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let relayUrl = DEFAULT_RELAY_URL;
  let roomId = `bench-${Date.now()}`;
  let durationMs = DEFAULT_DURATION_S * 1000;
  let peers = DEFAULT_PEERS;
  let iceMode: IceMode = 'none';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--relay-url') {
      relayUrl = args[++i] ?? relayUrl;
    } else if (a === '--room-id') {
      roomId = args[++i] ?? roomId;
    } else if (a === '--duration') {
      const d = args[++i];
      if (d !== undefined) durationMs = Math.round(parseFloat(d) * 1000);
    } else if (a === '--peers') {
      const n = args[++i];
      if (n !== undefined) {
        const parsed = parseInt(n, 10);
        if (Number.isFinite(parsed) && parsed >= 2 && parsed <= MAX_PEERS) {
          peers = parsed;
        } else {
          throw new Error(
            `--peers must be an integer in [2, ${MAX_PEERS}], got ${n}`,
          );
        }
      }
    } else if (a === '--ice-mode') {
      const m = args[++i];
      if (m !== undefined) {
        if ((VALID_ICE_MODES as readonly string[]).includes(m)) {
          iceMode = m as IceMode;
        } else {
          throw new Error(
            `--ice-mode must be one of ${VALID_ICE_MODES.join('|')}, got ${m}`,
          );
        }
      }
    }
  }
  return { relayUrl, roomId, durationMs, peers, iceMode };
}

/** Map peer index (0-based) to a stable label: A..Z. */
export function peerLabel(index: number): string {
  if (index < 0 || index >= MAX_PEERS) {
    throw new Error(`peerLabel: index ${index} out of range [0, ${MAX_PEERS})`);
  }
  return String.fromCharCode('A'.charCodeAt(0) + index);
}
