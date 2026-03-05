/**
 * Structured logger factory using pino.
 * Pretty output in development, JSON in production.
 */

import pino, { type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Create a pino logger instance for a named service.
 *
 * @param service - Service name (e.g. 'cp-daemon', 'signaling')
 */
export function createLogger(service: string): Logger {
  const isDev =
    process.env['NODE_ENV'] === 'development' ||
    process.env['LOG_LEVEL'] === 'debug' ||
    process.env['LOG_LEVEL'] === 'trace';

  return pino({
    name: service,
    level: process.env['LOG_LEVEL'] ?? 'info',
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true },
          },
        }
      : {}),
  });
}
