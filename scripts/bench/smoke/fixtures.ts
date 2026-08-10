/**
 * On-chain bench fixtures — extracted from run-smoke.ts (S25.B/C.3/C.5
 * split). Owns everything that turns a fresh localnet + published package
 * into a ready bench scenario: the 5 admin-gated registries, the 3 daemon
 * keypairs (funded + minted), the assembled `dvconf-daemons/.env`, user
 * registration, room creation, and the N-run scenario driver.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import { createGraphQLClient, fetchEventsForDigest } from '../../../packages/shared/src/index.ts';
import {
  buildEnvContent,
  parseSharedObjectFromCreate,
  parseRoomIdFromEvents,
  type BenchIds,
  type DaemonKeys,
  type PublishOutput,
  type SuiObjectChange,
  type SuiTxResult,
} from './parsers.ts';
import {
  DAEMONS_DIR,
  LOGS_DIR,
  SUI_RPC_URL,
  FAUCET_URL,
  runCli,
  spawnSuiNode,
  waitForSuiRpc,
  setupSuiClient,
  publishPackage,
  loadActiveSigner,
  type SuiNodeHandle,
} from './sui-node.ts';

// ── Registry creation (S25.B) ───────────────────────────────────────────

/** 5 registries that need an explicit `<module>::create(adminCap)` PTB call. */
const REGISTRY_SPEC = [
  { module: 'user_registry', structName: 'UserRegistry', key: 'userRegistryId' },
  { module: 'room_manager', structName: 'RoomManager', key: 'roomManagerId' },
  { module: 'relay_registry', structName: 'RelayRegistry', key: 'relayRegistryId' },
  {
    module: 'control_plane_registry',
    structName: 'ControlPlaneRegistry',
    key: 'cpRegistryId',
  },
  {
    module: 'validator_registry',
    structName: 'ValidatorRegistry',
    key: 'validatorRegistryId',
  },
] as const;

type RegistryKey =
  | 'userRegistryId'
  | 'roomManagerId'
  | 'relayRegistryId'
  | 'cpRegistryId'
  | 'validatorRegistryId';

/**
 * Sequentially create the 5 admin-gated shared registries. SDK PTBs +
 * showObjectChanges → parseSharedObjectFromCreate. One TX per registry keeps
 * failure diagnosis simple (one bad TX → one named bad registry).
 */
