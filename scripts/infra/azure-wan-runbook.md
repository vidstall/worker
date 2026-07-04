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

---

## Prerequisites

- Azure CLI installed and logged in: `az login`
- A resource group already created (or create one below)
- SSH key at `~/.ssh/id_rsa.pub`
- `nc` (netcat) available on a second machine on a **different** network/ISP

```bash
# One-time: create resource group (skip if it exists)
az group create --name dvconf-bench --location southeastasia
```

---

## Section 1 — Provision

Create a B2s VM in Southeast Asia (closest to VN). Capture the public IP immediately.

```bash
# Provision the VM
az vm create \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench \
  --location southeastasia \
  --image Ubuntu2204 \
  --size Standard_B2s \
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

Verify that the B2s size is available in Southeast Asia and that the subscription has
sufficient vCPU quota before provisioning (avoids a failed deployment).

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

```bash
source /tmp/dvconf-bench.env
ssh azureuser@"$VM_IP" 'bash -s' < scripts/infra/bootstrap-vm.sh
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

### 6.1 — Start daemons on the VM

Started via each package's `start` script (runs TypeScript directly under `tsx` —
**no `dist/` build needed**). `BENCH_LATENCY=1` turns on the probes; the signaling
sink listens on `BENCH_PORT=8081`; the relay serves plain `ws://` on `WS_PORT=4000`.

```bash
source /tmp/dvconf-bench.env
RUN_ID="wan-$(date +%Y%m%dT%H%M%S)"
echo "Run ID: $RUN_ID"

ssh azureuser@"$VM_IP" "cd ~/dvconf-daemons && \
  BENCH_LATENCY=1 BENCH_SCENARIO=s-wan BENCH_TRACE_ID=${RUN_ID} \
    nohup pnpm --filter @dvconf/signaling start > /tmp/signaling.log 2>&1 & \
  BENCH_LATENCY=1 BENCH_SCENARIO=s-wan BENCH_TRACE_ID=${RUN_ID} WS_PORT=4000 \
    nohup pnpm --filter relay start > /tmp/relay.log 2>&1 & \
  sleep 6 && echo 'daemons started:' && (pgrep -af 'tsx|src/index.ts' || true)"

# Sanity: the bench sink must answer (405 = up, only POST allowed) and the relay WS port open.
ssh azureuser@"$VM_IP" "curl -s -o /dev/null -w 'bench-sink /bench/event -> HTTP %{http_code}\n' http://localhost:8081/bench/event; \
  (ss -ltn | grep -E ':4000|:8081') || true"
```

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

### 8.1 — Region fallback: East Asia

If Southeast Asia has no B2s quota or availability (Section 3 returns no rows):

```bash
az vm create \
  --resource-group dvconf-bench \
  --name dvconf-wan-bench \
  --location eastasia \
  --image Ubuntu2204 \
  --size Standard_B2s \
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
| 3. UFW / bootstrap | `bootstrap-vm.sh` + allow 4000/8081/tcp | Exit 0, UFW active |
| 4a. Daemons (VM) | `pnpm --filter @dvconf/signaling start` + `pnpm --filter relay start` (BENCH_LATENCY=1) | bench-sink → HTTP 405; :4000/:8081 listening |
| 4b. Page (each client) | `cd dvconf-client && pnpm dev` | vite on localhost:5173 |
| 4c. Run | `wan-split-driver.ts --role produce\|consume --start-epoch <E>` on 2 ISPs (same E) | `session i/30 … done`; sink JSONL grows |
| 5. Collect + assemble | `scp apps/*/bench-output/*.jsonl` → `join-g2g.ts <RUN_ID>` | ≥30 rows, per-session p50/p95/p99 printed |
| 6. Deallocate | `az vm deallocate` | VM state = `Deallocated` |
