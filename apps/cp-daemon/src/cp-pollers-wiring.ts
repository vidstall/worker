/**
 * CP Daemon — event handler + bootstrap replay + EventPollers wiring.
 *
 * Pure extraction from index.ts's main(): the RelayPromoted observer, the
 * REQ-RMS-022 attested-placement load poller, createEventHandler wiring, the
 * F61 rpc_error_rate/event_lag health signals, the historical-events bootstrap
 * replay, the 8 control-plane EventPollers, and their aggregate start/stop.
 */

import { join } from 'node:path';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, NetworkConfig } from '@dvconf/shared';
import { EventPoller, queryHistoricalEvents } from '@dvconf/shared';
import { createEventHandler, extractEventName } from './event-handler.js';
import { startAttestedLoadPoller, type AttestedLoadPoller } from './attested-load-poller.js';
import { recordRoomLifecycleTimestamp, type RoomLifecycleTimestamps } from './room-expiry-sweep.js';
import type { CapTokenIssuer } from './cap-token/index.js';
import type { TurnIssuer } from './turn-issuer.js';
import type { NodeCandidate } from './scoring.js';

export interface CpPollersParams {
  client: SuiClient;
  graphqlClient: SuiGraphQLClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  logger: Logger;
  turnIssuer: TurnIssuer;
  capTokenIssuer: CapTokenIssuer;
  /** Shared with cp-watchers-wiring.ts's room-expiry sweep — trackedHandler writes into it. */
  roomTimestamps: Map<string, RoomLifecycleTimestamps>;
}

export interface CpPollers {
  relayState: Map<string, NodeCandidate>;
  validatorState: Map<string, NodeCandidate>;
  retryPendingAssignments: () => void;
  getRpcErrorRate: () => number;
  getEventLagMs: () => number;
  pollIntervalMs: number;
  attestedLoadPoller: AttestedLoadPoller | undefined;
  stopPollers: () => void;
}

