/**
 * Chain events -- cursor-based EventPoller + GraphQL query primitives.
 *
 * Barrel re-export -- the implementations live in event-poller-graphql.ts
 * (EVENTS_QUERY/toSuiEvent/fetchEventsForDigest/findCreatedObjectByType/
 * queryHistoricalEvents) and event-poller.ts (EventPoller class +
 * registerEventPollerMetrics). Kept as one entry point so existing import
 * paths (`from '.../chain/events.js'`, including this package's own
 * `index.ts`) keep working unchanged.
 *
 * See event-poller.ts's doc for the GraphQL-vs-JSON-RPC migration
 * background: SuiGraphQLClient's `events(filter:)` query (NOT the
 * deprecated JSON-RPC `queryEvents` / `subscribeEvent`) -- devnet's public
 * fullnode returns "Method not found" for `suix_queryEvents`, see
 * https://docs.sui.io/develop/accessing-data/json-rpc-migration.
 */

export {
  fetchEventsForDigest,
  findCreatedObjectByType,
  queryHistoricalEvents,
} from './event-poller-graphql.js';
export {
  EventPoller,
  registerEventPollerMetrics,
  type EventPollerOptions,
} from './event-poller.js';
