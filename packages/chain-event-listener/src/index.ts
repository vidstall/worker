/**
 * @dvconf/chain-event-listener — barrel export.
 *
 * The chain-event subscription wrapper (P17 M2b). P1 ships the SKELETON:
 * `ChainEventListener` wraps the shipped `EventPoller` by composition (one per
 * Move module) + owns the per-module cursor path under DATA_DIR + a stop() and
 * an isDegraded() stub. P2 adds the `ReplayGovernor` as a pure, isolated unit
 * (the listener wires it in at P3); the replay tip-snapshot/tagging is P3.
 */

export { ChainEventListener } from './listener.js';
export type {
  ChainEventListenerOptions,
  SubscribeOptions,
  ListenerHandler,
} from './listener.js';

export { ReplayGovernor, readReplayGovernorConfig } from './replay-governor.js';
export type { ReplayGovernorConfig } from './replay-governor.js';
