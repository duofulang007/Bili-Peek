$ErrorActionPreference = 'Stop'
$runtimeNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (!$runtimeNode) { $runtimeNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$runtimeRoot = Split-Path -Parent $PSScriptRoot
$runtimeExpected = Get-Content -LiteralPath (Join-Path $runtimeRoot '.local/runtime.json') -Raw -Encoding UTF8 | ConvertFrom-Json
function Test-RuntimeService {
    try {
        $runtimeResponse = Invoke-RestMethod -Uri 'http://127.0.0.1:18767/runtime' -TimeoutSec 1
        if ($runtimeResponse.sha256 -ne $runtimeExpected.sha256 -or $runtimeResponse.code -cne $runtimeExpected.code) { throw 'RUNTIME_MISMATCH' }
        return $true
    } catch {
        if ($_.Exception.Message -eq 'RUNTIME_MISMATCH' -or $_.Exception.Response) { throw '更新端口被其他服务占用或返回内容不一致。' }
        return $false
    }
}
if (!(Test-RuntimeService)) {
    $null = Start-Process -FilePath $runtimeNode -ArgumentList ('"' + (Join-Path $PSScriptRoot 'runtime.cjs') + '"') -WorkingDirectory $runtimeRoot -WindowStyle Hidden -PassThru
    for ($runtimeAttempt = 0; $runtimeAttempt -lt 20; $runtimeAttempt++) {
        Start-Sleep -Milliseconds 100
        if (Test-RuntimeService) { break }
    }
}
if (!(Test-RuntimeService)) { throw 'CPod 脚本更新服务启动失败。' }
Write-Output ('RUNTIME_SERVICE_READY ' + $runtimeExpected.version)
