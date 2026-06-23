/**
 * Stage 4 (multi-cp-quorum) — LIVE canary verify-loop seams, flag-gated + additive.
 *
 * The verify-loop (`verify-loop.ts`) is ALREADY fully hermetic-tested with INJECTED deps. Stage 4 is
 * PLUMBING: construct the LIVE `{ submit, coObserverBoards, capture, getRelayRoomScopes }` from env +
 * the Stage-3 artifacts (manifest bundle, daemon keys file, host PEM), then `index.ts` swaps them in
 * behind ONE master flag `CANARY_LIVE_SEAMS_ENABLED`. With the flag UNSET (default) `buildLiveSeams`
 * returns `null` and `index.ts` keeps its EXACT pre-Stage-4 no-op seams — byte-identical vanilla.
 *
 * The three seams mirror the proven hermetic fixtures (`c1-censorship.test.ts` /
 * `verify-loop.test.ts`) and the localnet E2E (`canary-slash-e2e.integration.test.ts`):
 *   4a submit  -> `submitCanarySlash.submit(client, relayKp, proof, opts)` (lazy client; W-E9 self-slash).
 *   4b boards  -> one `HttpClaimBoard` per PEER manifest (operatorPubkey != self) over mTLS.
 *   4c capture -> an INJECTED / CONTROLLED divergence (NOT real media) that promotes a TAMPER (p=1).
 *
 * INVARIANTS (HARD):
 *   - INV-A: `proof.ts` is untouched (145-byte msg / MIN_ATTESTERS=2). This module only CALLS the
 *     verify-loop with live deps; it never re-implements the proof / attestation chain.
 *   - INV-B: NOTHING here touches `apps/relay/**`. The capture is validator-daemon-side only.
 *   - INV-C: the only bytes that ever reach a wire are a Wallet-B `{pubkey,sig}` attestation (carried
 *     by `HttpClaimBoard`, whose schema allow-list rejects everything else fail-closed). This module
 *     NEVER puts `CANARY_CELL_SECRET` nor a Wallet-A<->Wallet-B mapping on a wire — the cellSecret is
 *     used ONLY to recompute the local canary frames inside the verifier (the same way the publisher /
 *     verifier already use it), and is carried THROUGH the in-process capture result, never logged.
 *
 * HONESTY (DA-3, on record): seam 4c is an INJECTED / CONTROLLED divergence so the demo slash path
 * runs end-to-end. The live producer/SFU-forward/consumer media-frame capture stays the INV-B
 * validator-side STRETCH goal (M4b). The W-E9 caveat (relay self-slashes its OWN bond) is on record
 * at the `submit` seam below.
 *
 * LOGGING (HARD-GATE): never log key material / cellSecret. Only non-secret ids/counts.
 */

import { readFileSync } from 'node:fs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiClient } from '@mysten/sui/client';
import {
  createSuiClient,
  createLogger,
  type Logger,
  loadManifests,
  manifestsToTrustedSpki,
  type SignedManifest,
} from '@dvconf/shared';
import {
  type CanaryForwardCapture,
  type CanaryForwardCaptureResult,
  type CanarySlashSubmit,
} from './verify-loop.js';
import type { ClaimBoard } from './claim-board.js';
import { HttpClaimBoard } from './claims-client.js';
import { CanaryPublisher } from './publisher.js';
import { submitCanarySlash, type SlashCallOpts } from './slash-submitter.js';
import type { RelayRoomScope } from './cell.js';

const MOD = 'canary/live-seams';

/** The LIVE deps this helper constructs for `index.ts` to merge into the verify-loop deps literal. */
export interface LiveSeams {
  /** 4a — the live PTB slash submit (relay self-slashes its OWN bond, W-E9). */
  submit: CanarySlashSubmit;
  /** 4b — one `HttpClaimBoard` per PEER manifest (operatorPubkey != self). May be empty if no peers. */
  coObserverBoards: ClaimBoard[];
  /** 4c — the INJECTED / CONTROLLED divergence capture (promotes a TAMPER, p=1). NOT real media. */
  capture: CanaryForwardCapture;
  /** 4c — at least one synthetic `{relayId,roomId}` scope (bare daemon has no `state.activeRooms`). */
  getRelayRoomScopes: () => RelayRoomScope[];
}

/** A keypair + bond id read from the `.scratch-daemon-keys.json` relay entry (W-E9 self-slash). */
interface RelayBondKeys {
  relayKp: Ed25519Keypair;
  relayBondId: string;
  relayMinerId: string;
}

/** Test seam: allow injecting the client factory so the unit test never opens a socket. */
export interface BuildLiveSeamsHooks {
  /** Lazily create the Sui client (defaults to the shared `createSuiClient`). */
  createClient?: (rpcUrl: string) => SuiClient;
  logger?: Logger;
}

/** Truthy iff the master flag is explicitly enabled (`1` / `true`). Default off. */
function isEnabled(env: Record<string, string | undefined>): boolean {
  const v = env['CANARY_LIVE_SEAMS_ENABLED'];
  return v === '1' || v === 'true';
}

