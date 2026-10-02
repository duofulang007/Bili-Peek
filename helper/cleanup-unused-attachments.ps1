$ErrorActionPreference = 'Stop'
$clipProject = Split-Path -Parent $PSScriptRoot
$clipConfig = Get-Content -LiteralPath (Join-Path $clipProject '.local\export-config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$clipFolderName = 'Bili-Peek' + [char]0x9644 + [char]0x4ef6
$clipRoot = [IO.Path]::GetFullPath((Join-Path $clipConfig.output $clipFolderName))
$clipHealth = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $clipConfig.port + '/health') -Headers @{ 'X-Bili-Peek-Token' = $clipConfig.token } -TimeoutSec 5
if ($clipHealth.active) { throw 'A save is active. No files were removed.' }
$clipTexts = @(Get-ChildItem -LiteralPath $clipConfig.vault -File -Recurse -Force | Where-Object {
    $_.Extension -in @('.md', '.canvas', '.base') -and $_.FullName -notmatch '[\\/]\.(obsidian|trash)[\\/]'
} | ForEach-Object { [IO.File]::ReadAllText($_.FullName) })
$clipNames = @('8e26a4af88a8fb07c077.srt', 'a3d29737f9dd8897ba9e.srt', 'a8127e948f00c9db7211.srt', '.pending-AOqMCz', '.pending-iNpcdR')
Add-Type -AssemblyName Microsoft.VisualBasic
$clipCount = 0
foreach ($clipName in $clipNames) {
    $clipTarget = [IO.Path]::GetFullPath((Join-Path $clipRoot $clipName))
    if (!$clipTarget.StartsWith($clipRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Target escaped attachment folder.' }
    if (!(Test-Path -LiteralPath $clipTarget)) { continue }
    $clipEntry = Get-Item -LiteralPath $clipTarget -Force
    if ($clipEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked target was preserved.' }
    if (@($clipTexts | Where-Object { $_.Contains($clipName) }).Count) { continue }
    if ($clipEntry.PSIsContainer) {
        if (@(Get-ChildItem -LiteralPath $clipTarget -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Linked child was preserved.' }
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($clipTarget, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    } else {
        [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($clipTarget, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
    $clipCount++
}
Write-Output ('Moved audited unused items to Recycle Bin: ' + $clipCount)
