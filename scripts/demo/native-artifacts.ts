/**
 * native-artifacts.ts — Track-C native-boot (NO-DOCKER) adapter for the slash orchestrator.
 *
 * The orchestrator `m2b-live-bhermetic-slash.ts` fetches the seed CP key + admin creds off a docker
 * VOLUME (`copyFromVolume` → `docker compose cp cp-daemon:/shared/...`). On the Azure 2-VM/1-VNet rig
 * there is NO docker: `native-bwan-bootstrap.ts` pre-writes those two files directly into `.demo-shared/`
 * (`.daemon-keys-from-volume.json` / `.admin-creds-from-volume.json`). This pure predicate lets
 * `copyFromVolume` SKIP the `docker compose cp` when the native flag is on AND the dest is already there.
 *
 * DEFAULT (flag unset) is BYTE-IDENTICAL: the docker copy path runs unchanged. Kept as its own
 * side-effect-free module so it is unit-testable without importing the orchestrator entry (whose
 * module-level `hexEnv32` constants throw unless the run env is present).
 */
export function shouldSkipVolumeCopy(nativeArtifacts: boolean, destExists: boolean): boolean {
  return nativeArtifacts && destExists;
}

/**
 * Track-C GENUINE 2-host co-sign gate. When `CLAIM_BOARD_URL` is set, the orchestrator posts its OWN
 * att1 to the `/canary/claims` board and polls until the PEER host (vm2) posts a DISTINCT att2 (the
 * peer independently captured the SAME forwarded media + signed with its OWN Wallet-B) — instead of
 * self-signing att2 in-process. Default (unset / empty) = BYTE-IDENTICAL single-process self-sign, so
 * the shipped single-host slash path is unchanged. Pure so the gate is unit-tested without a live board.
 */
export function shouldUsePeerCoSign(claimBoardUrl: string | undefined): boolean {
  return typeof claimBoardUrl === 'string' && claimBoardUrl.length > 0;
}

/**
 * Poll-termination predicate for the peer co-sign wait: the board cell is ready to ASSEMBLE once it
 * carries >= `minAttesters` DISTINCT Wallet-B pubkeys (host-A's own + the peer host's). The `>= 2`
 * floor is belt-and-suspenders — a lone-attester cell can NEVER be mistaken for a quorum even if a
 * caller passes a degenerate `minAttesters < 2`.
 */
export function peerCoSignQuorumMet(distinctCount: number, minAttesters: number): boolean {
  return minAttesters >= 2 && distinctCount >= minAttesters;
}
