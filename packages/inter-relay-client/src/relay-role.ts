/**
 * Relay role manager — role identification + pipe-port range/allocation.
 *
 * Pure extraction from relay-role-manager.ts (which is now a barrel — see its
 * module doc). Identifies whether this relay daemon is the primary or standby
 * for a room by reading assigned_relays[] from the RoomAssigned chain event,
 * and manages the PIPE_PORT_RANGE parsing + per-(room,role) port allocation
 * the warm pipe binds to.
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 * ADR: ADR-0009 (relay-overlap-redundancy M1)
 */

import type { types as msTypes } from 'mediasoup';

// ── Types ──────────────────────────────────────────────────────────────

export type RelayRole = 'primary' | 'standby';

/** B1-SRTP (WAN-precursor): gate the F1 PipeTransport SRTP wrap. Single source of truth; default OFF. */
export function pipeSrtpEnabled(): boolean {
  return process.env['PIPE_SRTP'] === '1';
}

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

// ── createPipePortAllocator (REQ-RO-009) ──────────────────────────────

/**
 * Per-room + per-role PIPE_PORT allocator over [min..max].
 *
 * The warm pipe used a single hardcoded `pipePortRange.min` for every room —
 * so a 2nd room hit EADDRINUSE binding its PipeTransport. This allocator hands
 * each KEY a distinct free port and recycles on release.
 *
 * Keyed per room AND per role (`roomId` for the standby, `${roomId}:primary`
 * for the primary) so a same-host primary+standby never collide (D3).
 *
 * REQ-RMS-007 generalization: the key namespace is an OPAQUE string, so the
 * primary leg generalizes additively to `${roomId}:${peerRelayId}:primary` once
 * a room spills across MULTIPLE peer relays (mesh M2) — each (room, peerRelay)
 * pair then holds its own distinct port slot without colliding. The M1 single-
 * peer callers keep using `${roomId}:primary` unchanged (peerRelayId omitted),
 * so this allocator's contract is byte-stable for the existing warm-pipe path.
 *
 * Idempotent per key — `allocate(key)` twice returns the SAME port and consumes
 * only ONE slot (preserves the N3 not-ready re-run invariant: a coordinator
 * re-run rebinds on the SAME pipePort, never leaking a second).
 *
 * `release(key)` frees the slot (room close / `coordinator.clear`). Releasing an
 * unknown key is a no-op. Throws when the range is exhausted.
 */
export function createPipePortAllocator(range: PipePortRange): {
  allocate(key: string): number;
  release(key: string): void;
  size(): number;
} {
  const assigned = new Map<string, number>();
  const free: number[] = [];
  for (let p = range.min; p <= range.max; p++) {
    free.push(p);
  }

  return {
    allocate(key: string): number {
      // Idempotent per key — N3 re-run rebinds the same port, no second slot.
      const existing = assigned.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const port = free.shift();
      if (port === undefined) {
        throw new Error(
          `createPipePortAllocator: port range [${range.min}-${range.max}] exhausted (${assigned.size} keys assigned)`,
        );
      }
      assigned.set(key, port);
      return port;
    },
    release(key: string): void {
      const port = assigned.get(key);
      if (port === undefined) {
        // Unknown key — no-op (idempotent release; double-release is safe).
        return;
      }
      assigned.delete(key);
      free.push(port);
    },
    size(): number {
      return assigned.size;
    },
  };
}
