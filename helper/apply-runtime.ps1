param([Parameter(Mandatory=$true)][string]$ExpectedHash, [switch]$RestartHelper)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Split-Path -Parent $PSScriptRoot
$runtimeNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (!$runtimeNode) { $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$runtimeConfigPath = Join-Path $runtimeRoot '.local/export-config.json'
$runtimeHealth = $null
if (Test-Path -LiteralPath $runtimeConfigPath) {
    $runtimeConfig = Get-Content -LiteralPath $runtimeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $runtimeProbe = [Net.Sockets.TcpClient]::new()
    $runtimeConnected = $false
    try {
        $runtimeConnectTask = $runtimeProbe.ConnectAsync('127.0.0.1', [int]$runtimeConfig.port)
        try { $runtimeConnected = $runtimeConnectTask.Wait(3000) -and $runtimeProbe.Connected } catch { $runtimeConnected = $false }
        if (!$runtimeConnectTask.IsCompleted) { throw '无法及时确认助手状态，请稍后更新。' }
    } finally { $runtimeProbe.Dispose() }
    if ($runtimeConnected) {
        try { $runtimeHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $runtimeConfig.port + '/health') -Headers @{'X-Bili-Peek-Token'=$runtimeConfig.token} -TimeoutSec 1 }
        catch { throw '助手状态核验失败，未切换版本。' }
    }
    if ($runtimeHealth.active) { throw '片段正在保存，请完成后再更新。' }
}
if ($RestartHelper -and $runtimeHealth.ready) {
    $runtimeResult = Join-Path $runtimeRoot '.local/runtime-helper-result.json'
    try {
        & (Join-Path $runtimeRoot '.apex/runner.ps1') -Action stop -ResultPath $runtimeResult
        & (Join-Path $runtimeRoot '.apex/runner.ps1') -Action run -ResultPath $runtimeResult
    } finally { Remove-Item -LiteralPath $runtimeResult -ErrorAction SilentlyContinue }
}
& $runtimeNode (Join-Path $PSScriptRoot 'runtime.cjs') --publish --sha256 $ExpectedHash
if ($LASTEXITCODE -ne 0) { throw '脚本发布失败，未确认更新成功。' }
& (Join-Path $PSScriptRoot 'start-runtime.ps1')
