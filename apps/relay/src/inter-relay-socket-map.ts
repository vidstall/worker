/**
 * REQ-RMS-008 — per-peer inter-relay socket map (multi-peer cascade).
 *
 * The M1 token gate held ONE attachedInterRelaySocket and DISPLACED on a 2nd
 * tagged peer (signaling.ts:533-539) — correct for single-standby failover, wrong
 * for a K_r-relay cascade where each peer relay needs its own live announce link.
 * This map keys live sockets by peerRelayId. detach removes only when the passed
 * socket is still the attached one (a stale close after a reconnect flap is a no-op).
 *
 * IMPORTANT: `InterRelaySocketLike` is ALREADY exported from `./inter-relay.ts:306`
 * — we REUSE it (import, do NOT redefine) so there is no Duplicate-identifier tsc
 * error when signaling.ts imports both this module and inter-relay.ts.
 */
import type { InterRelaySocketLike } from '@dvconf/inter-relay-client';

export interface InterRelaySocketMap {
  attach(peerRelayId: string, socket: InterRelaySocketLike): void;
  detach(peerRelayId: string, socket: InterRelaySocketLike): void;
  get(peerRelayId: string): InterRelaySocketLike | null;
  keys(): string[];                                  // REQ-RMS-028 — enumerate attached cascade peers
  entries(): [string, InterRelaySocketLike][];       // REQ-RMS-028
  size(): number;
}

export function createInterRelaySocketMap(): InterRelaySocketMap {
  const sockets = new Map<string, InterRelaySocketLike>();
  return {
    attach(peerRelayId, socket) { sockets.set(peerRelayId, socket); },
    detach(peerRelayId, socket) {
      if (sockets.get(peerRelayId) === socket) sockets.delete(peerRelayId);
    },
    get(peerRelayId) { return sockets.get(peerRelayId) ?? null; },
    keys() { return [...sockets.keys()]; },          // REQ-RMS-028 — enumerate attached cascade peers
    entries() { return [...sockets.entries()]; },    // REQ-RMS-028
    size() { return sockets.size; },
  };
}

/**
 * REQ-RMS-008 wiring helper (Issue #4) — the PURE attach/detach + recordPath
 * DECISIONS extracted out of signaling.ts's WS-server closure so they are
 * unit-testable RED-first (the `createSignalingServer` factory is NOT unit-
 * isolated). signaling.ts calls these; the only thing left in the closure is the
 * `ws`/`req` plumbing (the genuinely-untested residual seam, noted in Done Criteria).
 */

/** Resolve the cascade peerRelayId from the upgrade headers; default = single-peer. */
export function resolveInterRelayPeerId(
  headers: Record<string, string | string[] | undefined>,
  defaultPeerRelayId: string,
): string {
  const raw = headers['x-inter-relay-peer-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : defaultPeerRelayId;
}

/**
 * Decide whether a produce/consume success should bump the spill trigger's path
 * count. Returns true only when a SpillTrigger is wired (M1 untouched when absent).
 */
export function shouldRecordPath(spillTrigger: { recordPath(roomId: string): void } | undefined): boolean {
  return spillTrigger !== undefined;
}
