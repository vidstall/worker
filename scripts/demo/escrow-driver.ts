/**
 * Multi-CP Voting Live (N=5) — Phase C (GĐ2) Task C2: the transient escrow driver.
 *
 * WHY THIS SCRIPT EXISTS (design spec §C): the live multi-CP pairing vote (#7) is
 * triggered EXCLUSIVELY by the on-chain `EscrowCreated` event. The cp-daemons'
 * `EscrowCreated` handler (apps/cp-daemon/src/.../event-handler.ts) is the ONLY arm
 * that fires `submitProposal` → the genuine 4-of-5 pairing quorum. `RoomCreated`
 * alone just stashes the room and does NOT start a proposal. So to make the 5 seeded
 * daemons run a REAL pairing vote we must reach the chain through:
 *
 *     register_user → create_room → create_escrow
 *
 * NOT through the AdminCap `assign_relay_and_signaling` path (sibling
 * provision-room.ts / shared `createRoomWithRelay`) — that BYPASSES the CP vote and
 * is the WRONG path for this demo. We therefore deliberately do NOT import
 * `createRoomWithRelay`; we reuse only the generic `signAndAssert` building block.
 *
 * IDEMPOTENCY / FAILURE SURFACING (plan §5): `executeWithRetry` (load-test.ts's
 * helper) does NOT check `effects.status` and blindly retries any thrown error 5× —
 * so it would either loop on a deterministic Move abort or silently swallow a real
 * failure. We instead use shared `signAndAssert` (single attempt; asserts
 * status==success; throws the abort string on failure), and tolerate ONLY abort 540
 * (user_registry::E_ALREADY_REGISTERED, user_registry.move:11) on register_user —
 * any other abort/error still surfaces loud. A fresh per-run user normally never
 * hits 540; the guard is defence-in-depth.
 *
 * SCOPE: connects to an ALREADY-RUNNING localnet with the `multi-cp-live` package
 * published (loadNetworkConfig reads PACKAGE_ID + *_REGISTRY_ID / … from the env
 * exported by read-publish-output.sh). It does NOT boot `sui start`, publish, or
 * spawn daemons. It is a thin, transient, single-shot driver (KISS).
 *
 * Run (from the worktree root, against a staged localnet on :9000):
 *   pnpm exec tsx scripts/demo/escrow-driver.ts
 *
 * Env: FAUCET_URL / SUI_NETWORK / the published *_OBJECT_ID set — same levers as
 * seed-multicp.ts / seed-bootstrap.ts.
 *
 * STDOUT CONTRACT (for the C3 launcher): on success the created room id is written
 * as a single delimited line `ROOM_ID=0x…` (mirrors provision-room.ts:85). pino
 * logs ALSO go to stdout (logger.ts default), so the launcher must parse the room id
 * with the anchored regex /^ROOM_ID=(\S+)$/m — not by reading the whole stream.
 *
 * Fails LOUD: any failed TX, insufficient funding, or a non-540 abort throws; an
 * uncaught throw in main() exits non-zero so the controller can gate on it.
 *
 * Structured logging only (shared pino Logger). No console.log (the ROOM_ID line is
 * the single raw stdout contract).
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import {
  createSuiClient,
  createGraphQLClient,
  createLogger,
  loadNetworkConfig,
  signAndAssert,
  extractRoomId,
  type NetworkConfig,
  type Logger,
} from '../../packages/shared/src/index.ts'; // relative SOURCE import — scripts/ sits OUTSIDE the pnpm workspace graph, so the '@dvconf/shared' bare specifier is unresolvable from root (mirrors seed-multicp.ts:56 / provision-room.ts:24).

const MODULE = 'escrow-driver';

/** Faucet endpoint — same lever as provision-room.ts:26. */
const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');

/** 1 SUI escrow (mirrors load-test.ts:133 createEscrow). */
const ESCROW_AMOUNT_MIST = 1_000_000_000n;

/**
 * Minimum balance the fresh user needs before driving the chain: the 1 SUI escrow
 * + 3 txs × signAndAssert's 0.1 SUI gas budget (provision-room.ts:15) + headroom.
 * A single localnet faucet drip (≫ this) normally clears it in one shot; we drip up
 * to twice and HARD-FAIL if still short.
 */
const MIN_BALANCE_MIST = 1_500_000_000n;
const MAX_FAUCET_DRIPS = 2;
const FAUCET_SETTLE_MS = 1_500; // let the faucet tx settle before reading balance (mirrors createRoomWithRelay:80).

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Extract the Move abort code from a thrown error / signAndAssert failure message.
 * signAndAssert embeds `effects.status.error` ("MoveAbort(MoveLocation { … }, <code>)
 * in command N"); the SDK's own execution-failure throws carry the same substring.
 * Returns the trailing abort code, or null when no MoveAbort is present.
 */
export function extractMoveAbortCode(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/MoveAbort\(.*,\s*(\d+)\)/s); // greedy → the final `, <code>)`.
  return m ? Number(m[1]) : null;
}

