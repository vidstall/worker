/**
 * @dvconf/chain-event-listener — barrel export.
 *
 * The chain-event subscription wrapper (P17 M2b). P1 ships the SKELETON:
 * `ChainEventListener` wraps the shipped `EventPoller` by composition (one per
 * Move module) + owns the per-module cursor path under DATA_DIR + a stop() and
 * an isDegraded() stub. The ReplayGovernor (P2) and replay tip-snapshot/tagging
 * (P3) layer on later.
 */

export { ChainEventListener } from './listener.js';
export type {
  ChainEventListenerOptions,
  SubscribeOptions,
  ListenerHandler,
} from './listener.js';
