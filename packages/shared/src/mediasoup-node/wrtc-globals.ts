/**
 * Node WebRTC handler bootstrap — extracted from
 * `scripts/bench/mediasoup-client-harness.ts` (S25.C.6 — CI-16) so both the
 * bench harness and any other Node-only mediasoup-client consumer (e.g.
 * `apps/bot`) share ONE stitching implementation.
 *
 * mediasoup-client `Device` was designed for browsers — its built-in handlers
 * (`Chrome111`, `Firefox120`, …) read `RTCPeerConnection`, `MediaStream`, etc.
 * from `globalThis`. In Node the globals are absent and `Device.load()` throws
 * `UnsupportedError: device not supported`.
 *
 * Fix: lazy-import `@roamhq/wrtc` and stitch its named exports onto
 * `globalThis` once per process before the first `Device` is created. We pick
 * `Chrome111` as the handler because @roamhq/wrtc's surface matches a recent
 * Chromium build.
 *
 * Kept lazy so callers that mock the WS and never construct a Device don't
 * pay the native-binding cost or fail in environments without wrtc.
 */
let wrtcGlobalsInstalled = false;

export async function ensureNodeWebRtcGlobals(): Promise<void> {
  if (wrtcGlobalsInstalled) return;
  const wrtcModule = (await import('@roamhq/wrtc')) as {
    default?: Record<string, unknown>;
    [k: string]: unknown;
  };
  const w = (wrtcModule.default ?? wrtcModule) as Record<string, unknown>;
  const g = globalThis as unknown as Record<string, unknown>;
  const names = [
    'RTCPeerConnection',
    'RTCSessionDescription',
    'RTCIceCandidate',
    'RTCRtpReceiver',
    'RTCRtpSender',
    'MediaStream',
    'MediaStreamTrack',
  ] as const;
  for (const n of names) {
    if (g[n] === undefined && w[n] !== undefined) g[n] = w[n];
  }
  wrtcGlobalsInstalled = true;
}

/** Late-loaded `@roamhq/wrtc` nonstandard surface (RTCAudioSource/RTCVideoSource). */
export interface WrtcNonstandard {
  RTCAudioSource: new () => {
    createTrack: () => MediaStreamTrack;
    onData: (data: unknown) => void;
  };
  RTCVideoSource: new () => {
    createTrack: () => MediaStreamTrack;
    onFrame: (frame: { width: number; height: number; data: Uint8Array }) => void;
  };
}

export async function loadWrtcNonstandard(): Promise<WrtcNonstandard> {
  const wrtcModule = (await import('@roamhq/wrtc')) as {
    default?: { nonstandard?: WrtcNonstandard };
    nonstandard?: WrtcNonstandard;
  };
  const nonstandard = wrtcModule.nonstandard ?? wrtcModule.default?.nonstandard;
  if (nonstandard === undefined) {
    throw new Error('@roamhq/wrtc nonstandard surface not found');
  }
  return nonstandard;
}
