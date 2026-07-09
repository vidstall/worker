/**
 * Two-ceiling extrapolation — relay-saturation INTERNET run (Task A5).
 *
 * The relay mesh is bound by whichever of two independent ceilings is tighter
 * at the target concurrency:
 *
 *   1. CPU ceiling — a mediasoup Worker forwards at most `C_worker` SRTP paths
 *      before its core saturates. The DirectTransport micro-bench put this at an
 *      optimistic ~540; real SRTP encryption on the wire can only *lower* it (we
 *      recompute `cWorkerSrtp` from the MEASURED per-path CPU slope). Relays
 *      needed on CPU grounds: ceil(N * pathsPerViewer / C_worker_srtp).
 *
 *   2. Bandwidth ceiling — each relay NIC is capped at `nicMbps`; the MEASURED
 *      real per-viewer egress (`mbpsPerViewerReal`, from the standby capped-NIC
 *      bytesSent delta) replaces the datasheet figure. Relays needed on
 *      bandwidth grounds: ceil(N * mbpsPerViewerReal / nicMbps).
 *
 * The FLOOR at the target is the max of the two (both must be satisfied); the
 * BINDING ceiling is whichever drove that max. `planningAt100` adds engineering
 * headroom (20% traffic burst, 70% target NIC utilisation) for provisioning.
 *
 * This is pure arithmetic on measured slopes — no I/O — so it is unit-tested in
 * isolation and re-used by the aggregator (Task A4) to fill `twoCeiling`.
 *
 * Plan: `docs/superpowers/plans/2026-07-04-star-wan-measurement.md`
 */

/** Measured-slope inputs for the two-ceiling recompute at the target N. */
export interface TwoCeilingInput {
  /** CPU cores consumed per forwarded SRTP path (measured slope). Its
   *  reciprocal, rounded, is the per-Worker SRTP path ceiling `C_worker_srtp`. */
  cpuCoresPerPathSrtp: number;
  /** Real per-viewer egress in Mbps (measured on the capped-NIC standby). */
  mbpsPerViewerReal: number;
  /** Published/capped relay NIC in Mbps (e.g. 100). */
  nicMbps: number;
  /** Target concurrency to extrapolate to (e.g. 100 viewers). */
  nAtTarget: number;
  /** Forward paths generated per viewer (e.g. 9 for a simulcast gallery). */
  pathsPerViewer: number;
}

/** Result of the two-ceiling recompute at the target N. */
export interface TwoCeilingResult {
  /** Recomputed per-Worker SRTP path ceiling (`round(1 / cpuCoresPerPathSrtp)`). */
  cWorkerSrtp: number;
  /** Relays needed at the target on CPU grounds. */
  kRcpuAt100: number;
  /** Relays needed at the target on bandwidth grounds. */
  kRbwAt100: number;
  /** Which ceiling bound the floor at the target. */
  binding: 'cpu' | 'bandwidth';
  /** Hard floor = max(cpu, bandwidth) relays required at the target. */
  floorAt100: number;
  /** Provisioning target with 20% headroom at 70% NIC utilisation. */
  planningAt100: number;
}

/**
 * Recompute the CPU + bandwidth relay ceilings on MEASURED slopes and bind on
 * the tighter one. Pure function; see module doc for the model.
 */
export function extrapolateTwoCeiling(input: TwoCeilingInput): TwoCeilingResult {
  const cWorkerSrtp = Math.round(1 / input.cpuCoresPerPathSrtp);
  const kRcpuAt100 = Math.ceil(
    (input.nAtTarget * input.pathsPerViewer) / cWorkerSrtp,
  );
  const kRbwAt100 = Math.ceil(
    (input.nAtTarget * input.mbpsPerViewerReal) / input.nicMbps,
  );
  const floorAt100 = Math.max(kRcpuAt100, kRbwAt100);
  const binding: 'cpu' | 'bandwidth' =
    kRbwAt100 >= kRcpuAt100 ? 'bandwidth' : 'cpu';
  const planningAt100 = Math.ceil(
    (input.nAtTarget * input.mbpsPerViewerReal * 1.2) / 0.7 / input.nicMbps,
  );
  return {
    cWorkerSrtp,
    kRcpuAt100,
    kRbwAt100,
    binding,
    floorAt100,
    planningAt100,
  };
}
