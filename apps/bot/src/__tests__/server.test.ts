import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRequestHandler,
  validateCreateBotBody,
  validateLaunchPoolBody,
  toBotSummary,
  type RequestHandlerDeps,
} from '../server.js';
import type { BotSession } from '../session.js';

function fakeLogger(): { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Minimal mock IncomingMessage: async-iterable body + headers. */
function fakeRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const chunks = opts.body ? [Buffer.from(opts.body, 'utf8')] : [];
  const req = {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    [Symbol.asyncIterator]: async function* () {
      for (const c of chunks) yield c;
    },
  };
  return req as unknown as IncomingMessage;
}

/** Minimal mock ServerResponse capturing status/body. */
function fakeResponse(): ServerResponse & { _status?: number; _body?: string } {
  const res: Partial<ServerResponse> & { _status?: number; _body?: string; headersSent: boolean } = {
    headersSent: false,
    writeHead(status: number) {
      res._status = status;
      res.headersSent = true;
      return res as ServerResponse;
    },
    end(body?: unknown) {
      if (typeof body === 'string') res._body = body;
      return res as ServerResponse;
    },
  };
  return res as ServerResponse & { _status?: number; _body?: string };
}

async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  handler(req, res);
  // handleRequest is async internally; flush microtasks.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeSession(overrides: Partial<BotSession> = {}): BotSession {
  return {
    id: 'session-1',
    roomId: '0xroom',
    mediaMode: 'both',
    joinUrl: 'http://localhost:5173/rooms/0xroom?pw=123',
    startedAt: Date.now() - 1000,
    stop: vi.fn(),
    isDegraded: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

describe('validateCreateBotBody', () => {
  it('accepts a valid create+both body', () => {
    const r = validateCreateBotBody({ roomMode: 'create', mediaMode: 'both' });
    expect(r.ok).toBe(true);
  });

  it('rejects an invalid roomMode', () => {
    const r = validateCreateBotBody({ roomMode: 'nonsense', mediaMode: 'both' });
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid mediaMode', () => {
    const r = validateCreateBotBody({ roomMode: 'create', mediaMode: 'nonsense' });
    expect(r.ok).toBe(false);
  });

  it('requires a non-empty roomId when roomMode is join', () => {
    const r1 = validateCreateBotBody({ roomMode: 'join', mediaMode: 'listen' });
    expect(r1.ok).toBe(false);
    const r2 = validateCreateBotBody({ roomMode: 'join', mediaMode: 'listen', roomId: '' });
    expect(r2.ok).toBe(false);
    const r3 = validateCreateBotBody({ roomMode: 'join', mediaMode: 'listen', roomId: '0xabc' });
    expect(r3.ok).toBe(true);
  });

  it('rejects a non-object body', () => {
    expect(validateCreateBotBody(null).ok).toBe(false);
    expect(validateCreateBotBody('nope').ok).toBe(false);
    expect(validateCreateBotBody([]).ok).toBe(false);
  });

  it('rejects a non-string mp4Path', () => {
    const r = validateCreateBotBody({ roomMode: 'create', mediaMode: 'both', mp4Path: 123 });
    expect(r.ok).toBe(false);
  });
});

describe('toBotSummary', () => {
  it('computes uptimeMs from startedAt', () => {
    const session = fakeSession({ startedAt: 1000 });
    const summary = toBotSummary(session, 'brave-otter', 1500);
    expect(summary).toEqual({
      id: 'session-1',
      alias: 'brave-otter',
      roomId: '0xroom',
      mediaMode: 'both',
      joinUrl: session.joinUrl,
      uptimeMs: 500,
      status: 'active',
    });
  });

  it('reports status "degraded" when the session reports isDegraded() === true', () => {
    const session = fakeSession({ startedAt: 1000, isDegraded: vi.fn().mockReturnValue(true) });
    const summary = toBotSummary(session, 'brave-otter', 1500);
    expect(summary.status).toBe('degraded');
  });
});

describe('validateLaunchPoolBody', () => {
  it('accepts a valid body with count', () => {
    const r = validateLaunchPoolBody({ roomMode: 'create', mediaMode: 'both', count: 5 });
    expect(r.ok).toBe(true);
  });

  it('rejects a non-integer count', () => {
    expect(validateLaunchPoolBody({ roomMode: 'create', mediaMode: 'both', count: 1.5 }).ok).toBe(false);
    expect(validateLaunchPoolBody({ roomMode: 'create', mediaMode: 'both', count: 0 }).ok).toBe(false);
    expect(validateLaunchPoolBody({ roomMode: 'create', mediaMode: 'both' }).ok).toBe(false);
  });

  it('rejects a count above the cap', () => {
    const r = validateLaunchPoolBody({ roomMode: 'create', mediaMode: 'both', count: 26 });
    expect(r.ok).toBe(false);
  });

  it('still validates the per-bot fields', () => {
    const r = validateLaunchPoolBody({ roomMode: 'nonsense', mediaMode: 'both', count: 3 });
    expect(r.ok).toBe(false);
  });
});

describe('createRequestHandler routing', () => {
  let sessions: Map<string, BotSession>;
  let aliases: Map<string, string>;
  let startSession: ReturnType<typeof vi.fn>;
  let deps: RequestHandlerDeps;

  beforeEach(() => {
    sessions = new Map();
    aliases = new Map();
    startSession = vi.fn();
    deps = { sessions, aliases, controlToken: '', logger: fakeLogger() as never, startSession };
  });

  it('GET /healthz always answers 200 with no auth required', async () => {
    const handler = createRequestHandler({ ...deps, controlToken: 'secret' });
    const req = fakeRequest({ method: 'GET', url: '/healthz' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(200);
  });

  it('POST /bots with auth disabled (empty token) starts a session and returns 201', async () => {
    const session = fakeSession();
    startSession.mockResolvedValueOnce(session);
    const handler = createRequestHandler(deps);
    const req = fakeRequest({
      method: 'POST',
      url: '/bots',
      body: JSON.stringify({ roomMode: 'create', mediaMode: 'both' }),
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(201);
    const body = JSON.parse(res._body!) as { botId: string; alias: string; roomId: string; joinUrl: string };
    expect(body.botId).toBe(session.id);
    expect(body.roomId).toBe(session.roomId);
    expect(body.joinUrl).toBe(session.joinUrl);
    expect(typeof body.alias).toBe('string');
    expect(body.alias.length).toBeGreaterThan(0);
    expect(sessions.get(session.id)).toBe(session);
    expect(aliases.get(session.id)).toBe(body.alias);
  });

  it('POST /bots rejects an invalid body with 400 and does not start a session', async () => {
    const handler = createRequestHandler(deps);
    const req = fakeRequest({
      method: 'POST',
      url: '/bots',
      body: JSON.stringify({ roomMode: 'join', mediaMode: 'both' }), // missing roomId
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(400);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('POST /bots returns 502 with a clear message when startSession rejects', async () => {
    startSession.mockRejectedValueOnce(new Error('cp-daemon not running'));
    const handler = createRequestHandler(deps);
    const req = fakeRequest({
      method: 'POST',
      url: '/bots',
      body: JSON.stringify({ roomMode: 'create', mediaMode: 'listen' }),
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(502);
    expect(res._body).toContain('cp-daemon not running');
  });

  it('requires Bearer auth on /bots routes when a controlToken is configured', async () => {
    const handler = createRequestHandler({ ...deps, controlToken: 'secret-token' });
    const req = fakeRequest({ method: 'GET', url: '/bots' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(401);
  });

  it('admits a matching Bearer token on /bots routes', async () => {
    sessions.set('s1', fakeSession({ id: 's1' }));
    const handler = createRequestHandler({ ...deps, controlToken: 'secret-token' });
    const req = fakeRequest({
      method: 'GET',
      url: '/bots',
      headers: { authorization: 'Bearer secret-token' },
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body!);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('s1');
  });

  it('GET /bots lists active sessions with uptimeMs', async () => {
    sessions.set('s1', fakeSession({ id: 's1', startedAt: Date.now() - 10_000 }));
    const handler = createRequestHandler(deps);
    const req = fakeRequest({ method: 'GET', url: '/bots' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body!) as Array<{ id: string; uptimeMs: number }>;
    expect(body[0]?.id).toBe('s1');
    expect(body[0]?.uptimeMs).toBeGreaterThanOrEqual(9000);
  });

  it('DELETE /bots/:id stops and removes the session, returning 204', async () => {
    const session = fakeSession({ id: 's1' });
    sessions.set('s1', session);
    const handler = createRequestHandler(deps);
    const req = fakeRequest({ method: 'DELETE', url: '/bots/s1' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(204);
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(sessions.has('s1')).toBe(false);
  });

  it('DELETE /bots/:id returns 404 for an unknown id', async () => {
    const handler = createRequestHandler(deps);
    const req = fakeRequest({ method: 'DELETE', url: '/bots/nope' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(404);
  });

  it('POST /bots/pool launches `count` sessions and returns aliased summaries', async () => {
    startSession.mockImplementation(async () => fakeSession({ id: `s-${startSession.mock.calls.length}` }));
    const handler = createRequestHandler(deps);
    const req = fakeRequest({
      method: 'POST',
      url: '/bots/pool',
      body: JSON.stringify({ roomMode: 'create', mediaMode: 'listen', count: 3 }),
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(201);
    const body = JSON.parse(res._body!) as { launched: { botId: string; alias: string }[]; failed: unknown[] };
    expect(body.launched).toHaveLength(3);
    expect(body.failed).toHaveLength(0);
    expect(sessions.size).toBe(3);
    // aliases must be distinct within the pool
    expect(new Set(body.launched.map((b) => b.alias)).size).toBe(3);
  });

  it('POST /bots/pool reports partial failures without discarding successes', async () => {
    startSession
      .mockResolvedValueOnce(fakeSession({ id: 's-ok' }))
      .mockRejectedValueOnce(new Error('boom'));
    const handler = createRequestHandler(deps);
    const req = fakeRequest({
      method: 'POST',
      url: '/bots/pool',
      body: JSON.stringify({ roomMode: 'create', mediaMode: 'listen', count: 2 }),
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(201);
    const body = JSON.parse(res._body!) as { launched: unknown[]; failed: { error: string }[] };
    expect(body.launched).toHaveLength(1);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]?.error).toContain('boom');
  });

  it('POST /bots/pool rejects an invalid body with 400', async () => {
    const handler = createRequestHandler(deps);
    const req = fakeRequest({
      method: 'POST',
      url: '/bots/pool',
      body: JSON.stringify({ roomMode: 'create', mediaMode: 'listen', count: 0 }),
    });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(400);
    expect(startSession).not.toHaveBeenCalled();
  });

  it('DELETE /bots stops and clears every active session, returning the count', async () => {
    const s1 = fakeSession({ id: 's1' });
    const s2 = fakeSession({ id: 's2' });
    sessions.set('s1', s1);
    sessions.set('s2', s2);
    aliases.set('s1', 'brave-otter');
    aliases.set('s2', 'calm-reef');
    const handler = createRequestHandler(deps);
    const req = fakeRequest({ method: 'DELETE', url: '/bots' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body!)).toEqual({ stopped: 2 });
    expect(s1.stop).toHaveBeenCalledTimes(1);
    expect(s2.stop).toHaveBeenCalledTimes(1);
    expect(sessions.size).toBe(0);
    expect(aliases.size).toBe(0);
  });

  it('returns 404 for an unknown route', async () => {
    const handler = createRequestHandler(deps);
    const req = fakeRequest({ method: 'GET', url: '/unknown' });
    const res = fakeResponse();
    await invoke(handler, req, res);
    expect(res._status).toBe(404);
  });
});
