$ErrorActionPreference = 'Stop'
$workspacePath = (Get-Location).Path
$validationPath = Join-Path $workspacePath 'validation/mower-parity-2026-10-04'
$priorPath = Join-Path $validationPath 'prior-validation'
$generatedPath = Join-Path $validationPath 'full-test-artifacts'
New-Item -ItemType Directory -Path $priorPath,$generatedPath -Force | Out-Null
$relativeFiles = @('implementation-evidence.json','production-24h.json','production-168h.json','roster-seed-events.json','screenshot-scenarios.json','screenshot-failure.json')
$files = @($relativeFiles | ForEach-Object {
    $originalPath = Join-Path $workspacePath ('validation/mower-backup-2026-09-22/' + $_)
    [pscustomobject]@{ Name=$_; Original=$originalPath; Exists=(Test-Path -LiteralPath $originalPath); Hash=if(Test-Path -LiteralPath $originalPath){(Get-FileHash -Algorithm SHA256 -LiteralPath $originalPath).Hash}else{$null} }
})
foreach ($file in $files) {
    if ($file.Exists) { Copy-Item -LiteralPath $file.Original -Destination (Join-Path $priorPath $file.Name) }
}
$files | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $priorPath 'manifest.json') -Encoding utf8
$testExit = 1
try {
    $env:MOWER_PARITY_OUTPUT = '../mower-parity-2026-10-04/screenshot-scenarios.json'
    # Windows PowerShell treats native stderr as a terminating error under Stop.
    # Vitest emits harmless Vue warnings there; use its process exit status.
    $ErrorActionPreference = 'Continue'
    node node_modules/vitest/vitest.mjs run --exclude 'release/**' --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000 2>&1 | Tee-Object -FilePath (Join-Path $validationPath 'full-tests.txt')
    $testExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
} finally {
    foreach ($file in $files) {
        if (Test-Path -LiteralPath $file.Original) { Copy-Item -LiteralPath $file.Original -Destination (Join-Path $generatedPath $file.Name) }
        if ($file.Exists) {
            Copy-Item -LiteralPath (Join-Path $priorPath $file.Name) -Destination $file.Original -Force
            if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.Original).Hash -ne $file.Hash) { throw ('Validation restoration failed: ' + $file.Original) }
        } elseif (Test-Path -LiteralPath $file.Original) {
            $resolvedPath = (Resolve-Path -LiteralPath $file.Original).Path
            if (-not $resolvedPath.StartsWith($workspacePath + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Generated validation path escaped the workspace' }
            Remove-Item -LiteralPath $resolvedPath
        }
    }
}
exit $testExit
