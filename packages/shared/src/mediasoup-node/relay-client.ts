/**
 * Relay protocol client — extracted from
 * `scripts/bench/mediasoup-client-harness.ts` so any Node-only mediasoup-client
 * consumer (the bench harness, `apps/bot`) shares ONE implementation of the
 * relay's WS JSON request/response protocol (`apps/relay/src/signaling.ts`:
 * `join` → `routerRtpCapabilities`, `createTransport` → `transportCreated`,
 * `produce` → `produced`, `consume` → `consumed`, push `newProducer`).
 */

export interface RelayMessage {
  type: string;
  [k: string]: unknown;
}

/** Minimal logger shape RelayClient needs — avoids a hard @dvconf/shared dep here. */
export interface RelayClientLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/** Observability-only context for the `ws.on('close', ...)` log line. */
export interface RelayClientContext {
  roomId?: string;
  peerId?: string;
  relayUrl?: string;
}

export interface WsLike {
  send: (data: string) => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  close: () => void;
  /** Optional -- only real `ws` sockets support ping/terminate. When absent,
   *  RelayClient skips the heartbeat entirely (see `startHeartbeat`) rather
   *  than throwing, so minimal test/harness `WsLike` fakes keep working
   *  unchanged. */
  ping?: () => void;
  terminate?: () => void;
}

interface PendingRequest {
  predicate: (msg: RelayMessage) => boolean;
  resolve: (msg: RelayMessage) => void;
  reject: (err: Error) => void;
}

/**
 * Tiny request/response client over the relay's WS signaling. Push messages
 * (`newProducer`) are routed to an optional callback; everything else is
 * matched by predicate against the pending request queue (first match wins).
 */
export class RelayClient {
  private readonly ws: WsLike;
  private readonly pending: PendingRequest[] = [];
  private readonly onProducer: ((msg: RelayMessage) => void) | null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongMissed = false;
  readonly ready: Promise<void>;

  constructor(
    ws: WsLike,
    onProducer: ((msg: RelayMessage) => void) | null = null,
    context: RelayClientContext = {},
    logger?: RelayClientLogger,
    onClose?: () => void,
    /** Mirrors the relay-side `WS_HEARTBEAT_INTERVAL_MS` liveness pattern
     *  from the client's perspective: a relay whose TCP connection dies
     *  without a clean close (network blip, laptop sleep) never fires
     *  `ws.on('close')`, so the bot would otherwise sit forever believing a
     *  dead relay is still live. Env-read at the app boundary (apps/bot),
     *  not here -- this package stays env-agnostic. */
    heartbeatIntervalMs = 30_000,
  ) {
    this.ws = ws;
    this.onProducer = onProducer;
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.on('open', () => {
        this.startHeartbeat(heartbeatIntervalMs);
        resolve();
      });
      // Without this, a connect failure (dead/unreachable relay endpoint --
      // e.g. a stale on-chain registration) emits 'error' on `ws` with zero
      // listeners attached, which Node's EventEmitter special-cases into a
      // synchronous throw that crashes the whole process instead of just
      // rejecting `ready` and failing this one session/request.
      this.ws.on('error', (...args: unknown[]) => {
        const err = args[0];
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    // Bare observability (log line) plus an optional caller hook (`onClose`)
    // so a standby-aware caller (apps/bot's BotPeer) can react to a mid-session
    // relay death instead of it being silently invisible.
    this.ws.on('close', () => {
      this.stopHeartbeat();
      logger?.warn({ ...context }, 'RelayClient: relay WS closed');
      onClose?.();
    });
    this.ws.on('pong', () => {
      this.pongMissed = false;
    });
    this.ws.on('message', (...args: unknown[]) => {
      const data = args[0];
      const raw =
        typeof data === 'string'
          ? data
          : data instanceof Buffer
            ? data.toString('utf8')
            : String(data);
      let msg: RelayMessage;
      try {
        msg = JSON.parse(raw) as RelayMessage;
      } catch {
        return;
      }
      this.routeIncoming(msg);
    });
  }

  /** Test seam — feed an incoming message into the routing logic. */
  routeIncoming(msg: RelayMessage): void {
    if (msg.type === 'newProducer' && this.onProducer !== null) {
      this.onProducer(msg);
      return;
    }
    for (let i = 0; i < this.pending.length; i++) {
      if (this.pending[i]!.predicate(msg)) {
        const [matched] = this.pending.splice(i, 1);
        matched!.resolve(msg);
        return;
      }
    }
  }

  send(msg: RelayMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(predicate: (msg: RelayMessage) => boolean, timeoutMs = 10_000): Promise<RelayMessage> {
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error('Relay response timeout'));
      }, timeoutMs);
      this.pending.push(entry);
    });
  }

  close(): void {
    this.stopHeartbeat();
    this.ws.close();
  }

  /** Standard `ws` ping/pong liveness pattern, client side: each tick,
   *  terminate the socket if the last ping went unanswered, otherwise ping
   *  again and reset the flag. `terminate()` (or `close()` as a fallback for
   *  a `WsLike` without it) reuses the SAME `ws.on('close', ...)` handler
   *  above -- no separate dead-relay codepath. Skipped entirely when `ws`
   *  doesn't support `ping` (e.g. a minimal test/harness fake), matching the
   *  relay-side inter-relay-peer exemption in spirit: no liveness support,
   *  no heartbeat loop. Worst-case detection time is 2x `intervalMs`. */
  private startHeartbeat(intervalMs: number): void {
    if (this.ws.ping === undefined) return;
    this.pongMissed = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.pongMissed) {
        this.stopHeartbeat();
        if (this.ws.terminate !== undefined) this.ws.terminate();
        else this.ws.close();
        return;
      }
      this.pongMissed = true;
      this.ws.ping!();
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