/** Faucet the fresh user until it holds >= MIN_BALANCE_MIST; throw loud if it can't. */
async function fundUntilSufficient(client: SuiClient, address: string, logger: Logger): Promise<void> {
  let balance = 0n;
  for (let drip = 1; drip <= MAX_FAUCET_DRIPS; drip++) {
    await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
    await sleep(FAUCET_SETTLE_MS);
    balance = BigInt((await client.getBalance({ owner: address })).totalBalance);
    logger.info(
      { module: MODULE, action: 'fund', context: { address, drip, balance: balance.toString() } },
      'faucet drip settled',
    );
    if (balance >= MIN_BALANCE_MIST) return;
  }
  throw new Error(
    `escrow-driver: user ${address} underfunded after ${MAX_FAUCET_DRIPS} faucet drips ` +
      `(${balance} < ${MIN_BALANCE_MIST} MIST)`,
  );
}

/**
 * register_user (user_registry.move:63 — 3 args: net_reg, registry, display_name).
 * Idempotent: tolerate abort 540 (E_ALREADY_REGISTERED) as success; any other
 * abort/error still throws.
 */
async function registerUserIdempotent(
  client: SuiClient,
  userKp: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  try {
    await signAndAssert(
      client,
      userKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::user_registry::register_user`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.userRegistryId),
            tx.pure.vector('u8', [99]), // display_name (mirror createRoomWithRelay → provision-room.ts:85).
          ],
        });
      },
      'register_user',
      logger,
    );
  } catch (err) {
    if (extractMoveAbortCode(err) === 540) {
      logger.info(
        { module: MODULE, action: 'register_user', context: { abort: 540 } },
        'register_user already registered (abort 540) — treating as success (idempotent)',
      );
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  // Same wiring as seed-multicp.ts main(): loadNetworkConfig() reads PACKAGE_ID + all
  // *_REGISTRY_ID from env and derives config.rpcUrl from SUI_NETWORK.
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  // Event queries only (RoomCreated lookup below) -- devnet's public
  // fullnode returns empty `events` on JSON-RPC execute responses.
  const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');

  // Fresh, single-use user per run (mirrors provision-room.ts:70). The SAME user must
  // create both the room and the escrow — create_escrow asserts room_creator ==
  // sender (economic_layer.move:158, E_NOT_ROOM_CREATOR).
  const userKp = new Ed25519Keypair();
  const userAddress = userKp.getPublicKey().toSuiAddress();

  logger.info(
    { module: MODULE, action: 'start', context: { rpcUrl: config.rpcUrl, packageId: config.packageId, userAddress } },
    'escrow-driver starting (register_user → create_room → create_escrow → EscrowCreated → CP pairing vote)',
  );

  // 1. Fund the fresh user (gas for 3 txs + the 1 SUI escrow).
  await fundUntilSufficient(client, userAddress, logger);

  // 2. register_user (idempotent — tolerate 540).
  await registerUserIdempotent(client, userKp, config, logger);

  // 3. create_room (room_manager.move:247; SFU, expected_participants=4 → required_validators<=4,
  //    room_class_hint=0). Returns the RoomCreated event's room_id.
  const roomResult = await signAndAssert(
    client,
    userKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(config.userRegistryId),
          tx.pure.u8(0), // relay_mode SFU
          tx.pure.u64(4), // expected_participants = 4
          tx.pure.u8(0), // room_class_hint = small
        ],
      });
    },
    'create_room',
    logger,
    graphqlClient,
  );
  const roomId = extractRoomId(roomResult);
  logger.info({ module: MODULE, action: 'create_room', context: { roomId } }, 'room created');

  // 4. create_escrow (economic_layer.move:147; net_reg, room_mgr, room_id: ID, payment: Coin<SUI>).
  //    Emits EscrowCreated → the cp-daemons' handler fires submitProposal (the live pairing vote #7).
  await signAndAssert(
    client,
    userKp,
    (tx) => {
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(ESCROW_AMOUNT_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::economic_layer::create_escrow`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.pure.id(roomId), // room_id: ID — BCS-identical to address, matches provision-room.ts:111-113.
          payment!,
        ],
      });
    },
    'create_escrow',
    logger,
  );
  logger.info(
    { module: MODULE, action: 'create_escrow', context: { roomId, amount: ESCROW_AMOUNT_MIST.toString() } },
    'escrow created — EscrowCreated emitted; CP pairing vote should now fire',
  );

  // 5. STDOUT CONTRACT: emit the room id for the C3 launcher (parse via /^ROOM_ID=(\S+)$/m).
  process.stdout.write(`\nROOM_ID=${roomId}\n`);
}

// Run only when invoked directly so a future unit test can import the pure helpers
// without triggering a live run (mirrors provision-room.ts:91 / seed-multicp.ts).
if (process.argv[1]?.endsWith('escrow-driver.ts')) {
  main().catch((err) => {
    // Fail LOUD: a non-zero exit lets the controller's live run gate on this one-shot.
    process.stderr.write(`escrow-driver: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
