/**
 * CP Daemon — TURN + cap-token + quorum-claims bootstrap wiring.
 *
 * Pure extraction from index.ts's main(): the TURN issuer (+ optional TURN
 * RPC HTTP server), the multi-CP quorum-claims Leg 7d /quorum/claims live
 * carrier + board selection, and the F62 CapTokenIssuer bootstrap.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, NetworkConfig } from '@dvconf/shared';
import { InMemoryGenericClaimBoard } from '@dvconf/shared';
import { startTurnIssuer } from './turn-issuer.js';
import { startTurnRpc } from './turn-rpc.js';
import {
  buildCapTokenIssueBoardConfig,
  InfraPeerPubkeyCache,
  shouldWireInfraPeerRecovery,
  loadQuorumClaimsCrossHostTls,
  selectQuorumClaimsBoard,
  startCapTokenIssuer,
} from './cap-token/index.js';
import { startQuorumClaimsServer } from './quorum-claims-server.js';
import type { SuiChainStateReader } from './sui-chain-state-reader.js';

export interface CpIssuersParams {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  logger: Logger;
  /** The revote-watcher's SuiChainStateReader (cp-watchers-wiring.ts) — reused for Leg 7c discovery reads. */
  reader: SuiChainStateReader;
}

export interface CpIssuers {
  turnIssuer: Awaited<ReturnType<typeof startTurnIssuer>>['issuer'];
  capTokenIssuer: Awaited<ReturnType<typeof startCapTokenIssuer>>['issuer'];
  turnRotationIntervalMs: number;
  stopTurnIssuer: () => void;
  stopTurnRpc: (() => void) | null;
  stopCapTokenIssuer: () => void;
  stopQuorumClaimsServer: (() => Promise<void>) | null;
}

