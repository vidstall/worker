/**
 * Pure parsing/formatting helpers for bench smoke bring-up — extracted from
 * run-smoke.ts (S25.A). No process spawning or I/O beyond a raw TCP connect
 * probe (waitForPort) and a readable-stream watcher (waitForLogLine).
 */

import { createConnection } from 'node:net';

// ── Sui SDK object-change schema (subset we care about) ───────────────

export interface SuiSharedOwner {
  Shared: { initial_shared_version?: number | string } | unknown;
}

export interface SuiAddressOwner {
  AddressOwner: string;
}

export type SuiOwner = SuiSharedOwner | SuiAddressOwner | Record<string, unknown>;

export interface SuiObjectChange {
  type: 'published' | 'created' | 'mutated' | 'transferred' | 'wrapped' | 'deleted' | string;
  packageId?: string;
  objectId?: string;
  objectType?: string;
  owner?: SuiOwner;
}

export interface SuiPublishResult {
  objectChanges?: SuiObjectChange[];
}

/**
 * Subset of a Sui transaction event we care about. `parsedJson` is the BCS
 * payload decoded by the SDK; we only ever read top-level string/number
 * fields like `room_id` so the loose record type is sufficient.
 */
export interface SuiTxEvent {
  type: string;
  parsedJson?: Record<string, unknown>;
}

/** Tx result with events — what `signAndExecuteTransaction({showEvents:true})` returns. */
export interface SuiTxResult {
  events?: SuiTxEvent[];
}

function isShared(owner: SuiOwner | undefined): boolean {
  return owner !== undefined && typeof owner === 'object' && 'Shared' in owner;
}

function isAddressOwned(owner: SuiOwner | undefined): boolean {
  return (
    owner !== undefined && typeof owner === 'object' && 'AddressOwner' in owner
  );
}

// ── parsePublishJson ──────────────────────────────────────────────────

export interface PublishOutput {
  packageId: string;
  adminCapId: string;
  treasuryCapId: string;
  /** Auto-created by module::init when the package is published. */
  networkRegistryId: string;
  minerStoreId: string;
  roleVoteBoxId: string;
  livenessVoteBoxId: string;
}

/**
 * Pluck the six load-bearing identities from a `sui client test-publish --json`
 * payload. Throws when any of the six is missing — bring-up cannot proceed
 * without them and a partial result is more dangerous than a clean abort.
 */
export function parsePublishJson(json: SuiPublishResult): PublishOutput {
  let packageId: string | null = null;
  let adminCapId: string | null = null;
  let treasuryCapId: string | null = null;
  let networkRegistryId: string | null = null;
  let minerStoreId: string | null = null;
  let roleVoteBoxId: string | null = null;
  let livenessVoteBoxId: string | null = null;

  for (const change of json.objectChanges ?? []) {
    if (change.type === 'published') {
      if (typeof change.packageId === 'string') packageId = change.packageId;
      continue;
    }
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    const objId = change.objectId;
    if (typeof objId !== 'string') continue;
    const owner = change.owner;

    if (isShared(owner)) {
      if (objType.includes('::network_registry::NetworkRegistry')) {
        networkRegistryId = objId;
      } else if (objType.includes('::miner_store::MinerStore')) {
        minerStoreId = objId;
      } else if (objType.includes('::role_voting::RoleVoteBox')) {
        roleVoteBoxId = objId;
      } else if (objType.includes('::liveness_voting::LivenessVoteBox')) {
        livenessVoteBoxId = objId;
      }
    } else if (isAddressOwned(owner)) {
      if (objType.includes('::network_registry::AdminCap')) {
        adminCapId = objId;
      } else if (objType.includes('0x2::coin::TreasuryCap<')) {
        treasuryCapId = objId;
      }
    }
  }

  if (packageId === null) {
    throw new Error('parsePublishJson: PACKAGE_ID not in objectChanges');
  }
  if (adminCapId === null) {
    throw new Error('parsePublishJson: AdminCap not in objectChanges');
  }
  if (treasuryCapId === null) {
    throw new Error(
      'parsePublishJson: TreasuryCap<token::TOKEN> not in objectChanges',
    );
  }
  if (networkRegistryId === null) {
    throw new Error('parsePublishJson: NetworkRegistry not in objectChanges');
  }
  if (minerStoreId === null) {
    throw new Error('parsePublishJson: MinerStore not in objectChanges');
  }
  if (roleVoteBoxId === null) {
    throw new Error('parsePublishJson: RoleVoteBox not in objectChanges');
  }
  if (livenessVoteBoxId === null) {
    throw new Error('parsePublishJson: LivenessVoteBox not in objectChanges');
  }
  return {
    packageId,
    adminCapId,
    treasuryCapId,
    networkRegistryId,
    minerStoreId,
    roleVoteBoxId,
    livenessVoteBoxId,
  };
}

