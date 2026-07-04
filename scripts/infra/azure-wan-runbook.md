# Azure WAN Run Runbook — dvconf WAN Latency Measurement (REQ-WLM-04)

> **Purpose:** Turnkey procedure for provisioning an Azure VM, verifying inbound UDP is
> reachable (the critical gate missed by the prior VPS at 103.67.197.249 which was
> provider-blocked on inbound UDP), and executing a full WAN latency-measurement run.
>
> **Scope:** Section 6 covers **Lane A** (glass-to-glass over two ISPs, via
> `wan-split-driver.ts`). **Lane B** (inter-relay `t_hop_network` on a live
> cross-relay pipe, two relay hosts) is Section 6B.
>
> Docs language: English. All commands are real and executable.

> **Live-run deviations (first real run — Azure for Students, 2026-07-04).** The
> turnkey path below was validated end-to-end on an Azure-for-Students subscription;
> that environment forced eight deviations from the original procedure. Each is
> folded into its section as a `> DEVIATION` note. Summary:
>
> 1. **Region policy** — Students blocks `southeastasia`; the allowed set was
>    `{centralindia, malaysiawest, koreacentral, japaneast, indonesiacentral}`.
>    Used **malaysiawest** (closest to VN, `B2s_v2` unrestricted). → Section 1.
> 2. **VM size** — `Standard_B2s` (v1) was absent in-region; used
>    **`Standard_B2s_v2`** (x64, 2 vCPU / 8 GiB). → Section 1.
> 3. **Quota not pre-checkable** — `az vm list-usage` returns **0 rows** on Students;
>    provision-and-handle instead of gating on quota. → Section 3.
> 4. **Bootstrap needs root** — `bootstrap-vm.sh` self-checks for root, so the
>    `ssh … 'bash -s'` form fails; pipe to **`sudo bash -s`**. → Section 5.
> 5. **pnpm version** — corepack pulls the latest pnpm (11.x, which needs Node ≥ 22.13
>    → `node:sqlite` crash on the Node 20 the bootstrap installs). Pin
>    **`corepack prepare pnpm@10.30.3 --activate`**. → Section 5.
> 6. **mediasoup worker** — pnpm 10 ignores dependency build scripts, so the worker
>    binary is not built by `pnpm install`; build it directly. → Section 5.
> 7. **UFW ports** — bootstrap's UFW does not open the relay WS (4000) or bench sink
>    (8081); add them explicitly (Section 5's manual step is REQUIRED, not optional).
> 8. **Daemons require a live chain to BOOT** (the big one) — the relay registers
>    on-chain at startup (`ensureRegistered()` → `process.exit(1)` on failure) and
>    both daemons require 11 on-chain object IDs, so Section 6.1 is **not** "just
>    start the daemons": a full localnet must be published on the VM first, and the
>    start command needs `ANNOUNCED_IP` + the RTC port range. → Section 6.1.

---

## Prerequisites

- Azure CLI installed and logged in: `az login`
- A resource group already created (or create one below)
- SSH key at `~/.ssh/id_rsa.pub`
- `nc` (netcat) available on a second machine on a **different** network/ISP

```bash
# One-time: create resource group (skip if it exists)
# DEVIATION 1: on Azure for Students southeastasia is policy-blocked; malaysiawest
# is the closest allowed region (allowed set: centralindia, malaysiawest,
# koreacentral, japaneast, indonesiacentral). The RG region is only metadata.
az group create --name dvconf-bench --location malaysiawest
```

---

## Section 1 — Provision

Create a 2-vCPU VM in the closest allowed region and capture the public IP immediately.

> **DEVIATION 1 + 2 (Azure for Students):** `southeastasia` is policy-blocked and
> `Standard_B2s` (v1) was absent in the allowed regions — so this uses
> `--location malaysiawest` and `--size Standard_B2s_v2`. On a standard (non-Students)
> subscription the original `southeastasia` / `Standard_B2s` values work; adjust back
> if your subscription allows them. Confirm size availability with Section 3 first.

```bash
# Provision the VM
az vm create \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench \
  --location malaysiawest \
  --image Ubuntu2204 \
  --size Standard_B2s_v2 \
  --admin-username azureuser \
  --ssh-key-values ~/.ssh/id_rsa.pub \
  --public-ip-sku Standard \
  --output json | tee /tmp/vm-create-output.json

# Extract and store the public IP
VM_IP=$(az vm show \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench \
  --show-details \
  --query publicIps \
  --output tsv)

echo "VM public IP: $VM_IP"
# Persist it for later steps
echo "VM_IP=$VM_IP" > /tmp/dvconf-bench.env
```

---

## Section 2 — NSG (First Firewall Layer)

Add inbound NSG rules for SSH, HTTP/HTTPS, STUN/TURN, and the full mediasoup RTP range
(40000–49999). Rules are ordered by priority (lower = evaluated first).

```bash
NSG_NAME="dvconf-wan-benchNSG"   # Azure names it <vm-name>NSG by default

# SSH (already added by az vm create, but explicit here for clarity)
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-ssh \
  --priority 100 \
  --direction Inbound \
  --protocol Tcp \
  --destination-port-ranges 22 \
  --access Allow

# HTTP
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-http \
  --priority 110 \
  --direction Inbound \
  --protocol Tcp \
  --destination-port-ranges 80 \
  --access Allow

# HTTPS
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-https \
  --priority 120 \
  --direction Inbound \
  --protocol Tcp \
  --destination-port-ranges 443 \
  --access Allow

# STUN/TURN (UDP 3478)
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-stun-udp \
  --priority 200 \
  --direction Inbound \
  --protocol Udp \
  --destination-port-ranges 3478 \
  --access Allow

# mediasoup RTP/RTCP range (UDP 40000–49999) — the critical UDP range
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-mediasoup-rtp-udp \
  --priority 210 \
  --direction Inbound \
  --protocol Udp \
  --destination-port-ranges "40000-49999" \
  --access Allow

# mediasoup RTP/RTCP range (TCP fallback)
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-mediasoup-rtp-tcp \
  --priority 220 \
  --direction Inbound \
  --protocol Tcp \
  --destination-port-ranges "40000-49999" \
  --access Allow

# Relay WebSocket signaling (TCP 4000 = relay WS_PORT). The bench browsers
# connect ws://$VM_IP:4000 — WITHOUT this rule the run cannot start.
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-relay-ws \
  --priority 230 \
  --direction Inbound \
  --protocol Tcp \
  --destination-port-ranges 4000 \
  --access Allow

# Signaling /bench/event sink (TCP 8081 = BENCH_PORT). The browser RTCStats
# collector POSTs LatencyEvents here — WITHOUT this rule 0 rows are collected.
az network nsg rule create \
  --resource-group dvconf-bench \
  --nsg-name "$NSG_NAME" \
  --name allow-bench-sink \
  --priority 240 \
  --direction Inbound \
  --protocol Tcp \
  --destination-port-ranges 8081 \
  --access Allow
```

> The bench PAGE is served on each client machine's **localhost** (see Section 6),
> so port 5173 is NOT exposed on the VM and needs no NSG rule. Only the relay WS
> (4000), the bench sink (8081), and the media range (40000–49999/udp) cross the WAN.

---

## Section 3 — Step-0(a): Quota / Region Check

Verify that the chosen size is available in the target region and that the subscription
has sufficient vCPU quota before provisioning (avoids a failed deployment).

> **DEVIATION 3 (Azure for Students):** `az vm list-usage` returned **0 rows** on the
> Students subscription — quota is not pre-checkable there. In that case skip the quota
> gate and provision-and-handle: if `az vm create` fails on quota/availability, fall
> back per Section 8. Also check `Standard_B2s_v2` (not `Standard_B2s`) availability in
> `malaysiawest`.

```bash
# Check vCPU quota for the region (Standard_B family uses "standardBSFamily")
az vm list-usage \
  --location southeastasia \
  --query "[?contains(name.value, 'standardBSFamily')]" \
  --output table

# Sample output columns: Name | CurrentValue | Limit
# Ensure (Limit - CurrentValue) >= 2  (B2s = 2 vCPUs)

# Confirm B2s is available in Southeast Asia
az vm list-skus \
  --location southeastasia \
  --size Standard_B2s \
  --output table \
  --query "[?restrictions==[]]"

# If the above returns zero rows, B2s is restricted in that zone.
# Fallback: use East Asia (see Section 8).
```

---

## Section 4 — Step-0(b): Inbound UDP Gate

> **THIS IS A HARD GO/NO-GO GATE.**
> The VPS at 103.67.197.249 was provider-blocked on inbound UDP at the datacenter level
> (NSG showed open, but datagrams never arrived). Azure self-managed NSGs are different,
> but this MUST be proven before any paid run. Do NOT assume it works.

### On the Azure VM

```bash
source /tmp/dvconf-bench.env   # loads VM_IP
ssh azureuser@"$VM_IP"

# Inside the VM — run the preflight script:
bash scripts/infra/preflight-udp.sh 40001
# Script binds UDP :40001 and waits up to 60 s for one datagram.
```

### On a second machine (different ISP / mobile hotspot)

```bash
# Replace <VM_IP> with the value from $VM_IP above
echo "probe" | nc -u <VM_IP> 40001
```

### Decision

| Script output | Action |
|---|---|
| `[preflight] PASS — inbound UDP :40001 reachable` | Continue to Section 5. |
| `[preflight] FAIL — no inbound UDP` | **STOP. Do not run.** Re-check the NSG rule `allow-mediasoup-rtp-udp` is saved, UFW rule is present, and no additional Azure policy is blocking UDP. Re-run this section after fixes. |

---

## Section 5 — UFW (Second Firewall Layer)

Run the existing bootstrap script which installs dependencies and configures UFW.
Do NOT rewrite or inline its contents here — it is the authoritative source.

> **DEVIATION 4:** `bootstrap-vm.sh` self-checks for root, so the plain `'bash -s'`
> form fails ("must run as root"). Pipe it to `sudo bash -s`. It installs Node 20 by
> default (`NODE_MAJOR=20`).

```bash
source /tmp/dvconf-bench.env
ssh azureuser@"$VM_IP" 'sudo bash -s' < scripts/infra/bootstrap-vm.sh
```

> **DEVIATION 5 + 6 (pnpm + mediasoup) — REQUIRED after bootstrap, before `pnpm install`.**
> On Node 20, corepack's default pnpm is the latest (11.x, which needs Node ≥ 22.13 and
> crashes on `node:sqlite`). Pin pnpm 10, then install. pnpm 10 ignores dependency build
> scripts, so the mediasoup worker binary is NOT built by install — build it directly
> (needs `python3-venv`), or the relay crashes at worker spawn.

