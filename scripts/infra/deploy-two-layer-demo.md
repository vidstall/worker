# Deploy Runbook — Two-Layer (user -> R1 -> R2 -> user) LIVE PUBLIC DEMO

> **Purpose:** Copy-paste, templated procedure to (Phase B) bring up the 2-VM
> cross-region relay chain on-chain and (Phase C) put TLS on every browser-facing
> endpoint + host the prod client — so a real human on a real phone over the real
> internet can join the 2-relay demo without a mixed-content block.
>
> **Plan of record:** `docs/superpowers/plans/2026-07-08-two-layer-live-public-demo.md`
> (read "THE CRUX — mixed-content" + Phase B/C + the Reuse map first).
>
> **This runbook is Phase C-centric.** Phase B (the on-chain localnet + 2-relay
> choreography) is NOT re-derived here — it reuses the shipped procedure:
> `scripts/infra/azure-wan-runbook.md` §1–§6B + `scripts/demo/wan-bootstrap.ts`
> + the `lane-b-assign.ts` (`RMS_KR_MIN=2`) assignment driver. The live-discovered
> deviations for the 2-relay demo are folded into `azure-wan-runbook.md` under
> **"Two-layer demo deviations (2026-07-08)"** (near §6B) — READ THAT before Phase B.
>
> Docs language: English. All commands are real and templated on `<KR-DNS>` /
> `<JP-DNS>` (the two Azure `*.cloudapp.azure.com` names) and `<KR-pub-ip>` /
> `<JP-pub-ip>`. Caddy v2 syntax below is hand-written, NOT `caddy validate`-checked
> here (no live env) — run `caddy validate` on the VM before `reload`.

---

## Prerequisites (assumes Phase B is UP)

Before Phase C, Phase B must be live (per `azure-wan-runbook.md` §1–§6B + its
"Two-layer demo deviations" subsection):

- KR VM (koreacentral): Sui localnet published + cp + signaling + relay-KR (R1
  primary, `RMS_ACTIVE_FORWARD=1 RMS_TREE_ACTIVE=0`, `ANNOUNCED_IP=<KR-pub-ip>`).
- JP VM (japaneast): relay-JP (R2 standby, same `INTER_RELAY_TOKEN`,
  `ANNOUNCED_IP=<JP-pub-ip>`).
- On-chain `RoomAssigned = [relay-KR, relay-JP]` (two distinct relays), pipe UP.
- Each VM has a free Azure DNS name reserved (`--dns-name` on its public IP):
  `<KR-DNS>` (app/rpc/sig/relay-kr) and `<JP-DNS>` (relay-jp).
- NSG/UFW open **TCP 80 + 443** on BOTH VMs (Caddy ACME challenge + HTTPS) in
  ADDITION to the Phase-B ports (relay WS 4000, signaling 8080, Sui RPC 9000,
  UDP 40000-49999 media+pipe).

```bash
# Templated env (fill in from Phase B), used by the commands below:
KR_DNS=dvconf-kr.koreacentral.cloudapp.azure.com   # <-- your real KR DNS name
JP_DNS=dvconf-jp.japaneast.cloudapp.azure.com      # <-- your real JP DNS name
KR_IP=<KR-pub-ip>                                  # KR VM public IP
JP_IP=<JP-pub-ip>                                  # JP VM public IP
```

---

## Phase C.1 — Install Caddy + place the Caddyfile + reload (BOTH VMs)

Do this on the KR VM and the JP VM. The single templated Caddyfile is
`scripts/infra/caddy/Caddyfile.two-layer-demo`; on each VM keep only that VM's
section (it is split `# ===== KR VM =====` / `# ===== JP VM =====`).

### 1. Install Caddy (Ubuntu 22.04, official apt repo)

```bash
# Run on EACH VM (KR and JP):
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
caddy version    # expect v2.x
```

### 2. Place the Caddyfile with the DNS names substituted

Copy the template to the VM, substitute `<KR-DNS>` / `<JP-DNS>`, and (optionally)
the client web-root placeholder. From your workstation:

```bash
# scp the template to each VM (path relative to the dvconf-daemons repo root):
scp scripts/infra/caddy/Caddyfile.two-layer-demo azureuser@${KR_IP}:/tmp/Caddyfile.tmpl
scp scripts/infra/caddy/Caddyfile.two-layer-demo azureuser@${JP_IP}:/tmp/Caddyfile.tmpl
```

