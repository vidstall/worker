# Azure WAN Run Runbook — dvconf WAN Latency Measurement (REQ-WLM-04)

> **Purpose:** Turnkey procedure for provisioning an Azure VM, verifying inbound UDP is
> reachable (the critical gate missed by the prior VPS at 103.67.197.249 which was
> provider-blocked on inbound UDP), and executing a full WAN latency-measurement run.
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
```

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
# If needed, add manually after bootstrap:
ssh azureuser@"$VM_IP" "sudo ufw allow 40000:49999/udp && sudo ufw allow 3478/udp && sudo ufw reload"
```

---

## Section 6 — Run

Start signaling and relay daemons on the VM with latency-bench env vars, then drive two
client machines on separate ISPs through the Playwright driver.

### 6.1 — Start daemons on the VM

```bash
source /tmp/dvconf-bench.env
RUN_ID="wan-$(date +%Y%m%dT%H%M%S)"
echo "Run ID: $RUN_ID"

ssh azureuser@"$VM_IP" << EOF
  cd ~/dvconf-daemons
  export BENCH_LATENCY=1
  export BENCH_SCENARIO=s-wan
  export BENCH_TRACE_ID=${RUN_ID}
  # Start signaling in background (adjust path/port as needed)
  NODE_ENV=production node apps/signaling/dist/index.js &
  # Start relay in background
  NODE_ENV=production node apps/relay-sfu/dist/index.js &
  echo "Daemons started. PIDs: $(pgrep -f 'node apps' | tr '\n' ' ')"
EOF
```

### 6.2 — Drive from client machines (two ISPs)

On **client machine A** (ISP-1):

```bash
cd dvconf-daemons
BENCH_TRACE_ID=<run-id> \
  npx ts-node scripts/bench/wan-playwright-driver.ts \
  --signaling-url wss://$VM_IP:4000 \
  --role publisher \
  --duration 120
```

On **client machine B** (ISP-2):

```bash
cd dvconf-daemons
BENCH_TRACE_ID=<run-id> \
  npx ts-node scripts/bench/wan-playwright-driver.ts \
  --signaling-url wss://$VM_IP:4000 \
  --role subscriber \
  --duration 120
```

### 6.3 — Real-camera subset

Run one additional pair with real camera to capture codec/encoder overhead:

```bash
# On client machine A:
BENCH_TRACE_ID=<run-id>-realcam \
  npx ts-node scripts/bench/wan-playwright-driver.ts \
  --signaling-url wss://$VM_IP:4000 \
  --role publisher \
  --real-camera \
  --duration 60
```

---

## Section 7 — Collect and Teardown

### 7.1 — Pull bench output

```bash
source /tmp/dvconf-bench.env
mkdir -p bench-output/"$RUN_ID"
scp "azureuser@${VM_IP}:~/dvconf-daemons/bench-output/*.jsonl" bench-output/"$RUN_ID"/
ls -lh bench-output/"$RUN_ID"/
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

If either client machine is behind CGNAT (common on mobile/carrier ISPs) and ICE
candidate gathering fails (no srflx/relay candidates seen in the Playwright driver log),
force TURN relaying:

```bash
BENCH_TRACE_ID=<run-id>-turn \
  npx ts-node scripts/bench/wan-playwright-driver.ts \
  --signaling-url wss://$VM_IP:4000 \
  --role publisher \
  --ice-mode turn \
  --turn-server "turn:$VM_IP:3478" \
  --turn-user bench \
  --turn-pass bench123 \
  --duration 120
```

The TURN server must be running on the VM (coturn or equivalent). Confirm with:

```bash
ssh azureuser@"$VM_IP" "systemctl status coturn || echo 'coturn not installed'"
```

If coturn is not installed:

```bash
ssh azureuser@"$VM_IP" "sudo apt-get install -y coturn && sudo systemctl enable coturn && sudo systemctl start coturn"
```

---

## Checklist Summary

| Step | Command / action | Pass criterion |
|---|---|---|
| 0a. Quota | `az vm list-usage` | (Limit - CurrentValue) >= 2 vCPUs |
| 0b. Inbound UDP | `bash scripts/infra/preflight-udp.sh 40001` | Script prints PASS |
| 1. Provision | `az vm create` | VM running, IP captured in `$VM_IP` |
| 2. NSG | `az network nsg rule create` x6 | All rules show `Succeeded` |
| 3. UFW / bootstrap | `bootstrap-vm.sh` | Exit 0, UFW active |
| 4. Run | Playwright driver on 2 ISPs | `bench-output/*.jsonl` populated |
| 5. Collect | `scp bench-output/*.jsonl` | Files present locally |
| 6. Deallocate | `az vm deallocate` | VM state = `Deallocated` |
