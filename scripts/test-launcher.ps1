[CmdletBinding()]
param(
    [string]$LauncherPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repositoryRoot = [IO.Directory]::GetParent($PSScriptRoot).FullName
if (-not $LauncherPath) { $LauncherPath = Join-Path $repositoryRoot ((-join ([char[]]@(0x4e00, 0x952e, 0x542f, 0x52a8))) + '.bat') }
$fixtureRoot = Join-Path $repositoryRoot ('artifacts/launcher-tests/' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$launcherSource = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $LauncherPath).Path)
$results = [Collections.Generic.List[object]]::new()

function Write-Fixture {
    param([string]$Path, [string]$Content)
    [IO.Directory]::CreateDirectory([IO.Directory]::GetParent($Path).FullName) | Out-Null
    [IO.File]::WriteAllText($Path, ($Content -replace '\r?\n', "`r`n"), [Text.ASCIIEncoding]::new())
}

function Invoke-LauncherCase {
    param(
        [string]$Name,
        [string]$Branch = 'main',
        [bool]$HasGit = $true,
        [bool]$HasNode = $true,
        [bool]$HasPnpm = $true,
        [bool]$HasCorepack = $false,
        [bool]$Installed = $true,
        [bool]$CheckOnly = $true,
        [int]$InstallExit = 0,
        [int]$DevExit = 0,
        [int]$ExpectedExit = 0,
        [string[]]$ExpectedTrace = @(),
        [string]$ExpectedOutput = ''
    )
    # Spaces exercise the same quoting used by the real source directory.
    $caseRoot = Join-Path $fixtureRoot ($Name + ' source tree')
    $bin = Join-Path $caseRoot 'stub-bin'
    [IO.Directory]::CreateDirectory($bin) | Out-Null
    $trace = Join-Path $caseRoot 'commands.txt'
    $browserTrace = Join-Path $caseRoot 'browser.txt'
    if ($HasNode) { Write-Fixture (Join-Path $bin 'node.cmd') "@echo off`nexit /b 0`n" }
    if ($HasGit) { Write-Fixture (Join-Path $bin 'git.cmd') "@echo off`necho $Branch`nexit /b 0`n" }
    $packageStub = @(
        '@echo off'
        '>> "%LAUNCHER_TEST_TRACE%" echo %~n0 %*'
        'if /i "%~1"=="install" exit /b %LAUNCHER_TEST_INSTALL_EXIT%'
        'if /i "%~2"=="install" exit /b %LAUNCHER_TEST_INSTALL_EXIT%'
        'exit /b %LAUNCHER_TEST_DEV_EXIT%'
    ) -join "`n"
    if ($HasPnpm) { Write-Fixture (Join-Path $bin 'pnpm.cmd') $packageStub }
    if ($HasCorepack) { Write-Fixture (Join-Path $bin 'corepack.cmd') $packageStub }
    $browserStub = Join-Path $bin 'browser.cmd'
    Write-Fixture $browserStub "@echo off`n> `"%LAUNCHER_TEST_BROWSER%`" echo %*`nexit /b 0`n"
    # Substitute only the browser executable; no real browser or dev server runs.
    $fixtureLauncher = $launcherSource.Replace('powershell.exe', 'cmd.exe /d /c browser.cmd')
    $launcher = Join-Path $caseRoot 'launch.bat'
    Write-Fixture $launcher $fixtureLauncher
    if ($Installed) { Write-Fixture (Join-Path $caseRoot 'node_modules/.modules.yaml') 'fixture dependencies' }
    $argument = if ($CheckOnly) { ' --check' } else { '' }
    $runner = Join-Path $caseRoot 'invoke.cmd'
    Write-Fixture $runner ("@echo off`ncall `"%~dp0launch.bat`"" + $argument + "`nexit /b %errorlevel%`n")
    $start = [Diagnostics.ProcessStartInfo]::new($env:ComSpec)
    $start.Arguments = '/d /s /c ""' + $runner + '""'
    $start.WorkingDirectory = $caseRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['PATH'] = $bin + ';' + (Join-Path $env:SystemRoot 'System32')
    $start.EnvironmentVariables['LAUNCHER_TEST_TRACE'] = $trace
    $start.EnvironmentVariables['LAUNCHER_TEST_BROWSER'] = $browserTrace
    $start.EnvironmentVariables['LAUNCHER_TEST_INSTALL_EXIT'] = [string]$InstallExit
    $start.EnvironmentVariables['LAUNCHER_TEST_DEV_EXIT'] = [string]$DevExit
    $process = [Diagnostics.Process]::Start($start)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) { $process.Kill(); throw "Launcher fixture timed out: $Name" }
    $output = $stdout.GetAwaiter().GetResult() + $stderr.GetAwaiter().GetResult()
    [IO.File]::WriteAllText((Join-Path $caseRoot 'output.txt'), $output)
    $actualTrace = if (Test-Path -LiteralPath $trace) { @(Get-Content -LiteralPath $trace) } else { @() }
    $errors = [Collections.Generic.List[string]]::new()
    if ($process.ExitCode -ne $ExpectedExit) { $errors.Add("Exit: expected $ExpectedExit, actual $($process.ExitCode)") }
    if (($actualTrace -join '|') -cne ($ExpectedTrace -join '|')) { $errors.Add("Commands: $($actualTrace -join '|')") }
    if ($ExpectedOutput -and $output -notmatch $ExpectedOutput) { $errors.Add("Missing output: $ExpectedOutput") }
    if ($CheckOnly) {
        if (Test-Path -LiteralPath $browserTrace) { $errors.Add('--check opened the browser helper') }
    } elseif ($ExpectedTrace.Count -gt 0 -and $ExpectedTrace[-1] -match '\bdev\b') {
        for ($attempt = 0; $attempt -lt 20 -and -not (Test-Path -LiteralPath $browserTrace); $attempt++) { Start-Sleep -Milliseconds 50 }
        if (-not (Test-Path -LiteralPath $browserTrace)) { $errors.Add('Browser helper did not run') }
        elseif ([IO.File]::ReadAllText($browserTrace) -notmatch 'http://127\.0\.0\.1:4173/') { $errors.Add('Browser helper received a different port') }
    }
    $result = [ordered]@{ Name = $Name; Passed = $errors.Count -eq 0; ExitCode = $process.ExitCode; Errors = $errors.ToArray(); Commands = @($actualTrace); BrowserHelperRan = Test-Path -LiteralPath $browserTrace }
    $results.Add($result)
    $label = if ($result.Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "$label $Name $($errors -join '; ')"
    $process.Dispose()
}

