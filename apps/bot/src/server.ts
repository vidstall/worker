/**
 * Bot control HTTP server — lets an admin dashboard launch/list/stop bot
 * sessions instead of the old one-shot CLI script. Plain `node:http` (no
 * framework), mirroring `apps/relay/src/metrics-server.ts`'s style:
 *   - GET    /healthz    — always 200, no auth.
 *   - POST   /bots       — start ONE session. Bearer-auth gated.
 *   - POST   /bots/pool  — start N sessions ("cattle, not pets") with the
 *                          same params. Bearer-auth gated.
 *   - GET    /bots       — list active sessions. Bearer-auth gated.
 *   - DELETE /bots/:id   — stop + remove a session. Bearer-auth gated.
 *   - DELETE /bots       — stop + remove EVERY active session. Bearer-auth
 *                          gated.
 *
 * Auth: reuses `@dvconf/shared`'s `isBearerAuthorized` (constant-time
 * compare) for the actual token check. Unlike that helper's own fail-closed
 * default, the GATE here is OPEN-when-`BOT_CONTROL_TOKEN`-unset — matching
 * `apps/relay/src/metrics-server.ts`'s `METRICS_AUTH_TOKEN` convention — but
 * a loud startup warning is logged in that case (see index.ts).
 *
 * The routing logic (`createRequestHandler`) is exported separately from
 * `startServer` so it's unit-testable with mock req/res, without binding a
 * real socket.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Logger } from '@dvconf/shared';
import { isBearerAuthorized } from '@dvconf/shared';
import type { BotSession, BotSessionOptions, MediaMode, RoomMode } from './session.js';
import { generateBotAlias } from './alias.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

const VALID_ROOM_MODES: ReadonlySet<string> = new Set(['create', 'join']);
const VALID_MEDIA_MODES: ReadonlySet<string> = new Set(['listen', 'camera', 'mic', 'both']);

// A pool launch spins up that many real ffmpeg/mediasoup processes and
// spends real gas per bot -- bound it so a typo (or a misclick) can't fork-
// bomb the host.
const MAX_POOL_COUNT = 25;

export interface BotSummary {
  id: string;
  alias: string;
  roomId: string;
  mediaMode: MediaMode;
  joinUrl: string;
  uptimeMs: number;
}

export function toBotSummary(session: BotSession, alias: string, now: number = Date.now()): BotSummary {
  return {
    id: session.id,
    alias,
    roomId: session.roomId,
    mediaMode: session.mediaMode,
    joinUrl: session.joinUrl,
    uptimeMs: now - session.startedAt,
  };
}

/**
 * Returns true (admitted) when `controlToken` is empty (auth disabled) or
 * the request carries a matching `Authorization: Bearer <token>` header.
 */
function isAuthorized(req: IncomingMessage, controlToken: string): boolean {
  if (controlToken === '') return true;
  return isBearerAuthorized(req, controlToken);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  return JSON.parse(text);
}

type ValidationResult =
  | { ok: true; opts: BotSessionOptions }
  | { ok: false; error: string };

/** Pure validator for the POST /bots body — split out so it's unit-testable. */
export function validateCreateBotBody(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'request body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;

  const roomMode = b['roomMode'];
  if (typeof roomMode !== 'string' || !VALID_ROOM_MODES.has(roomMode)) {
    return { ok: false, error: `"roomMode" must be one of: create, join` };
  }

  const mediaMode = b['mediaMode'];
  if (typeof mediaMode !== 'string' || !VALID_MEDIA_MODES.has(mediaMode)) {
    return { ok: false, error: `"mediaMode" must be one of: listen, camera, mic, both` };
  }

  let roomId: string | undefined;
  if (roomMode === 'join') {
    const rawRoomId = b['roomId'];
    if (typeof rawRoomId !== 'string' || rawRoomId.trim() === '') {
      return { ok: false, error: `"roomId" is required and must be non-empty when roomMode is "join"` };
    }
    roomId = rawRoomId;
  }

  const rawMp4Path = b['mp4Path'];
  if (rawMp4Path !== undefined && typeof rawMp4Path !== 'string') {
    return { ok: false, error: `"mp4Path" must be a string when provided` };
  }

  return {
    ok: true,
    opts: {
      roomMode: roomMode as RoomMode,
      roomId,
      mediaMode: mediaMode as MediaMode,
      mp4Path: rawMp4Path as string | undefined,
    },
  };
}

export interface RequestHandlerDeps {
  sessions: Map<string, BotSession>;
  aliases: Map<string, string>;
  controlToken: string;
  logger: Logger;
  startSession: (opts: BotSessionOptions) => Promise<BotSession>;
}

/** Pure validator for the POST /bots/pool body -- reuses validateCreateBotBody
 *  for the per-bot fields, then additionally requires a bounded `count`. */
