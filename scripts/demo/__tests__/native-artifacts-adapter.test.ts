import { describe, it, expect } from 'vitest';
import { shouldSkipVolumeCopy } from '../native-artifacts.ts';

// Track-C native-boot adapter (no docker): copyFromVolume must skip the `docker compose cp` ONLY when
// the native flag is set AND the dest was pre-populated by native-bwan-bootstrap.ts. Default (flag unset)
// is byte-identical to the docker path — the copy always runs.

describe('shouldSkipVolumeCopy (Track-C native-boot adapter)', () => {
  it('skips the docker copy only when native artifacts are enabled AND the dest already exists', () => {
    expect(shouldSkipVolumeCopy(true, true)).toBe(true); // native rig, pre-placed file → no docker
  });
  it('does NOT skip when native is enabled but the dest is missing (fail loud, not silently skip)', () => {
    expect(shouldSkipVolumeCopy(true, false)).toBe(false);
  });
  it('never skips on the default docker path (flag unset) — byte-identical to before', () => {
    expect(shouldSkipVolumeCopy(false, true)).toBe(false);
    expect(shouldSkipVolumeCopy(false, false)).toBe(false);
  });
});