```bash
ssh azureuser@"$VM_IP" 'bash -s' <<'REMOTE'
set -e
cd ~/dvconf-daemons
corepack prepare pnpm@10.30.3 --activate      # DEVIATION 5: pin (matches lockfile v9)
pnpm install --frozen-lockfile
# DEVIATION 6: build the mediasoup worker from source (pnpm 10 skipped its postinstall)
sudo apt-get install -y python3-venv
cd node_modules/.pnpm/mediasoup@*/node_modules/mediasoup
node npm-scripts.mjs postinstall
ls -lh worker/out/Release/mediasoup-worker    # expect a ~9 MB linux-x64 binary
REMOTE
```

If the VM already has an existing firewall configuration and UFW would conflict, skip the
UFW portion with:

```bash
ssh azureuser@"$VM_IP" 'BOOTSTRAP_SKIP_UFW=1 bash -s' < scripts/infra/bootstrap-vm.sh
```

After bootstrap completes, re-run the preflight gate (Section 4) to confirm UFW did not
close UDP 40001. UFW must explicitly allow the mediasoup range:

```bash
# If needed, add manually after bootstrap (media range + STUN + relay WS + bench sink):
ssh azureuser@"$VM_IP" "sudo ufw allow 40000:49999/udp && sudo ufw allow 3478/udp && sudo ufw allow 4000/tcp && sudo ufw allow 8081/tcp && sudo ufw reload"
```

