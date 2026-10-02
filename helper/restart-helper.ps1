$ErrorActionPreference = 'Stop'
$clipRoot = Split-Path -Parent $PSScriptRoot
$clipPidPath = Join-Path $clipRoot '.local\helper.pid'
if (Test-Path -LiteralPath $clipPidPath) {
    $clipPid = [int](Get-Content -LiteralPath $clipPidPath)
    $clipProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $clipPid"
    if ($clipProcess) {
        $clipServer = Join-Path $PSScriptRoot 'server.cjs'
        if ($clipProcess.Name -ne 'node.exe' -or !$clipProcess.CommandLine.Contains($clipServer)) { throw 'Helper process identity did not match; no process was stopped.' }
        $clipConfig = Get-Content -LiteralPath (Join-Path $clipRoot '.local\export-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $clipHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $clipConfig.port + '/health') -Headers @{ 'X-Bili-Peek-Token' = $clipConfig.token } -TimeoutSec 5
        $clipChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $clipPid" | Where-Object { $_.Name -in @('ffmpeg.exe', 'ffprobe.exe') })
        if ($clipHealth.active -or $clipChildren.Count) { throw 'A clip is still processing. Finish saving before restarting the helper.' }
        Stop-Process -Id $clipPid
    }
}
$clipNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $clipNode (Join-Path $PSScriptRoot 'start.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Helper did not restart successfully.' }
