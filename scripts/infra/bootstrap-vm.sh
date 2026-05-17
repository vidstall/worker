#!/usr/bin/env bash
#
# bootstrap-vm.sh — DVConf Phase I cloud-VM provisioning (S28.B.3)
#
# Idempotent bootstrap for a fresh Ubuntu 22.04 LTS VM (tested target: DO
# Singapore 2 vCPU / 4 GB). Brings the host to the state required by
# internet-benchmark-plan.md § 5 Phase I row "Install nodejs 20, pnpm, sui
# CLI, coturn, certbot".
#
# Usage (as root or via sudo):
#   curl -sSL https://raw.githubusercontent.com/<org>/dvconf/master/dvconf-daemons/scripts/infra/bootstrap-vm.sh | sudo bash
#   # OR for local copy:
#   sudo bash bootstrap-vm.sh
#
# Re-run safely — every step is guarded by an existence check. State logs to
# /var/log/dvconf-bootstrap.log.
#
# After it finishes:
#   - Node 20 + pnpm 9 + sui CLI + coturn + certbot installed
#   - UFW configured (SSH 22, signaling 443, coturn 3478/UDP+TCP +
#     5349/TLS, mediasoup RTP range 40000-49999/UDP)
#   - System user `dvconf` exists with home dir
#   - Repo NOT cloned — teammate clones manually so they pick the right
#     ref + commit
#
# Plan: docs/80-research/evaluation/internet-benchmark-plan.md § 5 Phase I

set -euo pipefail

LOG_FILE=/var/log/dvconf-bootstrap.log
SUI_VERSION="${SUI_VERSION:-mainnet-v1.66.2}"
NODE_MAJOR="${NODE_MAJOR:-20}"
DVCONF_USER="${DVCONF_USER:-dvconf}"

log() {
    local msg="[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
    echo "$msg" | tee -a "$LOG_FILE"
}

fail() {
    log "FATAL: $*"
    exit 1
}

# ── Pre-flight ───────────────────────────────────────────────────────

preflight() {
    log "── Pre-flight checks ──"

    if [ "$(id -u)" -ne 0 ]; then
        fail "must run as root (use sudo)"
    fi

    if ! grep -q "Ubuntu 22.04" /etc/os-release 2>/dev/null; then
        log "WARN: not running on Ubuntu 22.04 — proceeding but YMMV"
    fi

    if ! curl -sSf -o /dev/null --max-time 10 https://github.com; then
        fail "no internet (github.com unreachable)"
    fi

    local free_gb
    free_gb=$(df -BG --output=avail / | tail -n 1 | tr -d 'G ')
    if [ "$free_gb" -lt 10 ]; then
        fail "insufficient disk space (${free_gb} GB free, need ≥ 10 GB)"
    fi

    log "pre-flight OK (root, internet, ${free_gb} GB free)"
}

# ── System packages ──────────────────────────────────────────────────

install_apt_packages() {
    log "── apt packages ──"

    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq \
        curl ca-certificates gnupg lsb-release \
        build-essential python3 python3-pip git \
        coturn certbot \
        ufw jq

    log "apt packages installed"
}

# ── Node.js ──────────────────────────────────────────────────────────

install_node() {
    log "── Node.js ${NODE_MAJOR} ──"

    if command -v node > /dev/null && \
       node --version | grep -q "^v${NODE_MAJOR}\."; then
        log "Node ${NODE_MAJOR} already present ($(node --version)), skipping"
        return
    fi

    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y -qq nodejs

    node --version | tee -a "$LOG_FILE"
}

install_pnpm() {
    log "── pnpm via corepack ──"

    if command -v pnpm > /dev/null; then
        log "pnpm already present ($(pnpm --version)), skipping"
        return
    fi

    corepack enable
    corepack prepare pnpm@9 --activate
    pnpm --version | tee -a "$LOG_FILE"
}

# ── Sui CLI ──────────────────────────────────────────────────────────

