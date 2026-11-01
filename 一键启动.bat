@echo off
setlocal EnableExtensions
title Arknights RIIC Income Calculator

cd /d "%~dp0"

echo.
echo  ========================================
echo    Arknights RIIC Income Calculator
echo  ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js was not found.
    echo Install Node.js 20 or newer, then run this script again.
    echo.
    pause
    exit /b 1
)

set "PNPM_COMMAND="
where pnpm >nul 2>nul
if not errorlevel 1 set "PNPM_COMMAND=pnpm"

if not defined PNPM_COMMAND (
    where corepack >nul 2>nul
    if not errorlevel 1 set "PNPM_COMMAND=corepack pnpm"
)

if not defined PNPM_COMMAND (
    echo [ERROR] pnpm and Corepack were not found.
    echo Run corepack enable or install pnpm, then try again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\.modules.yaml" (
    echo [SETUP] Installing project dependencies for the first run...
    call %PNPM_COMMAND% install
    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency installation failed. Check the messages above.
        pause
        exit /b 1
    )
    echo.
)

if /i "%~1"=="--check" (
    echo [OK] Node.js, pnpm, and project dependencies are ready.
    exit /b 0
)

set "DEV_PORT=4173"
set "DEV_URL=http://127.0.0.1:%DEV_PORT%/"
echo [START] Starting the application...
echo [URL] %DEV_URL%
echo [TIP] Close this window to stop the application.
echo.

start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process '%DEV_URL%'"
call %PNPM_COMMAND% dev --host 127.0.0.1 --port %DEV_PORT% --strictPort
set "DEV_EXIT_CODE=%ERRORLEVEL%"

echo.
echo The application has stopped.
pause
endlocal & exit /b %DEV_EXIT_CODE%