On the **KR VM** — substitute names, keep the KR section, install to `/etc/caddy`:

```bash
ssh azureuser@${KR_IP} "sed -e 's/<KR-DNS>/${KR_DNS}/g' -e 's/<JP-DNS>/${JP_DNS}/g' \
  /tmp/Caddyfile.tmpl | sudo tee /etc/caddy/Caddyfile >/dev/null"
# (the JP block references only relay-jp.<JP-DNS>; harmless on KR because Caddy
#  won't get a cert for a name that doesn't resolve to this VM — but for a clean
#  cert log, delete the JP block on KR and the KR block on JP.)
```

On the **JP VM** — same substitution, keep the JP section:

```bash
ssh azureuser@${JP_IP} "sed -e 's/<KR-DNS>/${KR_DNS}/g' -e 's/<JP-DNS>/${JP_DNS}/g' \
  /tmp/Caddyfile.tmpl | sudo tee /etc/caddy/Caddyfile >/dev/null"
```

### 3. Create the client web-root placeholder on the KR VM (before scp of dist/)

```bash
ssh azureuser@${KR_IP} "sudo mkdir -p /var/www/dvconf-dist && sudo chown -R caddy:caddy /var/www/dvconf-dist"
```

### 4. Validate + reload Caddy (BOTH VMs)

```bash
# On EACH VM: validate first, then reload (graceful; picks up the new Caddyfile).
ssh azureuser@${KR_IP} "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
ssh azureuser@${JP_IP} "sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy"
# Watch the ACME cert issuance (Let's Encrypt) — should see "certificate obtained":
ssh azureuser@${KR_IP} "sudo journalctl -u caddy -n 40 --no-pager | grep -iE 'certificate|obtain|error' || true"
```

> Caddy needs inbound TCP 80 reachable for the ACME HTTP-01 challenge. If cert
> issuance hangs, confirm the NSG/UFW allow 80 AND the DNS name resolves to this
> VM's public IP (`dig +short ${KR_DNS}` == `${KR_IP}`).

---

## Phase C.2 — Build the client with public envs + host it (KR VM)

Build the prod client from `dvconf-client` with the PUBLIC (TLS) endpoints, then
scp the static `dist/` to the KR Caddy web root.

### 1. Assemble the build env

The on-chain package/box IDs come from the Phase B `.env` (the 10 IDs written on
the KR VM — `PACKAGE_ID`, `*_REGISTRY_ID`, `ROOM_MANAGER_ID`, `ROLE_VOTE_BOX_ID`,
etc.). Map the daemon `.env` names to the client `VITE_*` names:

```bash
# Build from the dvconf-client repo root (your workstation, or the KR VM):
cd dvconf-client

# --- browser-facing endpoints: ALL TLS (defeats mixed-content) ---
export VITE_SIGNALING_URL=wss://sig.${KR_DNS}
export VITE_RELAY_URL=wss://relay-kr.${KR_DNS}
export VITE_SUI_RPC_URL=https://rpc.${KR_DNS}
export VITE_SUI_NETWORK=localnet

# --- on-chain IDs (copy the values from the Phase B KR-VM .env) ---
export VITE_PACKAGE_ID=<PACKAGE_ID>
export VITE_NETWORK_REGISTRY_ID=<NETWORK_REGISTRY_ID>
export VITE_MINER_STORE_ID=<MINER_STORE_ID>
export VITE_USER_REGISTRY_ID=<USER_REGISTRY_ID>
export VITE_RELAY_REGISTRY_ID=<RELAY_REGISTRY_ID>
export VITE_CONTROL_PLANE_REGISTRY_ID=<CP_REGISTRY_ID>
export VITE_VALIDATOR_REGISTRY_ID=<VALIDATOR_REGISTRY_ID>
export VITE_ROOM_MANAGER_ID=<ROOM_MANAGER_ID>
export VITE_SIGNALING_REGISTRY_ID=<SIGNALING_REGISTRY_ID>
export VITE_ROLE_VOTE_BOX_ID=<ROLE_VOTE_BOX_ID>

# --- OPTIONAL: 5 healthz/canary URLs over TLS (else widgets render DEGRADED) ---
# Only set these if you uncommented the matching healthz blocks in the Caddyfile.
# Omit them entirely to accept degraded liveness widgets (the demo is unaffected).
# export VITE_CP_HEALTHZ_URL=https://cp-hz.${KR_DNS}
# export VITE_SIGNALING_HEALTHZ_URL=https://sig-hz.${KR_DNS}
# export VITE_VALIDATOR_HEALTHZ_URL=https://val-hz.${KR_DNS}
# export VITE_RELAY_HEALTHZ_URL=https://relay-hz.${KR_DNS}
# export VITE_VALIDATOR_CANARY_COVERAGE_URL=https://canary.${KR_DNS}
```

