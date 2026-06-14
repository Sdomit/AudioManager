@echo off
setlocal

cd /d "%~dp0"

echo.
echo === AudioManager test launcher ===
echo.
echo Safety note: use headphones while testing microphone routing to avoid feedback.
echo.

if not exist "package.json" (
  echo ERROR: package.json was not found. Run this file from the AudioManager repo.
  goto :fail
)

if not exist "src-tauri\Cargo.toml" (
  echo ERROR: src-tauri\Cargo.toml was not found. This does not look like the AudioManager Tauri project.
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found on PATH. Install Node.js 18 or newer, then try again.
  goto :fail
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm was not found on PATH.
  echo Install it with: npm install -g pnpm
  goto :fail
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo ERROR: Rust/Cargo was not found on PATH. Install Rust from https://rustup.rs/, then try again.
  goto :fail
)

where git >nul 2>nul
if errorlevel 1 (
  echo ERROR: Git was not found on PATH. Install Git, then try again.
  goto :fail
)

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo ERROR: This folder is not a git repository.
  goto :fail
)

echo Switching to the main branch...
git checkout main
if errorlevel 1 (
  echo ERROR: Could not switch to main. Commit or stash local changes first, then retry.
  goto :fail
)

echo Updating main from origin ^(best effort^)...
git pull --ff-only origin main
if errorlevel 1 (
  echo WARNING: Could not fast-forward main from origin. Running the local main branch as-is.
)
echo.

if not exist "node_modules" (
  echo Node dependencies are missing. Running pnpm install...
  call pnpm install
  if errorlevel 1 goto :fail
  echo.
)

set RUST_BACKTRACE=1

rem Pin CMake to the installed VS 2022 toolset. Without this, cmake-rs auto-picks
rem the newest VS ("Visual Studio 18 2026") which the VS2022-bundled cmake cannot
rem generate, breaking audiopus_sys/aws-lc-rs outside a VS dev shell.
set "CMAKE_GENERATOR=Visual Studio 17 2022"
set "CMAKE_GENERATOR_PLATFORM=x64"

echo Building the phone client bundle (dist-phone)...
call pnpm run build:phone
if errorlevel 1 (
  echo ERROR: phone client build failed. Paired phones would load a blank page.
  goto :fail
)
echo.

echo Starting AudioManager in Tauri dev mode...
echo Vite will use http://localhost:1420.
echo Close the AudioManager window or press Ctrl+C in this terminal to stop.
echo.

call pnpm tauri dev
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" goto :fail_with_code

echo.
echo AudioManager exited.
pause
exit /b 0

:fail
set EXIT_CODE=1

:fail_with_code
echo.
echo AudioManager test launcher failed with exit code %EXIT_CODE%.
echo Check the messages above, fix any missing prerequisites, then run it again.
pause
exit /b %EXIT_CODE%
