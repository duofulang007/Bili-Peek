$ErrorActionPreference = 'Stop'
try {
    $clipConfigPath = Join-Path (Split-Path -Parent $PSScriptRoot) '.local\export-config.json'
    $clipConfig = Get-Content -LiteralPath $clipConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($clipConfig.token -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid pairing code' }
    Set-Clipboard -Value $clipConfig.token
    $clipCopied = Get-Clipboard -Raw
    if ($null -eq $clipCopied -or $clipCopied.Trim() -cne $clipConfig.token) { throw 'Clipboard verification failed' }
    Write-Output 'Pairing code copied and verified. Paste it into the Tampermonkey pairing menu.'
    exit 0
} catch {
    Write-Output 'Could not copy the pairing code. Check the local configuration and clipboard, then run the launcher again.'
    exit 1
}
