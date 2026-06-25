// apps/validator-daemon/src/canary/test-support/real-signaling-harness.ts
/**
 * M2b-live-WAN Sub-lane B — Task 2 (A4-live) TEST-SUPPORT. Boots the REAL PRODUCTION relay
 * signaling server (`createSignalingServer`) over a loopback WebSocket so a real browser canary
 * can do a REAL signaling JOIN (covert no-password path) + a REAL WebRtcTransport/DTLS PRODUCE,
 * with the produced producer landing on the TEST-OWNED `relayRouter` (the "router-handle bridge").
 *
 * THE BRIDGE: `createSignalingServer` mints a room's router via `manager.getNextWorker()` then
 * `manager.createRouter(worker)` (signaling.ts:854-855). We inject a `MediasoupManager`-shaped
 * object whose `createRouter(...)` IGNORES the worker and hands back the caller's `relayRouter`, so
 * the browser's real produce lands on the SAME router the test's `startEvilRelayForward` +
 * `createPrimaryPipeTransport` tap. (The prod `mediasoup-manager.ts` does not expose created
 * routers, hence this injected manager — the ONLY seam needed; we re-use ALL production join/
 * createTransport/connectTransport/produce handlers verbatim via `createSignalingServer`.)
 *
 * NO cap-token / NO password (Task-0): the relay media-plane signaling has no authHook; the
 * admission gate engages ONLY when the join carries `roomPassword`. The canary page sends a bare
 * `{type:'join',roomId}` → the legacy/covert path admits it. `capTokenForCanary` is `undefined`.
 *
 * Loopback DTLS/ICE: the prod `createWebRtcTransport` (room-handler.ts:108) listens on
 * `0.0.0.0` and announces `ANNOUNCED_IP` (default `127.0.0.1`) — identical to the proven A3b
 * mock-ingest. We force `ANNOUNCED_IP=127.0.0.1` + `WS_PORT=0` (ephemeral) for the call and restore
 * the prior env after the server binds.
 *
 * ADDITIVE / TEST-SUPPORT ONLY: lives under canary/test-support/**. It DOES import production
 * relay signaling (allowed for a harness) but MUST NOT be imported by any production entrypoint.
 * INV-B: the production relay binary stays content-blind & unedited — this only wires it for a test.
 * INV-C: never logs key material (no cellSecret/kRoom/K_canary touched here at all).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { types as msTypes } from 'mediasoup';
import { createLogger } from '@dvconf/shared';

// CROSS-APP RUNTIME IMPORT (tsc-safe): the production relay signaling lives in `apps/relay/src`,
// OUTSIDE this app's tsconfig `rootDir` ('apps/validator-daemon/src'). A STATIC import there trips
// TS6059 (rootDir) for every relay module in the graph. So we load the three relay modules via a
// runtime dynamic `import()` whose specifier is BUILT from a variable (a file:// URL) — tsc cannot
// statically resolve a non-literal specifier, so it types the result as `any` and pulls NOTHING
// into the rootDir graph (0-new-tsc). Vite/tsx resolves the real `.ts` at runtime. This mirrors the
// A3b producer's runtime-only cross-repo strategy (esbuild bundle) rather than a type-graph import.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 4 `../` test-support→canary→src→validator-daemon→apps, then into relay/src.
const RELAY_SRC = path.resolve(HERE, '../../../../relay/src');
const relayModuleUrl = (file: string): string =>
  new URL(`file://${path.resolve(RELAY_SRC, file).replace(/\\/g, '/')}`).href;

// Minimal STRUCTURAL aliases for the bits we call (avoids a type-import of the relay module — see
// the rootDir note above). These mirror the real signatures verified at recon.
type Worker = msTypes.Worker;
type Router = msTypes.Router;
interface MediasoupManagerLike {
  workers: Worker[];
  getNextWorker(): Worker;
  getWorkerExcluding(current: Worker): Worker;
  createRouter(worker: Worker): Promise<Router>;
  getWorkerDiedCount(): number;
  close(): void;
}
interface SignalingServerLike {
  wss: {
    once(ev: 'listening' | 'error', cb: (err?: unknown) => void): void;
    address(): { port: number } | string | null;
    close(cb: () => void): void;
  };
  closeRooms(): void;
}
interface RelaySignalingModule {
  createSignalingServer(manager: MediasoupManagerLike, metrics: unknown, logger: unknown): SignalingServerLike;
}
interface RelayManagerModule {
  createMediasoupManager(logger: unknown): Promise<MediasoupManagerLike>;
}
interface RelayMetricsModule {
  MetricsTracker: new () => unknown;
}

export interface RealSignalingHarness {
  /** ws://127.0.0.1:<ephemeral> — pass to startBrowserCanaryProducer({ signalingUrl }). */
  wsUrl: string;
  /** No admission gating on the covert no-password path (Task-0): always undefined. */
  capTokenForCanary?: undefined;
  stop(): Promise<void>;
}

