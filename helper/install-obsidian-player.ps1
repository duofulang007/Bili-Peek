$ErrorActionPreference = 'Stop'
$clipProject = Split-Path -Parent $PSScriptRoot
$clipConfig = Get-Content -LiteralPath (Join-Path $clipProject '.local\export-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$clipVault = $clipConfig.vault
$clipPluginId = 'bili-peek-player'
$clipPlugins = Join-Path $clipVault '.obsidian\plugins'
$clipTarget = Join-Path $clipPlugins $clipPluginId
if (!(Test-Path -LiteralPath (Join-Path $clipVault '.obsidian'))) { throw 'Obsidian vault not found.' }
New-Item -ItemType Directory -Path $clipTarget -Force | Out-Null
foreach ($clipName in @('manifest.json', 'main.js', 'styles.css')) {
    Copy-Item -LiteralPath (Join-Path $clipProject ('obsidian-plugin\' + $clipName)) -Destination (Join-Path $clipTarget $clipName) -Force
}
$clipEnabledPath = Join-Path $clipVault '.obsidian\community-plugins.json'
$clipEnabled = @()
if (Test-Path -LiteralPath $clipEnabledPath) {
    $clipParsed = Get-Content -LiteralPath $clipEnabledPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $clipEnabled = @(foreach ($clipEntry in $clipParsed) {
        if ($clipEntry -is [string]) { $clipEntry }
        elseif ($clipEntry.PSObject.Properties['value']) { foreach ($clipOriginal in $clipEntry.value) { if ($clipOriginal -isnot [string]) { throw 'Invalid plugin entry.' }; $clipOriginal } }
        else { throw 'Invalid plugin list; no changes made.' }
    })
    Copy-Item -LiteralPath $clipEnabledPath -Destination ($clipEnabledPath + '.bili-peek-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
if ($clipEnabled -notcontains $clipPluginId) {
    $clipEnabled += $clipPluginId
}
[IO.File]::WriteAllText($clipEnabledPath, (ConvertTo-Json -InputObject @($clipEnabled)), [Text.UTF8Encoding]::new($false))
Write-Output 'Bili-Peek Player installed and enabled. Reload Obsidian to activate.'
