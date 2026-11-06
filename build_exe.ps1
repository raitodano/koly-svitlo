# Builds dist\KolySvitlo.exe (single file, the user does not need Python installed).
# Usage:  powershell -ExecutionPolicy Bypass -File build_exe.ps1
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path .venv\Scripts\python.exe)) {
    py -m venv .venv
    .\.venv\Scripts\python.exe -m pip install --disable-pip-version-check -q pyinstaller
}
.\.venv\Scripts\python.exe tools\make_icon.py
.\.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile --console `
    --name KolySvitlo --icon tools\icon.ico `
    --add-data "static;static" `
    server.py
Write-Host "`nDone: $PSScriptRoot\dist\KolySvitlo.exe"
