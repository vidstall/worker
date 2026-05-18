/**
 * S30.C.3 — coturn URL derivation tests.
 *
 * Convention: coturn is co-located with the mediasoup relay on the same
 * host, listening on port 3478 (UDP). Given a registered relay endpoint
 * (`ws://host:port`, `wss://...`, `http(s)://...`, or `host:port`), this
 * helper extracts the host and builds the canonical turn URI.
 */
import { describe, it, expect } from 'vitest';
import { deriveCoturnUrl } from '../coturn-url.js';

describe('deriveCoturnUrl', () => {
  it('derives from ws:// URL with port', () => {
    expect(deriveCoturnUrl('ws://relay.example.com:4000')).toBe(
      'turn:relay.example.com:3478?transport=udp',
    );
  });

  it('derives from wss:// URL', () => {
    expect(deriveCoturnUrl('wss://relay.example.com:443')).toBe(
      'turn:relay.example.com:3478?transport=udp',
    );
  });

  it('derives from http:// URL', () => {
    expect(deriveCoturnUrl('http://relay.example.com:8080')).toBe(
      'turn:relay.example.com:3478?transport=udp',
    );
  });

  it('derives from https:// URL', () => {
    expect(deriveCoturnUrl('https://relay.example.com')).toBe(
      'turn:relay.example.com:3478?transport=udp',
    );
  });

  it('derives from raw host:port (no scheme)', () => {
    expect(deriveCoturnUrl('relay.example.com:4000')).toBe(
      'turn:relay.example.com:3478?transport=udp',
    );
  });

  it('derives from bare hostname (no scheme, no port)', () => {
    expect(deriveCoturnUrl('relay.example.com')).toBe(
      'turn:relay.example.com:3478?transport=udp',
    );
  });

  it('derives from IPv4 host:port', () => {
    expect(deriveCoturnUrl('ws://192.168.1.10:4000')).toBe(
      'turn:192.168.1.10:3478?transport=udp',
    );
  });

  it('returns null for empty input', () => {
    expect(deriveCoturnUrl('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(deriveCoturnUrl('   ')).toBeNull();
  });

  it('returns null for input containing only a scheme', () => {
    expect(deriveCoturnUrl('ws://')).toBeNull();
  });
});
