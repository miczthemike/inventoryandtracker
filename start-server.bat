@echo off
setlocal

cd /d "%~dp0"
if errorlevel 1 (
    echo ERROR: Could not change to the application folder.
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found on PATH. Install Node.js LTS or add it to the system PATH.
    exit /b 1
)

if not exist "%~dp0servver.js" (
    echo ERROR: servver.js was not found in "%~dp0".
    exit /b 1
)

node "%~dp0servver.js"
set "SERVER_EXIT_CODE=%ERRORLEVEL%"
if not "%SERVER_EXIT_CODE%"=="0" (
    echo ERROR: The server exited with code %SERVER_EXIT_CODE%.
)
exit /b %SERVER_EXIT_CODE%
