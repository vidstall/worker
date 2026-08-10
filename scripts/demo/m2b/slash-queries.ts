/**
 * m2b/slash-queries.ts — read-side chain queries: the newest CanaryDivergenceSlashed event for a room,
 * and a StakePosition bond value via devInspect. Extracted verbatim from the original single-file
 * m2b-live-bhermetic-slash.ts — pure code movement, no behavior change.
 */
import { Transaction } from '@mysten/sui/transactions';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { CanarySlashEvent } from '../assert-canary-slash.ts';

/** Newest CanaryDivergenceSlashed parsedJson matching roomId; {} if none (descending). */
export async function queryLatestSlash(client: SuiClient, packageId: string, roomId: string): Promise<CanarySlashEvent> {
  const page = await client.queryEvents({
    query: { MoveEventType: `${packageId}::canary_audit::CanaryDivergenceSlashed` },
    order: 'descending',
    // M4: limit:50 is safe because we slash a FRESH per-run room — at most ONE matching event exists
    // for `roomId`, and it is among the 50 newest descending (the live stack only auto-slashes its OWN
    // seed room, never these fresh rooms), so the scan reliably finds (or rules out) our event.
    limit: 50,
  });
  for (const e of page.data) {
    const pj = e.parsedJson as CanarySlashEvent | undefined;
    if (pj && pj.room_id === roomId) return pj;
  }
  return {};
}

/** Read a StakePosition bond value (MIST) via staking::amount (devInspect). */
export async function readBond(client: SuiClient, reader: Ed25519Keypair, stakeId: string, packageId: string): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::staking::amount`, arguments: [tx.object(stakeId)] });
  const res = await client.devInspectTransactionBlock({
    sender: reader.getPublicKey().toSuiAddress(),
    transactionBlock: tx,
  });
  const ret = res.results?.[0]?.returnValues?.[0];
  if (!ret) return 0n;
  const bytes = Uint8Array.from(ret[0] as number[]);
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v += BigInt(bytes[i]!) << (8n * BigInt(i));
  return v;
}