// ── parseSharedObjectFromCreate ───────────────────────────────────────

/**
 * Pluck the lone shared object out of a `<module>::create` call result.
 * The 6 registry-create calls each produce exactly one shared object whose
 * struct name matches `structSubstring`; we scan `objectChanges` for it.
 */
export function parseSharedObjectFromCreate(
  result: { objectChanges?: SuiObjectChange[] },
  structSubstring: string,
): string {
  for (const change of result.objectChanges ?? []) {
    if (change.type !== 'created') continue;
    const objType = change.objectType ?? '';
    if (
      isShared(change.owner) &&
      objType.includes(structSubstring) &&
      typeof change.objectId === 'string'
    ) {
      return change.objectId;
    }
  }
  throw new Error(
    `parseSharedObjectFromCreate: no shared object matching ${structSubstring}`,
  );
}

// ── buildEnvContent ───────────────────────────────────────────────────

export interface BenchIds {
  packageId: string;
  networkRegistryId: string;
  minerStoreId: string;
  cpRegistryId: string;
  relayRegistryId: string;
  validatorRegistryId: string;
  userRegistryId: string;
  roomManagerId: string;
  roleVoteBoxId: string;
  livenessVoteBoxId: string;
}

/**
 * The three canonical env-var names for daemon keypairs, mirroring the
 * per-app `.env.example` files. Each daemon reads a *different* name so the
 * bundle is a flat record, not a list.
 */
export interface DaemonKeys {
  /** cp-daemon — apps/cp-daemon/.env.example */
  CP_KEYPAIR: string;
  /** validator-daemon — apps/validator-daemon/.env.example */
  SUI_PRIVATE_KEY: string;
  /** relay — apps/relay/.env.example */
  PRIVATE_KEY: string;
}

/**
 * Render the dvconf-daemons/.env file the three daemons share. Matches the
 * legacy run-local.ps1 layout so existing daemon code paths (heartbeat,
 * auto-register, latency probe gating via `BENCH_LATENCY=1`) light up
 * unchanged.
 */
export function buildEnvContent(
  ids: BenchIds,
  keys: DaemonKeys,
  extras: Record<string, string> = {},
): string {
  const lines = [
    'SUI_NETWORK=localnet',
    `PACKAGE_ID=${ids.packageId}`,
    `NETWORK_REGISTRY_ID=${ids.networkRegistryId}`,
    `MINER_STORE_ID=${ids.minerStoreId}`,
    `CP_REGISTRY_ID=${ids.cpRegistryId}`,
    `RELAY_REGISTRY_ID=${ids.relayRegistryId}`,
    `VALIDATOR_REGISTRY_ID=${ids.validatorRegistryId}`,
    `USER_REGISTRY_ID=${ids.userRegistryId}`,
    `ROOM_MANAGER_ID=${ids.roomManagerId}`,
    `ROLE_VOTE_BOX_ID=${ids.roleVoteBoxId}`,
    `LIVENESS_VOTE_BOX_ID=${ids.livenessVoteBoxId}`,
    `CP_KEYPAIR=${keys.CP_KEYPAIR}`,
    `SUI_PRIVATE_KEY=${keys.SUI_PRIVATE_KEY}`,
    `PRIVATE_KEY=${keys.PRIVATE_KEY}`,
    'LOG_LEVEL=info',
    'HEARTBEAT_INTERVAL_MS=30000',
    'EVENT_POLL_INTERVAL_MS=3000',
    'BENCH_LATENCY=1',
  ];
  for (const [k, v] of Object.entries(extras)) {
    lines.push(`${k}=${v}`);
  }
  return lines.join('\n') + '\n';
}