install_sui() {
    log "── Sui CLI ${SUI_VERSION} ──"

    if command -v sui > /dev/null && sui --version > /dev/null 2>&1; then
        log "sui already present ($(sui --version | head -1)), skipping"
        return
    fi

    local arch tgz_name
    arch=$(uname -m)
    case "$arch" in
        x86_64)  tgz_name="sui-${SUI_VERSION}-ubuntu-x86_64.tgz" ;;
        aarch64) tgz_name="sui-${SUI_VERSION}-ubuntu-aarch64.tgz" ;;
        *)       fail "unsupported arch: $arch" ;;
    esac

    local url="https://github.com/MystenLabs/sui/releases/download/${SUI_VERSION}/${tgz_name}"
    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf $tmp_dir" RETURN

    log "downloading $url"
    curl -fsSL "$url" -o "$tmp_dir/sui.tgz"

    # Release tgz layout: binaries live under ./ (CI-20 from S25.5).
    tar -xz -C /usr/local/bin -f "$tmp_dir/sui.tgz" ./sui ./sui-faucet
    chmod +x /usr/local/bin/sui /usr/local/bin/sui-faucet

    sui --version | tee -a "$LOG_FILE"
}

# ── Firewall ─────────────────────────────────────────────────────────

configure_ufw() {
    log "── UFW firewall ──"

    # default deny incoming, allow outgoing
    ufw --force default deny incoming
    ufw --force default allow outgoing

    # SSH first — must not lock ourselves out
    ufw allow 22/tcp comment 'ssh'

    # HTTPS (signaling WSS + Let's Encrypt webroot)
    ufw allow 443/tcp comment 'signaling wss + certbot'
    ufw allow 80/tcp comment 'certbot http-01 challenge'

    # coturn: STUN/TURN UDP+TCP 3478, TURNS TLS 5349
    ufw allow 3478/udp comment 'coturn stun/turn udp'
    ufw allow 3478/tcp comment 'coturn turn tcp'
    ufw allow 5349/tcp comment 'coturn turns tls'

    # mediasoup RTP/RTCP range — internet-benchmark-plan § 4 invariants
    ufw allow 40000:49999/udp comment 'mediasoup rtp/rtcp'

    ufw --force enable
    ufw status verbose | tee -a "$LOG_FILE"
}

# ── DVConf system user ───────────────────────────────────────────────

create_dvconf_user() {
    log "── dvconf system user ──"

    if id "$DVCONF_USER" > /dev/null 2>&1; then
        log "user '$DVCONF_USER' already exists, skipping"
        return
    fi

    useradd -m -s /bin/bash "$DVCONF_USER"
    log "created user '$DVCONF_USER' with home /home/$DVCONF_USER"
}

# ── Post-install verification ────────────────────────────────────────

verify() {
    log "── verification ──"

    local errors=0

    for cmd in node pnpm sui git curl jq coturn certbot ufw; do
        if ! command -v "$cmd" > /dev/null; then
            log "FAIL: $cmd not on PATH"
            errors=$((errors + 1))
        else
            log "OK:   $cmd → $(command -v "$cmd")"
        fi
    done

    if [ "$errors" -gt 0 ]; then
        fail "$errors verification failure(s) — check $LOG_FILE"
    fi

    log "── all checks passed ──"
    log ""
    log "Next steps for teammate:"
    log "  1. su - $DVCONF_USER"
    log "  2. git clone <repo> ~/dvconf && cd ~/dvconf/dvconf-daemons"
    log "  3. pnpm install --frozen-lockfile"
    log "  4. Configure coturn: edit /etc/turnserver.conf (realm, static-auth-secret, external-ip)"
    log "  5. systemctl enable --now coturn"
    log "  6. Run \`sudo certbot certonly --standalone -d signaling.<your-domain>\` for WSS cert"
    log "  7. Follow internet-benchmark-plan.md § 5 Phase I row 'Deploy 4 daemons on VM'"
}

# ── main ─────────────────────────────────────────────────────────────

main() {
    mkdir -p "$(dirname "$LOG_FILE")"
    : > "$LOG_FILE"  # truncate, fresh run gets fresh log

    log "==== DVConf VM bootstrap starting ===="
    log "target Sui version: $SUI_VERSION"
    log "target Node major:  $NODE_MAJOR"
    log "dvconf user:        $DVCONF_USER"

    preflight
    install_apt_packages
    install_node
    install_pnpm
    install_sui
    create_dvconf_user
    configure_ufw
    verify

    log "==== bootstrap complete ===="
}

main "$@"
