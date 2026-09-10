param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$knownPaths = @('debug', 'release') | ForEach-Object {
    Join-Path $repoRoot "rust\lain-supervisor\target\$_\lain-supervisor.exe"
}
$allProcesses = @(Get-CimInstance Win32_Process)
$supervisors = @($allProcesses | Where-Object { $_.Name -eq 'lain-supervisor.exe' })
$byPid = @{}
foreach ($entry in $allProcesses) { $byPid[[int]$entry.ProcessId] = $entry }
$records = @{}
# Only test homes under the OS temp directory. Never scan a user's LAIN home.
foreach ($dir in Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'lain-*') {
    foreach ($file in Get-ChildItem -LiteralPath $dir.FullName -Filter endpoint.json -File -Recurse -ErrorAction SilentlyContinue) {
        if ($file.Directory.Name -ne 'supervisor') { continue }
        try {
            $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
            if ($record.pid -and $record.started_at) { $records[[int]$record.pid] = @{ Record = $record; File = $file.FullName } }
        } catch { continue }
    }
}
foreach ($proc in $supervisors) {
    $evidence = $records[[int]$proc.ProcessId]
    $parent = $byPid[[int]$proc.ParentProcessId]
    $parentGone = !$parent -or $parent.CreationDate -gt $proc.CreationDate
    $identified = $false
    if ($evidence -and $proc.ExecutablePath -in $knownPaths -and $proc.CommandLine -match '\bserve(?:\s|$)' -and $parentGone) {
        $start = [DateTimeOffset]::FromUnixTimeSeconds([long]$evidence.Record.started_at)
        $identified = [Math]::Abs(($start.UtcDateTime - $proc.CreationDate.ToUniversalTime()).TotalSeconds) -lt 5
    }
    $action = 'preserved: identity or test ownership unproven'
    if ($identified) {
        $action = 'eligible: stale test supervisor'
        if ($Apply) {
            # Revalidate PID identity immediately before the action (PID reuse).
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ProcessId)"
            if ($current -and $current.CreationDate -eq $proc.CreationDate -and $current.ExecutablePath -eq $proc.ExecutablePath) {
                Stop-Process -Id $proc.ProcessId -ErrorAction Stop
                $action = 'stopped: verified stale test supervisor'
            }
        }
    }
    [pscustomobject]@{ Pid = $proc.ProcessId; Action = $action; Evidence = $evidence.File }
}
