/**
 * @dvconf/shared — Barrel export.
 *
 * Re-exports all types, chain helpers, and logger for consumption by daemon packages.
 */

// Types
export type {
  MinerRegistered,
  MinerUnregistered,
  RoleChanged,
  RoleVoteCast,
  RoleAssigned,
  RoleApplied,
  RevoteEligibleMarked,
  RoleTransitioned,
  CPRegistered,
  CPHeartbeat,
  CPAssignedToRoom,
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  ValidatorRegistered,
  SessionWalletAssigned,
  SessionWalletRevealed,
  RoomCreated,
  RoomAssigned,
  RoomClosed,
  RoomRulesUpdated,
  UserRegistered,
  UserProfileUpdated,
  SignalingRegistered,
  SignalingHeartbeat,
  SignalingLoadUpdated,
  SignalingUnregistered,
  EscrowCreated,
  SessionProofSubmitted,
  RewardsDistributed,
  RelaySlashed,
  SecretRotated,
  NodeDegraded,
  DvconfEvent,
} from './types/events.js';

export type {
  SuiObjectRef,
  NetworkConfig,
  TxResult,
} from './types/chain.js';

export { economicLayerModuleName } from './types/chain.js';

export {
  RelayMode,
  MinerRole,
  ErrorCodes,
  SIGNALING_SESSION_REWARD,
  MIN_PROOFS_FOR_DISTRIBUTION,
  QUALITY_EXCELLENT_BPS,
  QUALITY_GOOD_BPS,
  QUALITY_ACCEPTABLE_BPS,
  SLASH_PERCENTAGE_BPS,
} from './types/constants.js';

// Chain helpers
export { createSuiClient, createGraphQLClient, loadNetworkConfig } from './chain/client.js';
export { loadKeypair, generateSessionKeypair } from './chain/keypair.js';
export { executeWithRetry, extractCreatedObjectByType, registerTxMetrics } from './chain/tx.js';
export { EventPoller, queryHistoricalEvents, registerEventPollerMetrics, fetchEventsForDigest, findCreatedObjectByType } from './chain/events.js';
export type { EventPollerOptions } from './chain/events.js';
export { waitForRoleAssignment, applyVotedRole, registerRoleAssignmentMetrics } from './chain/role-assignment.js';
// P17 M2b-P8 (DOH-021) — on-chain reads for the F60 reactive-shutdown wiring.
export { readIsPaused, readCapMinerId } from './chain/network-registry.js';

// Logger
export { createLogger, buildLoggerOptions } from './logger.js';
export type { Logger, LoggerEnv } from './logger.js';

// P17 M1 / F63 — cross-daemon trace primitive (x-trace-id chain).
export {
  TRACE_HEADER,
  genTraceId,
  readTraceId,
  withTraceHeader,
  traceChild,
} from './trace.js';
export type { IncomingHeaders } from './trace.js';

// P17 M1 / F65 — shared liveness server.
export { startHealthzServer, healthzBody } from './healthz.js';
export type { HealthzOptions, HealthzHandle } from './healthz.js';

// Worker-metrics — shared Prometheus registry + scrape server + concurrency gauge.
export {
  createMetricsRegistry,
  startPromMetricsServer,
  createConcurrencyGauge,
  createDurationHistogram,
  createCounter,
  createGauge,
  pushToGateway,
} from './metrics-prom.js';
export type {
  Registry,
  PromMetricsServerOptions,
  PromMetricsServerHandle,
  ConcurrencyGauge,
  PushGatewayMetric,
} from './metrics-prom.js';