Invoke-LauncherCase -Name 'main-check'
Invoke-LauncherCase -Name 'test-check' -Branch 'test'
Invoke-LauncherCase -Name 'codex-check' -Branch 'codex/fixture'
Invoke-LauncherCase -Name 'detached-check' -Branch ''
Invoke-LauncherCase -Name 'archive-without-git' -HasGit $false
Invoke-LauncherCase -Name 'missing-node' -HasNode $false -ExpectedExit 1 -ExpectedOutput 'Node.js was not found'
Invoke-LauncherCase -Name 'missing-package-manager' -HasPnpm $false -ExpectedExit 1 -ExpectedOutput 'pnpm and Corepack were not found'
Invoke-LauncherCase -Name 'first-install-check' -Installed $false -ExpectedTrace @('pnpm install')
Invoke-LauncherCase -Name 'install-failure' -Installed $false -InstallExit 7 -ExpectedExit 1 -ExpectedTrace @('pnpm install') -ExpectedOutput 'Dependency installation failed'
Invoke-LauncherCase -Name 'corepack-install-check' -HasPnpm $false -HasCorepack $true -Installed $false -ExpectedTrace @('corepack pnpm install')
Invoke-LauncherCase -Name 'pnpm-dev' -CheckOnly $false -ExpectedTrace @('pnpm dev --host 127.0.0.1 --port 4173 --strictPort')
Invoke-LauncherCase -Name 'corepack-dev' -CheckOnly $false -HasPnpm $false -HasCorepack $true -ExpectedTrace @('corepack pnpm dev --host 127.0.0.1 --port 4173 --strictPort')
Invoke-LauncherCase -Name 'dev-failure' -CheckOnly $false -DevExit 23 -ExpectedExit 23 -ExpectedTrace @('pnpm dev --host 127.0.0.1 --port 4173 --strictPort')

$failed = @($results | Where-Object { -not $_.Passed }).Count
$summary = [ordered]@{ Passed = $results.Count - $failed; Failed = $failed; LauncherPath = [IO.Path]::GetFullPath($LauncherPath); FixtureRoot = $fixtureRoot; ActualBrowserOrServerStarted = $false; Tests = $results.ToArray() }
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'test-result.json'), ($summary | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
Write-Host "$($summary.Passed)/$($results.Count) launcher tests passed. Fixtures/evidence: $fixtureRoot"
if ($failed -gt 0) { throw "$failed launcher tests failed." }
