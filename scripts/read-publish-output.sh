#!/bin/sh
# read-publish-output.sh -- shared entrypoint helper for docker-compose-demo.yml.
#
# Reads /shared/publish-output.json (written by the move-publish service) and
# exports both daemon-side (PACKAGE_ID, *_REGISTRY_ID, ROOM_MANAGER_ID, ...)
# and client-side (VITE_*) env vars before exec'ing the wrapped command.
#
# This is the single point where on-chain object IDs flow into runtime --
# satisfies vault GOTCHA P-11 (no hardcoded 0x... in compose or daemon code).
#
# Usage in compose:
#   entrypoint: ["/bin/sh", "-eu", "/entrypoint/read-publish-output.sh"]
#   command:    ["pnpm", "--filter", "@dvconf/cp-daemon", "start"]
#
# Requires: jq (present in node:20-alpine and mysten/sui-tools images, or
# falls back to grep/sed if jq missing).

set -eu

PUBLISH_OUTPUT="${PUBLISH_OUTPUT:-/shared/publish-output.json}"

if [ ! -s "$PUBLISH_OUTPUT" ]; then
  echo "[read-publish-output] FATAL: $PUBLISH_OUTPUT missing or empty" >&2
  exit 1
fi

echo "[read-publish-output] sourcing object IDs from $PUBLISH_OUTPUT"

# Detect whether jq is available; if not, fall back to a node one-liner.
if command -v jq >/dev/null 2>&1; then
  PARSER="jq"
elif command -v node >/dev/null 2>&1; then
  PARSER="node"
else
  echo "[read-publish-output] FATAL: neither jq nor node available to parse JSON" >&2
  exit 1
fi

extract_package_id() {
  if [ "$PARSER" = "jq" ]; then
    jq -r '.objectChanges[] | select(.type == "published") | .packageId' "$PUBLISH_OUTPUT" | head -n 1
  else
    node -e "const d=require('$PUBLISH_OUTPUT');const p=(d.objectChanges||[]).find(c=>c.type==='published');console.log(p?p.packageId:'')"
  fi
}

# Extract shared-object IDs by Move type name (the suffix after :: in objectType).
# Pass the type name (e.g. "NetworkRegistry") and get the first matching objectId.
extract_shared() {
  type_name="$1"
  if [ "$PARSER" = "jq" ]; then
    jq -r --arg t "$type_name" \
      '.objectChanges[] | select(.type == "created") | select(.objectType | test("::" + $t + "(<|$)")) | .objectId' \
      "$PUBLISH_OUTPUT" | head -n 1
  else
    node -e "const d=require('$PUBLISH_OUTPUT');const t='$type_name';const o=(d.objectChanges||[]).find(c=>c.type==='created'&&new RegExp('::'+t+'(<|\$)').test(c.objectType||''));console.log(o?o.objectId:'')"
  fi
}

PACKAGE_ID="$(extract_package_id)"
NETWORK_REGISTRY_ID="$(extract_shared NetworkRegistry)"
MINER_STORE_ID="$(extract_shared MinerStore)"
USER_REGISTRY_ID="$(extract_shared UserRegistry)"
RELAY_REGISTRY_ID="$(extract_shared RelayRegistry)"
CP_REGISTRY_ID="$(extract_shared ControlPlaneRegistry)"
VALIDATOR_REGISTRY_ID="$(extract_shared ValidatorRegistry)"
ROOM_MANAGER_ID="$(extract_shared RoomManager)"
SIGNALING_REGISTRY_ID="$(extract_shared SignalingRegistry)"
ROLE_VOTE_BOX_ID="$(extract_shared RoleVoteBox)"

if [ -z "$PACKAGE_ID" ]; then
  echo "[read-publish-output] FATAL: PACKAGE_ID empty (publish-output.json parse failed)" >&2
  exit 1
fi

# Daemon-side exports.
export PACKAGE_ID NETWORK_REGISTRY_ID MINER_STORE_ID USER_REGISTRY_ID
export RELAY_REGISTRY_ID CP_REGISTRY_ID VALIDATOR_REGISTRY_ID
export ROOM_MANAGER_ID SIGNALING_REGISTRY_ID ROLE_VOTE_BOX_ID

# Client-side (Vite) exports -- read by dvconf-client/src/config.ts.
export VITE_PACKAGE_ID="$PACKAGE_ID"
export VITE_NETWORK_REGISTRY_ID="$NETWORK_REGISTRY_ID"
export VITE_MINER_STORE_ID="$MINER_STORE_ID"
export VITE_USER_REGISTRY_ID="$USER_REGISTRY_ID"
export VITE_RELAY_REGISTRY_ID="$RELAY_REGISTRY_ID"
export VITE_CONTROL_PLANE_REGISTRY_ID="$CP_REGISTRY_ID"
export VITE_VALIDATOR_REGISTRY_ID="$VALIDATOR_REGISTRY_ID"
export VITE_ROOM_MANAGER_ID="$ROOM_MANAGER_ID"
export VITE_SIGNALING_REGISTRY_ID="$SIGNALING_REGISTRY_ID"
export VITE_ROLE_VOTE_BOX_ID="$ROLE_VOTE_BOX_ID"

echo "[read-publish-output] PACKAGE_ID=$PACKAGE_ID"
echo "[read-publish-output] exec: $*"
exec "$@"