// Cap-token primitive contract types (F62 W1 Stage 1 + Phase 2.4-retro). Append-only
// re-exports so daemon consumers (Phase 3.1 cap-token-issuer, Phase 3.2 signaling auth,
// Phase 3.3 signaling cache) can import QuorumSig + Capability* types from the root.
export type {
  QuorumSig,
  QuorumConfigState,
  QuorumSigEvent,
  QuorumVerifiedEvent,
  QuorumInsufficientEvent,
  QuorumConfigUpdatedEvent,
  QuorumSigErrorCode,
  CapabilityIssuedEvent,
  CapabilityRevokedEvent,
  CapabilityRefreshedEvent,
  CapabilityEvent,
  CapabilityErrorCode,
  CapTokenPrimitiveEvent,
  RoomCapabilityRefreshArgs,
} from './interfaces/cp-quorum-sig.contract.js';
export { QUORUM_SIG_ERRORS, CAPABILITY_ERRORS } from './interfaces/cp-quorum-sig.contract.js';

// Bench harness (Task #26)
export {
  LATENCY_EVENT_SCHEMA_VERSION,
  LatencyWriter,
  appendLatencyEvent,
  isBenchEnabled,
  resolveTraceId,
  resolveScenario,
  timeAsync,
  timeSync,
  startSampler,
} from './bench/index.js';
export type {
  LatencyEvent,
  LatencyMetric,
  LatencyScenario,
  LatencySource,
  LatencyWriterOptions,
} from './bench/index.js';

// Multi-CP quorum Phase 1 / Leg 5 — the GENERIC quorum claim board (parametric sibling of the
// canary-concrete InMemoryClaimBoard). Lives in @dvconf/shared so BOTH the canary lane
// (validator-daemon) and the cap-token Leg-6 collector (cp-daemon) import it WITHOUT a cross-app
// import. The canary board stays byte-identical; this is additive.
export { InMemoryGenericClaimBoard, DEFAULT_W_CORR } from './quorum-board.js';
export type {
  QuorumClaimBoard,
  BoardKindConfig,
  ClaimKind,
  GcFailMode,
  OpenGenericCell,
} from './quorum-board.js';

// Relay endpoint cache (REQ-RO-008 / D-RO-3 — relay-ID → WS-URL map + room →
// ordered relay-IDs, populated from RelayRegistered + RoomAssigned chain events).
// Extracted from apps/signaling (G3.2a) so the signaling + relay daemons share
// ONE impl. `DualRelayRouter` (ws-dependent) stays in apps/signaling.
export { InMemoryRelayEndpointCache, subscribeRelayEndpoints } from './chain/relay-endpoint-cache.js';
export type { RelayEndpointCache } from './chain/relay-endpoint-cache.js';

// OQ-7 / ADR-0021 cross-host mTLS carrier — Phase A. The operator-manifest primitive (OOB discovery
// + SPKI trust anchor + ed25519 manifest sign/verify). Off-relay shared so BOTH the cp-daemon
// (cap-token) and validator-daemon (canary) carriers import it WITHOUT a cross-app import. No
// transport yet — additive, vanilla stack byte-identical (nothing imports it until the TLS phases).
export {
  spkiFingerprint,
  signManifest,
  verifyManifest,
  loadManifests,
  canonicalManifestBytes,
} from './operator-manifest.js';
export type {
  OperatorManifest,
  RelayPipeDescriptor,
  SignedManifest,
  ManifestVerifyResult,
} from './operator-manifest.js';

// OQ-7 / ADR-0021 cross-host mTLS carrier — Phase D-1 PROMOTE. The GENERIC (carrier-agnostic)
// SPKI-pin primitives single-sourced out of apps/cp-daemon so the canary carrier (validator-daemon)
// reuses the SAME security-critical pin code WITHOUT a cross-app import. The cap-token-specific thin
// wrappers (flag name, route, config) stay in apps/cp-daemon and re-point to these.
export {
  isPeerSpkiTrusted,
  createMtlsServer,
  buildPinnedDispatcher,
  manifestsToTrustedSpki,
} from './mtls-carrier.js';
export type {
  MtlsServerConfig,
  PinnedDispatcherConfig,
} from './mtls-carrier.js';

