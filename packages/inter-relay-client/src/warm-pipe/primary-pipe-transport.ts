/**
 * Primary-side pipe half (Phase 5.3 spike — the missing production half) —
 * module-level mediasoup wiring that does not need any coordinator private
 * state, split out of primary-coordinator.ts.
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import { pipeSrtpEnabled } from '../relay-role-manager.js';

/**
 * The PRIMARY half of the warm pipe — the piece that did NOT exist before
 * (only the STANDBY half lived in relay-role-manager.ensureWarmPipe).
 *
 * `ensureWarmPipe` builds a PipeTransport on the STANDBY and `consume()`s a
 * producerId that lives on the PRIMARY. For RTP to actually cross between two
 * SEPARATE daemon processes the primary must ALSO:
 *
 *   1. createPipeTransport on its own router (this helper),
 *   2. exchange + `connect({ip, port, srtpParameters})` BOTH ends (the standby's
 *      params arrive over the inter-relay WS link; the caller drives connect),
 *   3. `pipeTransport.consume({producerId})` the room's real producer onto the
 *      pipe (pipeProducerOntoPrimaryTransport) — THIS mints the piped producer
 *      the standby then sees and is what puts RTP on the wire.
 *
 * mediasoup's high-level `router.pipeToRouter({producerId, router})` does all
 * of this automatically, but ONLY for two routers in the SAME process. In
 * production primary + standby are distinct processes, so this manual pairing
 * is required.
 *
 * Additive — does NOT change ensureWarmPipe's signature or behaviour. Pure
 * mediasoup wiring (no logger coupling): the caller owns link-health logging.
 */
export async function createPrimaryPipeTransport(
  router: msTypes.Router,
  pipePort: number,
): Promise<msTypes.PipeTransport> {
  // announcedIp = deploy-routable address the standby connects back to,
  // externalized via ANNOUNCED_IP (default loopback for local/bench). Mirrors
  // the room-handler.ts WebRTC-transport pattern.
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
  return router.createPipeTransport({
    listenIp: { ip: '0.0.0.0', announcedIp },
    port: pipePort,
    enableRtx: false,
    enableSrtp: pipeSrtpEnabled(),
  } as Parameters<msTypes.Router['createPipeTransport']>[0]);
}

/**
 * Consume the room's real producer onto the primary's already-connected pipe
 * transport. The returned Consumer's `.id` is the producerId the piped
 * producer carries on the standby router — exactly the id the primary must
 * announce (buildPipeProducerAnnounce) so the standby's ensureWarmPipe
 * consumes the REAL producer rather than the `pipe-producer-pending-*`
 * placeholder.
 */
export async function pipeProducerOntoPrimaryTransport(
  pipeTransport: msTypes.PipeTransport,
  producerId: string,
): Promise<msTypes.Consumer> {
  return pipeTransport.consume({ producerId } as Parameters<
    msTypes.PipeTransport['consume']
  >[0]);
}