> Fallbacks are localhost defaults (`config.ts`): unset healthz vars fall back to
> `http://localhost:{8091,8082,8101,4001,8102}` — which the HTTPS app CANNOT reach
> (mixed-content + localhost). That is the DEGRADED-widget path and is acceptable;
> the room/join/media flow does not depend on healthz. `VITE_SUI_RPC_URL`,
> `VITE_SIGNALING_URL`, `VITE_RELAY_URL` are NOT optional — they must be the wss/https
> Caddy names or the app mixed-content-blocks and cannot connect.

### 2. Build + ship the dist/

```bash
pnpm --filter dvconf-client build     # -> dvconf-client/dist/ (static)

# scp the built static site to the KR VM Caddy web root:
scp -r dvconf-client/dist/* azureuser@${KR_IP}:/tmp/dvconf-dist-upload/
ssh azureuser@${KR_IP} "sudo rm -rf /var/www/dvconf-dist/* && \
  sudo cp -r /tmp/dvconf-dist-upload/* /var/www/dvconf-dist/ && \
  sudo chown -R caddy:caddy /var/www/dvconf-dist"
```

> The Caddyfile `root` is `/var/www/dvconf-dist` (PLACEHOLDER). If you host the
> `dist/` elsewhere, change `root *` in `scripts/infra/caddy/Caddyfile.two-layer-demo`
> to match before C.1.

---

## Phase C.3 — Smoke checklist (from the laptop browser)

Open `https://app.<KR-DNS>` on the laptop (ISP-1) and verify:

- [ ] **Padlock valid** — the TLS cert is live (Let's Encrypt, no warning). Also
      confirm `https://rpc.<KR-DNS>`, `wss://sig.<KR-DNS>`, `wss://relay-kr.<KR-DNS>`,
      and `wss://relay-jp.<JP-DNS>` each show a valid cert.
- [ ] **ZERO mixed-content errors** — open DevTools console; there must be NO
      "Mixed Content: ... was loaded over HTTPS but requested an insecure ... ws://
      / http://" warnings. Any such warning means a `VITE_*` still points at
      ws://http:// — fix the build env (C.2) and rebuild.
- [ ] **Sui RPC reachable** — the room list loads (the client queries
      `https://rpc.<KR-DNS>`). If it hangs, `curl -sS https://rpc.<KR-DNS> -X POST
      -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'`
      should return a chain id.
- [ ] **Signaling wss connects** — no repeated WS reconnect errors in the console;
      the client establishes the cap-token signaling channel to `wss://sig.<KR-DNS>`.

Done when: the app loads clean over TLS, no mixed-content, room list populates,
signaling connected. Then proceed to the plan's Phase D (live run + record).

---

## Cross-links

- **Plan of record:** `docs/superpowers/plans/2026-07-08-two-layer-live-public-demo.md`
  (crux table, Phase B/C/D, Reuse map, 3-gate pass criteria, risk register).
- **Phase B choreography:** `scripts/infra/azure-wan-runbook.md` §1–§6B +
  "Two-layer demo deviations (2026-07-08)" + `scripts/demo/wan-bootstrap.ts`
  (CP-voting role assignment) + the `lane-b-assign.ts` assignment driver
  (`RMS_KR_MIN=2` -> `RoomAssigned = [relay-KR, relay-JP]`).
- **Caddyfile template:** `scripts/infra/caddy/Caddyfile.two-layer-demo`.
- **Standing landmine:** restart any relay ⇒ `rm -rf apps/relay/.cursors` first, so
  `RoomAssigned` re-emits and the relay re-resolves its role (see the deviations
  subsection in `azure-wan-runbook.md`).
