@echo off
setlocal EnableExtensions
cd /d "%~dp0"

:: ============================================
::  MoonTVPlus Build (production bundle only)
::  - checks Node.js and pnpm
::  - kills old server process on port 3000
::  - runs pnpm build, output redirected to build.log
::  - starts production server and opens browser
:: ============================================

echo ============================================
echo   MoonTVPlus Build
echo   Root: %~dp0
echo ============================================

echo [1/4] Checking Node.js and pnpm...
where node >nul 2>nul
if errorlevel 1 (
  echo FAILED: node not found in PATH.
  goto :fail
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo FAILED: pnpm not found in PATH.
  goto :fail
)

echo [2/4] Killing old server process on port 3000...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr /i "LISTENING"') do (
  taskkill /F /PID %%a >nul 2>&1
)

echo [3/4] Running production build...
echo       (progress is logged to build.log, this can take a few minutes)
set "NO_COLOR=1"
set "FORCE_COLOR=0"
call pnpm build > build.log 2>&1
if errorlevel 1 (
  echo BUILD FAILED. Check build.log for details.
  goto :fail
)

echo.
echo Build completed successfully.

echo [4/4] Starting production server and opening browser...
set "NODE_ENV=production"
start "MoonTVPlus Server" /min cmd /c "cd /d %~dp0 && node server.js"

echo Waiting for server to be ready...
set /a tries=0
:waitloop
timeout /t 1 /nobreak >nul
set /a tries+=1
>nul 2>&1 curl -s -o nul http://localhost:3000
if not errorlevel 1 goto :open
if %tries% lss 30 goto :waitloop
echo WARNING: Server not responding yet, opening browser anyway...
:open
start "" http://localhost:3000
exit /b 0

:fail
echo.
echo Build failed.
pause >nul
exit /b 1