/**
 * Wrap a real `MediasoupManager` so EVERY `createRouter(...)` returns the injected `relayRouter`
 * (the test-owned router the produce must land on). `getNextWorker`/the rest delegate to the real
 * manager (a throwaway 1-worker manager) so the shape is exactly what signaling.ts calls. The
 * worker `getNextWorker()` returns is passed straight into our overridden `createRouter`, which
 * ignores it — so the throwaway worker is never used to create anything.
 */
function injectRouterManager(real: MediasoupManagerLike, relayRouter: Router): MediasoupManagerLike {
  return {
    workers: real.workers,
    getNextWorker: () => real.getNextWorker(),
    getWorkerExcluding: (current) => real.getWorkerExcluding(current),
    // THE BRIDGE: hand back the test-owned router regardless of the worker arg.
    createRouter: async () => relayRouter,
    getWorkerDiedCount: () => real.getWorkerDiedCount(),
    close: () => real.close(),
  };
}

export async function startRealSignaling(opts: {
  relayRouter: Router;
  roomId: string;
}): Promise<RealSignalingHarness> {
  const logger = createLogger('m2b-a4live-real-signaling');

  // Runtime-load the production relay modules (see the rootDir note at the top: dynamic, variable
  // specifier → tsc-invisible, vite/tsx-resolved at runtime). The REAL handlers run unchanged.
  const signalingMod = (await import(relayModuleUrl('signaling.js'))) as RelaySignalingModule;
  const managerMod = (await import(relayModuleUrl('mediasoup-manager.js'))) as RelayManagerModule;
  const metricsMod = (await import(relayModuleUrl('metrics.js'))) as RelayMetricsModule;

  // Force loopback announce + ephemeral WS port for the prod server's internal WebSocketServer.
  const prevWsPort = process.env['WS_PORT'];
  const prevAnnouncedIp = process.env['ANNOUNCED_IP'];
  process.env['WS_PORT'] = '0';
  process.env['ANNOUNCED_IP'] = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';

  // A throwaway 1-worker manager: its createRouter is overridden to the injected relayRouter, so
  // its own workers only satisfy getNextWorker()'s return type (never used to create a router).
  const prevNumWorkers = process.env['NUM_WORKERS'];
  process.env['NUM_WORKERS'] = '1';
  const realManager = await managerMod.createMediasoupManager(logger);
  if (prevNumWorkers === undefined) delete process.env['NUM_WORKERS'];
  else process.env['NUM_WORKERS'] = prevNumWorkers;

  const manager = injectRouterManager(realManager, opts.relayRouter);
  const metrics = new metricsMod.MetricsTracker();

  // Boot the REAL production signaling server (covert no-password path; no turnContext/interRelay).
  const { wss, closeRooms } = signalingMod.createSignalingServer(manager, metrics, logger);

  // Restore env immediately — the WebSocketServer constructor already read WS_PORT synchronously.
  if (prevWsPort === undefined) delete process.env['WS_PORT'];
  else process.env['WS_PORT'] = prevWsPort;
  if (prevAnnouncedIp === undefined) {
    // Keep 127.0.0.1 for the lifetime of the harness so createWebRtcTransport/pipe transports
    // announce loopback while the test runs; restore on stop().
  } else {
    process.env['ANNOUNCED_IP'] = prevAnnouncedIp;
  }

  // Await the listening event, then read the OS-assigned ephemeral port.
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', (e) => reject(e));
  });
  const addr = wss.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) throw new Error('real-signaling-harness: failed to bind an ephemeral WS port');
  const wsUrl = `ws://127.0.0.1:${port}`;
  logger.info({ wsUrl, roomId: opts.roomId }, 'A4-live real signaling server listening');

  return {
    wsUrl,
    capTokenForCanary: undefined,
    async stop(): Promise<void> {
      // Restore ANNOUNCED_IP if we set the loopback default.
      if (prevAnnouncedIp === undefined) delete process.env['ANNOUNCED_IP'];
      else process.env['ANNOUNCED_IP'] = prevAnnouncedIp;
      try { closeRooms(); } catch { /* best-effort */ }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // Close the throwaway worker manager (NOT the test-owned relayRouter — the test owns it).
      try { realManager.close(); } catch { /* best-effort */ }
    },
  };
}
