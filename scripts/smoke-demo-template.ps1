# smoke-demo-template.ps1 -- F66 viz-infrastructure smoke test (REQ-VIZ-010).
#
# Boots the full docker-compose-demo.yml stack, polls the client until healthy,
# verifies publish-output.json contains object IDs, then tears the stack down.
#
# Windows host primary (D15 lock). Bash equivalent: smoke-demo-template.sh.
#
# Usage:
#   .\dvconf-daemons\scripts\smoke-demo-template.ps1
#   .\dvconf-daemons\scripts\smoke-demo-template.ps1 -SkipDown   # leave running for manual inspection
#   .\dvconf-daemons\scripts\smoke-demo-template.ps1 -ClientTimeoutSec 180
#
# Gotchas applied:
#   G-001: every `docker compose` invocation inside helper functions piped
#          through Out-Null (otherwise stdout pollutes function return values).
#   G-002: if Sui CLI is invoked (not in this script), use `2>&1 | Out-String`.

[CmdletBinding()]
param(
    [string]$ComposeFile = $(Join-Path (Split-Path -Parent $PSScriptRoot) '..\docker-compose-demo.yml' | Resolve-Path -ErrorAction SilentlyContinue),
    [int]$ClientTimeoutSec = 120,
    [int]$BringUpTimeoutSec = 300,
    [switch]$SkipDown
)

$ErrorActionPreference = 'Stop'

# Resolve compose file relative to script location if -ComposeFile not provided.
if (-not $ComposeFile -or -not (Test-Path $ComposeFile)) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $ComposeFile = Join-Path $repoRoot 'docker-compose-demo.yml'
}
if (-not (Test-Path $ComposeFile)) {
    throw "Compose file not found: $ComposeFile"
}

$RepoRoot = Split-Path -Parent $ComposeFile
$Timestamp = (Get-Date).ToString('yyyy-MM-ddTHH-mm-ss')
$EvidenceDir = Join-Path $RepoRoot '.evidence\verification'
$null = New-Item -ItemType Directory -Force -Path $EvidenceDir
$EvidenceLog = Join-Path $EvidenceDir "req-viz-010-smoke-$Timestamp.log"
$FailureLog = Join-Path $EvidenceDir "req-viz-010-smoke-failure-$Timestamp.log"

function Log($msg) { Write-Host "[smoke-demo] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[smoke-demo] $msg" -ForegroundColor Yellow }
function Err($msg) { Write-Host "[smoke-demo] $msg" -ForegroundColor Red }

# Pipe docker compose to Out-Null inside helper to avoid stdout pollution (G-001).
function Invoke-ComposeUp {
    Log "docker compose up --wait (timeout ${BringUpTimeoutSec}s)"
    & docker compose -f $ComposeFile up -d --wait --wait-timeout $BringUpTimeoutSec 2>&1 | Tee-Object -FilePath $EvidenceLog -Append | Out-Null
    return $LASTEXITCODE
}

function Invoke-ComposeDown {
    Log "docker compose down -v"
    & docker compose -f $ComposeFile down -v --remove-orphans 2>&1 | Tee-Object -FilePath $EvidenceLog -Append | Out-Null
}

function Dump-ComposeLogs($targetLog) {
    Log "dumping docker compose logs -> $targetLog"
    & docker compose -f $ComposeFile logs --no-color 2>&1 | Out-File -FilePath $targetLog -Encoding utf8 | Out-Null
}

function Test-ClientReady {
    param([int]$TimeoutSec)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                return $true
            }
        } catch {
            # 200 not reached yet -- swallow and retry.
        }
        Start-Sleep -Seconds 3
    }
    return $false
}

function Test-PublishOutputNonEmpty {
    # Read publish-output.json from inside the publish-output named volume by
    # exec'ing into one of the consumer containers (cp-daemon -- shared :ro mount).
    $output = & docker compose -f $ComposeFile exec -T cp-daemon sh -c 'wc -c < /shared/publish-output.json' 2>&1 | Out-String
    $output = $output.Trim()
    if ($output -match '^\s*(\d+)\s*$') {
        $bytes = [int]$Matches[1]
        Log "publish-output.json size = $bytes bytes"
        return ($bytes -gt 100)
    }
    Warn "could not parse publish-output.json size (output='$output')"
    return $false
}

# ----- Main flow --------------------------------------------------------
Log "compose file = $ComposeFile"
Log "evidence log = $EvidenceLog"

# Pre-flight: validate compose schema before bringing the stack up.
& docker compose -f $ComposeFile config 2>&1 | Tee-Object -FilePath $EvidenceLog | Out-Null
if ($LASTEXITCODE -ne 0) {
    Err "docker compose config FAILED -- compose schema invalid"
    exit 1
}
Log "compose schema PASS"

$upExit = Invoke-ComposeUp
if ($upExit -ne 0) {
    Err "docker compose up FAILED (exit $upExit)"
    Dump-ComposeLogs $FailureLog
    if (-not $SkipDown) { Invoke-ComposeDown }
    exit 1
}
Log "stack healthy"

# Smoke check 1: publish-output.json populated.
if (-not (Test-PublishOutputNonEmpty)) {
    Err "publish-output.json missing or too small -- move-publish service likely failed"
    Dump-ComposeLogs $FailureLog
    if (-not $SkipDown) { Invoke-ComposeDown }
    exit 1
}
Log "publish-output.json PASS"

# Smoke check 2: client responds 200.
Log "polling http://localhost:5173 (timeout ${ClientTimeoutSec}s)"
if (Test-ClientReady -TimeoutSec $ClientTimeoutSec) {
    Log "client PASS (200 from http://localhost:5173)"
} else {
    Err "client did not return 200 within ${ClientTimeoutSec}s"
    Dump-ComposeLogs $FailureLog
    if (-not $SkipDown) { Invoke-ComposeDown }
    exit 1
}

# All checks passed -- teardown unless caller asked to keep stack.
if (-not $SkipDown) {
    Invoke-ComposeDown
}

Log "smoke PASS -- evidence at $EvidenceLog"
exit 0
