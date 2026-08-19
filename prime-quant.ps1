# PrimeQuant launcher for Windows. Runs the prebuilt bundle (fast startup);
# installs dependencies and builds once on first run. All arguments are
# forwarded to the CLI. Runs in the caller's current directory.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bundle = Join-Path $ScriptDir "packages\coding-agent\dist\bundle\cli.js"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found on PATH. Install Node.js 22.8 or newer from https://nodejs.org"
    exit 1
}

if (-not (Test-Path (Join-Path $ScriptDir "node_modules"))) {
    Write-Host "First run: installing dependencies, this can take a few minutes..."
    npm --prefix $ScriptDir install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path $Bundle)) {
    Write-Host "First run: building the PrimeQuant bundle (one-time)..."
    npm --prefix $ScriptDir run build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& node $Bundle @args
exit $LASTEXITCODE
