/**
 * Structured logger factory using pino.
 * Pretty output in development, JSON in production.
 */

import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/** Minimal env shape the logger reads (subset of NodeJS.ProcessEnv). */
export type LoggerEnv = {
  NODE_ENV?: string;
  LOG_LEVEL?: string;
  LOG_PRETTY?: string;
  LOG_OUTPUT?: string;
};

/**
 * Build the pino options for a named service from the environment.
 *
 * Extracted as a pure function so transport selection is testable (a constructed
 * pino instance does not expose its transport config). `createLogger` is a thin
 * `pino(buildLoggerOptions(...))` wrapper.
 *
 * Precedence (DOH-006): explicit `LOG_PRETTY` overrides the NODE_ENV/LOG_LEVEL
 * dev heuristic. Output (DOH-005): pretty-to-stdout > `LOG_OUTPUT=file:/path`
 * JSON-to-file > JSON stdout.
 *
 * @param service - Service name (e.g. 'cp-daemon', 'signaling')
 * @param env - Environment source (defaults to `process.env` in `createLogger`)
 */
export function buildLoggerOptions(service: string, env: LoggerEnv): LoggerOptions {
  const base: LoggerOptions = {
    name: service,
    level: env.LOG_LEVEL ?? 'info',
  };

  // DOH-006: explicit LOG_PRETTY wins; fall back to the dev heuristic when unset.
  const pretty =
    env.LOG_PRETTY !== undefined
      ? env.LOG_PRETTY === 'true'
      : env.NODE_ENV === 'development' ||
        env.LOG_LEVEL === 'debug' ||
        env.LOG_LEVEL === 'trace';

  if (pretty) {
    return {
      ...base,
      transport: { target: 'pino-pretty', options: { colorize: true } },
    };
  }

  // DOH-005: LOG_OUTPUT=file:/path → JSON to a file destination (syslog omitted by design).
  const output = env.LOG_OUTPUT ?? 'stdout';
  if (output.startsWith('file:')) {
    return {
      ...base,
      transport: { target: 'pino/file', options: { destination: output.slice('file:'.length) } },
    };
  }

  // Default: JSON to stdout (no transport).
  return base;
}

/**
 * Create a pino logger instance for a named service.
 *
 * @param service - Service name (e.g. 'cp-daemon', 'signaling')
 */
export function createLogger(service: string): Logger {
  return pino(buildLoggerOptions(service, process.env));
}
