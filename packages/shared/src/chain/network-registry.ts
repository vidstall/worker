/**
 * @dvconf/shared — on-chain reads for the F60 reactive-shutdown wiring
 * (P17 M2b-P8, DOH-021). Two read-only helpers the per-daemon SelfShutdownWatcher
 * (P8-P10) wires:
 *
 *   - readIsPaused   — devInspect `network_registry::is_paused(&NetworkRegistry)`
 *                      → bool, for the watcher's `paused` arm poll.
 *   - readCapMinerId — getObject the daemon's own cap → its `miner_id` FIELD (the
 *                      ID carried by `RelaySlashed.relay_miner_id` /
 *                      `NodeDegraded.miner_id`), the watcher's self-filter key.
 *                      NOTE: the cap's `miner_id` field is the MinerProfile ID, NOT
 *                      the cap OBJECT id (`caps.move` MinerCap.miner_id / the
 *                      relay_registry key `rid`; economic_layer.move:582 emits it).
 *
 * Both are FAIL-OPEN: any RPC / decode error is logged and treated as the safe
 * default (not-paused / null id) so a transient chain hiccup can never self-kill a
 * daemon — the SelfShutdownWatcher's own `isPaused` catch is belt-and-suspenders
 * on top. devInspect needs no gas/signature — the `0x0` sender is the read-only
 * convention (mirrors role-assignment.ts).
 */
import type { SuiClient } from '@mysten/sui/client';
import type { Logger } from 'pino';
import { Transaction } from '@mysten/sui/transactions';

/** Read-only devInspect sender — no gas, no signature (role-assignment.ts:41). */
const DEV_INSPECT_SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * devInspect `network_registry::is_paused(&NetworkRegistry): bool`
 * (network_registry.move:99). Returns the decoded bool, or `false` (FAIL-OPEN) on
 * any RPC / decode error or an empty return — a transient read hiccup must never
 * read as paused (which would self-kill a healthy daemon).
 */
export async function readIsPaused(
  client: SuiClient,
  packageId: string,
  networkRegistryId: string,
  logger?: Logger,
): Promise<boolean> {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::network_registry::is_paused`,
      arguments: [tx.object(networkRegistryId)],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx as never,
      sender: DEV_INSPECT_SENDER,
    });
    const returnValues = result.results?.[0]?.returnValues;
    if (returnValues && returnValues.length > 0) {
      // BCS bool: a single byte — 1 = true, 0 = false.
      const bytes = new Uint8Array(returnValues[0][0] as number[]);
      return bytes.length > 0 && bytes[0] === 1;
    }
    return false; // no return value → fail-open
  } catch (err) {
    logger?.warn(
      { err, networkRegistryId },
      'readIsPaused devInspect failed; treating as not-paused',
    );
    return false;
  }
}

/**
 * getObject the daemon's own cap (MinerCap or ControlPlaneCap — both carry a
 * `miner_id` field) and extract `miner_id` — the ID the SelfShutdownWatcher
 * self-filter matches against `RelaySlashed.relay_miner_id` / `NodeDegraded.miner_id`.
 * Returns `null` (logged) if the object / field is missing — the watcher then
 * simply never matches an id-filtered arm (fail-safe: no spurious self-shutdown).
 */
export async function readCapMinerId(
  client: SuiClient,
  capId: string,
  logger?: Logger,
): Promise<string | null> {
  try {
    const obj = await client.getObject({ id: capId, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') {
      logger?.warn({ capId }, 'readCapMinerId: cap object not found / not a move object');
      return null;
    }
    const fields = content.fields as Record<string, unknown>;
    const minerId = fields?.['miner_id'];
    if (typeof minerId !== 'string') {
      logger?.warn({ capId }, 'readCapMinerId: miner_id field missing on cap');
      return null;
    }
    return minerId;
  } catch (err) {
    logger?.warn({ err, capId }, 'readCapMinerId: getObject failed');
    return null;
  }
}