export function validateLaunchPoolBody(
  body: unknown,
): { ok: true; count: number; opts: BotSessionOptions } | { ok: false; error: string } {
  const base = validateCreateBotBody(body);
  if (!base.ok) return base;
  const count = (body as Record<string, unknown>)['count'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    return { ok: false, error: `"count" must be a positive integer` };
  }
  if (count > MAX_POOL_COUNT) {
    return { ok: false, error: `"count" must be at most ${MAX_POOL_COUNT}` };
  }
  return { ok: true, count, opts: base.opts };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RequestHandlerDeps,
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && url === '/healthz') {
    sendJson(res, 200, { ok: true, service: 'bot' });
    return;
  }

  if (method === 'POST' && url === '/bots') {
    if (!isAuthorized(req, deps.controlToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const validated = validateCreateBotBody(body);
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return;
    }

    try {
      const session = await deps.startSession(validated.opts);
      const alias = generateBotAlias(new Set(deps.aliases.values()));
      deps.sessions.set(session.id, session);
      deps.aliases.set(session.id, alias);
      sendJson(res, 201, { botId: session.id, alias, roomId: session.roomId, joinUrl: session.joinUrl });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error({ module: 'bot-server', err }, 'failed to start bot session');
      sendJson(res, 502, { error: `failed to start bot session: ${message}` });
    }
    return;
  }

  if (method === 'POST' && url === '/bots/pool') {
    if (!isAuthorized(req, deps.controlToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const validated = validateLaunchPoolBody(body);
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return;
    }

    const results = await Promise.allSettled(
      Array.from({ length: validated.count }, () => deps.startSession(validated.opts)),
    );

    const launched: { botId: string; alias: string; roomId: string; joinUrl: string }[] = [];
    const failed: { error: string }[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const session = result.value;
        const alias = generateBotAlias(new Set(deps.aliases.values()));
        deps.sessions.set(session.id, session);
        deps.aliases.set(session.id, alias);
        launched.push({ botId: session.id, alias, roomId: session.roomId, joinUrl: session.joinUrl });
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        deps.logger.error({ module: 'bot-server', err: result.reason }, 'pool launch: one bot failed to start');
        failed.push({ error: message });
      }
    }

    sendJson(res, launched.length > 0 ? 201 : 502, { launched, failed });
    return;
  }

  if (method === 'GET' && url === '/bots') {
    if (!isAuthorized(req, deps.controlToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const list = Array.from(deps.sessions.values()).map((s) =>
      toBotSummary(s, deps.aliases.get(s.id) ?? s.id),
    );
    sendJson(res, 200, list);
    return;
  }

  if (method === 'DELETE' && url === '/bots') {
    if (!isAuthorized(req, deps.controlToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const stopped = deps.sessions.size;
    for (const session of deps.sessions.values()) session.stop();
    deps.sessions.clear();
    deps.aliases.clear();
    sendJson(res, 200, { stopped });
    return;
  }

  const deleteMatch = method === 'DELETE' ? url.match(/^\/bots\/([^/]+)$/) : null;
  if (deleteMatch) {
    if (!isAuthorized(req, deps.controlToken)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const id = decodeURIComponent(deleteMatch[1]!);
    const session = deps.sessions.get(id);
    if (!session) {
      sendJson(res, 404, { error: 'bot not found' });
      return;
    }
    session.stop();
    deps.sessions.delete(id);
    deps.aliases.delete(id);
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

/** Build a plain `(req, res) => void` handler — testable without a real socket. */
export function createRequestHandler(
  deps: RequestHandlerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(req, res, deps).catch((err: unknown) => {
      deps.logger.error({ module: 'bot-server', err }, 'unhandled request error');
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal server error' });
      }
    });
  };
}

export interface StartServerOptions {
  port: number;
  controlToken: string;
  startSession: (opts: BotSessionOptions) => Promise<BotSession>;
}

export interface BotServerHandle {
  server: Server;
  sessions: Map<string, BotSession>;
}

/** Start the bot control HTTP server bound to `options.port`. */
export function startServer(options: StartServerOptions, logger: Logger): BotServerHandle {
  const sessions = new Map<string, BotSession>();
  const aliases = new Map<string, string>();

  if (options.controlToken === '') {
    logger.warn(
      { module: 'bot-server' },
      'BOT_CONTROL_TOKEN is unset — the bot control API is UNAUTHENTICATED. Set BOT_CONTROL_TOKEN in production.',
    );
  }

  const handler = createRequestHandler({
    sessions,
    aliases,
    controlToken: options.controlToken,
    logger,
    startSession: options.startSession,
  });

  const server = createServer(handler);
  server.listen(options.port, () => {
    logger.info({ module: 'bot-server', port: options.port }, 'bot control HTTP server listening');
  });

  return { server, sessions };
}