export async function createRegistries(
  client: SuiClient,
  signer: Ed25519Keypair,
  packageId: string,
  adminCapId: string,
): Promise<Record<RegistryKey, string>> {
  const out = {} as Record<RegistryKey, string>;
  for (const spec of REGISTRY_SPEC) {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::${spec.module}::create`,
      arguments: [tx.object(adminCapId)],
    });
    tx.setGasBudget(100_000_000);
    const result = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: result.digest });
    out[spec.key] = parseSharedObjectFromCreate(
      { objectChanges: (result.objectChanges ?? []) as SuiObjectChange[] },
      spec.structName,
    );
  }
  return out;
}

export interface DaemonIdentity {
  keys: DaemonKeys;
  addresses: Record<keyof DaemonKeys, string>;
}

/**
 * Generate the 3 daemon Ed25519 keypairs via the SDK (no sui keytool round-trip).
 * Each emits the bech32 `suiprivkey…` form that the daemon .env files expect.
 */
export function generateDaemonKeypairs(): DaemonIdentity {
  const names: (keyof DaemonKeys)[] = [
    'CP_KEYPAIR',
    'SUI_PRIVATE_KEY',
    'PRIVATE_KEY',
  ];
  const keys = {} as DaemonKeys;
  const addresses = {} as Record<keyof DaemonKeys, string>;
  for (const name of names) {
    const kp = Ed25519Keypair.generate();
    keys[name] = kp.getSecretKey();
    addresses[name] = kp.getPublicKey().toSuiAddress();
  }
  return { keys, addresses };
}

/** Faucet-fund each address. Sequential to avoid the localnet faucet rate limit. */
export async function fundAddresses(addresses: string[]): Promise<void> {
  for (const addr of addresses) {
    await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: addr });
    // Localnet faucet is single-threaded; back off briefly between requests.
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Per-daemon DVCONF mint amounts (mirror run-local.ps1 Mint-DVCONF table). */
const MINT_AMOUNTS: Record<keyof DaemonKeys, bigint> = {
  CP_KEYPAIR: 3_000_000_000n, // 3 DVCONF (CP stake = 2 DVCONF)
  SUI_PRIVATE_KEY: 1_000_000_000n, // 1 DVCONF (validator stake = 0.5)
  PRIVATE_KEY: 2_000_000_000n, // 2 DVCONF (relay stake = 1)
};

/**
 * Mint DVCONF tokens to each daemon address via PTB `token::mint`.
 * One TX per recipient (matches PS layout — easier failure attribution).
 */
export async function mintDvconfTokens(
  client: SuiClient,
  signer: Ed25519Keypair,
  packageId: string,
  treasuryCapId: string,
  recipients: Record<keyof DaemonKeys, string>,
): Promise<void> {
  for (const [name, addr] of Object.entries(recipients) as [
    keyof DaemonKeys,
    string,
  ][]) {
    const amount = MINT_AMOUNTS[name];
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::token::mint`,
      arguments: [
        tx.object(treasuryCapId),
        tx.pure.u64(amount),
        tx.pure.address(addr),
      ],
    });
    tx.setGasBudget(100_000_000);
    const result = await client.signAndExecuteTransaction({
      signer,
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: result.digest });
  }
}

/**
 * Full Phase-1 bring-up: spawn Sui, publish package, create the 6
 * AdminCap-gated registries, generate + fund the 3 daemon keypairs, mint
 * DVCONF, write `dvconf-daemons/.env`. Returns the assembled bench identity
 * bundle so Phase 2 (daemon spawn + room create) can chain off it.
 */
export interface BenchBringupResult {
  ids: BenchIds;
  identity: DaemonIdentity;
  publishOut: PublishOutput;
  sui: SuiNodeHandle;
  client: SuiClient;
  deployer: Ed25519Keypair;
}

export async function bringUpBench(opts: {
  reuseRunning?: boolean;
} = {}): Promise<BenchBringupResult> {
  mkdirSync(LOGS_DIR, { recursive: true });

  let sui: SuiNodeHandle;
  if (opts.reuseRunning === true) {
    // Caller asserts a sui node is already running; we don't manage lifecycle.
    sui = {
      proc: null as unknown as SuiNodeHandle['proc'],
      stop: () => Promise.resolve(),
    };
  } else {
    console.log('[bench] spawning sui localnet...');
    sui = spawnSuiNode(join(LOGS_DIR, 'sui-localnet.log'));
    await waitForSuiRpc();
    console.log('[bench] sui RPC ready at', SUI_RPC_URL);
  }

  console.log('[bench] setting up sui client env...');
  await setupSuiClient();

  console.log('[bench] publishing package (test-publish, ~30-60s)...');
  const publishOut = await publishPackage();
  console.log('[bench] package:', publishOut.packageId);

  const deployer = await loadActiveSigner();
  const client = new SuiClient({ url: SUI_RPC_URL });

  console.log('[bench] creating 6 admin-gated registries...');
  const registries = await createRegistries(
    client,
    deployer,
    publishOut.packageId,
    publishOut.adminCapId,
  );

  console.log('[bench] generating 3 daemon keypairs...');
  const identity = generateDaemonKeypairs();
  console.log('[bench] funding daemon addresses...');
  await fundAddresses(Object.values(identity.addresses));

  console.log('[bench] minting DVCONF to daemons...');
  await mintDvconfTokens(
    client,
    deployer,
    publishOut.packageId,
    publishOut.treasuryCapId,
    identity.addresses,
  );

  const ids: BenchIds = {
    packageId: publishOut.packageId,
    networkRegistryId: publishOut.networkRegistryId,
    minerStoreId: publishOut.minerStoreId,
    roleVoteBoxId: publishOut.roleVoteBoxId,
    livenessVoteBoxId: publishOut.livenessVoteBoxId,
    ...registries,
  };

  const envPath = join(DAEMONS_DIR, '.env');
  writeFileSync(
    envPath,
    buildEnvContent(ids, identity.keys, {
      MEASUREMENT_INTERVAL_MS: '10000',
      ROLE_VOTING_INTERVAL_MS: '5000',
      POLL_INTERVAL_MS: '3000',
      REGISTRATION_MODE: 'voting',
    }),
  );
  console.log('[bench] wrote', envPath);

  return { ids, identity, publishOut, sui, client, deployer };
}