function requireEnv(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (v === undefined || v === '') {
    throw new Error(`${MOD}: ${key} is required when CANARY_LIVE_SEAMS_ENABLED is set`);
  }
  return v;
}

/** Load the relay (bondOwner) keypair + stake id from the env-given keys file (NEVER hardcode). */
function loadRelayBondKeys(env: Record<string, string | undefined>): RelayBondKeys {
  const keysPath = requireEnv(env, 'CANARY_DAEMON_KEYS_PATH');
  const parsed = JSON.parse(readFileSync(keysPath, 'utf8')) as {
    relay?: { secretKey?: string; stakeId?: string; minerId?: string };
  };
  const relay = parsed.relay;
  if (!relay?.secretKey || !relay.stakeId || !relay.minerId) {
    throw new Error(`${MOD}: keys file ${keysPath} is missing relay.secretKey/stakeId/minerId`);
  }
  const { secretKey } = decodeSuiPrivateKey(relay.secretKey); // bech32 'suiprivkey1...'
  return {
    relayKp: Ed25519Keypair.fromSecretKey(secretKey),
    relayBondId: relay.stakeId,
    relayMinerId: relay.minerId,
  };
}

/**
 * 4c — the INJECTED / CONTROLLED divergence capture. CONTROLLED (not real media): it reuses the
 * SHIPPED `CanaryPublisher.produce(...)` to build the canonical canary stream from the demo
 * cellSecret, then TAMPERs ONE frame's ciphertext (a byte after the 12-byte RTP header, well before
 * the 14-byte trailer, so the trailer ctr is preserved -> the verifier classifies it a TAMPER, p=1,
 * NOT a drop). The same forwarded set is placed under TWO distinct receiver miner_ids so the
 * SECONDARY >=k=2 breadth correlates (mirrors c1-censorship.test.ts / the E2E `produceRealDivergence`).
 *
 * INV-C: `cellSecret`/`kRoom` are carried THROUGH the capture result for the verifier to re-derive
 * K_canary locally — exactly as the existing hermetic capture does — and are NEVER put on a wire here.
 */
function buildInjectedCapture(opts: {
  kRoom: Uint8Array;
  cellSecret: Uint8Array;
  canaryKid: number;
  ctrs: number[];
  tamperCtr: number;
  receiverA: string;
  receiverB: string;
}): CanaryForwardCapture {
  const RTP_HEADER = 12;
  const wrapAsRtp = (body: Uint8Array): Buffer => {
    const header = Buffer.alloc(RTP_HEADER);
    header[0] = 0x80; // V=2
    header[1] = 96; // dynamic PT
    return Buffer.concat([header, Buffer.from(body)]);
  };

  return async (scope: RelayRoomScope): Promise<CanaryForwardCaptureResult> => {
    const publisher = new CanaryPublisher();
    const frames = await publisher.produce({
      kRoom: opts.kRoom,
      roomId: scope.roomId,
      cellSecret: opts.cellSecret,
      canaryKid: opts.canaryKid,
      ctrs: opts.ctrs,
    });
    const wire: Buffer[] = frames.map((f, i) => {
      const pkt = wrapAsRtp(f);
      if (opts.ctrs[i] === opts.tamperCtr) {
        // Flip a ciphertext byte AFTER the RTP header + BEFORE the trailer -> present-but-different
        // (TAMPER, p=1), not a drop. Mirrors canary-slash-e2e.integration.test.ts.
        const flipAt = RTP_HEADER + 4;
        pkt[flipAt] = pkt[flipAt]! ^ 0xff;
      }
      return pkt;
    });
    return {
      relayId: scope.relayId,
      roomId: scope.roomId,
      canaryKid: opts.canaryKid,
      expectedCtrs: opts.ctrs,
      kRoom: opts.kRoom,
      cellSecret: opts.cellSecret,
      // SAME forwarded set under two DISTINCT receiver miner_ids -> SECONDARY >=k=2 breadth.
      perReceiver: new Map([
        [opts.receiverA, wire],
        [opts.receiverB, wire.map((p) => Buffer.from(p))],
      ]),
    };
  };
}

/**
 * 4b — build one `HttpClaimBoard` per PEER manifest (operatorPubkey != self) from the OOB manifest
 * bundle, over mTLS. `trustedServerSpki` = the 2-entry set distilled from the bundle. The client
 * PRESENTS this host's own cert/key (the peer pins it). `baseUrl` is env-overridable per peer
 * (`CANARY_COOBSERVER_<n>_URL`) so an SSH-tunnelled localhost works (SPKI pin is address-agnostic).
 */
