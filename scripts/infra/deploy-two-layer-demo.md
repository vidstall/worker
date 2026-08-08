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
> Docs language: English. The two Azure `*.cloudapp.azure.com` hostnames are FIXED
> for this demo and HARDCODED in the Caddyfile (no `<KR-DNS>`/`<JP-DNS>` substitution
> anymore); the shell `KR_DNS` / `JP_DNS` vars below are only for the client-build
> URLs. Caddy v2 syntax is hand-written, NOT `caddy validate`-checked here (no live
> env) — run `caddy validate` on the VM before `reload`.
>
> **DNS scheme (READ THIS — why ports, not subdomains).** Azure's free
> `*.cloudapp.azure.com` gives EXACTLY ONE A-record per public IP
> (`<label>.<region>.cloudapp.azure.com`) — NO wildcard, NO sub-labels. So
> `app.<dns>` / `rpc.<dns>` / `sig.<dns>` do NOT resolve and Let's Encrypt cannot
> issue certs for them. The Caddyfile therefore fronts ONE hostname per VM and
> separates the backends by distinct TLS PORTS; Caddy provisions one cert per
> hostname and reuses it across all its ports. Fixed labels:
> `dvconf-kr.koreacentral.cloudapp.azure.com` (KR) /
> `dvconf-jp.japaneast.cloudapp.azure.com` (JP).
>
> **Single-hostname port map (KR VM):**
> | Browser touches | TLS URL (one KR hostname) | loopback daemon |
> |---|---|---|
> | client static app (SPA) | `https://dvconf-kr...` (:443) | `file_server dist/` |
> | relay-KR control WS (R1) | `wss://dvconf-kr...:8443` | `localhost:4000` |
> | signaling WS (cap-token) | `wss://dvconf-kr...:9443` | `localhost:8080` |
> | Sui RPC (JSON-RPC at /) | `https://dvconf-kr...:7443` | `localhost:9000` |
>
> **JP VM:** `wss://dvconf-jp...` (:443) → `localhost:4000` (single service, default port).
>
> Media RTP/RTCP (UDP 40000-49999) is DIRECT to each relay's raw `ANNOUNCED_IP` — it
> is NEVER proxied through Caddy and is the ONLY non-TLS browser path (DTLS/SRTP
> already encrypts it).

---

## Prerequisites (assumes Phase B is UP)

Before Phase C, Phase B must be live (per `azure-wan-runbook.md` §1–§6B + its
"Two-layer demo deviations" subsection):

- KR VM (koreacentral): Sui localnet published + cp + signaling + relay-KR (R1
  primary, `RMS_ACTIVE_FORWARD=1 RMS_TREE_ACTIVE=0`, `ANNOUNCED_IP=<KR-pub-ip>`).
- JP VM (japaneast): relay-JP (R2 standby, same `INTER_RELAY_TOKEN`,
  `ANNOUNCED_IP=<JP-pub-ip>`).
- On-chain `RoomAssigned = [relay-KR, relay-JP]` (two distinct relays), pipe UP.
- Each VM has its free Azure DNS name reserved (`--dns-name` on its public IP):
  `dvconf-kr` on the KR public IP → `dvconf-kr.koreacentral.cloudapp.azure.com`
  (app + relay-kr + signaling + rpc, all on ONE hostname by port) and
  `dvconf-jp` on the JP public IP → `dvconf-jp.japaneast.cloudapp.azure.com`
  (relay-jp). Confirm each resolves to its VM: `dig +short <dns>` == that VM's IP.
- **On-chain relay endpoint_url MUST be the wss TLS URLs** (the relay-leg half of
  the mixed-content crux) — register them in Phase B, NOT `ws://<pub-ip>:4000`:
  - relay-KR `endpoint_url = wss://dvconf-kr.koreacentral.cloudapp.azure.com:8443`
  - relay-JP `endpoint_url = wss://dvconf-jp.japaneast.cloudapp.azure.com` (:443)
  See "On-chain relay endpoint URLs" in C.2 below and the `azure-wan-runbook.md`
  §6B-D deviation. `ANNOUNCED_IP` (media) stays the raw public IP — UDP direct.
