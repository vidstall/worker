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
