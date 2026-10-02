param(
    [Parameter(Mandatory = $true)][ValidateSet('run', 'stop')][string]$Action,
    [Parameter(Mandatory = $true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
try {
    $clipRoot = Split-Path -Parent $PSScriptRoot
    $clipConfig = Get-Content -LiteralPath (Join-Path $clipRoot '.local/export-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $clipPidPath = Join-Path $clipRoot '.local/helper.pid'
    $clipServer = Join-Path $clipRoot 'helper\server.cjs'
    if ($Action -eq 'run') {
        $clipNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
        if (!$clipNode) { $clipNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
        & $clipNode (Join-Path $clipRoot 'helper\start.cjs')
        if ($LASTEXITCODE -ne 0) { throw '片段助手启动失败，请检查配置与 .local/helper.log。' }
    }
    $clipProcess = $null
    if (Test-Path -LiteralPath $clipPidPath) {
        $clipPid = [int](Get-Content -LiteralPath $clipPidPath -Raw)
        $clipProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$clipPid"
        if ($clipProcess -and ($clipProcess.Name -ne 'node.exe' -or !$clipProcess.CommandLine.Contains($clipServer))) {
            throw '助手进程身份不匹配，未关闭任何进程。'
        }
    }
    if ($clipProcess) {
        $clipHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $clipConfig.port + '/health') -Headers @{ 'X-Bili-Peek-Token' = $clipConfig.token } -TimeoutSec 5
        if (!$clipHealth.ready) { throw '片段助手尚未就绪。' }
        if ($Action -eq 'stop') {
            if ($clipHealth.active) { throw '片段正在保存，请完成后再关闭或重启。' }
            Stop-Process -Id $clipPid
            Wait-Process -Id $clipPid -Timeout 5 -ErrorAction SilentlyContinue
            if (Get-Process -Id $clipPid -ErrorAction SilentlyContinue) { throw '片段助手未退出。' }
            Remove-Item -LiteralPath $clipPidPath -ErrorAction SilentlyContinue
        }
    } elseif ($Action -eq 'run') { throw '未找到已启动的片段助手进程。' }
    else {
        $clipHealth = $null
        try { $clipHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $clipConfig.port + '/health') -Headers @{ 'X-Bili-Peek-Token' = $clipConfig.token } -TimeoutSec 3 } catch {}
        if ($clipHealth.ready) { throw '助手仍在运行，但缺少可核对的进程记录，未关闭任何进程。' }
    }
    $clipState = if ($Action -eq 'run') { 'running' } else { 'stopped' }
    $clipResult = @{ ok = $true; status = @{ state = $clipState } }
    if ($clipState -eq 'running') { $clipResult.status.pid = $clipPid }
    [IO.File]::WriteAllText($ResultPath, ($clipResult | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