- NSG/UFW open, on BOTH VMs, in ADDITION to the Phase-B ports (relay WS 4000,
  signaling 8080, Sui RPC 9000, UDP 40000-49999 media+pipe):
  - **TCP 80 + 443** — the ACME HTTP-01 challenge + cert renewal ride 80/443, and
    443 fronts the app (KR) / relay-JP (JP). KEEP BOTH OPEN even though services
    also sit on the extra ports below.
  - **TCP 8443 + 9443 + 7443** (KR VM only) — the extra single-hostname TLS ports
    (relay-KR / signaling / Sui RPC). The JP VM needs only 80 + 443.

```bash
# Hostnames are HARDCODED in the Caddyfile; these vars are only for the client build:
KR_DNS=dvconf-kr.koreacentral.cloudapp.azure.com   # fixed KR DNS label
JP_DNS=dvconf-jp.japaneast.cloudapp.azure.com      # fixed JP DNS label
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

### 2. Place the Caddyfile (hostnames are hardcoded — no substitution)

The Caddyfile has the two fixed hostnames HARDCODED (`dvconf-kr...` /
`dvconf-jp...`), so there is NO `sed` step anymore — just copy it and keep that
VM's block. From your workstation:

```bash
# scp the template to each VM (path relative to the dvconf-daemons repo root):
scp scripts/infra/caddy/Caddyfile.two-layer-demo azureuser@${KR_IP}:/tmp/Caddyfile.in
scp scripts/infra/caddy/Caddyfile.two-layer-demo azureuser@${JP_IP}:/tmp/Caddyfile.in
```

On the **KR VM** — install to `/etc/caddy` (keep the KR block; the JP block is
harmless because Caddy won't obtain a cert for a name that doesn't resolve to this
VM — but for a clean cert log, delete the JP block on KR):

```bash
ssh azureuser@${KR_IP} "sudo cp /tmp/Caddyfile.in /etc/caddy/Caddyfile"
```

On the **JP VM** — same (keep the JP block; delete the KR block for a clean cert log):

```bash
ssh azureuser@${JP_IP} "sudo cp /tmp/Caddyfile.in /etc/caddy/Caddyfile"
```

> The KR VM will provision ONE Let's Encrypt cert for `dvconf-kr...` and REUSE it
> across its ports 443 / 8443 / 9443 / 7443 (a single ACME issuance covers the whole
> VM). The JP VM provisions one cert for `dvconf-jp...` on :443. The ACME HTTP-01
> challenge rides port 80 — so 80 must be open on both VMs (Prerequisites port list).

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

# --- browser-facing endpoints: ALL TLS, PORT-BASED on the single KR hostname ---
# (defeats mixed-content). Distinct TLS ports on ONE hostname — NOT subdomains
# (Azure free DNS has no wildcard). The client feeds each URL straight to
# `new WebSocket(url)` / dapp-kit `createNetworkConfig` with NO port assumption and
# NO path append (verified: config.ts + useRelay.ts + main.tsx), so the ports work.
export VITE_SIGNALING_URL=wss://${KR_DNS}:9443
export VITE_RELAY_URL=wss://${KR_DNS}:8443
export VITE_SUI_RPC_URL=https://${KR_DNS}:7443
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
export VITE_ROLE_VOTE_BOX_ID=<ROLE_VOTE_BOX_ID>

# --- OPTIONAL: 5 healthz/canary URLs over TLS (else widgets render DEGRADED) ---
# Only set these if you uncommented the matching healthz PORT blocks in the Caddyfile
# (each gets its own extra TLS port on the KR hostname, e.g. :6443..:6447) AND opened
# those ports in the NSG/UFW. Omit them entirely to accept degraded liveness widgets
# (the demo is unaffected).
# export VITE_CP_HEALTHZ_URL=https://${KR_DNS}:6443
# export VITE_SIGNALING_HEALTHZ_URL=https://${KR_DNS}:6444
# export VITE_VALIDATOR_HEALTHZ_URL=https://${KR_DNS}:6445
# export VITE_RELAY_HEALTHZ_URL=https://${KR_DNS}:6446
# export VITE_VALIDATOR_CANARY_COVERAGE_URL=https://${KR_DNS}:6447
```

