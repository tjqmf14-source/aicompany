param([ValidateSet('Start', 'Stop')][string]$Action = 'Start', [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
# Node emits UTF-8 JSON. Windows PowerShell otherwise decodes native output using
# the legacy console code page and corrupts non-ASCII data-directory paths.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    $packageRoot = $PSScriptRoot
    $nodeExe = Join-Path $packageRoot 'runtime/node.exe'
    $entry = Join-Path $packageRoot 'dist/server/server/desktop-cli.js'
    $env:PATH = (Join-Path $packageRoot 'runtime') + ';' + $env:PATH
    & $nodeExe $entry verify
    if ($LASTEXITCODE -ne 0) { throw 'Package verification failed. Extract a fresh official package.' }
    if ($Action -eq 'Stop') {
        & $nodeExe $entry stop
        if ($LASTEXITCODE -ne 0) { throw 'No verified running instance could be stopped. No process was forcibly killed.' }
        Write-Host 'Shutdown requested. Your data is retained.'
        exit 0
    }
    $previous = & $nodeExe $entry status 2>$null
    if ($LASTEXITCODE -eq 0) {
        $url = ($previous | ConvertFrom-Json).url
    } else {
        $prepared = & $nodeExe $entry prepare
        if ($LASTEXITCODE -ne 0) { throw 'Data directory is unavailable or owned by another instance.' }
        $dataRoot = ($prepared | ConvertFrom-Json).dataRoot
        $server = Start-Process -FilePath $nodeExe -ArgumentList @(('"' + $entry + '"'), 'serve') -WorkingDirectory $packageRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataRoot 'server.log') -RedirectStandardError (Join-Path $dataRoot 'server-error.log')
        $url = $null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 300
            if ($server.HasExited) { throw "Startup failed. Inspect $dataRoot/server-error.log. Data was not removed." }
            $state = & $nodeExe $entry status 2>$null
            if ($LASTEXITCODE -eq 0) { $url = ($state | ConvertFrom-Json).url; break }
        }
        if (-not $url) { throw "Readiness timed out. Inspect $dataRoot/server-error.log; do not start another copy blindly." }
    }
    if ($url -notmatch '^http://127\.0\.0\.1:[0-9]+$') { throw 'Invalid local application URL' }
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host "AI Company Bridge is ready: $url"
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
