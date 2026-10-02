$ErrorActionPreference = 'Stop'
$clipRoot = Split-Path -Parent $PSScriptRoot
$clipConfig = Get-Content -LiteralPath (Join-Path $clipRoot '.local\export-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$clipFolder = 'Bili-Peek' + [char]0x9644 + [char]0x4ef6
$clipPattern = '(?m)^# [^\r\n]+\r?\n\r?\n(?=!\[\[' + [regex]::Escape($clipFolder) + '/[a-f0-9]{20}\.mp4\]\])'
$clipBackup = Join-Path $clipRoot ('.local\title-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$clipCount = 0
foreach ($clipFile in Get-ChildItem -LiteralPath $clipConfig.output -File -Filter '*.md') {
    $clipText = [IO.File]::ReadAllText($clipFile.FullName)
    if (![regex]::IsMatch($clipText, $clipPattern)) { continue }
    New-Item -ItemType Directory -Path $clipBackup -Force | Out-Null
    Copy-Item -LiteralPath $clipFile.FullName -Destination (Join-Path $clipBackup $clipFile.Name)
    [IO.File]::WriteAllText($clipFile.FullName, [regex]::Replace($clipText, $clipPattern, ''), [Text.UTF8Encoding]::new($false))
    $clipCount++
}
Write-Output ('Removed duplicate generated headings: ' + $clipCount)