---

## Section 6 — Run (Lane A: glass-to-glass over two ISPs)

Lane A measures the end-to-end one-way latency across two REAL, distinct ISPs.
Machine A **produces** on ISP-1, machine B **consumes** on ISP-2; both browsers
connect to the relay on the VM and POST their RTCStats to the signaling bench
sink. `wan-split-driver.ts` (one role per machine) synchronises the two machines
with **absolute-time windows** — no A↔B channel — so they land in the same room
(`wan-<i>`) at the same wall-clock time. The producer/consumer rendezvous is
relay-mediated (the relay's `newProducer` fan-out).

### 6.0 — Client-machine prerequisites (BOTH machines)

Each client machine needs BOTH repos and an NTP-synced clock:

- `dvconf-daemons` (runs the driver) and `dvconf-client` (serves the bench page).
- `pnpm install` done in each; `npx playwright install chromium` in `dvconf-daemons`.
- Clock synced (`sudo timedatectl set-ntp true` on Linux; Windows syncs by default).
  Absolute-time windows only align if both clocks agree to sub-second.
- The bench page is served on **localhost** (a browser secure context — required
  for `getUserMedia` on the produce side; `http://<VM_IP>:5173` would be blocked).

### 6.1a — Bring up the on-chain localnet on the VM (REQUIRED — daemons will NOT boot without it)

> **DEVIATION 8 — the daemons hard-require a live Sui chain to boot.** Both the relay
> and the signaling daemon call `loadNetworkConfig()`, which requires 11 on-chain
> object IDs, and the relay additionally runs `ensureRegistered()` at startup — an
> on-chain registration transaction that `process.exit(1)`s on failure. There is **no
> bench bypass**. The local `.env` IDs are bound to your local genesis and are NOT
> reusable on the VM (a fresh genesis mints fresh IDs). So before Section 6.1 you must
> stand up a full localnet on the VM and publish the contracts.
>
> Good news for **Lane A**: the relay serves rooms **ad-hoc** (`handleJoin` creates a
> router on first join; the only admission gate is an optional room-password, which the
> Lane-A driver does not send). So **cp-daemon and validators are NOT needed** — only
> the relay + signaling must boot. Lane B (Section 6B) still needs the full native stack.

Steps (run on the VM; the keypairs are **throwaway localnet keys**, safe only here):

1. **Copy the contracts sources to the VM** (the `dvconf-contracts` repo — Move sources +
   `scripts/demo/publish-and-init.sh`). A tarball or a git bundle both work, e.g.
   `~/dvconf-contracts` on the VM.
2. **Start the localnet** (`sui` 1.66.2 was already installed by bootstrap; it matches the
   `publish-and-init.sh` comments):

   ```bash
   ssh azureuser@"$VM_IP" 'nohup sui start --with-faucet --force-regenesis > /tmp/sui.log 2>&1 & sleep 20 && sui client chain-identifier'
   ```

3. **Publish + init** — mirror `dvconf-contracts/scripts/demo/publish-and-init.sh` steps
   **1–6** (configure client → new deployer address → faucet + poll gas →
   `sui client test-publish --build-env localnet` → create the 6 admin-gated registries →
   merge into `publish-output.json`). **Skip steps 7–9** (QuorumConfigState / cap-token /
   admin-creds — not needed for the media bench). This yields the 10 fresh object IDs.
   > NOTE: `publish-and-init.sh` is written for the docker localnet; on the VM you run the
   > same six steps against the host `sui` directly. Map the published objects to env names
   > with `dvconf-daemons/scripts/read-publish-output.sh`.
4. **Write `~/dvconf-daemons/.env`** on the VM with the 10 fresh IDs
   (`PACKAGE_ID`, `NETWORK_REGISTRY_ID`, `MINER_STORE_ID`, `USER_REGISTRY_ID`,
   `RELAY_REGISTRY_ID`, `CP_REGISTRY_ID`, `VALIDATOR_REGISTRY_ID`, `ROOM_MANAGER_ID`,
   `SIGNALING_REGISTRY_ID`, `ROLE_VOTE_BOX_ID`) + `SUI_NETWORK=localnet` + the four
   throwaway keypairs (`PRIVATE_KEY`, `SIGNALING_KEYPAIR`, `CP_KEYPAIR`, `SUI_PRIVATE_KEY`).
   Import + faucet `PRIVATE_KEY` and `SIGNALING_KEYPAIR` (the relay stakes 0.25 SUI at
   registration, so its address needs gas).
5. **DEVIATION 8a — acquire the relay/signaling ROLES via CP-voting.** `determine_role()`
   in `staking.move` only ever returns `role_cp` or `role_user`, so the relay and signaling
   nodes cannot get their role directly — a CP must vote them in. The live run used a helper,
   `scripts/demo/wan-bootstrap.ts` (10 steps: register a CP → cast role votes for the relay
   and signaling addresses → apply the voted roles → register in the relay and signaling
   registries). Run it once after step 4:

   ```bash
   # wan-bootstrap.ts reads PRIVATE_KEY + SIGNALING_KEYPAIR (from .env) and DEPLOYER_ADDRESS
   # (the deployer address minted in step 3). Replace <deployer-addr> with that address:
   ssh azureuser@"$VM_IP" "cd ~/dvconf-daemons && set -a && . ./.env && set +a && DEPLOYER_ADDRESS=<deployer-addr> npx tsx scripts/demo/wan-bootstrap.ts"
   ```

   > `wan-bootstrap.ts` is committed at `dvconf-daemons/scripts/demo/wan-bootstrap.ts`. It
   > reads all secrets / run-specific values from env (`PRIVATE_KEY`, `SIGNALING_KEYPAIR`,
   > `DEPLOYER_ADDRESS`) and the object IDs from `~/publish-output.json` — nothing is
   > hardcoded, so it is reusable across any localnet genesis.

> **Ephemeral warning:** the localnet uses `--force-regenesis`, so it does not survive a VM
> reboot — the object IDs change on restart. If the VM reboots, re-run steps 2–5 (re-publish
> + re-write `.env` + re-run `wan-bootstrap.ts`) before starting the daemons.

### 6.1 — Start daemons on the VM

Started via each package's `start` script (runs TypeScript directly under `tsx` —
**no `dist/` build needed**). `BENCH_LATENCY=1` turns on the probes; the signaling
sink listens on `BENCH_PORT=8081`; the relay serves plain `ws://` on `WS_PORT=4000`.

