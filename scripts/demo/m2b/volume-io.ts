/**
 * m2b/volume-io.ts — read artifacts off the booted-stack's `publish-output` docker volume (via the
 * cp-daemon mount): the seeded daemon keys + the publisher's AdminCap creds. Extracted verbatim from
 * the original single-file m2b-live-bhermetic-slash.ts — pure code movement, no behavior change.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { shouldSkipVolumeCopy } from '../native-artifacts.ts';
import { ROOT, DEMO_SHARED } from './common.ts';

const COMPOSE_FILES = [
  'docker-compose-demo.yml',
  'docker-compose-demo-w1.override.yml',
  'docker-compose-demo-relay-overlap.override.yml',
  'docker-compose-demo-consolidated.override.yml',
];

/** Copy a file out of the booted-stack named `publish-output` volume (via the cp-daemon mount). */
export function copyFromVolume(containerPath: string, hostDest: string): void {
  // Track-C (CANARY_NATIVE_ARTIFACTS): the Azure 2-VM native rig has no docker; native-bwan-bootstrap.ts
  // pre-writes hostDest directly into .demo-shared. Skip the `docker compose cp` when the flag is on AND
  // the file is already present (byte-identical default when the flag is unset — docker path unchanged).
  if (shouldSkipVolumeCopy(!!process.env['CANARY_NATIVE_ARTIFACTS'], existsSync(hostDest))) return;
  const composeArgs: string[] = [];
  for (const f of COMPOSE_FILES) { composeArgs.push('-f', join(ROOT, f)); }
  // cp-daemon mounts publish-output:/shared:ro — the seed artifacts live under /shared/.
  execFileSync(
    'docker',
    ['compose', ...composeArgs, 'cp', `cp-daemon:${containerPath}`, hostDest],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

export interface AdminCreds { adminCapId?: string; adminSecretKey?: string }

export interface SeededKey { secretKey: string; capId: string; stakeId: string; minerId?: string }
export interface DaemonKeys { cp?: SeededKey; [k: string]: SeededKey | undefined }

/**
 * Pull the LIVE seeded daemon-keys.json off the named docker volume. We REUSE the seed CP as the
 * role-vote VOTER for the fresh validators/relay (its capId is a ControlPlaneCap). Registering a NEW CP
 * is unreliable here: the booted network ALREADY has a CP, so the DYNAMIC CP stake threshold has scaled
 * above the first-CP base — a fresh 0.6/1.0-SUI register yields a MinerCap, not a ControlPlaneCap.
 */
export function readDaemonKeysFromVolume(): DaemonKeys {
  const dest = join(DEMO_SHARED, '.daemon-keys-from-volume.json');
  copyFromVolume('/shared/daemon-keys.json', dest);
  return JSON.parse(readFileSync(dest, 'utf8')) as DaemonKeys;
}

/** Pull the publisher's AdminCap creds off the volume (gen-canary-material reads these to provision rooms). */
export function readAdminCredsFromVolume(): AdminCreds {
  const dest = join(DEMO_SHARED, '.admin-creds-from-volume.json');
  copyFromVolume('/shared/admin-creds.json', dest);
  return JSON.parse(readFileSync(dest, 'utf8')) as AdminCreds;
}
