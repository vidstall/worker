/**
 * GraphQL query primitives for chain events -- SuiGraphQLClient's
 * `events(filter:)` / `transactionEffects(digest:)` / `address(...).transactions`
 * queries (NOT the deprecated JSON-RPC `queryEvents` / `subscribeEvent` /
 * `queryTransactionBlocks`). devnet's public fullnode returns
 * "Method not found" for the old JSON-RPC event-shaped reads -- see
 * https://docs.sui.io/develop/accessing-data/json-rpc-migration.
 *
 * Pure extraction from chain/events.ts. See that file's barrel doc.
 */

import type { SuiGraphQLClient, GraphQLQueryResult } from '@mysten/sui/graphql';
import type { SuiEvent } from '@mysten/sui/client';

export interface GraphQLEventNode {
  sender: { address: string } | null;
  sequenceNumber: number;
  timestamp: string | null;
  transactionModule: { package: { address: string }; name: string } | null;
  contents: { json: unknown; type: { repr: string } } | null;
}

export interface EventsQueryResult {
  events: {
    nodes: GraphQLEventNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// Filters by event TYPE, not emitting MODULE. GraphQL's `module` filter
// matches transactionModule.package -- the package version that was
// EXECUTING when the event was emitted, which changes on every
// `contract upgrade` (each upgrade calls entry points via a new latest
// package address). `type` instead matches contents.type.repr, which Sui
// pins to whichever package FIRST DEFINED the struct and never changes
// across upgrades -- confirmed against devnet: a MinerRegistered emitted
// via an old "latest" package still carries the original defining
// package in its type, so `module` filtering permanently loses events
// emitted before the most recent upgrade, while `type` filtering (keyed
// on the stable original package) does not. See NetworkConfig.originalPackageId.
export const EVENTS_QUERY = `
  query PollEvents($eventType: String!, $after: String) {
    events(filter: { type: $eventType }, after: $after, first: 50) {
      nodes {
        sender { address }
        sequenceNumber
        timestamp
        transactionModule { package { address } name }
        contents { json type { repr } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Adapt a GraphQL event node back into the JSON-RPC SuiEvent shape so
 * every existing handler (event-handler.ts and friends) is untouched.
 */
export function toSuiEvent(node: GraphQLEventNode, cursor: string): SuiEvent {
  const timestampMs = node.timestamp ? String(Date.parse(node.timestamp)) : '0';
  return {
    id: { txDigest: cursor, eventSeq: String(node.sequenceNumber) },
    packageId: node.transactionModule?.package.address ?? '',
    transactionModule: node.transactionModule?.name ?? '',
    sender: node.sender?.address ?? '',
    type: node.contents?.type.repr ?? '',
    parsedJson: node.contents?.json ?? {},
    bcs: '',
    timestampMs,
  } as unknown as SuiEvent;
}

interface TransactionEventsQueryResult {
  transactionEffects: {
    events: {
      nodes: GraphQLEventNode[];
    };
  } | null;
}

// Query.transactionEffects (NOT transactionBlock -- verified via live schema
// introspection against fullnode.devnet.sui.io/graphql: the @mysten/sui SDK's
// bundled generated schema type still names it "transactionBlock", but the
// GraphQL service itself has since renamed the root field, so the earlier
// version of this query 400'd with "Unknown field \"transactionBlock\"" and
// silently degraded to an empty event list at every call site).
// transactionEffects IS the effects object -- `events` hangs directly off it,
// there is no separate nested `effects` field like the old schema had.
const TRANSACTION_EVENTS_QUERY = `
  query TransactionEvents($digest: String!) {
    transactionEffects(digest: $digest) {
      events(first: 50) {
        nodes {
          sender { address }
          sequenceNumber
          timestamp
          transactionModule { package { address } name }
          contents { json type { repr } }
        }
      }
    }
  }
`;

/**
 * Fetch the events emitted by ONE already-executed transaction, by digest --
 * the GraphQL replacement for reading `.events` off a JSON-RPC
 * `signAndExecuteTransaction`/`executeTransactionBlock` response, which comes
 * back empty on devnet's public fullnode (JSON-RPC event-shaped reads are
 * deprecated there -- see chain/events.ts's top-of-file docstring). Used by
 * `chain/tx.ts::executeWithRetry` and `chain/provision-room.ts::signAndAssert`
 * to backfill `result.events` when it comes back empty.
 */
export async function fetchEventsForDigest(client: SuiGraphQLClient, digest: string): Promise<SuiEvent[]> {
  const result = await client.query<TransactionEventsQueryResult, { digest: string }>({
    query: TRANSACTION_EVENTS_QUERY,
    variables: { digest },
  });

  if (result.errors && result.errors.length > 0) {
    throw new Error(
      `GraphQL transaction-events query failed for ${digest}: ${result.errors.map((e: { message: string }) => e.message).join('; ')}`,
    );
  }

  const nodes = result.data?.transactionEffects?.events.nodes ?? [];
  return nodes.map((node) => toSuiEvent(node, digest));
}

interface ObjectChangeNode {
  address: string;
  idCreated: boolean;
  outputState: { asMoveObject: { contents: { type: { repr: string } } } | null } | null;
}

interface AddressTransactionsQueryResult {
  address: {
    transactions: {
      nodes: Array<{
        digest: string;
        effects: { objectChanges: { nodes: ObjectChangeNode[] } } | null;
      }>;
      pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    };
  } | null;
}

// Paginates BACKWARD from the most recent transaction (last/before). This
// repo's operator wallet pool is long-lived and REUSED across many
// `scenario apply`/`destroy` cycles and contract redeploys (each producing
// a fresh MinerStore/StakePosition/ControlPlaneCap under whatever package
// was active at the time) -- confirmed live on devnet: a wallet used by
// this repo had already accumulated 250+ transactions, its GENESIS-era
// objects typed under a now-abandoned package, with the CURRENT package's
// registration only ~200 transactions back from the tip. A forward-from-
// genesis scan (the original approach here) would have to page through
// that entire stale history before ever reaching the current registration
// -- easily exceeding any reasonable maxPages and returning null even
// though the object genuinely exists, which is exactly the self-heal
// failure this function exists to prevent. Scanning backward finds a
// RECENT registration (the only kind self-heal ever cares about -- an
// account re-registering under the CURRENT package) in a handful of pages
// regardless of how much older history the wallet carries. Replaces
// `client.queryTransactionBlocks(...)`, which is deprecated JSON-RPC on
// devnet's public fullnode (confirmed via direct curl: same "JSON-RPC on
// public fullnodes has been deprecated" error as every other event-shaped
// read fixed in this file).
const ADDRESS_TRANSACTIONS_QUERY = `
  query AddressTransactions($address: SuiAddress!, $before: String) {
    address(address: $address) {
      transactions(filter: { sentAddress: $address }, last: 50, before: $before) {
        nodes {
          digest
          effects {
            objectChanges(first: 50) {
              nodes {
                address
                idCreated
                outputState {
                  asMoveObject {
                    contents { type { repr } }
                  }
                }
              }
            }
          }
        }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
`;

/**
 * Find the most-recently-created on-chain object of type `objectType` among
 * the objects an `address` has created, scanning backward from its newest
 * transaction. Used to recover a wallet's own MinerCap / StakePosition /
 * ValidatorCap object IDs after a partial registration attempt (self-heal),
 * replacing `client.queryTransactionBlocks(...)` -- see chain/events.ts's own
 * docstring and ADDRESS_TRANSACTIONS_QUERY's comment on why backward (not
 * forward-from-genesis) is the correct direction for a reused wallet pool.
 * Returns null if no matching object is found within `maxPages` pages.
 */
export async function findCreatedObjectByType(
  client: SuiGraphQLClient,
  address: string,
  objectType: string,
  maxPages = 20,
): Promise<string | null> {
  let before: string | null = null;
  let hasPreviousPage = true;
  let pages = 0;

  while (hasPreviousPage && pages < maxPages) {
    const result: GraphQLQueryResult<AddressTransactionsQueryResult> = await client.query<
      AddressTransactionsQueryResult,
      { address: string; before: string | null }
    >({
      query: ADDRESS_TRANSACTIONS_QUERY,
      variables: { address, before },
    });

    if (result.errors && result.errors.length > 0) {
      throw new Error(
        `GraphQL address-transactions query failed for ${address}: ${result.errors.map((e: { message: string }) => e.message).join('; ')}`,
      );
    }

    const txs = result.data?.address?.transactions;
    if (!txs) {
      return null;
    }

    // Newest-first within this page too -- `last: 50` returns the page in
    // chronological (oldest-to-newest-within-page) order, so walk it in
    // reverse to find the MOST RECENT matching creation first, not the
    // oldest one in this batch of 50.
    for (const tx of [...txs.nodes].reverse()) {
      const changes = tx.effects?.objectChanges.nodes ?? [];
      for (const change of changes) {
        if (!change.idCreated) continue;
        const repr = change.outputState?.asMoveObject?.contents.type.repr;
        if (repr === objectType) {
          return change.address;
        }
      }
    }

    hasPreviousPage = txs.pageInfo.hasPreviousPage;
    before = txs.pageInfo.startCursor;
    pages++;
  }

  return null;
}

/**
 * One-shot paginated fetch of ALL historical events for a module (no cursor
 * persistence) -- for bootstrap-replay call sites that used to call
 * `client.queryEvents(...)` directly instead of going through EventPoller.
 */
export async function queryHistoricalEvents(
  client: SuiGraphQLClient,
  packageId: string,
  module: string,
  maxEvents = 100,
): Promise<SuiEvent[]> {
  const events: SuiEvent[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore && events.length < maxEvents) {
    const result: GraphQLQueryResult<EventsQueryResult> = await client.query<
      EventsQueryResult,
      { eventType: string; after: string | null }
    >({
      query: EVENTS_QUERY,
      variables: { eventType: `${packageId}::${module}`, after: cursor },
    });

    if (result.errors && result.errors.length > 0) {
      throw new Error(
        `GraphQL events query failed: ${result.errors.map((e: { message: string }) => e.message).join('; ')}`,
      );
    }

    const page = result.data?.events;
    if (!page) {
      throw new Error('GraphQL events query returned no data');
    }

    for (const node of page.nodes) {
      events.push(toSuiEvent(node, page.pageInfo.endCursor ?? cursor ?? ''));
    }

    cursor = page.pageInfo.endCursor;
    hasMore = page.pageInfo.hasNextPage;
  }

  return events;
}
