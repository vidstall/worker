#!/bin/sh
# read-canary-env.sh -- gap #3 (consolidated E2E Stage-5 live slash) validator entrypoint WRAPPER.
#
# Sits in FRONT of read-seed-keys.sh. The canary verify-loop's buildLiveSeams (validator-daemon
# index.ts:506) requireEnv's CANARY_DEMO_ROOM_ID + CANARY_DEMO_RELAY_MINER_ID + CANARY_SELF_OPERATOR_PUBKEY
# + CANARY_DAEMON_KEYS_PATH. The room id + relay miner id are RUNTIME-created (provision-room) so they
# cannot be baked into compose env -- the gen-canary-material one-shot writes them (plus the two
# operator main pubkeys) to /shared/canary-env.sh, which this wrapper sources before the daemon boots.
#
# Chain:  read-canary-env.sh  ->  read-seed-keys.sh (SUI_PRIVATE_KEY + VALIDATOR_CAP_ID)
#                             ->  read-publish-output.sh (PACKAGE_ID + *_REGISTRY_ID)  ->  exec "$@"
#
# Usage in compose (override):
#   entrypoint: ["/bin/sh", "-eu", "/entrypoint/demo/read-canary-env.sh"]
#   command:    ["pnpm", "--filter", "@dvconf/validator-daemon", "start"]
#   environment: { SEED_ROLE: validator | validator-2 }

set -eu

SEED_ROLE="${SEED_ROLE:-}"
CANARY_ENV_FILE="${CANARY_ENV_FILE:-/shared/canary-env.sh}"
READ_SEED="${READ_SEED:-/entrypoint/demo/read-seed-keys.sh}"

if [ ! -s "$CANARY_ENV_FILE" ]; then
  echo "[read-canary-env] FATAL: $CANARY_ENV_FILE missing or empty (gen-canary-material one-shot must run first)" >&2
  exit 1
fi

echo "[read-canary-env] role=$SEED_ROLE sourcing canary env from $CANARY_ENV_FILE"
# Exports CANARY_DEMO_ROOM_ID, CANARY_DEMO_RELAY_MINER_ID, VAL1_SELF_PUBKEY, VAL2_SELF_PUBKEY.
. "$CANARY_ENV_FILE"

# CANARY_SELF_OPERATOR_PUBKEY = THIS validator's MAIN ed25519 pubkey (used by buildCoObserverBoards to
# skip its own manifest; NOT the attestation signer). Pick the right one by seed slot.
case "$SEED_ROLE" in
  validator)   CANARY_SELF_OPERATOR_PUBKEY="${VAL1_SELF_PUBKEY:-}" ;;
  validator-2) CANARY_SELF_OPERATOR_PUBKEY="${VAL2_SELF_PUBKEY:-}" ;;
  *)
    echo "[read-canary-env] FATAL: SEED_ROLE must be validator|validator-2, got '$SEED_ROLE'" >&2
    exit 1
    ;;
esac

if [ -z "${CANARY_DEMO_ROOM_ID:-}" ] || [ -z "$CANARY_SELF_OPERATOR_PUBKEY" ]; then
  echo "[read-canary-env] FATAL: $CANARY_ENV_FILE incomplete (room id / operator pubkey for '$SEED_ROLE' empty)" >&2
  exit 1
fi

export CANARY_DEMO_ROOM_ID CANARY_DEMO_RELAY_MINER_ID CANARY_SELF_OPERATOR_PUBKEY
export CANARY_DAEMON_KEYS_PATH="${CANARY_DAEMON_KEYS_PATH:-/shared/daemon-keys.json}"

echo "[read-canary-env] CANARY_DEMO_ROOM_ID=$CANARY_DEMO_ROOM_ID (operator pubkey + relay miner id set)"
echo "[read-canary-env] chaining to $READ_SEED"

# read-seed-keys.sh chains to read-publish-output.sh which ends with `exec "$@"`, so the daemon
# start command (passed through here as "$@") still runs as PID 1.
exec /bin/sh -eu "$READ_SEED" "$@"
