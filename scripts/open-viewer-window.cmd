@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoLogo -NoExit -ExecutionPolicy Bypass -File "%SCRIPT_DIR%open-viewer-window.ps1" %*
) else (
  powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File "%SCRIPT_DIR%open-viewer-window.ps1" %*
)
