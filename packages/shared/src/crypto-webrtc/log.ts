/**
 * Vendored from services/client/client/src/lib/log.ts — kept byte-identical
 * (same console.* sink; works unchanged in Node) so the vendored crypto
 * modules below don't need any log-call-site rewriting. Resync manually if
 * the client's version changes.
 *
 * Client structured logging helper.
 *
 * Emits the workspace-standard structured JSON log shape
 * ({timestamp, level, source, module, message, context}) to the console as
 * a single JSON line, rather than ad-hoc `console.error(...)` string
 * concatenation.
 *
 * Usage:
 *   clientLog.error('webrtc/useRelay', 'Failed to consume producer', { err });
 */

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

interface LogContext {
  [key: string]: unknown;
}

/** Serialize an Error (or unknown) into a JSON-safe context value. */
function normalizeContext(context?: LogContext): LogContext | undefined {
  if (!context) return undefined;
  const out: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function emit(level: LogLevel, module: string, message: string, context?: LogContext): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    source: 'frontend' as const,
    module,
    message,
    context: normalizeContext(context),
  };
  const line = JSON.stringify(record);
  // Single structured JSON line. console is the only sink available here.
  // eslint-disable-next-line no-console
  if (level === 'ERROR' || level === 'FATAL') console.error(line);
  // eslint-disable-next-line no-console
  else if (level === 'WARN') console.warn(line);
  // eslint-disable-next-line no-console
  else console.info(line);
}

export const clientLog = {
  info: (module: string, message: string, context?: LogContext) =>
    emit('INFO', module, message, context),
  warn: (module: string, message: string, context?: LogContext) =>
    emit('WARN', module, message, context),
  error: (module: string, message: string, context?: LogContext) =>
    emit('ERROR', module, message, context),
  fatal: (module: string, message: string, context?: LogContext) =>
    emit('FATAL', module, message, context),
};
