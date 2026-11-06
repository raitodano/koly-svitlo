# Builds dist\KolySvitlo.exe (single file, the user does not need Python installed).
# Usage:  powershell -ExecutionPolicy Bypass -File build_exe.ps1
# On GitHub Actions (release.yml) the current Python is used instead of .venv.
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Invoke-Checked {
    & $args[0] @($args | Select-Object -Skip 1)
    if ($LASTEXITCODE) { throw "Command failed ($LASTEXITCODE): $($args -join ' ')" }
}

if ($env:GITHUB_ACTIONS) {
    $py = 'python'
    Invoke-Checked $py -m pip install --disable-pip-version-check -q pyinstaller
} else {
    if (-not (Test-Path .venv\Scripts\python.exe)) {
        Invoke-Checked py -m venv .venv
        Invoke-Checked .\.venv\Scripts\python.exe -m pip install --disable-pip-version-check -q pyinstaller
    }
    $py = '.\.venv\Scripts\python.exe'
}
Invoke-Checked $py tools\make_icon.py
Invoke-Checked $py -m PyInstaller --noconfirm --clean --onefile --console `
    --name KolySvitlo --icon tools\icon.ico `
    --add-data "static;static" `
    server.py
Write-Host "`nDone: $PSScriptRoot\dist\KolySvitlo.exe"
