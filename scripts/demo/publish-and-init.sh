#!/bin/bash
# publish-and-init.sh -- F47 Phase 5.4 docker move-publish step.
#
# Publishes the dvconf Move package to the demo localnet AND runs the admin-gated
# post-publish init that the package `init` does NOT do: the per-role registries
# (CP / relay / validator / signaling / user) + RoomManager are created by 6
# `<module>::create(&AdminCap)` calls (the AdminCap is BORROWED, so it is reused
# across all six). Mirrors the proven Phase-4.1 fixture
# (apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts publishPackage +
# createRegistries). Writes a COMPLETE /shared/publish-output.json (publish's
# objectChanges + the 6 created registries merged in) so read-publish-output.sh
# exports all 10 object IDs unchanged.
#
# Runs in the daemon image (dvconf-demo-daemons): has the `sui` CLI (build+publish+
# sign via keystore), `node` (JSON parse/merge -- sui-tools has neither curl nor
# node, which is why move-publish moved off it), and the baked dvconf-contracts.
#
# Env (sane localnet defaults; docker sets the sui-localnet values):
#   SUI_RPC_URL      default http://127.0.0.1:9000  (docker: http://sui-localnet:9000)
#   FAUCET_URL       default http://127.0.0.1:9123/gas (docker: http://sui-localnet:9123/gas)
#   PUBLISH_OUTPUT   default /shared/publish-output.json
#   CONTRACTS_DIR    default /work/dvconf-contracts (read-only mount; copied to a writable /tmp)
set -euo pipefail

RPC="${SUI_RPC_URL:-http://127.0.0.1:9000}"
FAUCET="${FAUCET_URL:-http://127.0.0.1:9123/gas}"
export PUBLISH_OUTPUT="${PUBLISH_OUTPUT:-/shared/publish-output.json}"
CONTRACTS_DIR="${CONTRACTS_DIR:-/work/dvconf-contracts}"

# 1. Point the sui client at the localnet RPC (no faucet url needed in config; we pass --url).
echo "[publish-init] configuring sui client for $RPC"
mkdir -p /root/.sui/sui_config
cat > /root/.sui/sui_config/client.yaml <<EOF
keystore:
  File: /root/.sui/sui_config/sui.keystore
envs:
  - alias: localnet
    rpc: "$RPC"
    ws: ~
active_env: localnet
active_address: ~
EOF

# 2. Generate the deployer address, faucet it, and POLL for the gas coin (the faucet is async).
sui client new-address ed25519 demo-publisher --json > /shared/publisher.json 2>/dev/null || true
ADDR="$(sui client active-address)"
echo "[publish-init] deployer=$ADDR -- requesting faucet at $FAUCET"
sui client faucet --address "$ADDR" --url "$FAUCET"
n=0; until sui client gas --json 2>/dev/null | grep -q 0x; do
  n=$((n+1)); if [ "$n" -ge 90 ]; then echo "[publish-init] FATAL: gas never arrived after 90s" >&2; exit 1; fi; sleep 1;
done
echo "[publish-init] gas ready after ~${n}s"

# 3. test-publish from a WRITABLE copy (the /work mount is read-only; test-publish --build-env
#    writes Pub.localnet.toml + build/ into the package dir). sui >=1.66 'publish' demands a
#    persistent Move.toml [environments] binding to the per-regenesis chain id, wrong for a
#    throwaway --force-regenesis chain; test-publish emits real on-chain objectChanges.
echo "[publish-init] copying package to /tmp/pkg (writable)"
rm -rf /tmp/pkg; mkdir -p /tmp/pkg
cp "$CONTRACTS_DIR/Move.toml" /tmp/pkg/
cp "$CONTRACTS_DIR/Move.lock" /tmp/pkg/ 2>/dev/null || true
cp -r "$CONTRACTS_DIR/sources" /tmp/pkg/
cd /tmp/pkg
echo "[publish-init] test-publish --build-env localnet"
sui client test-publish --build-env localnet --gas-budget 1000000000 --json > "$PUBLISH_OUTPUT"

# 4. Extract packageId + AdminCap from the publish objectChanges (node; jq absent).
PKG="$(node -e 'const d=require(process.env.PUBLISH_OUTPUT);const p=(d.objectChanges||[]).find(c=>c.type==="published");process.stdout.write(p&&p.packageId?p.packageId:"")')"
ADMIN="$(node -e 'const d=require(process.env.PUBLISH_OUTPUT);const a=(d.objectChanges||[]).find(c=>c.type==="created"&&/::network_registry::AdminCap/.test(c.objectType||""));process.stdout.write(a&&a.objectId?a.objectId:"")')"
[ -n "$PKG" ]   || { echo "[publish-init] FATAL: no packageId in publish output" >&2; exit 1; }
[ -n "$ADMIN" ] || { echo "[publish-init] FATAL: no AdminCap in publish output" >&2; exit 1; }
echo "[publish-init] PACKAGE_ID=$PKG  ADMIN_CAP=$ADMIN"

# 5. Create the 6 admin-gated shared registries (NOT created by package init). The AdminCap is
#    borrowed (&AdminCap), so the same cap drives all six (mirrors fixture createRegistries).
MODS="user_registry room_manager relay_registry control_plane_registry validator_registry signaling_registry"
for mod in $MODS; do
  echo "[publish-init] creating $mod registry"
  sui client call --package "$PKG" --module "$mod" --function create --args "$ADMIN" \
    --gas-budget 100000000 --json > "/shared/reg-$mod.json"
done

# 6. Merge every created shared object from the 6 create txs into PUBLISH_OUTPUT so
#    read-publish-output.sh (unchanged) extracts all 10 object IDs by type.
node -e '
const fs=require("fs");
const out=process.env.PUBLISH_OUTPUT;
const base=JSON.parse(fs.readFileSync(out,"utf8"));
base.objectChanges=base.objectChanges||[];
const mods=["user_registry","room_manager","relay_registry","control_plane_registry","validator_registry","signaling_registry"];
let added=0;
for(const m of mods){
  const r=JSON.parse(fs.readFileSync("/shared/reg-"+m+".json","utf8"));
  for(const c of (r.objectChanges||[])){ if(c.type==="created"){ base.objectChanges.push(c); added++; } }
}
fs.writeFileSync(out, JSON.stringify(base,null,2)+"\n");
console.log("[publish-init] merged "+added+" created object(s) into "+out);
'
echo "[publish-init] done -- publish-output.json now carries package + all registries"
