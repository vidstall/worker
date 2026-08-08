#!/bin/sh
# read-seed-keys.sh -- F47 Phase 5.4 daemon-container entrypoint WRAPPER.
#
# Sits in FRONT of read-publish-output.sh: pulls this daemon's pre-seeded keypair +
# CAP_ID out of the seed-bootstrap keys file, exports them under the env names each
# daemon's auto-register.ts checks (so the daemon SKIPS registration and just runs),
# then chains to read-publish-output.sh which exports the object IDs and finally
# `exec "$@"` the real start command (read-publish-output.sh:95).
#
# Usage in compose (override):
#   entrypoint: ["/bin/sh", "-eu", "/entrypoint/read-seed-keys.sh"]
#   command:    ["pnpm", "--filter", "@dvconf/cp-daemon", "start"]
#   environment: { SEED_ROLE: cp }
#
# Per-role env-name mapping (the names each auto-register.ts early-returns on):
#   cp          -> CP_KEYPAIR        + CP_CAP_ID
#   relay       -> PRIVATE_KEY       + MINER_CAP_ID
#   relay-standby -> PRIVATE_KEY     + MINER_CAP_ID  (2nd relay; same env names as relay)
#   validator   -> SUI_PRIVATE_KEY   + VALIDATOR_CAP_ID
#   validator-2 -> SUI_PRIVATE_KEY   + VALIDATOR_CAP_ID  (2nd distinct validator; same env names)
#
# Requires: jq (present in the daemon image) OR node fallback, mirroring
# read-publish-output.sh's jq/node detection.

set -eu

SEED_ROLE="${SEED_ROLE:-}"
KEYS_OUTPUT_PATH="${KEYS_OUTPUT_PATH:-/shared/daemon-keys.json}"
READ_PUBLISH="${READ_PUBLISH:-/entrypoint/read-publish-output.sh}"

if [ -z "$SEED_ROLE" ]; then
  echo "[read-seed-keys] FATAL: SEED_ROLE unset (expected one of cp|relay|relay-standby|validator|validator-2)" >&2
  exit 1
fi

if [ ! -s "$KEYS_OUTPUT_PATH" ]; then
  echo "[read-seed-keys] FATAL: $KEYS_OUTPUT_PATH missing or empty (seed-bootstrap one-shot must run first)" >&2
  exit 1
fi

echo "[read-seed-keys] role=$SEED_ROLE sourcing keys from $KEYS_OUTPUT_PATH"

# Detect a JSON parser (same precedence as read-publish-output.sh).
if command -v jq >/dev/null 2>&1; then
  PARSER="jq"
elif command -v node >/dev/null 2>&1; then
  PARSER="node"
else
  echo "[read-seed-keys] FATAL: neither jq nor node available to parse JSON" >&2
  exit 1
fi

# Extract a nested string field (keys[$role][$field]) from the keys file.
extract_field() {
  role="$1"
  field="$2"
  if [ "$PARSER" = "jq" ]; then
    jq -r --arg r "$role" --arg f "$field" '.[$r][$f] // empty' "$KEYS_OUTPUT_PATH"
  else
    node -e "const d=require('$KEYS_OUTPUT_PATH');const r='$role',f='$field';const v=(d[r]||{})[f];process.stdout.write(v?String(v):'')"
  fi
}

SECRET_KEY="$(extract_field "$SEED_ROLE" secretKey)"
CAP_ID="$(extract_field "$SEED_ROLE" capId)"

if [ -z "$SECRET_KEY" ] || [ -z "$CAP_ID" ]; then
  echo "[read-seed-keys] FATAL: no secretKey/capId for role '$SEED_ROLE' in $KEYS_OUTPUT_PATH" >&2
  exit 1
fi

# Export under the daemon-expected names so auto-register.ts skips registration.
case "$SEED_ROLE" in
  cp)
    export CP_KEYPAIR="$SECRET_KEY"
    export CP_CAP_ID="$CAP_ID"
    ;;
  relay)
    export PRIVATE_KEY="$SECRET_KEY"
    export MINER_CAP_ID="$CAP_ID"
    ;;
  relay-standby)
    # 2nd relay (relay-overlap warm-pipe standby, ws://relay-standby:4002) — SAME env names as
    # relay (apps/relay/auto-register.ts early-returns on PRIVATE_KEY+MINER_CAP_ID); only the seed
    # slot key differs. seed-bootstrap writes a 'relay-standby' slot, so this case must exist or the
    # standby crashes the consolidated stack's `up --wait` at boot (gap #3 live-run finding).
    export PRIVATE_KEY="$SECRET_KEY"
    export MINER_CAP_ID="$CAP_ID"
    ;;
  validator)
    export SUI_PRIVATE_KEY="$SECRET_KEY"
    export VALIDATOR_CAP_ID="$CAP_ID"
    ;;
  validator-2)
    # 2nd distinct validator — SAME env names as validator (validator-daemon/auto-register.ts
    # early-returns on SUI_PRIVATE_KEY+VALIDATOR_CAP_ID regardless of which seed slot it came from).
    export SUI_PRIVATE_KEY="$SECRET_KEY"
    export VALIDATOR_CAP_ID="$CAP_ID"
    ;;
  *)
    echo "[read-seed-keys] FATAL: unknown SEED_ROLE '$SEED_ROLE'" >&2
    exit 1
    ;;
esac

echo "[read-seed-keys] role=$SEED_ROLE CAP_ID=$CAP_ID (secret exported, not logged)"
echo "[read-seed-keys] chaining to $READ_PUBLISH"

# read-publish-output.sh exports the object IDs and ends with `exec "$@"`, so the
# daemon start command (passed through here as "$@") still runs as PID 1.
exec /bin/sh -eu "$READ_PUBLISH" "$@"
