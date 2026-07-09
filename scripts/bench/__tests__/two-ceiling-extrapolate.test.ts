import { describe, it, expect } from 'vitest';
import { extrapolateTwoCeiling } from '../two-ceiling-extrapolate';

describe('extrapolateTwoCeiling', () => {
  it('recomputes the two ceilings on measured slopes and binds on the tighter', () => {
    const r = extrapolateTwoCeiling({
      cpuCoresPerPathSrtp: 1 / 480,   // -> C_worker_srtp = 480 (<=540, SRTP lowered it)
      mbpsPerViewerReal: 3.0,         // real capped-NIC per-viewer
      nicMbps: 100, nAtTarget: 100, pathsPerViewer: 9,
    });
    expect(r.cWorkerSrtp).toBe(480);
    expect(r.kRcpuAt100).toBe(Math.ceil((100 * 9) / 480));   // = 2
    expect(r.kRbwAt100).toBe(Math.ceil((100 * 3.0) / 100));  // = 3
    expect(r.binding).toBe('bandwidth');
    expect(r.floorAt100).toBe(3);
  });
});