> **DEVIATION 8b — the relay start command MUST set `ANNOUNCED_IP` and the RTC port range.**
> Without `ANNOUNCED_IP=<VM public IP>` mediasoup advertises `127.0.0.1` in its ICE
> candidates and remote WebRTC never connects. And `RTC_MIN_PORT`/`RTC_MAX_PORT` default to
> `10000-10100`, which is OUTSIDE the `40000-49999` UDP range opened by the firewall
> (Sections 2/5) — set them to `40000/40100` so the media ports are actually reachable.

```bash
source /tmp/dvconf-bench.env
RUN_ID="wan-$(date +%Y%m%dT%H%M%S)"
echo "Run ID: $RUN_ID"

ssh azureuser@"$VM_IP" "cd ~/dvconf-daemons && \
  BENCH_LATENCY=1 BENCH_SCENARIO=s-wan BENCH_TRACE_ID=${RUN_ID} BENCH_PORT=8081 \
    nohup pnpm --filter @dvconf/signaling start > /tmp/signaling.log 2>&1 & \
  BENCH_LATENCY=1 BENCH_SCENARIO=s-wan BENCH_TRACE_ID=${RUN_ID} WS_PORT=4000 \
    ANNOUNCED_IP=${VM_IP} RTC_MIN_PORT=40000 RTC_MAX_PORT=40100 \
    nohup pnpm --filter relay start > /tmp/relay.log 2>&1 & \
  sleep 6 && echo 'daemons started:' && (pgrep -af 'tsx|src/index.ts' || true)"

# Sanity: the bench sink must answer (405 = up, only POST allowed) and the relay WS port open.
ssh azureuser@"$VM_IP" "curl -s -o /dev/null -w 'bench-sink /bench/event -> HTTP %{http_code}\n' http://localhost:8081/bench/event; \
  (ss -ltn | grep -E ':4000|:8081') || true"
```

