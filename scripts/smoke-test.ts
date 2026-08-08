/**
 * Smoke test: lightweight E2E flow for DVConf session lifecycle.
 *
 * Tests: user registration -> room creation -> escrow -> CP assignment ->
 * relay WebSocket connect -> join + routerRtpCapabilities -> room close.
 *
 * Usage:
 *   pnpm smoke-test
 *
 * Requires: local network running with deployed contracts + daemons.
 */

import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import WebSocket from 'ws';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  executeWithRetry,
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';

// ── Result tracking ─────────────────────────────────────────────────

interface StepResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: StepResult[] = [];

function pass(name: string, detail = '') {
  results.push({ name, passed: true, detail });
  console.log(`[PASS] ${name}${detail ? ` (${detail})` : ''}`);
}

function fail(name: string, detail = '') {
  results.push({ name, passed: false, detail });
  console.log(`[FAIL] ${name}${detail ? ` (${detail})` : ''}`);
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  intervalMs: number,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

// ── Smoke test logger (minimal) ─────────────────────────────────────

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  fatal: () => {},
  trace: () => {},
  child: () => logger,
  level: 'silent',
} as any;

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== DVConf Smoke Test ===\n');

  const config = loadNetworkConfig();
  const network = process.env['SUI_NETWORK'] ?? 'localnet';
  const client = createSuiClient(network);
  const signer = loadKeypair('SIGNER_KEY');
  const signerAddress = signer.getPublicKey().toSuiAddress();

  // 1. Register user
  try {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::user_registry::register_user`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.userRegistryId),
          ],
        });
      },
      'register-user',
      logger,
    );
    pass('User registration');
  } catch (err: any) {
    // Error code 540 = already registered — that's fine
    if (String(err).includes('540') || String(err).includes('already')) {
      pass('User registration', 'already registered');
    } else {
      fail('User registration', String(err));
    }
  }

  // 2. Create room
  let roomId: string | null = null;
  try {
    const result = await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::create_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.userRegistryId),
            tx.pure.u8(0), // SFU mode
            tx.pure.u64(4), // expected_participants (was MISSING — pre-existing arg drift)
            tx.pure.u8(0), // room_class_hint = small (NEW REQ-RMS-016)
          ],
        });
      },
      'create-room',
      logger,
    );

    if (result) {
      roomId = extractCreatedObjectByType(result, '::room_manager::Room');
    }

    if (roomId) {
      pass('Room created', roomId);
    } else {
      fail('Room created', 'could not extract Room ID');
    }
  } catch (err: any) {
    fail('Room created', String(err));
  }

  if (!roomId) {
    printSummary();
    return;
  }

  // 3. Create escrow (0.1 SUI = 100_000_000 MIST)
  try {
    const result = await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(100_000_000n)]);
        tx.moveCall({
          target: `${config.packageId}::economic_layer::create_escrow`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.pure.address(roomId!),
            payment!,
          ],
        });
      },
      'create-escrow',
      logger,
    );

    if (result) {
      pass('Escrow deposited');
    } else {
      fail('Escrow deposited', 'TX returned null');
    }
  } catch (err: any) {
    fail('Escrow deposited', String(err));
  }

  // 4. Poll for CP assignment (30s timeout)
  let assignment: { relayId: string } | null = null;
  try {
    assignment = await pollUntil(
      async () => {
        try {
          const tx = new Transaction();
          tx.moveCall({
            target: `${config.packageId}::room_manager::get_room_assignment`,
            arguments: [
              tx.object(config.roomManagerId),
              tx.pure.address(roomId!),
            ],
          });

          const result = await client.devInspectTransactionBlock({
            transactionBlock: tx,
            sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
          });

          // get_room_assignment's sole return value is now assigned_relays: vector<ID>
          // (was a tuple with a signaling Option<ID> before the standalone signaling
          // node type's removal). BCS vector<address>: 1 ULEB128 length byte (small
          // vectors) followed by 32-byte addresses back to back.
          const returnValues = result.results?.[0]?.returnValues;
          if (!returnValues || returnValues.length < 1) return null;

          const bytes = returnValues[0]![0] as unknown as number[];
          if (!bytes || bytes.length < 1 || bytes[0] === 0) return null; // empty vector = unassigned

          const relayBytes = bytes.slice(1, 33);
          if (relayBytes.length < 32) return null;
          const relayAddr = '0x' + Buffer.from(relayBytes).toString('hex');

          return { relayId: relayAddr };
        } catch {
          return null;
        }
      },
      2000,
      30_000,
    );

    if (assignment) {
      pass('CP assignment received', `relay: ${assignment.relayId.slice(0, 10)}...`);
    } else {
      fail('CP assignment received', 'timeout after 30s');
    }
  } catch (err: any) {
    fail('CP assignment received', String(err));
  }

  // 5. Connect WebSocket to relay
  let relayWs: WebSocket | null = null;
  try {
    relayWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:4000');
      const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
      ws.on('open', () => { clearTimeout(timer); resolve(ws); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    pass('Relay WebSocket connected');
  } catch (err: any) {
    fail('Relay WebSocket connected', String(err));
  }

  // 6. Send join, wait for routerRtpCapabilities
  if (relayWs) {
    try {
      const msgPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000);
        relayWs!.once('message', (data) => {
          clearTimeout(timer);
          resolve(JSON.parse(data.toString()));
        });
      });

      relayWs.send(JSON.stringify({ type: 'join', roomId, peerId: 'smoke-test-peer' }));
      const msg = await msgPromise;

      if (msg['type'] === 'routerRtpCapabilities') {
        pass('Received routerRtpCapabilities');
      } else {
        fail('Received routerRtpCapabilities', `got type: ${msg['type']}`);
      }

      relayWs.close();
    } catch (err: any) {
      fail('Received routerRtpCapabilities', String(err));
      relayWs.close();
    }
  }

  // 7. Close room
  try {
    const result = await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::close_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.pure.address(roomId!),
          ],
        });
      },
      'close-room',
      logger,
    );

    if (result) {
      pass('Room closed');
    } else {
      fail('Room closed', 'TX returned null');
    }
  } catch (err: any) {
    fail('Room closed', String(err));
  }

  printSummary();
}

function printSummary(): void {
  console.log('\n--- Summary ---');
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  console.log(`${passed}/${total} steps passed`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
