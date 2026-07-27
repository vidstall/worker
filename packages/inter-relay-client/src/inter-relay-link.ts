/**
 * Cross-daemon inter-relay WS LINK (G3.2b) — the STANDBY's outbound dial to the
 * PRIMARY's signaling server.
 *
 * Architecture (see inter-relay.ts header): the standby OPENS this link to the
 * primary (it resolves the primary's WS URL from chain via the endpoint cache);
 * the primary tags the accepted connection (Bearer INTER_RELAY_TOKEN), attaches
 * it to `interRelayLink.socket`, and pushes `pipe-producer` announces DOWN it.
 * Each announce arrives here as a `message` and is routed to `onFrame` (which
 * the wiring layer points at `handleInboundInterRelayFrame`).
 *
 * This module owns the `ws` CLIENT coupling so inter-relay.ts stays duck-typed
 * (mirrors signaling.ts owning the `ws` SERVER coupling). The live socket open
 * is otherwise isMainModule glue; it is exercised against a real `ws` server in
 * inter-relay-link.test.ts.
 *
 * Requirements: REQ-RO-004 (G1) · G3 (production cross-daemon WS wiring)
 */

import { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import { INTER_RELAY_SUBPROTOCOL } from './warm-pipe/index.js';

export interface OpenInterRelayLinkOptions {
  /** The primary relay's WS URL (resolved from chain via the endpoint cache). */
  url: string;
  /**
   * INTER_RELAY_TOKEN — sent as `Authorization: Bearer <token>` on the upgrade.
   * Omit (single-host / token-unset) to dial unauthenticated; the primary's
   * dispatch gate is then open and the link is still accepted as a client.
   */
  token?: string;
  /**
   * C6 (REQ-RMS-008) — this standby's DISTINCT inter-relay peer id, sent as
   * `x-inter-relay-peer-id: <id>` on the upgrade so the primary buckets each
   * standby under its own peerRelayId (resolveInterRelayPeerId) instead of
   * colliding on DEFAULT_PEER_RELAY_ID when ≥2 standbys link to one primary
   * (the live K_r≥2 mesh topology). Omit (single-standby / non-mesh) to dial
   * with NO peer-id header → the primary resolves DEFAULT → the M1 /
   * relay-overlap failover path is byte-for-byte unchanged.
   */
  peerRelayId?: string;
  /**
   * Called with each inbound frame (the primary's pipe-producer announces).
   * Fire-and-forget — the return is discarded (handleInboundInterRelayFrame
   * resolves to a boolean), so the type accepts any thenable/value.
   */
  onFrame: (raw: string | Buffer) => void | Promise<unknown>;
  logger?: Logger;
}

/**
 * Open the standby → primary inter-relay link. Returns the live `ws` WebSocket
 * (the caller owns close + reconnect — reconnect is the wiring layer's concern,
 * per the inter-relay.ts transport note). Wires inbound messages to `onFrame`
 * and logs the link lifecycle (open / close / error) without throwing — a flaky
 * primary link must never crash the standby daemon.
 */
export function openInterRelayLink(opts: OpenInterRelayLinkOptions): WebSocket {
  // Build the upgrade headers additively: Authorization (token) and/or the C6
  // peer-id tag. When NEITHER is set we pass NO `headers` option so the dial is
  // byte-identical to the pre-C6 / no-token call (the DEFAULT single-standby path).
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.peerRelayId) headers['x-inter-relay-peer-id'] = opts.peerRelayId;
  const ws =
    Object.keys(headers).length > 0
      ? new WebSocket(opts.url, INTER_RELAY_SUBPROTOCOL, { headers })
      : new WebSocket(opts.url, INTER_RELAY_SUBPROTOCOL);

  ws.on('open', () => {
    opts.logger?.info({ url: opts.url }, 'G3.2b: inter-relay link to primary OPEN');
  });
  ws.on('message', (data) => {
    void opts.onFrame(data as Buffer);
  });
  ws.on('close', (code) => {
    opts.logger?.warn({ url: opts.url, code }, 'G3.2b: inter-relay link to primary CLOSED');
  });
  ws.on('error', (err) => {
    opts.logger?.error({ err, url: opts.url }, 'G3.2b: inter-relay link error');
  });

  return ws;
}

// ── Standby link manager (dedup + reconnect state machine, G3.2b) ────────

/** Minimal socket the manager drives (a `ws` WebSocket satisfies this). */
export interface StandbyLinkSocket {
  // REQ-RMS-037 (D3) — 'open' widened in (type-surface only: the production `ws` socket
  // already emits it); the manager listens for it to fire onOpen(url, isReopen).
  on(event: 'close' | 'open', listener: () => void): void;
  close(): void;
  /**
   * Push a frame UP the link to the primary (REQ-RO-007 — the standby's
   * pipe-connect announce). The live `ws` socket already exposes this.
   */
  send(data: string): void;
  /** `ws` WebSocket.OPEN === 1 is the only state on which send is attempted. */
  readyState: number;
}

