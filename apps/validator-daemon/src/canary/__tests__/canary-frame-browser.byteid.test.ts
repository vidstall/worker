/**
 * REQ-MLW-A-02 — byte-identity unit (M2b-live-WAN Sub-lane A).
 *
 * Proves the BROWSER canary-core (`buildCanaryFrameBrowser`, pure WebCrypto + the
 * reused client encryptFrame/PathCKeyDerivation) is byte-identical to the FROZEN
 * daemon `recomputeCanaryFrame` (verifier.ts) for ctr 0..7. WebCrypto runs in Node
 * too, so this locks the crypto half WITHOUT a browser. Any divergence in one of the
 * 6 pinned inputs (seed label / u32BE ctr / codecOffset=10 / HKDF info / senderId /
 * salt) flips a base64 comparison RED. The verifier is never edited (INV-A).
 *
 * Import-depth notes (verified vs the filesystem, NOT copied from the plan):
 *   - `../verifier.js`  — 1 up from __tests__/ → canary/verifier.ts (mirrors verifier's own dir).
 *   - the module lives under `scripts/bench/` (OUTSIDE apps/validator-daemon/src), so reaching
 *     it from __tests__/ is 5 ups to the daemons ROOT, then down into scripts/ (the plan's
 *     4-up snippet resolves to apps/scripts/… and is WRONG).
 */
import { describe, it, expect } from 'vitest';
import { buildCanaryFrameBrowser } from '../../../../../scripts/bench/m2b-canary-browser/canary-frame-browser.js';
import { recomputeCanaryFrame, deriveCanarySeed } from '../verifier.js';

const base = {
  kRoom: new Uint8Array(32).fill(0x5c),
  roomId: 'm2b-live-xproc-room',
  cellSecret: new Uint8Array(32).fill(0xab),
  canaryKid: 7,
};

describe('REQ-MLW-A-02 — browser canary-core is byte-identical to the daemon recompute', () => {
  it('matches recomputeCanaryFrame for ctr 0..7 (62 bytes each)', async () => {
    const seed = deriveCanarySeed(base.cellSecret);
    for (const ctr of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const browser = await buildCanaryFrameBrowser({ ...base, ctr });
      const node = await recomputeCanaryFrame(base, seed, ctr);
      expect(Buffer.from(browser).toString('base64')).toBe(Buffer.from(node).toString('base64'));
      expect(browser.length).toBe(62);
    }
  });
});