> On first boot the relay runs its on-chain registration (a few seconds); watch
> `/tmp/relay.log` for the `ensureRegistered` success and the minted `MINER_CAP_ID`.
> Passing that `MINER_CAP_ID` back in on subsequent restarts skips re-registration.

> Output location: `pnpm --filter <pkg> start` runs with cwd = the package dir, so
> the JSONLs land in **`apps/signaling/bench-output/s-wan-client-${RUN_ID}.jsonl`**
> (browser send+recv legs — the Lane-A file) and `apps/relay/bench-output/s-wan-relay-${RUN_ID}.jsonl`
> (relay-side `L_relay_fwd`). Section 7 pulls both.

### 6.2 — Serve the bench page on each client machine

In a separate terminal on **each** client machine (leave it running):

```bash
cd dvconf-client
pnpm dev          # vite → http://localhost:5173  (serves bench/wan-measure-page.html)
```

### 6.3 — Launch the split driver on both machines

Pick ONE shared start-epoch and give both machines a comfortable lead to be ready:

```bash
# On EITHER machine, compute the shared anchor (3-minute lead), then tell the other operator:
node -e "console.log(Date.now()+180000)"     # -> e.g. 1783200000000  (this is E)
```

On **client machine A** (ISP-1) — produce:

```bash
cd dvconf-daemons
npx tsx scripts/bench/wan-split-driver.ts \
  --role produce \
  --start-epoch <E> \
  --sessions 30 --window-ms 25000 \
  --relay ws://$VM_IP:4000 \
  --bench http://$VM_IP:8081 \
  --page http://localhost:5173/bench/wan-measure-page.html
```

On **client machine B** (ISP-2) — consume (SAME `<E>`):

```bash
cd dvconf-daemons
npx tsx scripts/bench/wan-split-driver.ts \
  --role consume \
  --start-epoch <E> \
  --sessions 30 --window-ms 25000 \
  --relay ws://$VM_IP:4000 \
  --bench http://$VM_IP:8081 \
  --page http://localhost:5173/bench/wan-measure-page.html
```

