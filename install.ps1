# PRIME QUANT Windows installer (A7).
#
# Honest path: clone the product into %USERPROFILE%\.primequant\repo (or update
# an existing clone), npm ci, build the prebuilt bundle, then register a thin
# `primequant` shim on the user PATH. No CI artifacts relied on; the Windows
# smoke job in B4 verifies this exact build on every PR once it is wired to
# upload the tarball (docs/windows.md notes the future upgrade path).

param(
    [string]$RepoDir = "$env:USERPROFILE\.primequant\repo",
    [string]$RemoteUrl = "https://github.com/DEEPAK-X/prime-quant.git"
)

$ErrorActionPreference = "Stop"

function Write-Info([string]$Message) { Write-Host "[primequant] $Message" }

# 1. Prerequisites.
Write-Info "checking prerequisites…"
try { $node = (node --version).Trim() } catch { throw "Node.js is required (https://nodejs.org >= 18)." }
try { git --version | Out-Null } catch { throw "Git is required (https://git-scm.com)." }
$major = [int]($node -replace "v(\d+).*", '$1')
if ($major -lt 18) { throw "Node.js $node is too old; install >= 18." }

# 2. Clone or update the product repo.
if (Test-Path (Join-Path $RepoDir ".git")) {
    Write-Info "updating existing clone at $RepoDir…"
    Push-Location $RepoDir
    git fetch --quiet
    git pull --ff-only
    Pop-Location
} else {
    Write-Info "cloning prime-quant into $RepoDir…"
    git clone --quiet $RemoteUrl $RepoDir
}

Push-Location $RepoDir
try {
    # 3. Install + build the prebuilt bundle.
    Write-Info "installing dependencies (npm ci)…"
    npm ci --no-audit --no-fund | Out-Null
    Write-Info "building bundle…"
    npm run build | Out-Null

    $bundle = Join-Path $RepoDir "packages\coding-agent\dist\bundle\cli.js"
    if (-not (Test-Path $bundle)) { throw "bundle not produced at $bundle" }

    # 4. PATH shim (always executes the bundle, never tsx).
    $binDir = Join-Path $env:USERPROFILE ".primequant\bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$shim = @"
@echo off
rem PRIME QUANT shim (installed by install.ps1)
node "%~dp0..\repo\packages\coding-agent\dist\bundle\cli.js" %*
"@
    Set-Content -Path (Join-Path $binDir "primequant.cmd") -Value $shim -Encoding ASCII
    $path = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($path -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$path;$binDir", "User")
        Write-Info "added $binDir to the user PATH (reopen your terminal)."
    }

    # 5. Verify through the shim.
    Write-Info "verifying…"
    & (Join-Path $binDir "primequant.cmd") "--version" | Out-Null
    Write-Info "done. Use 'primequant' from any project folder; API login via 'primequant /login' or env keys. MT5: set PRIME_QUANT_MT5_PATH/LOGIN/PASSWORD/SERVER; without MT5, rlm.quant.load_data(path) still backtests CSV/Parquet exports."
} finally {
    Pop-Location
}
