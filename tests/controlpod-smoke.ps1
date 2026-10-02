$ErrorActionPreference = 'Stop'
$clipRoot = Split-Path -Parent $PSScriptRoot
$clipRunner = Join-Path $clipRoot '.apex/runner.ps1'
$clipConfig = Get-Content (Join-Path $clipRoot '.local/export-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$clipHeaders = @{ 'X-Bili-Peek-Token' = $clipConfig.token }
$clipUrl = 'http://127.0.0.1:' + $clipConfig.port + '/health'
$clipWasRunning = $false
try {
    $clipHealth = Invoke-RestMethod -Uri $clipUrl -Headers $clipHeaders -TimeoutSec 3
    $clipWasRunning = [bool]$clipHealth.ready
    if ($clipHealth.active) { throw '片段正在保存，暂不运行启停测试。' }
} catch {
    if ($clipWasRunning) { throw }
}
$clipResultPath = Join-Path $env:TEMP ('bili-peek-controlpod-' + [guid]::NewGuid() + '.json')
function Invoke-ClipAction([string]$clipAction) {
    $clipArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $clipRunner + '" -Action ' + $clipAction + ' -ResultPath "' + $clipResultPath + '"'
    $clipActionProcess = Start-Process powershell.exe -ArgumentList $clipArguments -WindowStyle Hidden -PassThru
    if (!$clipActionProcess.WaitForExit(15000)) { throw "动作超时：$clipAction" }
    if ($clipActionProcess.ExitCode -ne 0) { throw "动作失败：$clipAction" }
    $clipResult = Get-Content $clipResultPath -Raw | ConvertFrom-Json
    $clipExpected = if ($clipAction -eq 'run') { 'running' } else { 'stopped' }
    if (!$clipResult.ok -or $clipResult.status.state -ne $clipExpected) { throw '结果状态不正确。' }
    return $clipResult.status.pid
}
try {
    $clipFirst = Invoke-ClipAction run
    $clipSecond = Invoke-ClipAction run
    if ($clipFirst -ne $clipSecond) { throw '重复启动产生了不同进程。' }
    $null = Invoke-ClipAction stop
    if (Get-Process -Id $clipFirst -ErrorAction SilentlyContinue) { throw '停止后进程仍存在。' }
    Write-Output 'CONTROLPOD_ADAPTER_PASS: start, duplicate start, stop'
} finally {
    $clipRestoreAction = if ($clipWasRunning) { 'run' } else { 'stop' }
    $null = Invoke-ClipAction $clipRestoreAction
    Remove-Item -LiteralPath $clipResultPath -ErrorAction SilentlyContinue
}