export async function buildCpPollers(params: CpPollersParams): Promise<CpPollers> {
  const { client, graphqlClient, signer, config, cpCapId, logger, turnIssuer, capTokenIssuer, roomTimestamps } = params;

  // M1 Phase 3.1 (REQ-RO-009 / C8) — RelayPromoted observer. The chain-authoritative
  // promotion event is the split-brain resolver: when room_manager::promote_relay
  // emits RelayPromoted, the cp-daemon records it (the canonical Stay decision). The
  // client drives its own re-discovery off the same on-chain event via
  // useRelayDiscovery; the daemon-side observer is the audit + future hook point.
  const relayPromotedObserver = {
    onRelayPromoted: async (
      evt: { room_id: string; old_primary: string; new_primary: string; epoch: number },
      traceId: string,
    ): Promise<void> => {
      logger.info(
        {
          trace_id: traceId,
          module: 'cp-daemon',
          action: 'relay-promoted-observed',
          context: {
            roomId: evt.room_id,
            oldPrimary: evt.old_primary,
            newPrimary: evt.new_primary,
            epoch: evt.epoch,
          },
        },
        'RelayPromoted observed — chain-authoritative promotion recorded (Layer C)',
      );
    },
  };

  // REQ-RMS-022 (static-mesh-hardening D1) -- flag-gated attested-placement feed. Default OFF =
  // byte-stable legacy self-report placement (REQUIRED while attested rows are canary-M4b-gated:
  // a wired-but-empty feed strictly DEFERS ALL admissions, spec §2-D1). Mirrors the RMS_TREE_ACTIVE
  // flag pattern. The poller maintains ONE long-lived Map fed by reference into capacityCtx below.
  // Feed URL default = the co-located validator's VALIDATOR_CANARY_COVERAGE_PORT (8102, loopback).
  const attestedPlacementActive = process.env['RMS_ATTESTED_PLACEMENT'] === '1';
  let attestedLoadPoller: AttestedLoadPoller | undefined;
  if (attestedPlacementActive) {
    const feedUrl = process.env['RMS_LOAD_FEED_URL'] ?? 'http://127.0.0.1:8102/canary/load';
    const feedPollMs = parseInt(process.env['RMS_LOAD_FEED_POLL_MS'] ?? '5000', 10);
    attestedLoadPoller = startAttestedLoadPoller({ feedUrl, pollMs: feedPollMs, logger });
    logger.info({ module: 'cp-daemon', feedUrl, feedPollMs }, 'REQ-RMS-022: attested-load poller started (RMS_ATTESTED_PLACEMENT=1)');
  }

  const { handler, relayState, validatorState, retryPendingAssignments } = createEventHandler(logger, undefined, {
    client,
    signer,
    config,
    cpCapId,
    turnIssuer,
    capTokenIssuer,
    relayPromotedObserver,
  }, attestedPlacementActive && attestedLoadPoller
    ? { attestedLoad: attestedLoadPoller.attestedLoad } // currentEpoch/byzantineFlag stay M4b scope (both optional; spec §7 resolution)
    : undefined);

  // Retry rooms whose pairing proposal failed after executeWithRetry's own
  // retries were exhausted (a transient chain-state race, not a permanent
  // failure -- see room_manager E_INVALID_BALLOT history). Without this,
  // such a room stays stuck until the whole daemon restarts and replays
  // events from genesis (a side effect of the .cursors persistence gap, not
  // something to rely on).
  const roomRetryIntervalMs = parseInt(process.env['ROOM_RETRY_INTERVAL_MS'] ?? '30000', 10);
  const roomRetryTimer = setInterval(() => retryPendingAssignments(), roomRetryIntervalMs);
  roomRetryTimer.unref?.();

  // ── F61 health signals (DOH-014) ──────────────────────────────────────────
  // rpc_error_rate: queryEvents failures / attempts, sampled at the bootstrap loop
  // (the verified in-daemon queryEvents catch — the EventPoller's internal poll is
  // private to @dvconf/shared, untouched). HONEST CARRY-FORWARD: the bootstrap loop
  // runs once at startup, so this is a startup-RPC-health gauge; a continuously
  // refreshed rate would need a net-new periodic probe (deferred, OQ-DOH-3).
  let rpcErrors = 0;
  let rpcTotal = 0;
  const getRpcErrorRate = (): number => (rpcTotal === 0 ? 0 : rpcErrors / rpcTotal);
  // event_lag: now - newest handled event timestamp (continuously updated by the
  // tracked handler below). Primes 0 (= healthy) until the first event is seen.
  let newestEventTsMs = 0;
  const getEventLagMs = (): number =>
    newestEventTsMs === 0 ? 0 : Math.max(0, Date.now() - newestEventTsMs);
  // Additive wrapper: stamp the newest event ts then delegate to the real handler
  // (event-handler.ts + its RelaySlashed arm untouched). Used by the bootstrap
  // replay + all pollers below.
  const trackedHandler = async (ev: SuiEvent): Promise<void> => {
    const ts = ev.timestampMs ? Number(ev.timestampMs) : 0;
    if (ts > newestEventTsMs) newestEventTsMs = ts;
    recordRoomLifecycleTimestamp(ev, roomTimestamps, extractEventName);
    await handler(ev);
  };

  // Bootstrap: replay historical relay/validator events so state maps are populated
  // before real-time polling starts (prevents race where relay registers before CP poller runs)
  for (const mod of ['relay_registry', 'validator_registry', 'registration'] as const) {
    try {
      const events = await queryHistoricalEvents(graphqlClient, config.originalPackageId ?? config.packageId, mod, 100);
      rpcTotal++; // F61 rpc_error_rate: a successful queryEvents attempt (DOH-014)
      for (const ev of events) {
        await trackedHandler(ev);
      }
      logger.info({ module: mod, count: events.length }, 'Bootstrap: replayed historical events');
    } catch (err) {
      rpcErrors++; // F61 rpc_error_rate: a failed queryEvents attempt (DOH-014)
      rpcTotal++;
      logger.warn({ module: mod, err }, 'Bootstrap: failed to query historical events');
    }
  }
  logger.info(
    { relays: relayState.size, validators: validatorState.size },
    'Bootstrap complete — state maps populated',
  );

  // Poll relay_registry events
  const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);
  // DATA_DIR (mirrors ChainEventListener's own default), NOT process.cwd(),
  // so a container recreate (redeploy) doesn't force a full event-history
  // replay from genesis.
  //
  // Namespaced by originalPackageId: a GraphQL events cursor is an OPAQUE
  // pagination token scoped to the exact `filter: { type }` query it was
  // issued for (see events.ts's EVENTS_QUERY / originalPackageId doc). A
  // fresh `sui client publish` (not `upgrade` -- a brand-new package, not an
  // in-place upgrade of the same one) changes originalPackageId, so any
  // cursor persisted under the OLD package is meaningless for the NEW
  // package's event stream -- confirmed live: after a republish, cp-daemon
  // kept the stale cursor (DATA_DIR is a host-mounted volume that survives
  // container recreation), the room_manager_events/economic_layer_events
  // pollers silently never advanced past it, and RoomCreated/EscrowCreated
  // were never observed even though get_active_room_ids (a direct devInspect,
  // not event-sourced) correctly saw the room -- rooms stayed pending
  // forever with zero pairing proposals from any CP. Scoping the cursor
  // path by package keeps the intended "redeploy doesn't replay everything"
  // behavior for ordinary redeploys of the SAME package, while a republish
  // naturally starts every poller from a fresh (missing) cursor file --
  // EventPoller.loadCursor() then defaults to null, i.e. a correct replay
  // from genesis for the new package.
  const cursorPkg = config.originalPackageId ?? config.packageId;
  const cursorDir = (name: string): string =>
    join(process.env['DATA_DIR'] ?? '.', '.cursors', cursorPkg, name);

  const relayPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'relay_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('relay_registry.json'),
    logger: logger.child({ poller: 'relay_registry' }),
  });

  const cpPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'control_plane_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('control_plane_registry.json'),
    logger: logger.child({ poller: 'control_plane_registry' }),
  });

  const roomPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    // room_manager.move's RoomCreated/RoomAssigned etc. structs are actually
    // DEFINED in the companion room_manager_events module (LOC-budget split
    // -- see room_manager/events.move) -- events are pinned to whichever
    // module FIRST DEFINED the struct, not the module that called the emit
    // wrapper, so this filter must name room_manager_events or it silently
    // matches zero events forever. Confirmed via live GraphQL introspection
    // against a real create_room tx (module 'room_manager' returned no
    // events at all; 'room_manager_events' returned the RoomCreated node).
    module: 'room_manager_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('room_manager.json'),
    logger: logger.child({ poller: 'room_manager' }),
  });

  const economicPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    // Same LOC-budget split as room_manager above -- EscrowCreated etc. are
    // defined in economic_layer_events (economic_layer/events.move), not
    // economic_layer itself.
    module: 'economic_layer_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('economic_layer.json'),
    logger: logger.child({ poller: 'economic_layer' }),
  });

  const validatorPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('validator_registry.json'),
    logger: logger.child({ poller: 'validator_registry' }),
  });

  const roleVotingPoller = new EventPoller({
    client: graphqlClient,
    // Package split (see services/contract/role-voting): role_voting_events
    // is now defined in the SEPARATE dvconf_role_voting package -- NOT an
    // "original package" of dvconf_contracts (that's for a module added in a
    // later upgrade of the SAME package; this is a different package
    // entirely, with its own address and no packageId fallback that would
    // ever be correct).
    packageId: config.roleVotingPackageId,
    module: 'role_voting_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('role_voting.json'),
    logger: logger.child({ poller: 'role_voting' }),
  });

  const registrationPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    // Same LOC-budget split -- registration.move's events are defined in the
    // companion registration_events module (`use dvconf::registration_events`).
    module: 'registration_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('registration.json'),
    logger: logger.child({ poller: 'registration' }),
  });

  // F8 (REQ-CRR-005) — poll turn_credential events so the cp-daemon observes
  // emergency relay-secret rotations (SecretRotated) and arms the TURN issuer
  // kill-switch via handleEvent → turnIssuer.emergencyEvictSecret. Live-only
  // (no historical replay): SecretRotated is an emergency kill-switch; replaying
  // past rotations on restart would only re-evict already-evicted secrets (no-op).
  const turnCredentialPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'turn_credential',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('turn_credential.json'),
    logger: logger.child({ poller: 'turn_credential' }),
  });

  // Start all pollers (trackedHandler stamps the event-lag gauge then delegates)
  await Promise.all([
    relayPoller.start(trackedHandler),
    cpPoller.start(trackedHandler),
    roomPoller.start(trackedHandler),
    economicPoller.start(trackedHandler),
    validatorPoller.start(trackedHandler),
    roleVotingPoller.start(trackedHandler),
    registrationPoller.start(trackedHandler),
    turnCredentialPoller.start(trackedHandler),
  ]);

  const stopPollers = (): void => {
    relayPoller.stop();
    cpPoller.stop();
    roomPoller.stop();
    economicPoller.stop();
    validatorPoller.stop();
    roleVotingPoller.stop();
    registrationPoller.stop();
    turnCredentialPoller.stop();
    attestedLoadPoller?.stop(); // REQ-RMS-022 (D1) — undefined when RMS_ATTESTED_PLACEMENT unset
  };

  return {
    relayState,
    validatorState,
    retryPendingAssignments,
    getRpcErrorRate,
    getEventLagMs,
    pollIntervalMs,
    attestedLoadPoller,
    stopPollers,
  };
}