// ── waitForPort ───────────────────────────────────────────────────────

function tryConnectOnce(
  host: string,
  port: number,
  connectTimeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(connectTimeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/**
 * Poll a TCP port until it accepts a connection, or fail after `timeoutMs`.
 * Used to wait on the Sui RPC socket (9000), the faucet (9123), and the
 * daemon WS ports (4000 relay, etc.).
 */
export async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number,
  pollIntervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await tryConnectOnce(host, port, Math.min(1000, pollIntervalMs));
    if (ok) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(
    `waitForPort: ${host}:${port} not reachable after ${timeoutMs}ms`,
  );
}

// ── parseRoomIdFromEvents ─────────────────────────────────────────────

/**
 * Pluck a string `room_id` from the first event whose `type` ends with
 * `eventTypeSuffix` (typically `'::room_manager::RoomCreated'`). The Sui
 * Move side emits `RoomCreated` from `create_room` instead of returning the
 * object — the SDK surfaces it in `tx.events`, not `tx.objectChanges`.
 *
 * Throws when (a) `events` is missing, (b) no event matches the suffix, or
 * (c) the matched event lacks a string `room_id`. Bench bring-up cannot
 * recover from any of these; failing loudly beats a silent placeholder.
 */
export function parseRoomIdFromEvents(
  result: SuiTxResult,
  eventTypeSuffix: string,
): string {
  if (!Array.isArray(result.events)) {
    throw new Error(
      `parseRoomIdFromEvents: tx result has no events array (suffix=${eventTypeSuffix})`,
    );
  }
  for (const ev of result.events) {
    if (typeof ev.type !== 'string' || !ev.type.endsWith(eventTypeSuffix)) {
      continue;
    }
    const roomId = ev.parsedJson?.['room_id'];
    if (typeof roomId !== 'string') {
      throw new Error(
        `parseRoomIdFromEvents: matched ${ev.type} but room_id is not a string (got ${typeof roomId})`,
      );
    }
    return roomId;
  }
  throw new Error(
    `parseRoomIdFromEvents: no event matched ${eventTypeSuffix} in ${result.events.length} events`,
  );
}

// ── waitForLogLine ────────────────────────────────────────────────────

/** Minimal readable-stream shape — `child_process.spawn` stdout/stderr fit. */
export interface LogStream {
  on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  off?: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown;
  removeListener?: (
    event: 'data',
    listener: (chunk: Buffer | string) => void,
  ) => unknown;
}

/**
 * Watch a readable stream for the first complete line that matches `pattern`,
 * resolving with the matched line text (without trailing newline). Lines
 * without a terminating `\n` are kept in a buffer — they're not considered
 * complete and never match. Rejects with `timeout` if `timeoutMs` passes.
 *
 * Used for ready-detection on daemons that don't expose a listening port:
 *   - cp-daemon: `"Starting role voting loop"`
 *   - validator-daemon: `"Validator daemon started"`
 * And as a secondary check for those that do:
 *   - relay: `"Relay daemon starting"` + later auto-register success
 */
export function waitForLogLine(
  stream: LogStream,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Split on \n; the last fragment (no trailing \n) stays in buffer.
      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
        buffer = buffer.slice(nlIdx + 1);
        if (pattern.test(line)) {
          finish(null, line);
          return;
        }
      }
    };

    const finish = (err: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detach = stream.off ?? stream.removeListener;
      if (detach !== undefined) detach.call(stream, 'data', onData);
      if (err !== null) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => {
      finish(new Error(`waitForLogLine: timeout after ${timeoutMs}ms waiting for ${pattern}`));
    }, timeoutMs);

    stream.on('data', onData);
  });
}
