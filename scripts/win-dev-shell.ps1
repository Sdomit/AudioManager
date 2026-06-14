<#
.SYNOPSIS
  Set up an MSVC build environment for AudioManager and (optionally) run a command in it.

.DESCRIPTION
  The Phase 2+ phone-audio receiver depends on `audiopus`, which builds libopus
  from C source via CMake. That needs three things on PATH that a bare
  PowerShell session does not have: the MSVC compiler (cl.exe), cmake, and
  ninja. rustc finds its own linker, so the rest of the app builds without this
  — only the libopus build script needs it.

  This script discovers the installed Visual Studio via vswhere, imports
  vcvars64 (cl + INCLUDE/LIB), prepends VS's bundled cmake + ninja to PATH, and
  pins the Ninja generator. Dot-source it to configure the current session, or
  pass a command to run in a configured child scope.

.EXAMPLE
  . .\scripts\win-dev-shell.ps1
  # current session now builds; then:
  pnpm tauri dev

.EXAMPLE
  .\scripts\win-dev-shell.ps1 cargo build --lib
  # one-off: sets up env and runs the command
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Command
)

$ErrorActionPreference = 'Stop'

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    throw "vswhere not found at $vswhere — install Visual Studio 2022 with the 'Desktop development with C++' workload."
}

# Prefer the stable VS 2022 toolset (17.x). VS 18 preview's bundled CMake/toolset
# fails to configure the libopus build via cmake-rs; pin away from it. Fall back
# to whatever -latest finds only if no 17.x is installed.
$install = & $vswhere -version '[17.0,18.0)' -products * `
    -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
    -property installationPath | Select-Object -First 1
if (-not $install) {
    $install = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath
}
if (-not $install) {
    throw "No Visual Studio install with the C++ toolset found. Install the 'Desktop development with C++' workload."
}

$vcvars = Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

# Import the vcvars environment into this PowerShell process.
cmd /c "`"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
    if ($_ -match '^(.*?)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}

# VS bundles cmake + ninja but does not put them on PATH.
$cmakeBin = Join-Path $install 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'
$ninjaBin = Join-Path $install 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
foreach ($dir in @($cmakeBin, $ninjaBin)) {
    if ((Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) { $env:PATH = "$dir;$env:PATH" }
}
$env:CMAKE_GENERATOR = 'Ninja'

Write-Host "[win-dev-shell] cl    : $((Get-Command cl    -ErrorAction SilentlyContinue).Source)"
Write-Host "[win-dev-shell] cmake : $((Get-Command cmake -ErrorAction SilentlyContinue).Source)"
Write-Host "[win-dev-shell] ninja : $((Get-Command ninja -ErrorAction SilentlyContinue).Source)"

if ($Command -and $Command.Count -gt 0) {
    & $Command[0] @($Command[1..($Command.Count - 1)])
    exit $LASTEXITCODE
}
