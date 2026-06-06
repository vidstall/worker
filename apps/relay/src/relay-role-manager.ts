/**
 * Relay role manager — warm-pipe + paused standby consumer.
 *
 * Identifies whether this relay daemon is the primary or standby for a room
 * by reading assigned_relays[] from the RoomAssigned chain event. Primary
 * creates a Router and accepts producers. Standby lazily opens pipeToRouter
 * from primary on the FIRST peer join (C7 mitigation) and creates a pipe
 * Consumer that is immediately paused (RTCP keepalive only, ~80% BW saving).
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 * ADR: ADR-0009 (relay-overlap-redundancy M1)
 */

import type { types as msTypes } from 'mediasoup';

// ── Types ──────────────────────────────────────────────────────────────

export type RelayRole = 'primary' | 'standby';

/**
 * Per-room topology state held by the relay daemon.
 * pipeConsumer is null until the first peer joins (lazy warm-pipe, C7).
 */
export interface RoomTopology {
  roomId: string;
  role: RelayRole;
  /** WebSocket endpoint of the primary relay (used by standby to open the pipe). */
  primaryEndpoint: string;
  /** WebSocket endpoint of this relay. */
  standbyEndpoint: string;
  /** Port allocated from PIPE_PORT_RANGE for the PlainTransport pipe. */
  pipePort: number;
  /**
   * The pipe Consumer on the standby relay.
   * null = lazy pipe not yet opened (pre first-peer-join).
   * non-null = paused Consumer (RTCP keepalive only, REQ-RO-005).
   */
  pipeConsumer: msTypes.Consumer | null;
  /**
   * The PipeTransport created on the standby to receive piped media.
   * null until ensureWarmPipe opens the pipe. RETAINED here so a teardown or a
   * coordinator not-ready re-run can close it — without this handle the
   * transport leaks idle on the router (N2) and a re-run on a fixed pipePort
   * risks EADDRINUSE (N3). G3.1 leak fix.
   */
  pipeTransport: msTypes.PipeTransport | null;
}

export interface PipePortRange {
  min: number;
  max: number;
}

// ── determineRole ──────────────────────────────────────────────────────

/**
 * Identifies the role of this relay for a room from the RoomAssigned event payload.
 *
 * Contract: assigned_relays[0] = primary, [1..N-1] = standby.
 * Reads .length — never hardcodes 2 (future-proof for K>2).
 *
 * Throws if ownRelayId is not found in the list (mis-assigned event — caller
 * should log and skip this room).
 */
export function determineRole(assignedRelays: string[], ownRelayId: string): RelayRole {
  const idx = assignedRelays.indexOf(ownRelayId);
  if (idx === -1) {
    throw new Error(
      `determineRole: ownRelayId "${ownRelayId}" not found in assignedRelays [${assignedRelays.join(', ')}]`,
    );
  }
  return idx === 0 ? 'primary' : 'standby';
}

// ── parsePipePortRange ─────────────────────────────────────────────────

/**
 * Parses the PIPE_PORT_RANGE env var (format: "40000-40100").
 * Returns default {min:40000, max:40100} when envValue is undefined.
 */
export function parsePipePortRange(envValue: string | undefined): PipePortRange {
  const raw = envValue ?? '40000-40100';
  const parts = raw.split('-');
  if (parts.length !== 2) {
    throw new Error(
      `parsePipePortRange: invalid format "${raw}" — expected "min-max" (e.g. "40000-40100")`,
    );
  }
  const min = parseInt(parts[0]!, 10);
  const max = parseInt(parts[1]!, 10);
  if (isNaN(min) || isNaN(max) || min >= max) {
    throw new Error(
      `parsePipePortRange: invalid port values min=${min} max=${max}`,
    );
  }
  return { min, max };
}

// ── ensureWarmPipe ─────────────────────────────────────────────────────