Each driver prints its window schedule up front (both must show the SAME anchor `E`)
and logs `session i/30 … done` (or `FAILED — …`) per window. 30 × 25 s ≈ 12.5 min.
A `FAILED` line with `ERR_CONNECTION_REFUSED` → the vite page or the relay is
unreachable; a consumeRemote rendezvous timeout → the other machine was not in the
room (check both used the same `E` and both clocks are NTP-synced).

### 6.4 — Real-camera subset

Repeat 6.3 once with a fresh `E` and `--real-camera` on BOTH machines to capture
real encoder/codec overhead (use a smaller `--sessions`, e.g. 10). Give it a
distinct run id so the JSONL is separable:

```bash
# Restart the VM daemons (6.1) with BENCH_TRACE_ID=${RUN_ID}-realcam first, then on both machines:
npx tsx scripts/bench/wan-split-driver.ts --role <produce|consume> --start-epoch <E2> \
  --sessions 10 --window-ms 25000 --real-camera \
  --relay ws://$VM_IP:4000 --bench http://$VM_IP:8081 \
  --page http://localhost:5173/bench/wan-measure-page.html
```

---

## Section 6B — Run (Lane B: inter-relay `t_hop_network`)

Lane B measures the one-way **inter-relay** network hop `t_hop_network` on a LIVE
cross-relay pipe, so `t_hop` flips from assumed → measured in the cascade-tree
latency model. Unlike Lane A this is NOT "start two relays and point B at A": the
PRIMARY/STANDBY topology is **chain-mediated** — the standby resolves the
primary's endpoint from the on-chain `RoomAssigned` event (`relayIds[0]` →
`primaryUrl`, `relay-endpoint-resolver.ts`) and dials the inter-relay link, opens
a warm PlainTransport pipe, and mints a local producer via active-forward. The
T7 probe samples RTCP RR `roundTripTime` on **that minted producer** (the
receiver/`inbound-rtp` side) and emits `t_hop_network = rtt/2`
(`apps/relay/src/index.ts:496-502` → `latency-probe.ts startRtpStreamSampler`).

> **Prerequisite — the full native cross-relay stack.** Lane B needs the same
> stack the RMS-live cross-relay run used: an on-chain package + validators +
> cp-daemon with `RMS_KR_MIN>=2` (so a room is assigned ≥2 relays) + signaling +
> **two relays on two hosts** + ≥1 browser producing into the room. Bring it up
> with the canonical procedure (the `rms-live-local` path); the on-chain deploy is
> NOT reproduced here. Reference: `.evidence/verification/rms-live-crossrelay-fix-liveproof.md`
> and `apps/relay/src/__tests__/integration/live/rms-live-local.integration.test.ts`.
> This is the heavier lane — budget accordingly.

### 6B.1 — Two relay hosts (WAN deltas)

Provision a SECOND VM (repeat Section 1 with a different `--name`, e.g.
`dvconf-wan-bench-2`) so the inter-relay pipe crosses a real network hop. On EACH
relay host, the relay process needs these env vars (the non-obvious WAN deltas
over a loopback bring-up):

| Env | Loopback default | WAN value | Why |
|---|---|---|---|
| `BENCH_LATENCY` | unset | `1` | turns on the T7 `t_hop` probe (off → null, zero-cost) |
| `RMS_ACTIVE_FORWARD` | unset | `1` | standby mints the local producer the probe samples |
| `RELAY_ENDPOINT_URL` | `ws://127.0.0.1:$WS_PORT` | `ws://<THIS-host-public-ip>:$WS_PORT` | published on-chain so the standby resolves a WAN-routable primary |
| `ANNOUNCED_IP` | `127.0.0.1` | `<THIS-host-public-ip>` | the PlainTransport pipe address the peer relay connects back to — **without this the pipe is unreachable across the WAN** |
| `WS_PORT` / `METRICS_PORT` | 4000 / 4001 | distinct per host (e.g. 4000/4001) | each host is its own machine, so ports need not differ between hosts, but must match its NSG rule |

```bash
# On EACH relay VM (values are THAT host's own public IP):
ssh azureuser@"$RELAY_IP" "cd ~/dvconf-daemons && \
  BENCH_LATENCY=1 BENCH_SCENARIO=s-wan-hop BENCH_TRACE_ID=${RUN_ID} \
  RMS_ACTIVE_FORWARD=1 RMS_TREE_ACTIVE=0 \
  RELAY_ENDPOINT_URL=ws://${RELAY_IP}:4000 ANNOUNCED_IP=${RELAY_IP} WS_PORT=4000 \
    nohup pnpm --filter relay start > /tmp/relay-hop.log 2>&1 & \
  sleep 6 && (pgrep -af 'tsx|src/index.ts' || true)"
```

