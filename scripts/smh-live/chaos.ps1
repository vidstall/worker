# SMH-LIVE OS-level chaos -- kill-relay-by-port + link-state probe.
#
# Two verbs only (RECONCILIATION v2 dropped D3, so no block/unblock):
#   kill   <port>  -- kill the process LISTENing on <port> (a relay's WS port, e.g. 4000)
#                     plus its descendant tree (mediasoup workers), so the relay is truly
#                     DOWN: it stops heart-beating -> goes stale -> room_manager::promote_relay
#                     fires RelayPromoted (the D2 failover trigger). Real killable PID.
#   isopen <port>  -- print 'OPEN' if something is LISTENing on <port>, else 'NOT-OPEN'.
#                     Used to CONFIRM (assert, not assume) a relay went down before asserting
#                     the promotion.
#
# Output contract (last stdout line):
#   kill   -> "killed:<port>:pids=<csv>"  |  "no-listener:<port>"
#   isopen -> "OPEN"                       |  "NOT-OPEN"
#
# NOTE: intentionally pure-ASCII (PowerShell 5.1 reads a no-BOM file as CP1252, which mangles
# non-ASCII bytes into string-delimiter smart-quotes the parser chokes on). Keep it ASCII-only.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('kill', 'isopen')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [int]$Port
)

# Transitive descendant PIDs of $rootPid (BFS over ParentProcessId, single CIM snapshot).
# A relay's node process spawns mediasoup worker children; reaping the tree stops the worker
# procs holding RTC ports too, so a later pre-flight re-scan is not tripped by an orphan.
function Get-DescendantPids($rootPid) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $result = @()
    $frontier = @([int]$rootPid)
    while ($frontier.Count -gt 0) {
        $next = @()
        foreach ($parentId in $frontier) {
            foreach ($proc in ($all | Where-Object { $_.ParentProcessId -eq $parentId })) {
                $childId = [int]$proc.ProcessId
                if ($childId -ne [int]$rootPid -and $result -notcontains $childId) {
                    $result += $childId
                    $next += $childId
                }
            }
        }
        $frontier = $next
    }
    return $result
}

switch ($Action) {
    'kill' {
        $owners = @(
            Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique
        )
        if ($owners.Count -eq 0) {
            Write-Output "no-listener:$Port"
            exit 0
        }
        foreach ($ownerPid in $owners) {
            foreach ($childId in (Get-DescendantPids $ownerPid)) {
                Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
            }
            Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
        }
        Write-Output "killed:$Port`:pids=$($owners -join ',')"
    }
    'isopen' {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($conn) { Write-Output 'OPEN' } else { Write-Output 'NOT-OPEN' }
    }
}
