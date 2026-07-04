#!/usr/bin/env bash
# preflight-udp.sh — step-0(b): prove inbound UDP reaches this VM (spec REQ-WLM-04).
# The Azure NSG UDP layer is new+untested here; the VPS 103.67.197.249 was provider-blocked
# on inbound UDP -> this MUST pass before any run, not be assumed.
set -euo pipefail
PORT="${1:-40001}"   # a port inside the mediasoup range 40000-49999 the NSG must open
echo "[preflight] binding UDP :$PORT and waiting for an external probe..."
echo "[preflight] from a DIFFERENT network, run:  nc -u <this-vm-public-ip> $PORT   then type + enter"
# Listen for one datagram; succeed if anything arrives within 60s.
if timeout 60 nc -u -l "$PORT" | head -c 1 | grep -q .; then
  echo "[preflight] PASS — inbound UDP :$PORT reachable (NSG + UFW open)."
else
  echo "[preflight] FAIL — no inbound UDP on :$PORT. Check the NSG inbound rule + UFW. BLOCK the run."; exit 1
fi
