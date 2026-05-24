#!/usr/bin/env bash
# smoke-demo-template.sh -- F66 viz-infrastructure smoke test (REQ-VIZ-010, Linux/CI variant).
#
# Boots docker-compose-demo.yml, polls the client until healthy, verifies
# publish-output.json non-empty, tears the stack down.
#
# Windows host primary: smoke-demo-template.ps1. This script targets Linux/CI.
#
# Usage:
#   ./dvconf-daemons/scripts/smoke-demo-template.sh
#   SKIP_DOWN=1 ./dvconf-daemons/scripts/smoke-demo-template.sh
#   CLIENT_TIMEOUT_SEC=180 ./dvconf-daemons/scripts/smoke-demo-template.sh

set -eu
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_ROOT/docker-compose-demo.yml}"
CLIENT_TIMEOUT_SEC="${CLIENT_TIMEOUT_SEC:-120}"
BRING_UP_TIMEOUT_SEC="${BRING_UP_TIMEOUT_SEC:-300}"
SKIP_DOWN="${SKIP_DOWN:-0}"

TIMESTAMP="$(date +%Y-%m-%dT%H-%M-%S)"
EVIDENCE_DIR="$REPO_ROOT/.evidence/verification"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_LOG="$EVIDENCE_DIR/req-viz-010-smoke-$TIMESTAMP.log"
FAILURE_LOG="$EVIDENCE_DIR/req-viz-010-smoke-failure-$TIMESTAMP.log"

log()  { printf '[smoke-demo] %s\n' "$*"; }
warn() { printf '[smoke-demo] WARN: %s\n' "$*" >&2; }
err()  { printf '[smoke-demo] ERROR: %s\n' "$*" >&2; }

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

compose_up() {
  log "docker compose up --wait (timeout ${BRING_UP_TIMEOUT_SEC}s)"
  compose up -d --wait --wait-timeout "$BRING_UP_TIMEOUT_SEC" 2>&1 | tee -a "$EVIDENCE_LOG"
}

compose_down() {
  log "docker compose down -v"
  compose down -v --remove-orphans 2>&1 | tee -a "$EVIDENCE_LOG" >/dev/null
}

dump_logs() {
  local target="$1"
  log "dumping docker compose logs -> $target"
  compose logs --no-color > "$target" 2>&1 || true
}

teardown_if_requested() {
  if [ "$SKIP_DOWN" != "1" ]; then
    compose_down
  else
    log "SKIP_DOWN=1 -- leaving stack up for inspection"
  fi
}

test_client_ready() {
  local deadline=$(( $(date +%s) + CLIENT_TIMEOUT_SEC ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null | grep -q '^200$'; then
      return 0
    fi
    sleep 3
  done
  return 1
}

test_publish_output_non_empty() {
  local bytes
  bytes="$(compose exec -T cp-daemon sh -c 'wc -c < /shared/publish-output.json' 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$bytes" ] || ! [ "$bytes" -gt 100 ] 2>/dev/null; then
    warn "publish-output.json size invalid (got '$bytes')"
    return 1
  fi
  log "publish-output.json size = $bytes bytes"
  return 0
}

# ----- Main flow --------------------------------------------------------
log "compose file = $COMPOSE_FILE"
log "evidence log = $EVIDENCE_LOG"

# Pre-flight: schema validation.
if ! compose config > "$EVIDENCE_LOG" 2>&1; then
  err "docker compose config FAILED -- schema invalid"
  exit 1
fi
log "compose schema PASS"

if ! compose_up; then
  err "docker compose up FAILED"
  dump_logs "$FAILURE_LOG"
  teardown_if_requested
  exit 1
fi
log "stack healthy"

if ! test_publish_output_non_empty; then
  err "publish-output.json check FAILED"
  dump_logs "$FAILURE_LOG"
  teardown_if_requested
  exit 1
fi
log "publish-output.json PASS"

log "polling http://localhost:5173 (timeout ${CLIENT_TIMEOUT_SEC}s)"
if ! test_client_ready; then
  err "client did not return 200 within ${CLIENT_TIMEOUT_SEC}s"
  dump_logs "$FAILURE_LOG"
  teardown_if_requested
  exit 1
fi
log "client PASS (200 from http://localhost:5173)"

teardown_if_requested

log "smoke PASS -- evidence at $EVIDENCE_LOG"
exit 0