/**
 * Lazily establishes pipeToRouter from primary to this standby relay,
 * then creates a pipe Consumer that is immediately paused (RTCP only).
 *
 * REQ-RO-004: called on FIRST peer join (not at room-create time).
 * REQ-RO-005: pipe Consumer created with paused=true semantics via consumer.pause().
 *
 * Idempotent — if topology.pipeConsumer already exists, returns it immediately
 * without opening a second pipe transport (safe to call multiple times).
 *
 * Primary relay: returns null (primary does not pipe to itself).
 *
 * @param topology   - Room topology state (mutated: pipeConsumer set on success).
 * @param router     - The mediasoup Router on the standby relay.
 * @param pipePort   - Local port for the PlainTransport pipe (from PIPE_PORT_RANGE).
 * @param producerId - The PRIMARY's real pipe-producer ID, resolved from the
 *                     inter-relay announce (see inter-relay.ts). When omitted,
 *                     a clearly-marked `pipe-producer-pending-<roomId>` placeholder
 *                     is used (no real producer announced yet — G1 fallback).
 * @returns The paused Consumer, or null for primary / on error.
 */
export async function ensureWarmPipe(
  topology: RoomTopology,
  router: msTypes.Router,
  pipePort: number,
  producerId?: string,
): Promise<msTypes.Consumer | null> {
  // Primary relay does not call pipeToRouter
  if (topology.role === 'primary') {
    return null;
  }

  // Idempotency guard — pipe already established
  if (topology.pipeConsumer !== null) {
    return topology.pipeConsumer;
  }

  // N3 leak fix: a prior not-ready run (the StandbyWarmPipeCoordinator re-run)
  // resets pipeConsumer to null while leaving its PipeTransport bound. Close the
  // stale transport before rebinding so we neither leak it nor hit EADDRINUSE on
  // a fixed pipePort.
  if (topology.pipeTransport !== null) {
    topology.pipeTransport.close();
    topology.pipeTransport = null;
  }

  // Create a PipeTransport on the standby router to receive piped media.
  // The primary will connect its end via a paired pipeToRouter call.
  // listenIp '0.0.0.0' with the dedicated pipe port from PIPE_PORT_RANGE;
  // announcedIp is the deploy-routable address the primary connects back to,
  // externalized via ANNOUNCED_IP (default loopback for local/bench). Mirrors
  // the room-handler.ts WebRTC-transport pattern.
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
  const pipeTransport = await router.createPipeTransport({
    listenIp: { ip: '0.0.0.0', announcedIp },
    port: pipePort,
    enableRtx: false,
    enableSrtp: false,
  } as Parameters<msTypes.Router['createPipeTransport']>[0]);

  // N2 leak fix: retain the transport so teardown / a coordinator re-run can
  // close it (an un-retained transport leaks idle on the router until exit).
  topology.pipeTransport = pipeTransport;

  // Consume from the pipe transport — the producer lives on the primary Router.
  // G1 wiring: the caller (signaling layer) resolves the PRIMARY's real
  // producerId from the inter-relay announce registry (inter-relay.ts) and
  // passes it here. If no producer has been announced yet, we fall back to a
  // CLEARLY-MARKED `pipe-producer-pending-<roomId>` placeholder — the standby
  // re-runs ensureWarmPipe once the announce arrives (the topology.pipeConsumer
  // idempotency guard is reset by the caller in that not-ready path).
  const resolvedProducerId = producerId ?? `pipe-producer-pending-${topology.roomId}`;
  const consumer = await pipeTransport.consume({
    producerId: resolvedProducerId,
  } as Parameters<msTypes.PipeTransport['consume']>[0]);

  // REQ-RO-005: pause immediately — RTCP keepalive only, saves ~80% pipe BW.
  // F55-safe: pause() is the same primitive used by the F55 paused-flag invariant.
  await consumer.pause();

  // Store on topology for idempotency + later resume on cutover
  topology.pipeConsumer = consumer;

  return consumer;
}
