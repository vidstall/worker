/**
 * Relay role manager — warm-pipe + paused standby consumer, honest
 * probe-liveness.
 *
 * Barrel re-export — the implementations live in relay-role.ts
 * (RelayRole/RoomTopology/PipePortRange/determineRole/parsePipePortRange/
 * createPipePortAllocator/pipeSrtpEnabled), warm-pipe-core.ts
 * (createStandbyPipeTransport/ensureWarmPipe/produceLocalFromPipe/
 * pipeRoomToSecondWorker), and pipe-liveness-observer.ts
 * (createPipeLivenessObserver + its types). Kept as one entry point so
 * existing import paths (`from './relay-role-manager.js'`, including
 * `packages/inter-relay-client/src/index.ts`'s `export *` and every
 * warm-pipe/ consumer) keep working unchanged.
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 * ADR: ADR-0009 (relay-overlap-redundancy M1)
 */

export * from './relay-role.js';
export * from './warm-pipe-core.js';
export * from './pipe-liveness-observer.js';