export interface StandbyLinkManager {
  /** (Re-)point the standby at a primary URL. No-op if already linked to it. */
  connectTo(url: string): void;
  /** Close the link + suppress all further reconnects (daemon shutdown). */
  shutdown(): void;
  /** The URL currently targeted (diagnostic). */
  currentUrl(): string | null;
  /**
   * Best-effort push of a frame UP the live link to the primary (REQ-RO-007).
   * No-op when no socket is attached or the socket is not OPEN; a send that
   * throws (link died mid-flight) is swallowed so the caller never crashes.
   */
  send(data: string): void;
}

export interface StandbyLinkManagerOptions {
  /** Opens a socket to `url` (production: openInterRelayLink → a `ws`). */
  open: (url: string) => StandbyLinkSocket;
  /** Delay (ms) before re-dialing after a non-shutdown close. */
  reconnectMs: number;
  logger?: Logger;
  /** Timer factory (default global setTimeout) — injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /**
   * REQ-RMS-037 (D3) — fired when a dialed socket reaches OPEN. isReopen=false on the
   * FIRST open per target url (part-3 A2 reversePending drain already back-fills the
   * first connect — do NOT resend there), true on every later open (the silent-drop
   * window to recover: the wiring layer re-delivers stored reverse announces).
   * A url switch and return (A→B→A) re-opens A with isReopen=true and re-sends its stored
   * frames even if the A2 drain already back-filled them — harmless, the primary's
   * reverseMintedIds dedup makes the duplicate announce an idempotent no-op.
   * A throwing callback is caught inside the manager (never crashes the socket loop).
   */
  onOpen?: (url: string, isReopen: boolean) => void;
}

/**
 * Owns the standby's single inter-relay link lifecycle so the dedup + reconnect
 * state machine is unit-testable (the live socket open stays in openInterRelayLink;
 * the assembly stays in index.ts). Invariants:
 *   - idempotent on the same URL while a link is OPEN (no stacked links);
 *   - a NEW URL closes the current link before dialing the new one;
 *   - a non-shutdown close re-dials the SAME url ONCE after `reconnectMs`
 *     (guarded so a URL switch or a second close cannot stack reconnects);
 *   - `shutdown()` closes the link and blocks every future reconnect.
 */
export function createStandbyLinkManager(opts: StandbyLinkManagerOptions): StandbyLinkManager {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  let socket: StandbyLinkSocket | null = null;
  let url: string | null = null;
  let down = false;
  // REQ-RMS-037 (D3) — target urls that have opened at least once, so onOpen can flag a
  // RE-open (vs the first connect, which the A2 drain already back-fills).
  const everOpened = new Set<string>();

  const dial = (target: string): void => {
    if (target === url && socket !== null) return; // already linked + OPEN
    url = target;
    socket?.close();
    const s = opts.open(target);
    socket = s;
    s.on('open', () => {
      if (socket !== s) return; // stale socket raced a URL switch
      const isReopen = everOpened.has(target);
      everOpened.add(target);
      try {
        opts.onOpen?.(target, isReopen);
      } catch (err) {
        // REQ-RMS-037 (D3, review fold) — a throwing onOpen must NOT escape the socket's
        // 'open' emit (uncaught on the real `ws` socket): a flaky link must never crash the
        // standby daemon (mirrors the send() best-effort guard).
        opts.logger?.warn({ err, url: target }, 'G3.2b: standby link onOpen callback threw (swallowed)');
      }
    });
    s.on('close', () => {
      if (socket === s) socket = null;
      if (down || url === null) return;
      const retry = url;
      const t = setTimer(() => {
        // Re-dial only if still targeting `retry` with no live socket (a URL
        // switch or a fresh dial in the meantime cancels this stale reconnect).
        if (!down && url === retry && socket === null) {
          opts.logger?.info({ url: retry }, 'G3.2b: re-dialing standby inter-relay link');
          dial(retry);
        }
      }, opts.reconnectMs);
      t.unref?.();
    });
  };

  return {
    connectTo: (target) => dial(target),
    shutdown: () => {
      down = true;
      socket?.close();
    },
    currentUrl: () => url,
    send: (data: string) => {
      if (!socket) {
        opts.logger?.debug('G3.2b: standby→primary send dropped — no link attached');
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        opts.logger?.debug(
          { readyState: socket.readyState },
          'G3.2b: standby→primary send dropped — link not OPEN',
        );
        return;
      }
      try {
        socket.send(data);
      } catch (err) {
        // Best-effort — link died mid-flight must not crash the caller.
        opts.logger?.warn({ err }, 'G3.2b: standby→primary send failed (link down)');
      }
    },
  };
}
