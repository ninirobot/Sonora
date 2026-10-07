# One-click build / debug script.
#
#   .\build.ps1           # build: produce the single portable exe (no installer)
#   .\build.ps1 -Dev      # debug run (recompiles on Rust changes)
#
# Why it exists: cargo is usually not on PATH (it lives in %USERPROFILE%\.cargo\bin),
# so this script calls it by full path.
#
# It also prints the version being built, and refuses to build when the three version
# files disagree (fix that in one shot with scripts/bump-version.mjs).
#
# Keep this file pure ASCII (no Chinese): PowerShell 5.1 decodes a .ps1 without a
# UTF-8 BOM as GBK, which corrupts non-ASCII text and breaks the script.
param([switch]$Dev)

$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
if (-not (Test-Path $cargo)) {
    $cargo = 'cargo'
}

# Version guard: Cargo.toml / tauri.conf.json / version.json must agree.
# Skipped with a warning when node is not on PATH, so a missing tool never blocks a build.
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    & $node.Source (Join-Path $PSScriptRoot '..\scripts\check-version.mjs')
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} else {
    Write-Host 'node not found: skipping the version consistency check'
}

$cargoVersion = Select-String -Path (Join-Path $PSScriptRoot 'Cargo.toml') -Pattern '^version = "(.+)"' |
    Select-Object -First 1
if ($cargoVersion) {
    Write-Host ('Sonora v' + $cargoVersion.Matches[0].Groups[1].Value)
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
