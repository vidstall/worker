/**
 * S30.C — Derive the coturn URL for a relay node from its registered
 * mediasoup endpoint URL.
 *
 * Convention: coturn runs co-located with the mediasoup relay on the
 * same host, port 3478 UDP. Given any of the forms below, we extract
 * the hostname and synthesise `turn:<host>:3478?transport=udp`:
 *
 *   ws://relay.example.com:4000
 *   wss://relay.example.com:443
 *   http(s)://relay.example.com[:port]
 *   relay.example.com:4000           (no scheme)
 *   relay.example.com                (bare host)
 *
 * Returns null for empty / unparseable input.
 */
const COTURN_PORT = 3478;
const TRANSPORT = 'udp';

export function deriveCoturnUrl(endpointUrl: string): string | null {
  const trimmed = endpointUrl.trim();
  if (!trimmed) return null;

  let host: string | null = null;

  if (trimmed.includes('://')) {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
    } catch {
      return null;
    }
  } else {
    // Bare host[:port]
    const colonIdx = trimmed.indexOf(':');
    host = colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
  }

  if (host === null || host === '') return null;

  return `turn:${host}:${COTURN_PORT}?transport=${TRANSPORT}`;
}
