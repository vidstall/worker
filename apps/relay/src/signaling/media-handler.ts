/**
 * mediasoup transport/producer/consumer signaling: createTransport,
 * connectTransport, produce, consume, setConsumerLayers, pauseConsumer,
 * resumeConsumer, and the per-room AudioLevelObserver attach.
 *
 * Barrel re-export — the implementations live in media-handler-transport.ts
 * (createTransport/connectTransport), media-handler-produce.ts (produce),
 * media-handler-consume.ts (consume), and media-handler-audio.ts
 * (setConsumerLayers/pauseConsumer/resumeConsumer/attachAudioLevelObserver).
 * Kept as one entry point so existing import paths
 * (`from './signaling/media-handler.js'`) keep working unchanged.
 *
 * Requirements: RELAY-05
 */

export { handleCreateTransport, handleConnectTransport } from './media-handler-transport.js';
export { handleProduce } from './media-handler-produce.js';
export { handleConsume } from './media-handler-consume.js';
export {
  handleSetConsumerLayers,
  handlePauseConsumer,
  handleResumeConsumer,
  attachAudioLevelObserver,
} from './media-handler-audio.js';
