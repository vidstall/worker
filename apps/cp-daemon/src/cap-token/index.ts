/**
 * cap-token — barrel export.
 *
 * F62 M1 Stage 3 / Phase 3.1 — the cp-daemon's RoomCapability issuance/refresh/
 * revoke module, split (god-file split) out of the former monolithic
 * `cap-token-issuer.ts` + the `index.ts` bootstrap block:
 *   - `types.ts`               — DI shapes + event payload shapes + issuer options.
 *   - `canonical-messages.ts`  — MOVE-CONTRACT byte-layout wire-message builders
 *                                (`buildIssueCanonicalMsg` et al.) — byte-identical
 *                                to the on-chain Move module; do not reformat.
 *   - `infra-peer-recovery.ts` — Multi-CP quorum Leg 2/3 (G1/G3) attest predicate +
 *                                infra-peer pubkey recovery cache.
 *   - `quorum.ts`              — Multi-CP quorum Leg 4/6 (G2) assembler + the
 *                                `captoken-issue` claim-board config.
 *   - `issuer.ts`              — the `CapTokenIssuer` class.
 *   - `bootstrap.ts`           — the `startCapTokenIssuer` factory + LocalCpKeystore
 *                                + the Leg 7d live `/quorum/claims` board selection.
 *
 * Re-exports every name importable from the former `cap-token-issuer.ts` (unchanged
 * import paths for external consumers via `./cap-token/index.js`) plus the bootstrap
 * factory surface `index.ts` needs back.
 */

// ── types.ts ───────────────────────────────────────────────────────────────
export type {
  CapTokenCacheLike,
  SubmitResult,
  SubmitFn,
  CpKeystore,
  RoomAssignedEvent,
  RoleChangedEvent,
  RoleAssignedEvent,
  RelaySlashedEvent,
  EmergencyRotationEvent,
  CapTokenIssuerOpts,
} from './types.js';

// ── canonical-messages.ts ────────────────────────────────────────────────
export {
  resolvePeerPubkey,
  buildIssueCanonicalMsg,
  buildRevokeCanonicalMsg,
  buildRefreshCanonicalMsg,
} from './canonical-messages.js';
export type { CapTokenIssueClaim, CapTokenIssueAttestation } from './canonical-messages.js';

// ── infra-peer-recovery.ts ───────────────────────────────────────────────
export {
  rebuildCanonicalAndSignIfMatches,
  shouldWireInfraPeerRecovery,
  InfraPeerPubkeyCache,
  recoverInfraPeerClaim,
} from './infra-peer-recovery.js';
export type { CapabilityIssuedLike } from './infra-peer-recovery.js';

// ── quorum.ts ────────────────────────────────────────────────────────────
export { assembleCapTokenQuorum, buildCapTokenIssueBoardConfig } from './quorum.js';

// ── issuer.ts ────────────────────────────────────────────────────────────
export { CapTokenIssuer } from './issuer.js';

// ── bootstrap.ts ─────────────────────────────────────────────────────────
export {
  buildLocalCpKeystore,
  selectQuorumClaimsBoard,
  loadQuorumClaimsCrossHostTls,
  startCapTokenIssuer,
  selectProductionSubmitFnForTest,
} from './bootstrap.js';
export type {
  ChainQuorumReader,
  StartCapTokenIssuerOptions,
  StartCapTokenIssuerResult,
  QuorumCollectorConfig,
  QuorumClaimsCrossHostTls,
} from './bootstrap.js';