### 6B.2 — NSG / firewall for the inter-relay pipe

- **Pipe media (UDP):** `PIPE_PORT_RANGE` defaults to `40000-40100`, which is a
  SUBSET of the mediasoup range `40000-49999` already opened in Section 2 — so no
  new UDP rule is needed, but that range must be open **on both relay hosts** and
  reachable **relay-to-relay** (the Section 2 rules allow it from any source).
- **Inter-relay WS (TCP):** the standby dials `ws://<primary>:$WS_PORT`, so each
  relay host's NSG must open its `WS_PORT` (TCP 4000) — the `allow-relay-ws` rule
  from Section 2, applied to BOTH relay VMs' NSGs.
- If you tighten the pipe range with `PIPE_PORT_RANGE=<min-max>`, open that exact
  UDP range on both hosts instead.

### 6B.3 — Drive a session and collect `t_hop_network`

With the native stack up and a room assigned to ≥2 relays, have ≥1 browser join
and PRODUCE into that room (the Lane-A produce page works, or any client). Once
media flows, the primary pipes → the standby mints → the T7 probe samples. Verify
the pipe is live on the standby, then pull the standby's bench file:

```bash
# On the STANDBY relay: confirm cross-relay bytes are flowing (peaks during the active window):
ssh azureuser@"$STANDBY_IP" "curl -s http://localhost:4001/api/probe | grep -o '\"pipe_bytes_observed\":[0-9]*'"

# t_hop_network is emitted by the STANDBY (source=relay). Pull + inspect:
scp "azureuser@${STANDBY_IP}:~/dvconf-daemons/apps/relay/bench-output/s-wan-hop-relay-${RUN_ID}.jsonl" bench-output/"$RUN_ID"/
grep -o '"metric":"t_hop_network"[^}]*"value_ms":[0-9.]*' bench-output/"$RUN_ID"/s-wan-hop-relay-"$RUN_ID".jsonl | head
```

> **Honest caveats (from the RMS-live cross-relay live-proof):** only ONE active
> standby has been proven live; the cross-relay byte-flow is airtight (standby
> received ~1.2 MB over `pipe_bytes_observed`), but `t_hop` on the WAN pipe is the
> NEW magnitude this run establishes. The probe emits only once RTCP RR has
> populated `roundTripTime` on the minted producer (a few seconds of media), so
> keep the producing session alive ≥10 s. If `t_hop_network` rows are absent,
> check the standby actually minted a producer (`REQ-RMS-025 ... active forward`
> in `/tmp/relay-hop.log`) and that `pipe_bytes_observed` climbed.

---

## Section 7 — Collect and Teardown

### 7.1 — Pull bench output and assemble

The signaling sink (browser send+recv legs) and the relay probe write to their
own package `bench-output/` dirs (see 6.1). Pull both:

```bash
source /tmp/dvconf-bench.env
mkdir -p bench-output/"$RUN_ID"
# Lane-A file (browser RTCStats, source=client) — the one join-g2g needs:
scp "azureuser@${VM_IP}:~/dvconf-daemons/apps/signaling/bench-output/*.jsonl" bench-output/"$RUN_ID"/
# Relay-side L_relay_fwd (source=relay) — bonus:
scp "azureuser@${VM_IP}:~/dvconf-daemons/apps/relay/bench-output/*.jsonl" bench-output/"$RUN_ID"/ || true
ls -lh bench-output/"$RUN_ID"/
```

Assemble one-way glass-to-glass rows (one per session `room_id = wan-<i>`, with
per-session p50/p95/p99). `join-g2g` groups by `(room_id, flow_id)`, medians each
session, and sums both last-mile legs (`RTT_send/2 + RTT_recv/2 + residual`):

```bash
# CLI is <trace-id> [output-dir]; loadTrace() reads every *-<trace-id>.jsonl in the dir.
npx tsx scripts/bench/join-g2g.ts "$RUN_ID" bench-output/"$RUN_ID"
```

### 7.2 — Deallocate VM (preserves disk, stops billing for compute)

```bash
az vm deallocate \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench

echo "VM deallocated. Disk still exists. Restart with: az vm start --resource-group dvconf-bench --name dvconf-wan-bench"
```

### 7.3 — Full delete (if run is complete and disk not needed)

