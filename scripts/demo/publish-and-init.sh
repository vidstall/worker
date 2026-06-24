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
export SUI_RPC_URL="$RPC"   # make the resolved RPC visible to the idempotency gate (node, below)
CONTRACTS_DIR="${CONTRACTS_DIR:-/work/dvconf-contracts}"

# 0. IDEMPOTENCY GATE (root cause A, 2026-06-24). The consolidated runner runs `docker compose run
#    --rm <scenario>` WITHOUT --no-deps, so EVERY scenario (1b/2/2a/5) re-triggers this
#    `service_completed_successfully` one-shot. `sui client test-publish` is non-idempotent, so each
#    re-trigger minted a BRAND-NEW package (5 in one boot) → cp-daemon latched the 1st while
#    validators/host latched the last → role-vote/cap-token/canary desync. If PUBLISH_OUTPUT already
#    holds a package LIVE on THIS chain, skip re-publish so every consumer converges on ONE package.
#    Pure decision logic is unit-tested (check-publish-fresh.test.ts); the .mjs runs with bare `node`
#    (no tsx) from the bind-mounted /entrypoint — no image rebuild. fail-safe: any doubt → publish.
if node /entrypoint/demo/check-publish-fresh.mjs; then
  echo "[publish-init] PUBLISH_OUTPUT already holds a package live on $RPC -- skipping re-publish (idempotent no-op)"
  exit 0
fi

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
# 7. (W1 defense-demo Phase 3, ADDITIVE) Create + configure a single-CP QuorumConfigState so
#    live cap-token issuance/revoke + the F8 rotate scenario can run on this demo stack.
#    create_config is AdminCap-only and stores NO signer set (verify_quorum checks
#    ControlPlaneRegistry membership, which seed-bootstrap enrolls), so creating it + lowering
#    the threshold to 1 at publish time is safe with no CP-address dependency (W-P4 recipe).
echo "[publish-init] creating QuorumConfigState (cp_quorum_sig::create_config)"
sui client call --package "$PKG" --module cp_quorum_sig --function create_config \
  --args "$ADMIN" --gas-budget 100000000 --json > /shared/qs-create.json
QUORUM_STATE_ID="$(node -e 'const o=require("/shared/qs-create.json");const c=(o.objectChanges||[]).find(x=>x.type==="created"&&String(x.objectType||"").includes("::cp_quorum_sig::QuorumConfigState"));if(!c){console.error("FATAL: no QuorumConfigState created");process.exit(1)}process.stdout.write(c.objectId)')"
[ -n "$QUORUM_STATE_ID" ] || { echo "[publish-init] FATAL: no QuorumConfigState created" >&2; exit 1; }
echo "[publish-init] QuorumConfigState=$QUORUM_STATE_ID"

# NetworkRegistry id is not held in a var above -- parse it from the publish output (node; jq absent).
NETWORK_REGISTRY_ID="$(node -e 'const d=require(process.env.PUBLISH_OUTPUT);const o=(d.objectChanges||[]).find(c=>c.type==="created"&&/::network_registry::NetworkRegistry(<|$)/.test(c.objectType||""));process.stdout.write(o&&o.objectId?o.objectId:"")')"
[ -n "$NETWORK_REGISTRY_ID" ] || { echo "[publish-init] FATAL: no NetworkRegistry in publish output" >&2; exit 1; }

echo "[publish-init] lowering min_quorum to 1 (cp_quorum_sig::update_threshold)"
DEPLOYER_ADDR="$(sui client active-address)"
sui client call --package "$PKG" --module cp_quorum_sig --function update_threshold \
  --args "$ADMIN" "$NETWORK_REGISTRY_ID" "$QUORUM_STATE_ID" 1 "$DEPLOYER_ADDR" \
  --gas-budget 100000000 --json > /dev/null

# 8. Merge the QuorumConfigState id into PUBLISH_OUTPUT in the SAME shape read-publish-output.sh
#    greps for (type:"created" + objectType ending ::cp_quorum_sig::QuorumConfigState), so a
#    Phase-5 `QUORUM_STATE_OBJECT_ID="$(extract_shared QuorumConfigState)"` line will find it.
PKG="$PKG" QS="$QUORUM_STATE_ID" node -e '
const fs=require("fs");
const out=process.env.PUBLISH_OUTPUT;
const o=JSON.parse(fs.readFileSync(out,"utf8"));
o.objectChanges=o.objectChanges||[];
o.objectChanges.push({type:"created",objectType:process.env.PKG+"::cp_quorum_sig::QuorumConfigState",objectId:process.env.QS});
fs.writeFileSync(out, JSON.stringify(o,null,2)+"\n");
console.log("[publish-init] merged QuorumConfigState into "+out);
'

# 9. Export demo-only AdminCap creds for the cap-token issuer/revoke + F8 rotate scenarios.
#    LOCALNET THROWAWAY KEY ONLY -- never run against a real network. On sui v1.66.2,
#    `sui keytool export --json` returns a top-level .exportedPrivateKey (verified against the
#    cp-daemon localnet-fixture / cap-token-wiring-e2e / run-smoke usages). If a later sui rev
#    ever changes that field, the Task 0.2 fallback is to transfer the AdminCap to the seed CP
#    in seed-bootstrap.ts instead of exporting the publisher secret here.
echo "[publish-init] exporting demo-only admin creds"
ADMIN_SECRET="$(sui keytool export --key-identity "$(sui client active-address)" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.exportedPrivateKey||"")})')"
[ -n "$ADMIN_SECRET" ] || { echo "[publish-init] FATAL: could not export publisher secret" >&2; exit 1; }
# umask 077 in a subshell so the private-key file lands 600 (codifies demo-only-throwaway in the bits).
( umask 077; CAP="$ADMIN" SK="$ADMIN_SECRET" node -e 'const fs=require("fs");fs.writeFileSync("/shared/admin-creds.json",JSON.stringify({adminCapId:process.env.CAP,adminSecretKey:process.env.SK},null,2)+"\n")' )
echo "[publish-init] admin-creds.json written (adminCapId=$ADMIN)"

echo "[publish-init] done -- publish-output.json now carries package + all registries + QuorumConfigState"