async function buildCoObserverBoards(
  env: Record<string, string | undefined>,
  log: Logger,
): Promise<ClaimBoard[]> {
  const bundlePath = requireEnv(env, 'CANARY_MANIFEST_BUNDLE_PATH');
  const selfPubkey = requireEnv(env, 'CANARY_SELF_OPERATOR_PUBKEY');
  const token = requireEnv(env, 'CANARY_CLAIMS_AUTH_TOKEN');
  const cert = readFileSync(requireEnv(env, 'CANARY_TLS_CERT_PATH'), 'utf8');
  const key = readFileSync(requireEnv(env, 'CANARY_TLS_KEY_PATH'), 'utf8');

  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as SignedManifest[];
  const manifests = await loadManifests(bundle);
  const trustedServerSpki = manifestsToTrustedSpki(manifests);

  const boards: ClaimBoard[] = [];
  let n = 0;
  for (const m of manifests.values()) {
    if (m.operatorPubkey === selfPubkey) continue; // skip self
    n += 1;
    const override = env[`CANARY_COOBSERVER_${n}_URL`];
    const baseUrl = override ?? `https://${m.boardEndpoint}`;
    boards.push(
      new HttpClaimBoard({ baseUrl, token, tls: { cert, key, trustedServerSpki } }),
    );
    log.info({ module: MOD, peerEndpoint: m.boardEndpoint, baseUrl }, 'co-observer HttpClaimBoard wired');
  }
  return boards;
}

/**
 * Build the LIVE verify-loop seams from env + the Stage-3 artifacts, or `null` when the master flag
 * `CANARY_LIVE_SEAMS_ENABLED` is unset/false (the no-op seams stay byte-identical vanilla).
 */
export async function buildLiveSeams(
  env: Record<string, string | undefined> = process.env,
  hooks: BuildLiveSeamsHooks = {},
): Promise<LiveSeams | null> {
  if (!isEnabled(env)) return null;

  const log = hooks.logger ?? createLogger(MOD);

  // 4a inputs — registry ids + the relay (bondOwner) keys (W-E9 self-slash).
  const slashOpts: SlashCallOpts = {
    packageId: requireEnv(env, 'PACKAGE_ID'),
    netReg: requireEnv(env, 'NETWORK_REGISTRY_ID'),
    validatorReg: requireEnv(env, 'VALIDATOR_REGISTRY_ID'),
    roomMgr: requireEnv(env, 'ROOM_MANAGER_ID'),
    relayBondId: '', // filled from the keys file below
  };
  const bond = loadRelayBondKeys(env);
  slashOpts.relayBondId = bond.relayBondId;

  const rpcUrl = requireEnv(env, 'SUI_RPC_URL');
  const makeClient = hooks.createClient ?? createSuiClient;
  // Lazy single client — created on FIRST submit only (so construction opens no socket).
  let client: SuiClient | undefined;

  // 4a submit. W-E9 HONESTY CAVEAT (on record): `relay_bond` is the relay's OWNED `&mut
  // StakePosition` -> a PTB can pass an owned object only as its OWNER -> the slash tx MUST be signed
  // by the relay (the bond owner). For the demo the relay SELF-SLASHES (we hold the relay key). A
  // validator CANNOT slash another's owned bond without the owner; a protocol-controlled bond is
  // post-thesis (W-E9 limitation). So bondOwner = the relay keypair, relayBondId = the relay's stakeId.
  const submit: CanarySlashSubmit = async (proof) => {
    if (!client) client = makeClient(rpcUrl);
    await submitCanarySlash.submit(client, bond.relayKp, proof, slashOpts, log);
  };

  // 4b co-observer boards (mTLS, one per peer).
  const coObserverBoards = await buildCoObserverBoards(env, log);

  // 4c injected capture + synthetic scope.
  const cellSecret = Buffer.from(requireEnv(env, 'CANARY_CELL_SECRET'), 'hex');
  const canaryKid = parseInt(env['CANARY_DEMO_CANARY_KID'] ?? '7', 10);
  const relayMinerId = env['CANARY_DEMO_RELAY_MINER_ID'] ?? bond.relayMinerId;
  const roomId = requireEnv(env, 'CANARY_DEMO_ROOM_ID');
  // A short canonical ctr window; tamper the middle frame (mirrors the E2E TAMPER_CTR=2).
  const ctrs = [0, 1, 2, 3, 4];
  const tamperCtr = 2;
  // kRoom is NOT a secret on the wire here — it is an in-process verifier re-derivation factor
  // (carried through the capture result exactly like cellSecret). Demo-fixed 32 bytes.
  const kRoom = new Uint8Array(32).fill(0xab);

  const capture = buildInjectedCapture({
    kRoom,
    cellSecret: new Uint8Array(cellSecret),
    canaryKid,
    ctrs,
    tamperCtr,
    receiverA: `${relayMinerId}-rx-a`,
    receiverB: `${relayMinerId}-rx-b`,
  });

  const getRelayRoomScopes = (): RelayRoomScope[] => [{ relayId: relayMinerId, roomId }];

  log.info(
    { module: MOD, peers: coObserverBoards.length, relayMinerId, roomId, canaryKid },
    'live canary seams constructed (INJECTED/CONTROLLED divergence — NOT real media; W-E9 self-slash)',
  );

  return { submit, coObserverBoards, capture, getRelayRoomScopes };
}
