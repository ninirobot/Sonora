# One-click build / debug script.
#
#   .\build.ps1           # build: produce the single portable exe (no installer)
#   .\build.ps1 -Dev      # debug run (recompiles on Rust changes)
#
# Why it exists: cargo is usually not on PATH (it lives in %USERPROFILE%\.cargo\bin),
# so this script calls it by full path.
#
# Keep this file pure ASCII (no Chinese): PowerShell 5.1 decodes a .ps1 without a
# UTF-8 BOM as GBK, which corrupts non-ASCII text and breaks the script.
param([switch]$Dev)

$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path $cargo)) {
    $cargo = 'cargo'
}

if ($Dev) {
    & $cargo tauri dev
} else {
    & $cargo tauri build

    # Report the artifact (full path + size). Print only, do nothing else.
    $exe = Join-Path $PSScriptRoot 'target\release\sonora.exe'
    if (Test-Path $exe) {
        $file = Get-Item $exe
        $size = [math]::Round($file.Length / 1MB, 2)
        Write-Host ($file.FullName + '  ' + $size + ' MB')
    } else {
        Write-Host ('artifact not found: ' + $exe)
    }
}
