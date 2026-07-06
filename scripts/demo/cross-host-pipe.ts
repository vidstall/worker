// scripts/demo/cross-host-pipe.ts
/**
 * Track-C GENUINE 2-host co-sign — the cross-host F1 SRTP handshake return channel.
 *
 * The pipe handshake is inherently 2-way: vm1's relay primary#2 can only `connect()` once it knows
 * vm2's standby {ip, port, srtpParameters}, and vm2's standby can only `connect()` once it knows
 * primary#2's params (delivered via CANARY_PIPE_PARAMS_PATH). So vm2 publishes its standby params to a
 * RETURN file; the driver scps it back to vm1; the orchestrator polls + parses it here, then connects.
 *
 * This module is the TRUST BOUNDARY on that return file: a malformed / half-written / half-scp'd return
 * must fail LOUD rather than let the orchestrator bind a bogus cross-host endpoint. Pure `parse*` so the
 * validation is unit-tested without fs/timers; the poller wraps it with existsSync + a bounded wait.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { PipeConnectParams } from '../../packages/inter-relay-client/src/index.ts';

/** Validate + parse vm2's standby return JSON into a PipeConnectParams. Throws on any malformed field. */
export function parsePeerStandbyParams(json: string): PipeConnectParams {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`cross-host-pipe: peer standby return is not valid JSON (half-written?): ${String(e)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('cross-host-pipe: peer standby return must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  const ip = o['ip'];
  const port = o['port'];
  if (typeof ip !== 'string' || ip.length === 0) {
    throw new Error('cross-host-pipe: peer standby return missing a non-empty string "ip"');
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) {
    throw new Error(`cross-host-pipe: peer standby return "port" must be a positive integer (got ${String(port)})`);
  }
  const out: PipeConnectParams = { ip, port };
  const srtp = o['srtpParameters'];
  if (srtp !== undefined) {
    if (typeof srtp !== 'object' || srtp === null) {
      throw new Error('cross-host-pipe: peer standby return "srtpParameters" must be an object when present');
    }
    const s = srtp as Record<string, unknown>;
    if (typeof s['cryptoSuite'] !== 'string' || typeof s['keyBase64'] !== 'string') {
      throw new Error('cross-host-pipe: peer standby "srtpParameters" needs string cryptoSuite + keyBase64');
    }
    out.srtpParameters = srtp as PipeConnectParams['srtpParameters'];
  }
  return out;
}

/**
 * Poll `returnPath` until vm2's standby return appears + parses, or throw after `timeoutMs`. The driver
 * scps the return file back to vm1 mid-run; we wait for it (fail-loud on timeout rather than hang). The
 * file may briefly exist half-written during scp, so a parse error is treated as "not ready yet" and
 * retried until the deadline — only the FINAL timeout surfaces the last parse error.
 */
export async function awaitPeerStandbyParams(
  returnPath: string,
  timeoutMs: number,
  pollMs = 500,
): Promise<PipeConnectParams> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    if (existsSync(returnPath)) {
      try {
        return parsePeerStandbyParams(readFileSync(returnPath, 'utf8'));
      } catch (e) {
        lastErr = e; // possibly a half-scp'd file — retry until the deadline
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `cross-host-pipe: peer standby return ${returnPath} not ready within ${timeoutMs}ms` +
          (lastErr ? ` (last parse error: ${String(lastErr)})` : ' (file never appeared)'),
      );
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