```bash
az vm delete \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench \
  --yes

# Also delete the NIC, public IP, and NSG if no longer needed:
az network nsg delete --resource-group dvconf-bench --name dvconf-wan-benchNSG
az network public-ip delete --resource-group dvconf-bench --name dvconf-wan-benchPublicIP
```

---

## Section 8 — Fallbacks

### 8.1 — Region fallback: koreacentral

If malaysiawest has no availability, use another allowed region. **On Azure for Students
`eastasia` is also policy-blocked** — pick from the allowed set (`centralindia`,
`koreacentral`, `japaneast`, `indonesiacentral`); `koreacentral` was verified clean:

```bash
az vm create \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench \
  --location koreacentral \
  --image Ubuntu2204 \
  --size Standard_B2s_v2 \
  --admin-username azureuser \
  --ssh-key-values ~/.ssh/id_rsa.pub \
  --public-ip-sku Standard \
  --output json | tee /tmp/vm-create-output.json
```

### 8.2 — Size fallback: B1ms (1 vCPU / 2 GB)

If B2s is exhausted across both regions, drop to B1ms. Note: single vCPU may cause
mediasoup worker contention under load — limit concurrent producers to 1.

```bash
# Replace --size Standard_B2s with:
--size Standard_B1ms
```

### 8.3 — ICE fallback: TURN relay for CGNAT peers

If either client machine is behind CGNAT (common on mobile/carrier ISPs) and the
media never flows (a `session … done` line but 0 rows assembled by join-g2g, i.e.
ICE never connected), the WebRTC transport needs a TURN relay.

**The split driver has NO `--ice-mode`/`--turn-*` flags** — ICE servers are NOT a
driver concern. The bench page (`wan-measure.ts`) passes through whatever
`iceServers` the relay returns in its `transportCreated` response
(`createSendTransport`/`createRecvTransport`). So TURN is configured **relay-side**,
not on the driver. Steps:

1. Install + start coturn on the VM:

```bash
ssh azureuser@"$VM_IP" "systemctl status coturn || (sudo apt-get install -y coturn && sudo systemctl enable coturn && sudo systemctl start coturn)"
```

2. Configure the relay to advertise that TURN server in `transportCreated.iceServers`
   (relay ICE-server config — see the relay's transport-creation path). Once the relay
   hands the browser a `turn:$VM_IP:3478` server, re-run 6.3 unchanged; the browsers
   will gather `relay` candidates automatically.

> Note: NSG/UFW already open UDP 3478 (STUN/TURN) from Section 2/5. If the relay has
> no ICE-server config surface yet, that is a relay feature gap to close before a
> CGNAT run — it is not something the driver or this runbook can inject.

---

## Checklist Summary

| Step | Command / action | Pass criterion |
|---|---|---|
| 0a. Quota | `az vm list-usage` | (Limit - CurrentValue) >= 2 vCPUs |
| 0b. Inbound UDP | `bash scripts/infra/preflight-udp.sh 40001` | Script prints PASS |
| 1. Provision | `az vm create` | VM running, IP captured in `$VM_IP` |
| 2. NSG | `az network nsg rule create` x8 (incl. TCP 4000 relay-WS + TCP 8081 bench-sink) | All rules show `Succeeded` |
| 3. UFW / bootstrap | `sudo bash -s` < `bootstrap-vm.sh` + pin `pnpm@10.30.3` + build mediasoup worker + allow 4000/8081/tcp | Exit 0, UFW active, worker binary present |
| 3b. Localnet (VM) | publish contracts + write `.env` (10 IDs) + `wan-bootstrap.ts` (CP-voting roles) | `sui client chain-identifier` OK; relay/signaling registered |
| 4a. Daemons (VM) | signaling + relay `start` with `BENCH_LATENCY=1`, relay also `ANNOUNCED_IP=$VM_IP RTC_MIN_PORT=40000 RTC_MAX_PORT=40100` | bench-sink → HTTP 405; :4000/:8081 listening |
| 4b. Page (each client) | `cd dvconf-client && pnpm dev` | vite on localhost:5173 |
| 4c. Run | `wan-split-driver.ts --role produce\|consume --start-epoch <E>` on 2 ISPs (same E) | `session i/30 … done`; sink JSONL grows |
| 5. Collect + assemble | `scp apps/*/bench-output/*.jsonl` → `join-g2g.ts <RUN_ID>` | ≥30 rows, per-session p50/p95/p99 printed |
| 6. Deallocate | `az vm deallocate` | VM state = `Deallocated` |
