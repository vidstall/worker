import { describe, it, expect } from 'vitest';
import { shouldSkipVolumeCopy, shouldUsePeerCoSign, peerCoSignQuorumMet } from '../native-artifacts.ts';

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

// Track-C GENUINE 2-host co-sign gate. When CLAIM_BOARD_URL is set, the orchestrator posts its OWN
// att1 to the /canary/claims board and polls until the PEER host (vm2) posts a DISTINCT att2 — instead
// of self-signing att2 in-process. Default (unset/empty) = BYTE-IDENTICAL single-process self-sign.
describe('shouldUsePeerCoSign (Track-C genuine 2-host co-sign gate)', () => {
  it('enables peer co-sign only when CLAIM_BOARD_URL is a non-empty string', () => {
    expect(shouldUsePeerCoSign('http://10.0.0.4:8092')).toBe(true);
  });
  it('stays on the byte-identical self-sign path when CLAIM_BOARD_URL is unset or empty', () => {
    expect(shouldUsePeerCoSign(undefined)).toBe(false);
    expect(shouldUsePeerCoSign('')).toBe(false);
  });
});

// The poll-termination predicate for the peer co-sign wait: the board cell is ready to ASSEMBLE once it
// carries >= minAttesters DISTINCT Wallet-B pubkeys (host-A's own + the peer host's). The >=2 floor is
// belt-and-suspenders so a lone-attester cell can NEVER be mistaken for a quorum.
describe('peerCoSignQuorumMet (Track-C poll-termination)', () => {
  it('is met once distinct attesters reach the >=2 minimum', () => {
    expect(peerCoSignQuorumMet(2, 2)).toBe(true);
    expect(peerCoSignQuorumMet(3, 2)).toBe(true);
  });
  it('is NOT met while only host-A has posted (1 distinct)', () => {
    expect(peerCoSignQuorumMet(1, 2)).toBe(false);
    expect(peerCoSignQuorumMet(0, 2)).toBe(false);
  });
  it('never treats a sub-2 minAttesters as a valid quorum (defensive floor)', () => {
    expect(peerCoSignQuorumMet(1, 1)).toBe(false);
    expect(peerCoSignQuorumMet(5, 1)).toBe(false);
  });
});
