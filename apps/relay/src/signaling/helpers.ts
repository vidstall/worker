/**
 * Small pure helpers for the mediasoup signaling server: JSON send, room-mode
 * derivation, admission-password hashing/validation, and the brute-force
 * attempt-tracker record shape.
 *
 * Extracted verbatim from the original signaling.ts.
 *
 * Requirements: RELAY-05
 */

import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';

/** Send a JSON message to a WebSocket. */
export function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── W5 M2 P1.0 (REQ-MCS-012/013) — Zoom-style admission helpers ─────────

/**
 * Per-room ADMISSION config (NOT on-chain; D-M2-2). Co-located with `rooms`.
 * `passwordHash` is SHA-256(password) base64 — set by the FIRST joiner
 * (first-joiner-sets-it host model, decision #3) and matched by every later
 * joiner. NEVER stores the plaintext password.
 */
export interface RoomConfig {
  passwordHash: string;
  /**
   * W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5): the per-room E2EE flag declared by
   * the FIRST joiner (host) at create-time. Later joiners INHERIT it (read-only
   * after create). `true` ⇒ the SFrame transform is active for the room. NOT
   * on-chain (D-M2-2) — signaling/client-asserted, not tamper-evident.
   */
  e2ee: boolean;
}

/**
 * W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5 `RoomModeProperty`): the E2EE room-mode
 * state propagated to clients over signaling. `mode` is the E2EE state-machine
 * value — DISTINCT from the relay forwarding `room.mode` ('sfu'|'mcu'). Mapping:
 * an SFU room maps to 'SFU-E2EE'; an MCU room maps to 'MCU-floor' (the
 * graceful-degradation floor, D-M2-6 — the SFU-E2EE→MCU-floor consent gate is P7).
 *
 * ⚠️ HONESTY INVARIANT (D-M2-8): an MCU relay server-MIXES (decode → re-encode)
 * media, which structurally breaks SFrame content-E2EE — an MCU room is content-
 * blind to the participant by the RELAY, it is NOT end-to-end encrypted. So we
 * FORCE `e2ee:false` under MCU regardless of the host's request, keeping the
 * asserted property honest (the client badge keys on this flag). Matches
 * CONTRACTS.md §5 field-for-field.
 */
export function deriveRoomMode(
  forwardingMode: 'sfu' | 'mcu',
  e2ee: boolean,
): { e2ee: boolean; mode: 'SFU-E2EE' | 'MCU-floor' } {
  // MCU server-mixing is incompatible with SFrame E2EE → e2ee:false (honest).
  if (forwardingMode === 'mcu') return { e2ee: false, mode: 'MCU-floor' };
  return { e2ee, mode: 'SFU-E2EE' };
}

/**
 * Hash the admission room-password. Reuses the SAME approach as the shipped TURN
 * credential verifier — SHA-256 → base64 (cp-daemon `turn-issuer.ts:94-96`
 * `hashCredentialPassword`); relay is a separate app so the small helper is
 * replicated locally rather than imported. NOT a new/invented hash. The plain
 * password is NEVER logged or stored (only this digest is kept).
 */
export function hashRoomPassword(password: string): string {
  return createHash('sha256').update(password).digest('base64');
}

/**
 * Validate + return the joiner's base64 ed25519 SESSION pubkey, or `null` if it
 * is malformed (non-base64 / not exactly 32 bytes). Mirrors the cap-token-issuer
 * length-check (`cap-token-issuer.ts:251-264`) — the relay is a separate app so
 * the small check is replicated locally (no cross-app import). A `null` return
 * means admission must FAIL LOUD (no silent placeholder key).
 */
export function validateSessionPubkey(pubkeyB64: string | undefined): string | null {
  if (typeof pubkeyB64 !== 'string' || pubkeyB64.length === 0) return null;
  // Buffer.from(base64) is lenient (drops invalid chars), so a non-base64 input
  // typically surfaces as a wrong-length decode rather than a throw.
  const decoded = Buffer.from(pubkeyB64, 'base64');
  if (decoded.length !== 32) return null;
  return pubkeyB64;
}

/**
 * Per-roomId wrong-password attempt tracker — Zoom-equivalent brute-force
 * defense. Counts failed admission attempts within a sliding window; once the
 * threshold is hit, further attempts for that room are refused with a
 * rate-limit error (not a plain wrong-password error) until the window lapses.
 * A correct password (admission) resets the room's counter. Cleared when the
 * room empties (so a reused roomId starts fresh).
 */
export interface AttemptRecord {
  count: number;
  windowStart: number;
}
