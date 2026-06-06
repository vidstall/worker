/**
 * P17 M1 / F63 (DOH-005, DOH-006) — logger config builder.
 *
 * Transport selection is extracted into the pure `buildLoggerOptions(service, env)`
 * so it is introspectable (the returned pino instance is not). `createLogger` is a
 * thin `pino(buildLoggerOptions(...))` wrapper.
 *
 * Precedence (DOH-006): LOG_PRETTY (explicit) > NODE_ENV/LOG_LEVEL dev heuristic.
 * Output (DOH-005): LOG_PRETTY pretty-to-stdout > LOG_OUTPUT=file:/path JSON-to-file > JSON stdout.
 */

import { describe, it, expect } from 'vitest';
import { buildLoggerOptions } from '../logger.js';

describe('buildLoggerOptions', () => {
  it('defaults to JSON stdout at level info with the service name (no transport)', () => {
    const opts = buildLoggerOptions('cp-daemon', {});
    expect(opts.name).toBe('cp-daemon');
    expect(opts.level).toBe('info');
    expect(opts.transport).toBeUndefined();
  });

  it('honors LOG_LEVEL', () => {
    const opts = buildLoggerOptions('relay', { LOG_LEVEL: 'warn' });
    expect(opts.level).toBe('warn');
  });

  it('LOG_PRETTY=true selects the pino-pretty transport', () => {
    const opts = buildLoggerOptions('signaling', { LOG_PRETTY: 'true' });
    expect(opts.transport).toMatchObject({ target: 'pino-pretty' });
  });

  it('LOG_PRETTY=false overrides the NODE_ENV=development dev heuristic (no pretty)', () => {
    const opts = buildLoggerOptions('signaling', {
      LOG_PRETTY: 'false',
      NODE_ENV: 'development',
    });
    expect(opts.transport).toBeUndefined();
  });

  it('keeps the dev heuristic when LOG_PRETTY is unset (NODE_ENV=development → pretty)', () => {
    const opts = buildLoggerOptions('validator-daemon', { NODE_ENV: 'development' });
    expect(opts.transport).toMatchObject({ target: 'pino-pretty' });
  });

  it('LOG_OUTPUT=file:/path emits JSON to a pino/file destination', () => {
    const opts = buildLoggerOptions('cp-daemon', { LOG_OUTPUT: 'file:/var/log/dvconf/cp.log' });
    expect(opts.transport).toMatchObject({
      target: 'pino/file',
      options: { destination: '/var/log/dvconf/cp.log' },
    });
  });

  it('LOG_PRETTY=true takes precedence over LOG_OUTPUT=file', () => {
    const opts = buildLoggerOptions('relay', {
      LOG_PRETTY: 'true',
      LOG_OUTPUT: 'file:/var/log/dvconf/relay.log',
    });
    expect(opts.transport).toMatchObject({ target: 'pino-pretty' });
  });
});