> Fallbacks are localhost defaults (`config.ts`): unset healthz vars fall back to
> `http://localhost:{8091,8082,8101,4001,8102}` — which the HTTPS app CANNOT reach
> (mixed-content + localhost). That is the DEGRADED-widget path and is acceptable;
> the room/join/media flow does not depend on healthz. `VITE_SUI_RPC_URL`,
> `VITE_SIGNALING_URL`, `VITE_RELAY_URL` are NOT optional — they must be the
> port-based wss/https URLs on the KR hostname (`:9443` / `:8443` / `:7443`) or the
> app mixed-content-blocks and cannot connect.

### 1b. On-chain relay endpoint URLs — the relay-leg half of the mixed-content crux

The client HOMES to each relay using the CONTROL endpoint URL delivered by on-chain
`RoomAssigned` — it reads `relay_registry` `endpoint_url` VERBATIM
(`useRoomAssignment.ts` → `resolvePinnedRelayUrls` → `new WebSocket(url)`, no port
assumption, no path append). So if Phase B registered `ws://<pub-ip>:4000`, the HTTPS
browser MIXED-CONTENT-BLOCKS it and media never starts. Phase B MUST register the wss
TLS URLs instead (via `wan-bootstrap.ts` / the `lane-b` assignment path — set
`RELAY_ENDPOINT_URL` per relay before it registers on-chain):

- relay-KR `endpoint_url = wss://dvconf-kr.koreacentral.cloudapp.azure.com:8443`
  (matches the KR Caddy :8443 → `localhost:4000` block)
- relay-JP `endpoint_url = wss://dvconf-jp.japaneast.cloudapp.azure.com` (:443)
  (matches the JP Caddy default-port block)

`ANNOUNCED_IP` (the MEDIA / ICE address + the inter-relay pipe address) stays each
VM's RAW public IP — media is direct UDP, NEVER through Caddy. ONLY the CONTROL/
signaling endpoint URL becomes the TLS wss URL. This is folded into
`azure-wan-runbook.md` §6B-D as the two-layer-demo deviation; register it there in
Phase B, BEFORE layering Caddy here.

> Verify after Phase B assignment: the on-chain relay endpoint resolves to the wss URL
> the browser can reach —
> `curl -sN https://${KR_DNS}:8443` (expect an HTTP 400/426 "Upgrade Required" style
> reply from the WS server = the port is TLS-fronted and reachable, NOT a cert error).

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

Open `https://dvconf-kr.koreacentral.cloudapp.azure.com` (the :443 app) on the laptop
(ISP-1) and verify:

- [ ] **Padlock valid on ALL ports** — the app (`:443`) shows a live Let's Encrypt
      cert (no warning). Because Caddy reuses the one KR cert across ports, also
      confirm each extra port opens WITHOUT a cert error:
      `https://dvconf-kr...:7443` (RPC), `wss://dvconf-kr...:9443` (signaling),
      `wss://dvconf-kr...:8443` (relay-KR), and `wss://dvconf-jp...` (:443, relay-JP).
- [ ] **ZERO mixed-content errors** — open DevTools console; there must be NO
      "Mixed Content: ... was loaded over HTTPS but requested an insecure ... ws://
      / http://" warnings. Any such warning means a `VITE_*` build env OR an on-chain
      relay `endpoint_url` still points at `ws://`/`http://` — fix the build env (C.2)
      / re-register the relay endpoint as wss (C.2 §1b) and rebuild.
- [ ] **Sui RPC reachable** — the room list loads (the client queries
      `https://dvconf-kr...:7443`). If it hangs:
      `curl -sS https://${KR_DNS}:7443 -X POST -H 'content-type: application/json'
      -d '{"jsonrpc":"2.0","id":1,"method":"sui_getChainIdentifier","params":[]}'`
      should return a chain id.
- [ ] **Signaling wss connects** — no repeated WS reconnect errors in the console;
      the client establishes the cap-token signaling channel to `wss://dvconf-kr...:9443`.
- [ ] **Relay control wss connects (both legs TLS)** — on join, the client opens
      `wss://dvconf-kr...:8443` (primary); a `?relayPin=standby` browser opens
      `wss://dvconf-jp...` (:443). Confirm the on-chain relay `endpoint_url`s ARE those
      wss URLs (C.2 §1b) — otherwise the WS URL the browser dials is `ws://` and
      mixed-content-blocks.

Done when: the app loads clean over TLS, no mixed-content, room list populates,
signaling + relay control connected. Then proceed to the plan's Phase D (live run +
record).

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