export async function buildCpIssuers(params: CpIssuersParams): Promise<CpIssuers> {
  const { client, signer, config, cpCapId, logger, reader } = params;

  // Bootstrap TURN issuer (S30.B Option A — ADR-0005 hybrid 24h+on-slash rotation)
  const turnRotationIntervalMs = parseInt(
    process.env['TURN_ROTATION_INTERVAL_MS'] ?? '86400000',
    10,
  );
  const { issuer: turnIssuer, stop: stopTurnIssuer } = await startTurnIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpCapId,
    logger,
    rotateIntervalMs: turnRotationIntervalMs,
  });

  // S30.C: Optional TURN RPC HTTP server. Enabled iff TURN_RPC_TOKEN is set.
  // Relay daemon fetches credentials via POST /turn/issue during client room-join.
  const turnRpcToken = process.env['TURN_RPC_TOKEN'];
  const stopTurnRpc = turnRpcToken
    ? (
        await startTurnRpc({
          issuer: turnIssuer,
          port: parseInt(process.env['TURN_RPC_PORT'] ?? '8090', 10),
          token: turnRpcToken,
          logger,
        })
      ).stop
    : null;

  // F62 Stage 4 Item #1 — bootstrap CapTokenIssuer.
  // Leg 7c — the DEAD-ON-PROD discovery reads + peer-pubkey recovery are now promoted onto the
  // prod path: a multi-CP (threshold>=2) issue sources `min_quorum` (per-round, no cache) +
  // the active-CP operator set from chain via the SAME `reader` the revote-watcher uses, and
  // FAILS CLOSED if QUORUM_STATE_OBJECT_ID is unset (no silent minQuorum=2). The
  // InfraPeerPubkeyCache is fed off the event-handler CapabilityIssued observer (G3) so a
  // multi-CP infra-peer mint recovers the real 32-byte key (no 916 abort). Single-CP startup
  // is unaffected (threshold<=1 never reads the quorum-state object).
  const capTokenIssuerThreshold = parseInt(
    process.env['CAP_TOKEN_QUORUM_THRESHOLD'] ?? '2',
    10,
  );

  // ── Multi-CP quorum Leg 7d — LIVE-mode /quorum/claims carrier + board selection ──────────────
  //
  // ROADMAP Leg 7d: when QUORUM_CLAIMS_ENABLED is set, start the Leg-7a carrier (over a shared
  // server-side InMemoryGenericClaimBoard with the captoken-issue config) and select a
  // HttpQuorumClaimBoard CLIENT pointed at it — injected into the keystore's quorumCollector.board
  // as a PURE transport substitution. When unset (the HERMETIC default), `selectQuorumClaimsBoard`
  // returns undefined → the keystore keeps its in-memory board BYTE-IDENTICAL (nothing starts, no
  // server, no port). The server's stop() registers in the LAST shutdown group (mirror turn-rpc).
  //
  // OQ-7 cross-host boot-wiring (gap #1): when QUORUM_CLAIMS_TLS_ENABLED is on, `loadQuorumClaimsCrossHostTls`
  // loads this CP's cert/key + the signed operator-manifest bundle and derives the trusted-SPKI set;
  // the same material threads into BOTH the server fork (opts.tls) and the client (opts.tls). When the
  // flag is OFF it returns undefined → no file read, no tls → byte-identical loopback. C4 rendezvous =
  // leader-hosts-board: this CP HOSTS the board only when QUORUM_CLAIMS_PEER_URL is unset (single-host
  // default: peer URL unset → hosts, exactly as before); a FOLLOWER sets QUORUM_CLAIMS_PEER_URL to the
  // leader and consumes the leader's board WITHOUT starting a local server.
  const quorumClaimsCrossHostTls = await loadQuorumClaimsCrossHostTls({ logger });
  const quorumCollectorBoard = selectQuorumClaimsBoard({
    logger,
    ...(quorumClaimsCrossHostTls !== undefined && { tls: quorumClaimsCrossHostTls.clientTls }),
  });
  let stopQuorumClaimsServer: (() => Promise<void>) | null = null;
  const quorumClaimsPeerUrl = process.env['QUORUM_CLAIMS_PEER_URL'];
  const hostsQuorumClaimsBoard =
    quorumCollectorBoard !== undefined &&
    (quorumClaimsPeerUrl === undefined || quorumClaimsPeerUrl === '');
  if (hostsQuorumClaimsBoard) {
    const serverBoard = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({
        minDistinct: capTokenIssuerThreshold,
        // Fail-LOUD escalation is the CLIENT-side collector closure (never serialized); the
        // server-side board only runs state-GC, so this hook is a benign no-op here.
        onUnquorumedExpiry: () => {},
      }),
    ]);
    const quorumClaimsServer = await startQuorumClaimsServer({
      board: serverBoard,
      logger,
      ...(quorumClaimsCrossHostTls !== undefined && { tls: quorumClaimsCrossHostTls.serverTls }),
    });
    stopQuorumClaimsServer = quorumClaimsServer.stop;
    logger.info({ module: 'cp-daemon' }, 'quorum/claims live carrier started');
  }

  // Leg 7c (G3) recovery is a MULTI-CP mechanism (threshold>=2): it recovers the real 32-byte
  // peer_pubkey from a PRIOR CapabilityIssued event. A single-CP issuer (threshold<=1) has no seed
  // path, so wiring the cache fail-closed-SKIPs the first infra mint forever (no CapabilityIssued
  // ever emitted) — single-CP must fall back to the legacy resolvePeerPubkey mint (F62-proven).
  const infraPeerCache = shouldWireInfraPeerRecovery(capTokenIssuerThreshold)
    ? new InfraPeerPubkeyCache()
    : undefined;
  const { issuer: capTokenIssuer, stop: stopCapTokenIssuer } = await startCapTokenIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpRegistryObjectId: process.env['CP_REGISTRY_OBJECT_ID'] ?? '',
    quorumStateObjectId: process.env['QUORUM_STATE_OBJECT_ID'] ?? '',
    quorumThreshold: capTokenIssuerThreshold,
    logger,
    // Leg 7c — promote G5 (discovery) + G3 (recovery) onto the prod path.
    chainReader: reader, // reuse the revote-watcher's SuiChainStateReader (one instance)
    networkConfig: config,
    infraPeerCache,
    // Leg 7d — inject the selected live board (or undefined → hermetic in-memory default).
    ...(quorumCollectorBoard !== undefined && { quorumCollectorBoard }),
  });

  return {
    turnIssuer,
    capTokenIssuer,
    turnRotationIntervalMs,
    stopTurnIssuer,
    stopTurnRpc,
    stopCapTokenIssuer,
    stopQuorumClaimsServer,
  };
}