// ── Room creation (S25.C.3) ───────────────────────────────────────────

/** user_registry::E_ALREADY_REGISTERED — idempotency check on second bring-up. */
const E_USER_ALREADY_REGISTERED = 540;

/**
 * Best-effort `user_registry::register_user`. Swallows the E_ALREADY_REGISTERED
 * abort (code 540) — bench may re-run against an existing localnet (--reuse-running)
 * where the deployer is already in `UserRegistry`. Any other failure rethrows.
 */
export async function ensureUserRegistered(
  sui: SuiClient,
  signer: Ed25519Keypair,
  ids: BenchIds,
  displayName = 'bench-deployer',
): Promise<void> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${ids.packageId}::user_registry::register_user`,
    arguments: [
      tx.object(ids.networkRegistryId),
      tx.object(ids.userRegistryId),
      tx.pure.vector('u8', Array.from(new TextEncoder().encode(displayName))),
    ],
  });
  try {
    const result = await sui.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true },
    });
    // CI-14: without waitForTransaction, the next call's dry-run can
    // execute against pre-register state and abort with E_USER_NOT_REGISTERED.
    await sui.waitForTransaction({ digest: result.digest });
    console.log('[bench] registered deployer in UserRegistry');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(`abort_code: ${E_USER_ALREADY_REGISTERED}`) || msg.includes(`, ${E_USER_ALREADY_REGISTERED})`)) {
      console.log('[bench] deployer already registered in UserRegistry (idempotent)');
      return;
    }
    throw err;
  }
}

/**
 * Build + execute the `room_manager::create_room` PTB and pluck `room_id` out
 * of the `RoomCreated` event. Default is SFU mode (relay_mode=0) with 4
 * expected participants — matches the bench scenario in `mediasoup-client-harness.ts`.
 *
 * The Move side stores the Room in `RoomManager`'s internal table rather than
 * minting a shared object, so we can't use `parseSharedObjectFromCreate`. The
 * event carries the room ID — see `parseRoomIdFromEvents`.
 */
export async function createBenchRoom(
  sui: SuiClient,
  signer: Ed25519Keypair,
  ids: BenchIds,
  opts: { relayMode?: 'sfu' | 'mcu'; expectedParticipants?: number } = {},
): Promise<string> {
  const mode = opts.relayMode === 'mcu' ? 1 : 0;
  const expected = opts.expectedParticipants ?? 4;

  const tx = new Transaction();
  tx.moveCall({
    target: `${ids.packageId}::room_manager::create_room`,
    arguments: [
      tx.object(ids.networkRegistryId),
      tx.object(ids.roomManagerId),
      tx.object(ids.userRegistryId),
      tx.pure.u8(mode),
      tx.pure.u64(expected),
      tx.pure.u8(0), // room_class_hint = small (NEW REQ-RMS-016)
    ],
  });

  const result = await sui.signAndExecuteTransaction({
    transaction: tx,
    signer,
    options: { showEvents: true, showEffects: true },
  });
  await sui.waitForTransaction({ digest: result.digest });

  // devnet's public fullnode returns empty `events` on the JSON-RPC execute
  // response (event-shaped reads are deprecated there); harmless no-op on
  // localnet (bench's usual target), where JSON-RPC events already work.
  let events = result.events ?? [];
  if (events.length === 0) {
    const graphqlClient: SuiGraphQLClient = createGraphQLClient('localnet');
    events = await fetchEventsForDigest(graphqlClient, result.digest);
  }

  const roomId = parseRoomIdFromEvents(
    { events } as SuiTxResult,
    '::room_manager::RoomCreated',
  );
  console.log(`[bench] created bench room id=${roomId} mode=${opts.relayMode ?? 'sfu'} expected=${expected}`);
  return roomId;
}

// ── Scenario runner (S25.C.5) ─────────────────────────────────────────

export interface BenchScenarioOpts {
  /** dvconf-daemons working directory (cwd for harness spawn). */
  daemonsDir: string;
  /** On-chain room ID from createBenchRoom. */
  roomId: string;
  /** Peer count per run — passed to harness as --peers. */
  peers: number;
  /** How many times to run the scenario. */
  runs: number;
  /** Per-run capture duration in seconds (passed as --duration). */
  durationSec: number;
  /** Quiet period between runs so the relay can close stale transports. */
  cooldownMs?: number;
  /** Extra env vars (e.g. BENCH_LATENCY=1, BENCH_TRACE_ID). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Sequentially execute `runs` copies of the N-peer harness against the bench
 * room. Each run is a fresh `tsx mediasoup-client-harness.ts` child process
 * with its own JSONL trace file (LatencyWriter generates a UUID per process).
 *
 * Failure of one run is logged but does not abort the loop — bench wants a
 * sample set, not a fail-fast pipeline. Per-run hard timeout =
 * `(durationSec + 30) * 1000` covers join + close overhead.
 */
export async function runBenchScenario(opts: BenchScenarioOpts): Promise<void> {
  const cooldown = opts.cooldownMs ?? 5_000;
  const perRunBudgetMs = (opts.durationSec + 30) * 1000;
  const harnessEntry = join('scripts', 'bench', 'mediasoup-client-harness.ts');

  for (let i = 1; i <= opts.runs; i++) {
    console.log(
      `[bench] scenario run ${i}/${opts.runs} — peers=${opts.peers} duration=${opts.durationSec}s`,
    );
    const startedAt = Date.now();
    const result = await runCli(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        harnessEntry,
        '--room-id',
        opts.roomId,
        '--peers',
        String(opts.peers),
        '--duration',
        String(opts.durationSec),
      ],
      {
        cwd: opts.daemonsDir,
        timeoutMs: perRunBudgetMs,
        env: { ...process.env, ...opts.env, BENCH_LATENCY: '1' },
      },
    );
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    // Treat as success if the harness logged `[harness] done` (data was
    // flushed) regardless of exit code — the harness deliberately SIGKILLs
    // itself after flushing JSONL to skip the @roamhq/wrtc native cleanup
    // crash on Windows (CI-19 mitigation, see harness main()).
    const harnessDone = result.stdout.includes('[harness] done');
    if (result.code === 0 || harnessDone) {
      const exitNote = result.code === 0 ? '' : ` (exit=${result.code}, data flushed)`;
      console.log(`[bench] scenario run ${i} done in ${elapsed}s${exitNote}`);
    } else {
      console.error(
        `[bench] scenario run ${i} FAILED (code=${result.code}, elapsed=${elapsed}s)`,
      );
      console.error('[bench] ── full stderr ──');
      console.error(result.stderr);
      console.error('[bench] ── full stdout (tail 30) ──');
      console.error(result.stdout.split('\n').slice(-30).join('\n'));
    }

    if (i < opts.runs) {
      console.log(`[bench] cooldown ${cooldown}ms before next run`);
      await new Promise((r) => setTimeout(r, cooldown));
    }
  }
}
