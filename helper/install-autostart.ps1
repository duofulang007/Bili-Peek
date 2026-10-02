$ErrorActionPreference = 'Stop'
$clipRoot = Split-Path -Parent $PSScriptRoot
$clipNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$clipStart = Join-Path $PSScriptRoot 'start.cjs'
if (!(Test-Path -LiteralPath $clipNode) -or !(Test-Path -LiteralPath $clipStart) -or !(Test-Path -LiteralPath (Join-Path $clipRoot '.local\export-config.json'))) {
    throw 'Bili-Peek runtime or configuration is missing.'
}
$clipStartup = [Environment]::GetFolderPath('Startup')
$clipEntry = Join-Path $clipStartup 'Bili-Peek Helper.vbs'
$clipVbs = @"
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "$($clipRoot.Replace('"', '""'))"
shell.Run Chr(34) & "$($clipNode.Replace('"', '""'))" & Chr(34) & " " & Chr(34) & "$($clipStart.Replace('"', '""'))" & Chr(34), 0, False
"@
[IO.File]::WriteAllText($clipEntry, $clipVbs, [Text.Encoding]::Unicode)
if ([IO.File]::ReadAllText($clipEntry) -cne $clipVbs) { throw 'Startup entry verification failed.' }
Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $clipEntry + '"') -WindowStyle Hidden
Write-Output 'AUTO_START_INSTALLED_AND_LAUNCHED'