// OQ-7 / ADR-0021 carrier — DRY extraction (2026-06-23 review D1+D2). The two per-carrier claim
// servers (cap-token /quorum/claims + canary /canary/claims) shared a near-identical port-collision
// guard (incl. the drift-prone in-use daemon-port SET) and a byte-identical constant-time bearer
// check. Single-sourced here; each carrier keeps only its own DEFAULT_*_PORT + *_AUTH_TOKEN env name
// and delegates. PURE (no transport) — the per-carrier modules stay behavior-preserving wrappers.
export { DAEMON_PORTS_IN_USE, assertClaimsPortFree, resolveClaimsPort } from './claims-port.js';
export { isBearerAuthorized } from './bearer-auth.js';

// Committed room-provisioning lifecycle (register_user → create_room → assign_relay_and_signaling),
// extracted from validator-daemon __tests__ so the test helper + scripts/demo/provision-room.ts share
// ONE source. fundAddress is injected so this stays test-free.
export { createRoomWithRelay, extractRoomId, signAndAssert } from './chain/provision-room.js';
export type { TxStatusLike } from './chain/provision-room.js';

// Vendored SFrame/E2EE crypto (services/client/client/src/lib/{webrtc,crypto}/*.ts).
// validator-daemon's canary forwarding-integrity verifier and relay's SFrame
// integration tests need the EXACT client crypto ("reuses the SHIPPED client crypto
// verbatim"), not a reimplementation. Vendored here (not imported cross-repo, since
// services/client is a separate git submodule unreachable from the Docker build
// context) so BOTH validator-daemon and relay import it WITHOUT a cross-app or
// cross-repo import. Keep byte-identical to the client source; resync manually if it
// changes there.
export {
  SFRAME_TRAILER_LEN,
  SFRAME_IV_LEN,
  MAX_CODEC_OFFSET,
  codecOffsetForFrameType,
  writeSframeTrailer,
  readSframeTrailer,
  deriveFrameIv,
  encryptFrame,
  decryptFrame,
} from './crypto-webrtc/sframe-transform.js';
export type {
  FrameKind,
  FrameHeader,
  ParsedTrailer,
  KeyLookup,
} from './crypto-webrtc/sframe-transform.js';

export {
  initSodium,
  bytesEqual,
  generateSyntheticMember,
  generateRoomKey,
  sealRoomKeyToRoster,
  openOwnEnvelope,
  electCoordinator,
  electCoordinatorWithLiveness,
  ratchetOnJoin,
  freshRekeyOnLeave,
  KidKeyStore,
  importRoomKeyNonExtractable,
  PathAKeyDerivation,
  PathCKeyDerivation,
  bridgeMystenSeedToOpener,
} from './crypto-webrtc/e2ee-spike.js';
export type {
  SyntheticMember,
  SealedEnvelope,
  E2EEKeyBundle,
  KeyDerivationInput,
  KeyDerivation,
  MystenOpener,
} from './crypto-webrtc/e2ee-spike.js';

export { assertSenderIdSafe, KeyManager } from './crypto-webrtc/key-manager.js';
export type { RosterMember, KeyManagerOptions } from './crypto-webrtc/key-manager.js';

export { createSessionKeypair } from './crypto-webrtc/session-keypair.js';
export type {
  SessionOpener,
  SessionKeypair,
  CreateSessionKeypairOptions,
} from './crypto-webrtc/session-keypair.js';

// Node-only mediasoup-client protocol primitives (join/transport/produce wiring +
// @roamhq/wrtc globalThis bootstrap), extracted from scripts/bench/mediasoup-client-harness.ts
// so both the bench harness and apps/bot share ONE implementation of the relay wire protocol.
export {
  ensureNodeWebRtcGlobals,
  loadWrtcNonstandard,
  RelayClient,
  createWiredTransport,
} from './mediasoup-node/index.js';
export type {
  WrtcNonstandard,
  RelayMessage,
  WsLike,
  RelayClientLogger,
  RelayClientContext,
  IceServerLike,
} from './mediasoup-node/index.js';
