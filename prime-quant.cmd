@echo off
rem PrimeQuant launcher for Windows. Runs the prebuilt bundle (fast startup);
rem installs dependencies and builds once on first run. All arguments are
rem forwarded to the CLI. Runs in the caller's current directory.
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
set "BUNDLE=%SCRIPT_DIR%packages\coding-agent\dist\bundle\cli.js"

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js not found on PATH. Install Node.js 22.8 or newer from https://nodejs.org
	exit /b 1
)

if not exist "%SCRIPT_DIR%node_modules" (
	echo First run: installing dependencies, this can take a few minutes...
	call npm --prefix "%SCRIPT_DIR%" install
	if errorlevel 1 (
		echo npm install failed. See the output above.
		exit /b 1
	)
)

if not exist "%BUNDLE%" (
	echo First run: building the PrimeQuant bundle, this is a one-time step...
	call npm --prefix "%SCRIPT_DIR%" run build
	if errorlevel 1 (
		echo Build failed. See the output above.
		exit /b 1
	)
)

node "%BUNDLE%" %*
exit /b %ERRORLEVEL%
